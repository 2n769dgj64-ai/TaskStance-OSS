import { describe, expect, it } from "vitest";
import { AggregateTelemetry, parseTelemetryMode } from "../src/telemetry.js";

describe("aggregate telemetry", () => {
  it("is off by default and rejects unknown modes", () => {
    expect(parseTelemetryMode(undefined)).toBe("off");
    expect(parseTelemetryMode("aggregate")).toBe("aggregate");
    expect(() => parseTelemetryMode("verbose")).toThrow();
  });

  it("records nothing while telemetry is off", () => {
    const telemetry = new AggregateTelemetry("off");
    telemetry.recordDecision({
      schema_version: "2",
      source: "deterministic",
      profile: {
        executor: "primary",
        model_tier: "cheap",
        reasoning_effort: "minimal",
        context_budget: "tiny",
        test_depth: "none",
        review_depth: "none",
        parallel_safe: true,
        integration_strategy: "direct",
      },
      policy_trace: ["docs-only-skip-provider"],
    });

    expect(telemetry.snapshot().decisions.total).toBe(0);
  });

  it("records only aggregate decision and provider usage counters", () => {
    const telemetry = new AggregateTelemetry("aggregate");
    telemetry.recordDecision({
      schema_version: "2",
      source: "provider+policy",
      profile: {
        executor: "primary",
        model_tier: "balanced",
        reasoning_effort: "medium",
        context_budget: "small",
        test_depth: "targeted",
        review_depth: "targeted",
        parallel_safe: true,
        integration_strategy: "direct",
      },
      policy_trace: [],
      judgment: {
        schema_version: "2",
        available: true,
        provider: "fake-decider",
        model: "fake-model-v1",
        usage: { input_tokens: 123, output_tokens: 17 },
        decisions: {},
      },
    });

    const snapshot = telemetry.snapshot();
    expect(snapshot.decisions).toEqual({
      total: 1,
      by_source: { deterministic: 0, "provider+policy": 1, fallback: 0 },
      provider_attempts: 1,
      provider_available: 1,
      input_tokens: 123,
      output_tokens: 17,
    });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("task_summary");
    expect(serialized).not.toContain("selected_ids");
    expect(serialized).not.toContain("scores");
  });

  it("aggregates budget, discovery, and pruning metrics without identifiers", () => {
    const telemetry = new AggregateTelemetry("aggregate");

    telemetry.recordContextBudget({
      schema_version: "1",
      context_budget: "small",
      max_estimated_tokens: 12000,
      max_candidates: 16,
      min_relevance: 0.5,
    });

    telemetry.recordDiscovery({
      schema_version: "1",
      discovery_complete: false,
      requires_replan: true,
      reason: "candidate_cap_truncated",
      input_hit_count: 20,
      deduplicated_candidate_count: 18,
      dropped_optional_count: 2,
      candidates: [],
      batches: [],
    });

    telemetry.recordPrune({
      schema_version: "1",
      source: "provider",
      selected_ids: ["secret/path.ts"],
      selected_estimated_tokens: 2400,
      mandatory_estimated_tokens: 700,
      budget_exceeded_by_mandatory: false,
      requires_replan: false,
      reason: "selected",
      judgment: {
        schema_version: "1",
        available: true,
        provider: "fake-decider",
        model: "fake-model-v1",
        usage: { input_tokens: 80, output_tokens: 8 },
        scores: [{ id: "secret/path.ts", relevance: 0.9 }],
      },
    });

    const snapshot = telemetry.snapshot();
    expect(snapshot.context_budgets.total).toBe(1);
    expect(snapshot.context_budgets.by_tier.small).toBe(1);
    expect(snapshot.discovery).toMatchObject({
      total: 1,
      incomplete: 1,
      replans: 1,
      input_hits: 20,
      deduplicated_candidates: 18,
      dropped_optional: 2,
    });
    expect(snapshot.pruning).toMatchObject({
      total: 1,
      by_source: { deterministic: 0, provider: 1, fallback: 0 },
      replans: 0,
      provider_attempts: 1,
      provider_available: 1,
      input_tokens: 80,
      output_tokens: 8,
      selected_estimated_tokens: 2400,
      mandatory_estimated_tokens: 700,
    });

    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("secret/path.ts");
    expect(serialized).not.toContain("scores");
    expect(serialized).not.toContain("selected_ids");
  });

  it("returns a defensive snapshot copy", () => {
    const telemetry = new AggregateTelemetry("aggregate");
    const first = telemetry.snapshot();
    first.decisions.total = 999;
    expect(telemetry.snapshot().decisions.total).toBe(0);
  });
});
