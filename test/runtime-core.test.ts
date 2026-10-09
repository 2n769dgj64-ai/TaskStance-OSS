import { describe, expect, it } from "vitest";
import type { ContextCandidate, ContextPruneInput, ContextScoreJudgment } from "../src/context-contracts.js";
import type { RawJudgment, TaskInput } from "../src/contracts.js";
import { createDecisionRuntime } from "../src/runtime-core.js";

const judgmentProvider = {
  async decide(_task: TaskInput): Promise<RawJudgment> {
    return {
      schema_version: "2",
      available: true,
      provider: "fixture",
      model: "fixture-judge",
      decisions: {
        executor: { selected: "primary", confidence: 0.95 },
        model_tier: { selected: "balanced", confidence: 0.95 },
        reasoning_effort: { selected: "medium", confidence: 0.95 },
        context_budget: { selected: "small", confidence: 0.95 },
        test_depth: { selected: "targeted", confidence: 0.95 },
        review_depth: { selected: "targeted", confidence: 0.95 },
        parallel_safe: { selected: true, probability_true: 0.95 },
        integration_strategy: { selected: "direct", confidence: 0.95 },
      },
    };
  },
};

const contextScoringProvider = {
  async score(_input: ContextPruneInput, candidates: ContextCandidate[]): Promise<ContextScoreJudgment> {
    return {
      schema_version: "1",
      available: true,
      provider: "fixture",
      model: "fixture-relevance",
      scores: candidates.map((candidate) => ({ id: candidate.id, relevance: 0.9 })),
    };
  },
};

function makeRuntime() {
  return createDecisionRuntime(
    {
      id: "fixture",
      configured: true,
      model: "fixture-judge",
      judgmentProvider,
      contextScoringProvider,
    },
    {
      executors: {
        primary: "Primary executor",
        secondary: "Secondary executor",
        replan: "Stop and replan",
      },
      defaultExecutor: "primary",
    },
  );
}

describe("provider-neutral core runtime", () => {
  it("decides through an injected fixture provider", async () => {
    const runtime = makeRuntime();
    const result = await runtime.decider.decide({
      data_classification: "engineering_non_sensitive",
      task_id: "core-runtime-test",
      attempt_id: "a1",
      summary: "Verify injected provider decision.",
      flags: {},
    });

    expect(runtime.info.provider).toBe("fixture");
    expect(runtime.info.model).toBe("fixture-judge");
    expect(result.source).toBe("provider+policy");
    expect(result.judgment?.provider).toBe("fixture");
  });

  it("uses deterministic paths without calling provider-specific configuration", async () => {
    const runtime = makeRuntime();
    const result = await runtime.decider.decide({
      data_classification: "engineering_non_sensitive",
      summary: "Documentation-only change.",
      flags: { docs_only: true },
    });

    expect(result.source).toBe("deterministic");
    expect(result.profile.executor).toBe("primary");
  });

  it("fails closed when policy references an unknown executor", () => {
    expect(() =>
      createDecisionRuntime(
        {
          id: "fixture",
          configured: true,
          judgmentProvider,
          contextScoringProvider,
        },
        {
          executors: { primary: null, secondary: null },
          policy: {
            version: "1",
            defaults: {
              executor: "ghost",
              model_tier: "balanced",
              reasoning_effort: "medium",
              context_budget: "small",
              test_depth: "targeted",
              review_depth: "targeted",
              parallel_safe: true,
              integration_strategy: "direct",
            },
            fallback: {
              executor: "primary",
              model_tier: "strong",
              reasoning_effort: "high",
              context_budget: "medium",
              test_depth: "standard",
              review_depth: "full",
              parallel_safe: false,
              integration_strategy: "replan",
            },
            rules: [],
          },
        },
      ),
    ).toThrow("Policy references unconfigured executor(s): ghost");
  });
});
