#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ZodError } from "zod";
import { prepareTaskExecution } from "./execution-control.js";
import { TaskInputSchema } from "./contracts.js";
import { createUnavailableProviderBundle } from "./offline-providers.js";
import { defaultProjectConfig, parseProjectConfig } from "./project-config.js";
import { createDecisionRuntime } from "./runtime-core.js";
import { executeWithExecutorAdapter } from "./executor-adapter.js";
import { selectAdapter } from "./integrations/adapter-registry.js";
import { selectJudgmentAdapter } from "./integrations/judgment-registry.js";
import { RunMeasurementsSchema } from "./benchmark/schemas.js";

const DEFAULT_CONFIG_PATH = "taskstance.config.json";
const DEFAULT_TASK_PATH = "taskstance.task.example.json";

function readFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

async function readJson(path: string): Promise<unknown> {
  const text = await readFile(resolve(path), "utf8");
  return JSON.parse(text) as unknown;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(resolve(path), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}

async function initCommand(): Promise<void> {
  await writeJson(DEFAULT_CONFIG_PATH, defaultProjectConfig);
  await writeJson(DEFAULT_TASK_PATH, {
    data_classification: "engineering_non_sensitive",
    task_id: "example-task",
    attempt_id: "a1",
    summary: "Update documentation without changing runtime behavior.",
    flags: { docs_only: true },
  });
  process.stdout.write(`Created ${DEFAULT_CONFIG_PATH} and ${DEFAULT_TASK_PATH}\n`);
}

async function validateCommand(args: string[]): Promise<void> {
  const configPath = readFlag(args, "--config") ?? DEFAULT_CONFIG_PATH;
  const config = parseProjectConfig(await readJson(configPath));
  createDecisionRuntime(createUnavailableProviderBundle(), {
    executors: config.executors,
    ...(config.default_executor ? { defaultExecutor: config.default_executor } : {}),
  });
  process.stdout.write(`${JSON.stringify({ ok: true, config: resolve(configPath) }, null, 2)}\n`);
}

function judgmentSelection(args: string[]) {
  for (const flag of ["--judgment", "--judgment-config"]) {
    if (args.filter(arg => arg === flag).length > 1) throw new Error(`Duplicate ${flag}`);
  }
  const name = readFlag(args, "--judgment");
  const path = readFlag(args, "--judgment-config");
  if (!name && !path) return undefined;
  const factory = selectJudgmentAdapter(name);
  if (!path) throw new Error("--judgment requires --judgment-config <path>");
  return { factory, path };
}

async function judgmentProviders(selection: ReturnType<typeof judgmentSelection>, executors: string[], signal: AbortSignal) {
  if (!selection) return createUnavailableProviderBundle();
  const rawConfig = await readJson(selection.path).catch(() => { throw new Error("Cannot read judgment configuration"); });
  const bundle = selection.factory(rawConfig, executors);
  const provider = bundle.judgmentProvider;
  return { ...bundle, judgmentProvider: {
    decide: (task: Parameters<typeof provider.decide>[0], bounded?: AbortSignal) =>
      provider.decide(task, bounded ? AbortSignal.any([signal, bounded]) : signal),
  } };
}

async function planCommand(args: string[], signal: AbortSignal): Promise<void> {
  const selection = judgmentSelection(args);
  const configPath = readFlag(args, "--config") ?? DEFAULT_CONFIG_PATH;
  const taskPath = readFlag(args, "--task");
  if (!taskPath) throw new Error("plan requires --task <path>");

  const config = parseProjectConfig(await readJson(configPath));
  const task = TaskInputSchema.parse(await readJson(taskPath));
  const runtime = createDecisionRuntime(await judgmentProviders(selection, Object.keys(config.executors), signal), {
    executors: config.executors,
    ...(config.default_executor ? { defaultExecutor: config.default_executor } : {}),
  });
  const prepared = await prepareTaskExecution(runtime, task);
  process.stdout.write(`${JSON.stringify(prepared, null, 2)}\n`);
}

async function runCommand(args: string[], signal: AbortSignal): Promise<void> {
  const selection = judgmentSelection(args);
  const factory = selectAdapter(readFlag(args, "--adapter"));
  const { LocalContextPathsSchema, prepareLocalExecution } = await import("./integrations/local-context.js");
  const taskPath = readFlag(args, "--task");
  const adapterPath = readFlag(args, "--adapter-config");
  const contextPath = readFlag(args, "--context");
  const workspace = readFlag(args, "--workspace");
  if (!taskPath || !adapterPath || !contextPath || !workspace) {
    throw new Error("run requires --task, --adapter-config, --context, and --workspace");
  }
  const config = parseProjectConfig(await readJson(readFlag(args, "--config") ?? DEFAULT_CONFIG_PATH));
  const adapterConfig = factory(await readJson(adapterPath));
  if (!(adapterConfig.executor in config.executors)) throw new Error("Adapter executor is not configured");
  const providers = await judgmentProviders(selection, Object.keys(config.executors), signal);
  let judgmentCalls = 0;
  const judgmentProvider = providers.judgmentProvider;
  const runtime = createDecisionRuntime({ ...providers, judgmentProvider: {
    decide: (task, bounded) => {
      if (selection) judgmentCalls += 1;
      return judgmentProvider.decide(task, bounded);
    },
  } }, {
    executors: config.executors,
    ...(config.default_executor ? { defaultExecutor: config.default_executor } : {}),
  });
  const task = TaskInputSchema.parse(await readJson(taskPath));
  const paths = LocalContextPathsSchema.parse(await readJson(contextPath));
  const local = await prepareLocalExecution(runtime, task, workspace, paths);
  const adapter = adapterConfig.create(local.workspace, local.files);
  const result = await executeWithExecutorAdapter(adapter, local.preparation, signal);
  const packet = local.preparation.context_packet!;
  const output = args.includes("--benchmark-json") ? RunMeasurementsSchema.parse({
    schema_version: "1", decision_source: local.preparation.decision.source,
    profile: local.preparation.decision.profile, judgment_calls: judgmentCalls,
    initial_context_files: packet.selected_ids.length,
    initial_context_estimated_tokens: packet.selected_estimated_tokens,
    mandatory_context_retained: local.files.every(file => packet.selected_ids.includes(file.path)),
    requires_replan: packet.requires_replan || local.preparation.decision.profile.integration_strategy === "replan",
    executor: result,
  }) : result;
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (result.status !== "completed") process.exitCode = 1;
}

async function withCancellation(command: (signal: AbortSignal) => Promise<void>) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try { await command(controller.signal); }
  finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}

function printHelp(): void {
  process.stdout.write(`TaskStance CLI\n\nCommands:\n  init\n  validate [--config <path>]\n  plan --task <path> [--config <path>] [--judgment process --judgment-config <path>]\n  run --adapter codex --task <path> --adapter-config <path> --workspace <path> --context <path> [--config <path>] [--judgment process --judgment-config <path>]\n\nRegistered executor adapters: codex\nRegistered judgment adapters: process (explicit selection only)\n`);
}

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (command === "init") return initCommand();
  if (command === "validate") return validateCommand(args);
  if (command === "plan") return withCancellation(signal => planCommand(args, signal));
  if (command === "run") return withCancellation(signal => runCommand(args, signal));
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error: unknown) => {
  if (error instanceof ZodError) {
    process.stderr.write(`${JSON.stringify({ error: "validation_failed", issues: error.issues }, null, 2)}\n`);
  } else {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exitCode = 1;
});
