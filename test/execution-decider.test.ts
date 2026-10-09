import { describe, expect, it } from "vitest";
import { defaultPolicy } from "../src/default-policy.js";
import { ExecutionDecider, type JudgmentProvider } from "../src/execution-decider.js";
import type { PolicyConfig } from "../src/policy.js";
import type { RawJudgment, TaskInput } from "../src/contracts.js";

const ALLOWED_EXECUTORS = ["default", "primary", "secondary", "replan"] as const;

class FakeProvider implements JudgmentProvider {
  public calls = 0;
  constructor(private readonly judgment: unknown) {}

  async decide(_task: TaskInput): Promise<unknown> {
    this.calls += 1;
    return this.judgment;
  }
}

class ThrowingProvider implements JudgmentProvider {
  public calls = 0;

  async decide(_task: TaskInput): Promise<unknown> {
    this.calls += 1;
    throw new Error("provider failed");
  }
}

type DecisionOverrides = Partial<NonNullable<RawJudgment["decisions"]>>;

function goodJudgment(overrides: DecisionOverrides = {}): RawJudgment {
  return {
    schema_version: "2",
    available: true,
    provider: "fake-decider",
    model: "fake-model-v1",
    decisions: {
      executor: { selected: "primary", confidence: 0.92 },
      model_tier: { selected: "balanced", confidence: 0.91 },
      reasoning_effort: { selected: "medium", confidence: 0.90 },
      context_budget: { selected: "small", confidence: 0.89 },
      test_depth: { selected: "targeted", confidence: 0.88 },
      review_depth: { selected: "targeted", confidence: 0.87 },
      parallel_safe: { selected: true, probability_true: 0.84 },
      integration_strategy: { selected: "direct", confidence: 0.86 },
      ...overrides,
    },
  };
}

function billableTask(overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    data_classification: "engineering_non_sensitive",
    task_id: "decision-test",
    attempt_id: "a1",
    summary: "Bounded engineering decision test",
    flags: {},
    ...overrides,
  };
}

describe("ExecutionDecider", () => {
  it("skips the provider for deterministic docs-only work without spending identity", async () => {
    const provider = new FakeProvider(goodJudgment());
    const decider = new ExecutionDecider(defaultPolicy, provider, ALLOWED_EXECUTORS);

    const result = await decider.decide({
      data_classification: "engineering_non_sensitive",
      summary: "Correct spelling in README",
      flags: { docs_only: true },
    });

    expect(result.source).toBe("deterministic");
    expect(result.profile.model_tier).toBe("cheap");
    expect(result.profile.test_depth).toBe("none");
    expect(provider.calls).toBe(0);
  });

  it("fails closed before the provider when a provider decision lacks attempt identity", async () => {
    const provider = new FakeProvider(goodJudgment());
    const decider = new ExecutionDecider(defaultPolicy, provider, ALLOWED_EXECUTORS);

    const result = await decider.decide({
      data_classification: "engineering_non_sensitive",
      task_id: "missing-attempt",
      summary: "Refactor feature module",
      flags: {},
    });

    expect(result.source).toBe("fallback");
    expect(result.profile.executor).toBe("replan");
    expect(result.policy_trace).toContain("spending_identity_required");
    expect(provider.calls).toBe(0);
  });

  it("fails closed before the provider when a provider decision lacks task identity", async () => {
    const provider = new FakeProvider(goodJudgment());
    const decider = new ExecutionDecider(defaultPolicy, provider, ALLOWED_EXECUTORS);

    const result = await decider.decide({
      data_classification: "engineering_non_sensitive",
      attempt_id: "a1",
      summary: "Refactor feature module",
      flags: {},
    });

    expect(result.source).toBe("fallback");
    expect(result.policy_trace).toContain("spending_identity_required");
    expect(provider.calls).toBe(0);
  });

  it("falls back conservatively when the provider is unavailable", async () => {
    const provider = new FakeProvider({
      schema_version: "2",
      available: false,
      unavailable_reason_code: "RATE_LIMITED",
      provider: "fake-decider",
    });
    const decider = new ExecutionDecider(defaultPolicy, provider, ALLOWED_EXECUTORS);

    const result = await decider.decide(billableTask({ summary: "Refactor feature module" }));

    expect(result.source).toBe("fallback");
    expect(result.profile.executor).toBe("replan");
    expect(result.profile.review_depth).toBe("full");
    expect(provider.calls).toBe(1);
  });

  it("falls back conservatively when the provider throws", async () => {
    const provider = new ThrowingProvider();
    const decider = new ExecutionDecider(defaultPolicy, provider, ALLOWED_EXECUTORS);

    const result = await decider.decide(billableTask());

    expect(result.source).toBe("fallback");
    expect(result.profile.executor).toBe("replan");
    expect(result.policy_trace).toContain("provider_unavailable_or_invalid");
    expect(provider.calls).toBe(1);
  });


  it("falls back conservatively when the provider exceeds the configured timeout", async () => {
    const provider: JudgmentProvider = {
      async decide(_task: TaskInput, signal?: AbortSignal): Promise<unknown> {
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    };
    const decider = new ExecutionDecider(defaultPolicy, provider, ALLOWED_EXECUTORS, 100);

    const result = await decider.decide(billableTask());

    expect(result.source).toBe("fallback");
    expect(result.profile.executor).toBe("replan");
    expect(result.policy_trace).toContain("provider_unavailable_or_invalid");
  });

  it("falls back conservatively when the provider returns malformed data", async () => {
    const provider = new FakeProvider({
      schema_version: "2",
      available: true,
      provider: "fake-decider",
      unexpected: true,
    });
    const decider = new ExecutionDecider(defaultPolicy, provider, ALLOWED_EXECUTORS);

    const result = await decider.decide(billableTask());

    expect(result.source).toBe("fallback");
    expect(result.policy_trace).toContain("provider_unavailable_or_invalid");
    expect(result.judgment).toBeUndefined();
  });

  it("lets policy raise the floor for security-critical work", async () => {
    const provider = new FakeProvider(goodJudgment());
    const decider = new ExecutionDecider(defaultPolicy, provider, ALLOWED_EXECUTORS);

    const result = await decider.decide(
      billableTask({
        summary: "Change authentication boundary",
        flags: { security_critical: true },
      }),
    );

    expect(result.source).toBe("provider+policy");
    expect(result.judgment?.provider).toBe("fake-decider");
    expect(result.profile.reasoning_effort).toBe("high");
    expect(result.profile.test_depth).toBe("full");
    expect(result.profile.review_depth).toBe("full");
    expect(result.profile.parallel_safe).toBe(false);
    expect(result.profile.integration_strategy).toBe("staged");
    expect(provider.calls).toBe(1);
  });

  it("preserves deterministic pre-policy sets when the provider runs", async () => {
    const policy: PolicyConfig = {
      ...defaultPolicy,
      rules: [
        ...defaultPolicy.rules,
        {
          id: "pre-review-floor",
          priority: 20,
          phase: "pre",
          when: { flags_all: ["pre_review_floor"] },
          set: { review_depth: "full" },
          skip_provider: false,
        },
      ],
    };
    const provider = new FakeProvider(goodJudgment());
    const decider = new ExecutionDecider(policy, provider, ALLOWED_EXECUTORS);

    const result = await decider.decide(billableTask({ flags: { pre_review_floor: true } }));

    expect(result.source).toBe("provider+policy");
    expect(result.profile.review_depth).toBe("full");
    expect(result.policy_trace).toContain("pre-review-floor");
  });

  it("falls back when the final provider-selected executor is not configured", async () => {
    const provider = new FakeProvider(
      goodJudgment({ executor: { selected: "unconfigured", confidence: 0.95 } }),
    );
    const decider = new ExecutionDecider(defaultPolicy, provider, ALLOWED_EXECUTORS);

    const result = await decider.decide(billableTask());

    expect(result.source).toBe("fallback");
    expect(result.profile.executor).toBe("replan");
    expect(result.policy_trace).toContain("provider_executor_unconfigured");
  });

  it("replans when any choice confidence is below the policy threshold", async () => {
    const provider = new FakeProvider(
      goodJudgment({ context_budget: { selected: "medium", confidence: 0.61 } }),
    );
    const decider = new ExecutionDecider(defaultPolicy, provider, ALLOWED_EXECUTORS);

    const result = await decider.decide(
      billableTask({ summary: "Ambiguous cross-module change" }),
    );

    expect(result.profile.executor).toBe("replan");
    expect(result.profile.integration_strategy).toBe("replan");
    expect(result.policy_trace).toContain("low-confidence-replan");
    expect(provider.calls).toBe(1);
  });
});

describe("docs_only cannot bypass risk-flag safety floors", () => {
  const unavailable = { schema_version: "2", available: false, unavailable_reason_code: "UNKNOWN", provider: "fake-decider" };
  const riskFlags = [
    { docs_only: true, security_critical: true },
    { docs_only: true, destructive: true },
    { docs_only: true, security_critical: true, destructive: true },
  ];

  it("keeps the low-cost deterministic profile for docs_only alone", async () => {
    const provider = new FakeProvider(goodJudgment());
    const result = await new ExecutionDecider(defaultPolicy, provider, ALLOWED_EXECUTORS)
      .decide(billableTask({ flags: { docs_only: true } }));
    expect(result).toMatchObject({ source: "deterministic", policy_trace: ["docs-only-skip-provider"],
      profile: { model_tier: "cheap", reasoning_effort: "minimal", context_budget: "tiny", test_depth: "none",
        review_depth: "none", integration_strategy: "direct" } });
    expect(provider.calls).toBe(0);
  });

  it.each(riskFlags)("falls back to replan when the provider is unavailable: %o", async (flags) => {
    const provider = new FakeProvider(unavailable);
    const result = await new ExecutionDecider(defaultPolicy, provider, ALLOWED_EXECUTORS).decide(billableTask({ flags }));
    expect(result.source).toBe("fallback");
    expect(result.profile).toEqual(defaultPolicy.fallback);
    expect(result.policy_trace).not.toContain("docs-only-skip-provider");
    expect(provider.calls).toBe(1);
  });

  it.each(riskFlags)("falls back to replan when the provider throws: %o", async (flags) => {
    const provider = new ThrowingProvider();
    const result = await new ExecutionDecider(defaultPolicy, provider, ALLOWED_EXECUTORS).decide(billableTask({ flags }));
    expect(result).toMatchObject({ source: "fallback", profile: { executor: "replan", integration_strategy: "replan" } });
  });

  it.each(riskFlags)("requires spending identity instead of skipping deterministically: %o", async (flags) => {
    const provider = new FakeProvider(goodJudgment());
    const result = await new ExecutionDecider(defaultPolicy, provider, ALLOWED_EXECUTORS).decide({
      data_classification: "engineering_non_sensitive", summary: "Remove obsolete docs", flags,
    });
    expect(result.source).toBe("fallback");
    expect(result.profile.integration_strategy).toBe("replan");
    expect(result.policy_trace).toContain("spending_identity_required");
    expect(provider.calls).toBe(0);
  });

  it.each(riskFlags)("applies post floors over a low-safety provider suggestion: %o", async (flags) => {
    const provider = new FakeProvider(goodJudgment({
      model_tier: { selected: "cheap", confidence: 0.99 }, reasoning_effort: { selected: "minimal", confidence: 0.99 },
      test_depth: { selected: "none", confidence: 0.99 }, review_depth: { selected: "none", confidence: 0.99 },
    }));
    const result = await new ExecutionDecider(defaultPolicy, provider, ALLOWED_EXECUTORS).decide(billableTask({ flags }));
    expect(result.source).toBe("provider+policy");
    expect(result.profile).toMatchObject({ reasoning_effort: "high", test_depth: "full", review_depth: "full",
      parallel_safe: false, integration_strategy: "staged" });
    if (flags.security_critical) expect(result.profile.model_tier).toBe("strong");
  });

  it("leaves unrelated provider-path tasks unchanged", async () => {
    const provider = new FakeProvider(goodJudgment());
    const result = await new ExecutionDecider(defaultPolicy, provider, ALLOWED_EXECUTORS).decide(billableTask());
    expect(result).toMatchObject({ source: "provider+policy", policy_trace: [],
      profile: { executor: "primary", model_tier: "balanced", integration_strategy: "direct" } });
  });

  it("blocks a custom provider-skip rule when a post-only floor matches", async () => {
    const policy: PolicyConfig = {
      ...defaultPolicy,
      rules: [
        { id: "custom-skip", priority: 1, phase: "pre", when: { flags_all: ["trivial"] },
          set: { review_depth: "none", integration_strategy: "direct" }, skip_provider: true },
        { id: "custom-floor", priority: 50, phase: "post", when: { flags_all: ["risky"] },
          set: { review_depth: "full", integration_strategy: "staged" }, skip_provider: false },
      ],
    };
    const blockedProvider = new FakeProvider(unavailable);
    const blocked = await new ExecutionDecider(policy, blockedProvider, ALLOWED_EXECUTORS)
      .decide(billableTask({ flags: { trivial: true, risky: true } }));
    expect(blocked.source).toBe("fallback");
    expect(blocked.policy_trace).toEqual(["custom-skip", "provider_skip_blocked_by_post_policy", "provider_unavailable_or_invalid"]);
    expect(blockedProvider.calls).toBe(1);

    const skipProvider = new FakeProvider(goodJudgment());
    const skipped = await new ExecutionDecider(policy, skipProvider, ALLOWED_EXECUTORS)
      .decide(billableTask({ flags: { trivial: true } }));
    expect(skipped).toMatchObject({ source: "deterministic", policy_trace: ["custom-skip"] });
    expect(skipProvider.calls).toBe(0);
  });
});
