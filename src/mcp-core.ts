import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { ContextPruneInputSchema, MinimalContextPacketSchema } from "./context-contracts.js";
import { ContextBudgetSchema, ExecutionDecisionSchema, ProviderIdSchema, TaskInputSchema } from "./contracts.js";
import { assembleDiscovery } from "./discovery-assembler.js";
import {
  DiscoveryAssemblyInputSchema,
  DiscoveryAssemblyResultSchema,
} from "./discovery-contracts.js";
import {
  ResolvedContextBudgetSchema,
  resolveContextBudget,
} from "./execution-presets.js";
import type { DecisionRuntime } from "./runtime-core.js";
import { AggregateTelemetry, TelemetrySnapshotSchema } from "./telemetry.js";

const ResolveContextBudgetInputSchema = z.strictObject({
  context_budget: ContextBudgetSchema,
});

const HealthSchema = z.strictObject({
  status: z.literal("ok"),
  provider: ProviderIdSchema,
  configured: z.boolean(),
  model: z.string().nullable(),
  policy_version: z.string(),
  executors: z.array(z.string()),
  default_executor: z.string(),
  policy_source: z.enum(["built-in", "file"]),
  execution_presets_source: z.enum(["built-in", "file"]),
  provider_timeout_ms: z.number().int().min(100).max(120000),
  telemetry_mode: z.enum(["off", "aggregate"]),
});

export type DecisionMcpToolNames = {
  decideExecution: string;
  resolveContextBudget: string;
  assembleContextCandidates: string;
  pruneContext: string;
  telemetrySnapshot: string;
  runtimeHealth: string;
};

export const PUBLIC_MCP_TOOL_NAMES = Object.freeze({
  decideExecution: "decide_execution",
  resolveContextBudget: "resolve_context_budget",
  assembleContextCandidates: "assemble_context_candidates",
  pruneContext: "prune_context",
  telemetrySnapshot: "telemetry_snapshot",
  runtimeHealth: "runtime_health",
}) satisfies Readonly<DecisionMcpToolNames>;

export type DecisionServerIdentity = {
  name: string;
  version: string;
};

const PUBLIC_SERVER_IDENTITY: Readonly<DecisionServerIdentity> = Object.freeze({
  name: "taskstance",
  version: "0.1.0",
});

function validateToolNames(toolNames: DecisionMcpToolNames): void {
  const values = Object.values(toolNames);
  const invalid = values.filter((name) => !/^[a-z][a-z0-9_]{0,63}$/.test(name));
  if (invalid.length > 0) {
    throw new Error(`Invalid MCP tool name(s): ${invalid.join(", ")}`);
  }
  if (new Set(values).size !== values.length) {
    throw new Error("MCP tool names must be unique");
  }
}

export function createDecisionServerWithToolNames(
  runtime: DecisionRuntime,
  telemetry: AggregateTelemetry,
  toolNames: DecisionMcpToolNames,
  identity: DecisionServerIdentity,
): McpServer {
  validateToolNames(toolNames);

  const server = new McpServer(identity);

  server.registerTool(
    toolNames.decideExecution,
    {
      description:
        "Return a policy-authoritative execution profile for an engineering_non_sensitive task. Deterministic rules run first. Decisions that would call the configured judgment provider require both task_id and attempt_id and fail closed before provider billing when either is absent. The provider is called only when needed; conservative fallback is used when it is unavailable or invalid.",
      inputSchema: TaskInputSchema,
      outputSchema: ExecutionDecisionSchema,
    },
    async (task) => {
      const result = await runtime.decider.decide(task);
      telemetry.recordDecision(result);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );

  server.registerTool(
    toolNames.resolveContextBudget,
    {
      description:
        "Deterministically translate an execution profile's tiny/small/medium/large context budget into concrete token, candidate-count, and relevance limits using the configured execution presets. This tool never calls the judgment provider.",
      inputSchema: ResolveContextBudgetInputSchema,
      outputSchema: ResolvedContextBudgetSchema,
    },
    async ({ context_budget }) => {
      const result = resolveContextBudget(runtime.executionPresets, context_budget);
      telemetry.recordContextBudget(result);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );

  server.registerTool(
    toolNames.assembleContextCandidates,
    {
      description:
        "Deterministically merge and normalize bounded metadata produced by local discovery adapters such as git, text search, symbols, dependencies, tests, docs, and history. Mandatory evidence is preserved before any candidate cap. Truncated/failed sources or cap truncation mark discovery incomplete so downstream pruning fails conservatively. This tool never calls the judgment provider.",
      inputSchema: DiscoveryAssemblyInputSchema,
      outputSchema: DiscoveryAssemblyResultSchema,
    },
    async (input) => {
      const result = assembleDiscovery(input);
      telemetry.recordDiscovery(result);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );

  server.registerTool(
    toolNames.pruneContext,
    {
      description:
        "Build a bounded Minimal Context Packet from deterministic candidate metadata for an engineering_non_sensitive task. Mandatory candidates are always preserved. Incomplete discovery or invalid scoring fails conservatively. The configured context-scoring provider is called at most once and only when optional candidates can actually fit the requested context budget.",
      inputSchema: ContextPruneInputSchema,
      outputSchema: MinimalContextPacketSchema,
    },
    async (input) => {
      const result = await runtime.contextPruner.prune(input);
      telemetry.recordPrune(result);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );

  server.registerTool(
    toolNames.telemetrySnapshot,
    {
      description:
        "Return process-local aggregate counters only. Telemetry is off by default. Aggregate mode never stores task summaries, candidate/file identifiers, prompts, code contents, credentials, or raw request payloads.",
      inputSchema: z.strictObject({}),
      outputSchema: TelemetrySnapshotSchema,
    },
    async () => {
      const result = telemetry.snapshot();
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );

  server.registerTool(
    toolNames.runtimeHealth,
    {
      description: "Return bounded execution-runtime health/configuration metadata without exposing credentials.",
      inputSchema: z.strictObject({}),
      outputSchema: HealthSchema,
    },
    async () => {
      const result = HealthSchema.parse({
        status: "ok",
        ...runtime.info,
        telemetry_mode: telemetry.mode,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );

  return server;
}

export function createDecisionServerWithRuntime(
  runtime: DecisionRuntime,
  telemetry: AggregateTelemetry = new AggregateTelemetry("off"),
): McpServer {
  return createDecisionServerWithToolNames(
    runtime,
    telemetry,
    PUBLIC_MCP_TOOL_NAMES,
    PUBLIC_SERVER_IDENTITY,
  );
}
