import { resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  ContextScoringProcessAdapter,
  ContextScoringProcessConfigSchema,
} from "../src/integrations/context-scoring-process.js";
import { ContextPruner } from "../src/context-pruner.js";
import type { ContextCandidate, ContextPruneInput } from "../src/context-contracts.js";

const fixture = resolve("test/fixtures/context-scoring-process.mjs");
const config = (mode = "valid") => ({
  version: "1" as const, provider_id: "synthetic-scoring", executable: "node",
  cli_entrypoint: fixture, args: [mode],
});
const candidates: ContextCandidate[] = [
  { id: "safety.ts", kind: "file", summary: "Mandatory safety context", estimated_tokens: 100, mandatory: true },
  { id: "logic.ts", kind: "file", summary: "Task-relevant code", estimated_tokens: 200, mandatory: false },
  { id: "other.ts", kind: "file", summary: "Unrelated optional code", estimated_tokens: 100, mandatory: false },
];
const input: ContextPruneInput = {
  data_classification: "engineering_non_sensitive", task_id: "synthetic-task", attempt_id: "a1",
  task_summary: "Update one synthetic TypeScript function", discovery_complete: true,
  max_estimated_tokens: 500, min_relevance: 0.5, candidates,
};
const opt = candidates.filter(candidate => !candidate.mandatory);
const adapter = (mode = "valid") => new ContextScoringProcessAdapter(config(mode));

afterEach(() => { delete process.env.TASKSTANCE_PROCESS_SECRET; });

it("scores only optional candidate metadata through one isolated process and keeps mandatory context", async () => {
  const packet = await new ContextPruner(adapter()).prune(input);
  expect(packet.source).toBe("provider");
  expect(packet.selected_ids).toEqual(["safety.ts", "logic.ts"]);
  expect(packet.requires_replan).toBe(false);
  expect(packet.judgment?.provider).toBe("synthetic-scoring");
  expect(packet.selected_estimated_tokens).toBe(300);
});

it("does not inherit a parent's secret environment variable", async () => {
  process.env.TASKSTANCE_PROCESS_SECRET = "SECRET_SENTINEL";
  const result = await adapter("env-check").score(input, opt);
  expect(result.available).toBe(true);
  expect(result.scores).toHaveLength(2);
});

it("child receives metadata-only input, not any source file contents", async () => {
  const result = await adapter("echo-content-check").score(input, opt);
  expect(result.available).toBe(true);
});

it.each(["missing", "duplicate", "unknown", "invalid-score", "spoof-provider", "malformed", "duplicate-member", "oversized", "nonzero"])(
  "rejects %s, preserving mandatory context with conservative fallback", async mode => {
    const result = await new ContextPruner(adapter(mode)).prune(input);
    expect(result.source).toBe("fallback");
    expect(result.selected_ids).toEqual(["safety.ts"]);
    expect(result.requires_replan).toBe(true);
    expect(result.reason).toBe("provider_unavailable_or_invalid");
    expect(JSON.stringify(result)).not.toContain("SECRET_SENTINEL");
  },
);

it("accepts an explicitly unavailable response but still replans", async () => {
  const result = await new ContextPruner(adapter("unavailable")).prune(input);
  expect(result.source).toBe("fallback");
  expect(result.selected_ids).toEqual(["safety.ts"]);
  expect(result.requires_replan).toBe(true);
});

it("fails without launching the process for incomplete discovery", async () => {
  const packet = await new ContextPruner(adapter()).prune({ ...input, discovery_complete: false });
  expect(packet.reason).toBe("incomplete_discovery");
  expect(packet.selected_ids).toEqual(["safety.ts"]);
});

it("rejects mandatory, unknown and duplicate direct-scoring candidate subsets", async () => {
  const scorer = adapter();
  await expect(scorer.score(input, [candidates[0]])).rejects.toThrow();
  await expect(scorer.score(input, [candidates[1], candidates[1]])).rejects.toThrow();
  await expect(scorer.score(input, [{ ...candidates[1], id: "not-a-candidate" }])).rejects.toThrow();
});

it("cancels an outstanding process and fails conservatively", async () => {
  const result = await new ContextPruner(adapter("hang"), 600).prune(input);
  expect(result.source).toBe("fallback");
  expect(result.selected_ids).toEqual(["safety.ts"]);
}, 10000);

it("rejects native shell launchers and non-absolute native executables", () => {
  expect(() => new ContextScoringProcessAdapter({version:"1",provider_id:"test",executable:"powershell.exe"})).toThrow();
  expect(() => new ContextScoringProcessAdapter({version:"1",provider_id:"test",executable:"node"})).toThrow();
  expect(() => ContextScoringProcessConfigSchema.parse({...config(),unknown:true})).toThrow();
});
