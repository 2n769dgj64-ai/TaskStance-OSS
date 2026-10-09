import { describe, expect, it } from "vitest";
import type {
  ContextCandidate,
  ContextPruneInput,
  ContextScoreJudgment,
} from "../src/context-contracts.js";
import { ContextPruner, type ContextScoringProvider } from "../src/context-pruner.js";

class FakeContextProvider implements ContextScoringProvider {
  public calls = 0;
  public lastCandidates: ContextCandidate[] = [];

  constructor(private readonly judgment: ContextScoreJudgment) {}

  async score(_input: ContextPruneInput, candidates: ContextCandidate[]): Promise<ContextScoreJudgment> {
    this.calls += 1;
    this.lastCandidates = candidates;
    return this.judgment;
  }
}

function available(scores: Array<{ id: string; relevance: number }>): ContextScoreJudgment {
  return {
    schema_version: "1",
    available: true,
    provider: "fake-decider",
    model: "fake-model-v1",
    scores,
  };
}

const baseCandidates = [
  {
    id: "src/auth.ts",
    kind: "file" as const,
    summary: "Authentication adapter",
    estimated_tokens: 1200,
    mandatory: true,
  },
  {
    id: "src/session.ts",
    kind: "file" as const,
    summary: "Session lifecycle helper",
    estimated_tokens: 900,
  },
  {
    id: "test/auth.test.ts",
    kind: "test" as const,
    summary: "Authentication regression tests",
    estimated_tokens: 800,
  },
  {
    id: "docs/auth.md",
    kind: "doc" as const,
    summary: "Authentication documentation",
    estimated_tokens: 700,
  },
];

describe("ContextPruner", () => {
  it("preserves mandatory candidates and ranks optional context within budget", async () => {
    const provider = new FakeContextProvider(
      available([
        { id: "src/session.ts", relevance: 0.92 },
        { id: "test/auth.test.ts", relevance: 0.88 },
        { id: "docs/auth.md", relevance: 0.2 },
      ]),
    );
    const pruner = new ContextPruner(provider);

    const result = await pruner.prune({
      data_classification: "engineering_non_sensitive",
      task_id: "context-test",
      attempt_id: "a1",
      task_summary: "Refactor authentication without changing behavior",
      discovery_complete: true,
      max_estimated_tokens: 3000,
      candidates: baseCandidates,
    });

    expect(provider.calls).toBe(1);
    expect(result.source).toBe("provider");
    expect(result.judgment?.provider).toBe("fake-decider");
    expect(result.selected_ids).toEqual(["src/auth.ts", "src/session.ts", "test/auth.test.ts"]);
    expect(result.selected_estimated_tokens).toBe(2900);
    expect(result.mandatory_estimated_tokens).toBe(1200);
    expect(result.budget_exceeded_by_mandatory).toBe(false);
    expect(result.requires_replan).toBe(false);
  });

  it("never calls the provider when discovery is incomplete", async () => {
    const provider = new FakeContextProvider(available([]));
    const pruner = new ContextPruner(provider);

    const result = await pruner.prune({
      data_classification: "engineering_non_sensitive",
      task_id: "context-test",
      attempt_id: "a1",
      task_summary: "Cross-module change",
      discovery_complete: false,
      max_estimated_tokens: 3000,
      candidates: baseCandidates,
    });

    expect(provider.calls).toBe(0);
    expect(result.source).toBe("fallback");
    expect(result.selected_ids).toEqual(["src/auth.ts"]);
    expect(result.reason).toBe("incomplete_discovery");
    expect(result.requires_replan).toBe(true);
  });

  it("never calls the provider when mandatory context already consumes the budget", async () => {
    const provider = new FakeContextProvider(available([]));
    const pruner = new ContextPruner(provider);

    const result = await pruner.prune({
      data_classification: "engineering_non_sensitive",
      task_id: "context-test",
      attempt_id: "a1",
      task_summary: "Small budget",
      discovery_complete: true,
      max_estimated_tokens: 1000,
      candidates: baseCandidates,
    });

    expect(provider.calls).toBe(0);
    expect(result.selected_ids).toEqual(["src/auth.ts"]);
    expect(result.budget_exceeded_by_mandatory).toBe(true);
    expect(result.requires_replan).toBe(true);
  });

  it("falls back to mandatory context when scoring is unavailable", async () => {
    const provider = new FakeContextProvider({
      schema_version: "1",
      available: false,
      unavailable_reason_code: "RATE_LIMITED",
      provider: "fake-decider",
    });
    const pruner = new ContextPruner(provider);

    const result = await pruner.prune({
      data_classification: "engineering_non_sensitive",
      task_id: "context-test",
      attempt_id: "a1",
      task_summary: "Provider unavailable",
      discovery_complete: true,
      max_estimated_tokens: 3000,
      candidates: baseCandidates,
    });

    expect(provider.calls).toBe(1);
    expect(result.source).toBe("fallback");
    expect(result.selected_ids).toEqual(["src/auth.ts"]);
    expect(result.reason).toBe("provider_unavailable_or_invalid");
    expect(result.requires_replan).toBe(true);
  });

  it("rejects incomplete or mismatched score sets conservatively", async () => {
    const provider = new FakeContextProvider(
      available([
        { id: "src/session.ts", relevance: 0.9 },
        { id: "unknown.ts", relevance: 0.9 },
        { id: "docs/auth.md", relevance: 0.9 },
      ]),
    );
    const pruner = new ContextPruner(provider);

    const result = await pruner.prune({
      data_classification: "engineering_non_sensitive",
      task_id: "context-test",
      attempt_id: "a1",
      task_summary: "Mismatched scoring output",
      discovery_complete: true,
      max_estimated_tokens: 3000,
      candidates: baseCandidates,
    });

    expect(result.source).toBe("fallback");
    expect(result.requires_replan).toBe(true);
    expect(result.selected_ids).toEqual(["src/auth.ts"]);
  });

  it("honors a stricter relevance threshold", async () => {
    const provider = new FakeContextProvider(
      available([
        { id: "src/session.ts", relevance: 0.79 },
        { id: "test/auth.test.ts", relevance: 0.95 },
        { id: "docs/auth.md", relevance: 0.9 },
      ]),
    );
    const pruner = new ContextPruner(provider);

    const result = await pruner.prune({
      data_classification: "engineering_non_sensitive",
      task_id: "context-test",
      attempt_id: "a1",
      task_summary: "Use only high relevance context",
      discovery_complete: true,
      max_estimated_tokens: 2700,
      min_relevance: 0.8,
      candidates: baseCandidates,
    });

    expect(result.selected_ids).toEqual(["src/auth.ts", "test/auth.test.ts", "docs/auth.md"]);
    expect(result.selected_estimated_tokens).toBe(2700);
  });

  it("requires replan when no candidate can fit and nothing is mandatory", async () => {
    const provider = new FakeContextProvider(available([]));
    const pruner = new ContextPruner(provider);

    const result = await pruner.prune({
      data_classification: "engineering_non_sensitive",
      task_id: "context-test",
      attempt_id: "a1",
      task_summary: "Budget cannot fit any discovered candidate",
      discovery_complete: true,
      max_estimated_tokens: 500,
      candidates: [
        {
          id: "src/large.ts",
          kind: "file",
          summary: "Large implementation file",
          estimated_tokens: 1200,
        },
      ],
    });

    expect(provider.calls).toBe(0);
    expect(result.source).toBe("deterministic");
    expect(result.selected_ids).toEqual([]);
    expect(result.reason).toBe("no_candidate_fits_budget");
    expect(result.requires_replan).toBe(true);
  });

  it("requires replan when scoring selects nothing and there is no mandatory context", async () => {
    const provider = new FakeContextProvider(available([{ id: "src/optional.ts", relevance: 0.1 }]));
    const pruner = new ContextPruner(provider);

    const result = await pruner.prune({
      data_classification: "engineering_non_sensitive",
      task_id: "context-test",
      attempt_id: "a1",
      task_summary: "No candidate reaches threshold",
      discovery_complete: true,
      max_estimated_tokens: 2000,
      candidates: [
        {
          id: "src/optional.ts",
          kind: "file",
          summary: "Possibly unrelated file",
          estimated_tokens: 800,
        },
      ],
    });

    expect(provider.calls).toBe(1);
    expect(result.source).toBe("provider");
    expect(result.selected_ids).toEqual([]);
    expect(result.reason).toBe("no_relevant_optional_candidates");
    expect(result.requires_replan).toBe(true);
  });

  it("fails closed on duplicate candidate ids", async () => {
    const provider = new FakeContextProvider(available([]));
    const pruner = new ContextPruner(provider);

    await expect(
      pruner.prune({
        data_classification: "engineering_non_sensitive",
        task_id: "context-test",
        attempt_id: "a1",
        task_summary: "Duplicate candidate ids",
        discovery_complete: true,
        max_estimated_tokens: 3000,
        candidates: [baseCandidates[0]!, { ...baseCandidates[0]!, mandatory: false }],
      }),
    ).rejects.toThrow("Duplicate context candidate id: src/auth.ts");

    expect(provider.calls).toBe(0);
  });
});
