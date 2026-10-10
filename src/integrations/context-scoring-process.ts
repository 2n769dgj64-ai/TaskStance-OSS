import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { z } from "zod";
import {
  ContextCandidateSchema,
  ContextPruneInputSchema,
  ContextScoreJudgmentSchema,
  type ContextCandidate,
  type ContextPruneInput,
  type ContextScoreJudgment,
} from "../context-contracts.js";
import { ProviderIdSchema } from "../contracts.js";
import type { ContextScoringProvider } from "../context-pruner.js";
import { callProviderWithTimeout, DEFAULT_PROVIDER_TIMEOUT_MS } from "../provider-call.js";

const MAX_INPUT_BYTES = 65_536;
const DEFAULT_MAX_OUTPUT_BYTES = 262_144;

export const ContextScoringProcessConfigSchema = z.strictObject({
  version: z.literal("1"),
  provider_id: ProviderIdSchema,
  executable: z.string().min(1),
  args: z.array(z.string()).max(32).default([]),
  cli_entrypoint: z.string().min(1).refine(isAbsolute).optional(),
  max_output_bytes: z.number().int().min(1024).max(1_048_576).default(DEFAULT_MAX_OUTPUT_BYTES),
});
export type ContextScoringProcessConfig = z.infer<typeof ContextScoringProcessConfigSchema>;

// Metadata only. No source file contents, repository paths or task configuration objects.
// The caller's summaries remain unredacted and MUST be non-sensitive engineering metadata.
const ScoringCandidateSchema = ContextCandidateSchema.pick({
  id: true, kind: true, summary: true, estimated_tokens: true,
});
export const ContextScoringProcessRequestSchema = z.strictObject({
  schema_version: z.literal("1"),
  task: ContextPruneInputSchema.pick({
    data_classification: true, task_id: true, attempt_id: true, task_summary: true,
  }),
  candidates: z.array(ScoringCandidateSchema).min(1).max(64),
});

// Identity is supplied only by the embedding application's trusted configuration.
// Do not accept a provider, model, usage, or other child-selected identity.
export const ContextScoringProcessResponseSchema = ContextScoreJudgmentSchema
  .omit({ provider: true, model: true, usage: true })
  .refine(value => value.available ? !!value.scores : !value.scores, "Inconsistent availability");

function parseUniqueJson(text: string): unknown {
  const parsed: unknown = JSON.parse(text);
  const stack: (Set<string> | null)[] = [];
  for (const match of text.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]]/g)) {
    const token = match[0];
    if (token === "{") stack.push(new Set());
    else if (token === "[") stack.push(null);
    else if (token === "}" || token === "]") stack.pop();
    else if (text.slice(match.index + token.length).trimStart().startsWith(":")) {
      const keys = stack.at(-1);
      const key: string = JSON.parse(token);
      if (keys?.has(key)) throw new Error("Duplicate response member");
      keys?.add(key);
    }
    if (stack.length > 32) throw new Error("Response depth exceeded");
  }
  return parsed;
}

function validatedScores(
  parsed: z.infer<typeof ContextScoringProcessResponseSchema>,
  candidates: ContextCandidate[],
): void {
  if (!parsed.available) return;
  const expected = new Set(candidates.map(candidate => candidate.id));
  const seen = new Set<string>();
  const scores = parsed.scores;
  if (!scores || scores.length !== expected.size || expected.size !== candidates.length) {
    throw new Error("Invalid scored candidate count");
  }
  for (const score of scores) {
    if (!expected.has(score.id) || seen.has(score.id)) throw new Error("Invalid scored candidate id");
    seen.add(score.id);
  }
}

/** Optional local scoring provider. Never retries and never inherits parent credentials. */
export class ContextScoringProcessAdapter implements ContextScoringProvider {
  private readonly config: ContextScoringProcessConfig;

  constructor(rawConfig: z.input<typeof ContextScoringProcessConfigSchema>) {
    this.config = ContextScoringProcessConfigSchema.parse(rawConfig);
    if (/\.(cmd|bat|ps1|sh)$/i.test(this.config.executable) ||
        /^(cmd|powershell|pwsh|sh|bash|dash|zsh)(\.exe)?$/i.test(basename(this.config.executable))) {
      throw new Error("Shell launchers are unsupported");
    }
    // A native executable must be absolute. For a JS bridge, always use the running Node binary.
    if (!this.config.cli_entrypoint && !isAbsolute(this.config.executable)) {
      throw new Error("Native scoring executable must be absolute");
    }
  }

  score(input: ContextPruneInput, candidates: ContextCandidate[], signal?: AbortSignal): Promise<ContextScoreJudgment> {
    return signal ? this.launch(input, candidates, signal) :
      callProviderWithTimeout(DEFAULT_PROVIDER_TIMEOUT_MS, bounded => this.launch(input, candidates, bounded));
  }

  private async launch(input: ContextPruneInput, candidates: ContextCandidate[], signal: AbortSignal): Promise<ContextScoreJudgment> {
    if (signal.aborted) throw new Error("Scoring process cancelled");
    // Re-parse at the process trust boundary; do not expose raw schema errors containing summaries.
    let wire: Buffer;
    try {
      const safeInput = ContextPruneInputSchema.parse(input);
      const optional = new Map(safeInput.candidates.filter(c => !c.mandatory).map(c => [c.id, c]));
      if (new Set(candidates.map(c => c.id)).size !== candidates.length ||
          candidates.some(candidate => {
            const expected = optional.get(candidate.id);
            return !expected || expected.kind !== candidate.kind ||
              expected.summary !== candidate.summary || expected.estimated_tokens !== candidate.estimated_tokens ||
              candidate.mandatory;
          })) throw new Error("Invalid subset");
      const request = ContextScoringProcessRequestSchema.parse({
        schema_version: "1",
        task: {
          data_classification: safeInput.data_classification,
          task_id: safeInput.task_id,
          attempt_id: safeInput.attempt_id,
          task_summary: safeInput.task_summary,
        },
        candidates: candidates.map(candidate => ({
          id: candidate.id,
          kind: candidate.kind,
          summary: candidate.summary,
          estimated_tokens: candidate.estimated_tokens,
        })),
      });
      wire = Buffer.from(`${JSON.stringify(request)}\n`, "utf8");
      if (wire.length > MAX_INPUT_BYTES) throw new Error("Input limit");
    } catch { throw new Error("Invalid or oversized context scoring request"); }
    const command = this.config.cli_entrypoint ? process.execPath : this.config.executable;
    const args = this.config.cli_entrypoint ? [this.config.cli_entrypoint, ...this.config.args] : this.config.args;

    return new Promise<ContextScoreJudgment>((resolve, reject) => {
      const child = spawn(command, args, {
        shell: false, windowsHide: true, detached: process.platform !== "win32",
        cwd: tmpdir(), env: {}, stdio: ["pipe", "pipe", "ignore"],
      });
      const chunks: Buffer[] = [];
      let bytes = 0;
      let failure = false;
      let termination: Promise<void> | undefined;
      const stop = () => {
        if (failure) return;
        failure = true;
        chunks.length = 0;
        if (!child.pid) return;
        if (process.platform === "win32") {
          const root = process.env.SystemRoot;
          const taskkill = join(root && isAbsolute(root) ? root : "C:\\Windows", "System32", "taskkill.exe");
          termination = new Promise<void>(done => {
            const killer = spawn(taskkill, ["/pid", String(child.pid), "/T", "/F"], {
              shell: false, windowsHide: true, env: {}, stdio: "ignore",
            });
            killer.once("error", () => { child.kill("SIGKILL"); done(); });
            killer.once("close", code => { if (code !== 0) child.kill("SIGKILL"); done(); });
          });
        } else {
          try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
        }
      };
      const onAbort = () => stop();
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) stop();
      child.stdout.on("data", (chunk: Buffer) => {
        if (failure) return;
        bytes += chunk.length;
        if (bytes > this.config.max_output_bytes) stop();
        else chunks.push(chunk);
      });
      child.stdin.on("error", stop);
      child.once("error", stop);
      child.once("close", async code => {
        signal.removeEventListener("abort", onAbort);
        await termination;
        try {
          if (failure || code !== 0) throw new Error("Process failure");
          const raw = parseUniqueJson(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
          const response = ContextScoringProcessResponseSchema.parse(raw);
          validatedScores(response, candidates);
          resolve(ContextScoreJudgmentSchema.parse({ ...response, provider: this.config.provider_id }));
        } catch {
          reject(new Error("Context scoring process unavailable or invalid"));
        } finally { chunks.length = 0; }
      });
      if (!failure) child.stdin.end(wire);
      else child.stdin.destroy();
    });
  }
}
