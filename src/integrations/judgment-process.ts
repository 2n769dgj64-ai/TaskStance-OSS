import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { z } from "zod";
import {
  ContextBudgetSchema, ExecutorSchema, IntegrationStrategySchema, ModelTierSchema,
  ProviderIdSchema, RawJudgmentSchema, ReasoningEffortSchema, ReviewDepthSchema,
  TaskInputSchema, TestDepthSchema, type RawJudgment, type TaskInput,
} from "../contracts.js";
import type { JudgmentProvider } from "../execution-decider.js";
import { callProviderWithTimeout, DEFAULT_PROVIDER_TIMEOUT_MS } from "../provider-call.js";

export const JudgmentProcessConfigSchema = z.strictObject({
  version: z.literal("1"),
  provider_id: ProviderIdSchema,
  executors: z.array(ExecutorSchema).min(1).max(16).refine(values => new Set(values).size === values.length),
  executable: z.string().min(1),
  args: z.array(z.string()).max(64).default([]),
  cli_entrypoint: z.string().min(1).refine(isAbsolute).optional(),
  max_output_bytes: z.number().int().min(1024).max(16_000_000).default(262144),
});
export type JudgmentProcessConfig = z.infer<typeof JudgmentProcessConfigSchema>;

export const JudgmentProcessRequestSchema = z.strictObject({
  schema_version: z.literal("1"),
  task: TaskInputSchema,
  choices: z.strictObject({
    executors: z.array(ExecutorSchema).min(1).max(16),
    model_tiers: z.array(ModelTierSchema),
    reasoning_efforts: z.array(ReasoningEffortSchema),
    context_budgets: z.array(ContextBudgetSchema),
    test_depths: z.array(TestDepthSchema),
    review_depths: z.array(ReviewDepthSchema),
    integration_strategies: z.array(IntegrationStrategySchema),
  }),
});

// Reuse Core's decision boundary; identity belongs exclusively to configuration.
export const JudgmentProcessResponseSchema = RawJudgmentSchema
  .omit({ provider: true, schema_version: true })
  .extend({ schema_version: z.literal("1") });

function parseDocument(text: string): unknown {
  const value: unknown = JSON.parse(text);
  // JSON.parse accepts repeated members; reject that ambiguity, including escaped keys.
  const objects: (Set<string> | null)[] = [];
  for (const token of text.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]]/g)) {
    const part = token[0];
    if (part === "{") objects.push(new Set());
    else if (part === "[") objects.push(null);
    else if (part === "}" || part === "]") objects.pop();
    else if (text.slice(token.index + part.length).trimStart().startsWith(":")) {
      const keys = objects.at(-1);
      const key: string = JSON.parse(part);
      if (keys?.has(key)) throw new Error("Duplicate response member");
      keys?.add(key);
    }
  }
  return value;
}

/** One process, one JSON document, no retries, raw logs, or inherited secrets. */
export class JudgmentProcessAdapter implements JudgmentProvider {
  private readonly config: JudgmentProcessConfig;

  constructor(rawConfig: z.input<typeof JudgmentProcessConfigSchema>) {
    this.config = JudgmentProcessConfigSchema.parse(rawConfig);
    if (/\.(cmd|bat|ps1|sh)$/i.test(this.config.executable) ||
        /^(cmd|powershell|pwsh|sh|bash|dash|zsh)(\.exe)?$/i.test(basename(this.config.executable))) {
      throw new Error("Use a native executable or absolute cli_entrypoint; shell launchers are unsupported");
    }
  }

  decide(task: TaskInput, signal?: AbortSignal): Promise<RawJudgment> {
    // Core supplies its existing bounded signal. Direct callers are bounded too.
    return signal ? this.launch(task, signal) :
      callProviderWithTimeout(DEFAULT_PROVIDER_TIMEOUT_MS, bounded => this.launch(task, bounded));
  }

  private async launch(task: TaskInput, signal: AbortSignal): Promise<RawJudgment> {
    if (signal.aborted) throw new Error("Judgment process cancelled");
    const request = JudgmentProcessRequestSchema.parse({
      schema_version: "1", task,
      choices: {
        executors: this.config.executors,
        model_tiers: ModelTierSchema.options, reasoning_efforts: ReasoningEffortSchema.options,
        context_budgets: ContextBudgetSchema.options, test_depths: TestDepthSchema.options,
        review_depths: ReviewDepthSchema.options, integration_strategies: IntegrationStrategySchema.options,
      },
    });
    const command = this.config.cli_entrypoint ? process.execPath : this.config.executable;
    const args = this.config.cli_entrypoint ? [this.config.cli_entrypoint, ...this.config.args] : this.config.args;
    return new Promise((resolve, reject) => {
      const start = () => {
        try {
          return spawn(command, args, {
            shell: false, windowsHide: true, detached: process.platform !== "win32",
            cwd: tmpdir(), env: {}, stdio: ["pipe", "pipe", "ignore"],
          });
        } catch { throw new Error("Judgment process launch failure"); }
      };
      const child = start();
      let chunks: Buffer[] = [];
      let bytes = 0;
      let failure: string | undefined;
      let termination: Promise<void> | undefined;
      const stop = (reason: string) => {
        if (failure) return;
        failure = reason;
        chunks = [];
        if (!child.pid) return;
        const pid = child.pid;
        if (process.platform === "win32") {
          termination = new Promise(done => {
            const killer = spawn(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
              ["/pid", String(pid), "/T", "/F"], { shell: false, windowsHide: true, env: {}, stdio: "ignore" });
            killer.on("error", () => { child.kill("SIGKILL"); done(); });
            killer.on("close", code => { if (code !== 0) child.kill("SIGKILL"); done(); });
          });
        } else {
          try { process.kill(-pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
        }
      };
      const abort = () => stop("Judgment process cancelled");
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      child.stdout.on("data", (chunk: Buffer) => {
        if (failure) return;
        bytes += chunk.length;
        if (bytes > this.config.max_output_bytes) { stop("Judgment process output limit"); return; }
        chunks.push(chunk);
      });
      child.stdin.on("error", () => stop("Judgment process input failure"));
      child.on("error", () => stop("Judgment process launch failure"));
      child.on("close", async code => {
        signal.removeEventListener("abort", abort);
        await termination;
        try {
          if (failure || code !== 0) throw new Error("failure");
          // Parsing the entire document rejects missing and duplicate final responses.
          const response = JudgmentProcessResponseSchema.parse(parseDocument(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))));
          const result = RawJudgmentSchema.parse({ ...response, schema_version: "2", provider: this.config.provider_id });
          if (result.decisions?.executor && !this.config.executors.includes(result.decisions.executor.selected)) {
            throw new Error("executor outside process choices");
          }
          resolve(result);
        } catch {
          // Never propagate raw output, stderr, JSON parse messages, or schema errors.
          reject(new Error(failure ?? "Judgment process unavailable or invalid"));
        } finally { chunks = []; }
      });
      if (!failure) child.stdin.end(`${JSON.stringify(request)}\n`);
      else child.stdin.destroy();
    });
  }
}
