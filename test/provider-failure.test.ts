import { describe, expect, it } from "vitest";
import { ContextPruner, type ContextScoringProvider } from "../src/context-pruner.js";
import type { ContextPruneRequest } from "../src/context-contracts.js";

const request: ContextPruneRequest = {
  data_classification: "engineering_non_sensitive",
  task_id: "provider-failure-test",
  attempt_id: "a1",
  task_summary: "Select bounded context.",
  discovery_complete: true,
  max_estimated_tokens: 1000,
  min_relevance: 0.5,
  candidates: [
    {
      id: "src/mandatory.ts",
      kind: "file",
      summary: "Mandatory context",
      estimated_tokens: 200,
      mandatory: true,
    },
    {
      id: "src/optional.ts",
      kind: "file",
      summary: "Optional context",
      estimated_tokens: 200,
      mandatory: false,
    },
  ],
};

describe("context provider failure handling", () => {
  it("falls back conservatively when the provider throws", async () => {
    const provider: ContextScoringProvider = {
      async score() {
        throw new Error("provider failed");
      },
    };
    const result = await new ContextPruner(provider).prune(request);

    expect(result.source).toBe("fallback");
    expect(result.reason).toBe("provider_unavailable_or_invalid");
    expect(result.requires_replan).toBe(true);
    expect(result.selected_ids).toEqual(["src/mandatory.ts"]);
    expect(result.judgment).toBeUndefined();
  });


  it("falls back conservatively when the scoring provider exceeds the configured timeout", async () => {
    const provider: ContextScoringProvider = {
      async score(_input, _candidates, signal) {
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    };
    const result = await new ContextPruner(provider, 100).prune(request);

    expect(result.source).toBe("fallback");
    expect(result.reason).toBe("provider_unavailable_or_invalid");
    expect(result.requires_replan).toBe(true);
  });

  it("falls back conservatively when the provider returns malformed data", async () => {
    const provider: ContextScoringProvider = {
      async score() {
        return {
          schema_version: "1",
          available: true,
          provider: "fixture",
          unexpected: true,
        };
      },
    };
    const result = await new ContextPruner(provider).prune(request);

    expect(result.source).toBe("fallback");
    expect(result.reason).toBe("provider_unavailable_or_invalid");
    expect(result.requires_replan).toBe(true);
    expect(result.judgment).toBeUndefined();
  });
});
