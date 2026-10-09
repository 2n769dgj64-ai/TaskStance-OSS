import { describe, expect, it } from "vitest";
import { DryRunExecutorAdapter, prepareWithExecutorAdapter } from "../src/executor-adapter.js";

const decision = {
  schema_version: "2" as const,
  source: "deterministic" as const,
  profile: {
    executor: "primary",
    model_tier: "cheap" as const,
    reasoning_effort: "minimal" as const,
    context_budget: "tiny" as const,
    test_depth: "none" as const,
    review_depth: "none" as const,
    parallel_safe: true,
    integration_strategy: "direct" as const,
  },
  policy_trace: ["docs-only-skip-provider"],
};

const input = {
  task: {
    data_classification: "engineering_non_sensitive" as const,
    summary: "Update documentation.",
    flags: { docs_only: true },
  },
  decision,
  resolved_context_budget: {
    schema_version: "1" as const,
    context_budget: "tiny" as const,
    max_estimated_tokens: 4000,
    max_candidates: 8,
    min_relevance: 0.5,
  },
};

describe("executor adapter boundary", () => {
  it("prepares a strict dry-run execution without invoking an executor", async () => {
    const adapter = new DryRunExecutorAdapter("primary");
    const result = await adapter.prepare(input);

    expect(result.mode).toBe("dry-run");
    expect(result.adapter_id).toBe("dry-run-primary");
    expect(result.executor).toBe("primary");
    expect(result.profile.reasoning_effort).toBe("minimal");
  });

  it("rejects a decision addressed to another executor", async () => {
    const adapter = new DryRunExecutorAdapter("secondary");
    await expect(prepareWithExecutorAdapter(adapter, input)).rejects.toThrow(
      "Executor adapter mismatch: decision selected primary, adapter handles secondary",
    );
  });
});
