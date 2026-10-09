import {
  DecisionProfileSchema,
  ExecutorSchema,
  ExecutionDecisionSchema,
  RawJudgmentSchema,
  TaskInputSchema,
  type DecisionProfile,
  type ExecutionDecision,
  type RawJudgment,
  type TaskInput,
} from "./contracts.js";
import { evaluatePolicy, PolicyConfigSchema, type PolicyConfig } from "./policy.js";
import { callProviderWithTimeout, parseProviderTimeoutMs } from "./provider-call.js";

export interface JudgmentProvider {
  decide(task: TaskInput, signal?: AbortSignal): Promise<unknown>;
}

function profileFromJudgment(judgment: RawJudgment): DecisionProfile | undefined {
  if (!judgment.available || !judgment.decisions) return undefined;
  const d = judgment.decisions;
  const candidate = {
    executor: d.executor?.selected,
    model_tier: d.model_tier?.selected,
    reasoning_effort: d.reasoning_effort?.selected,
    context_budget: d.context_budget?.selected,
    test_depth: d.test_depth?.selected,
    review_depth: d.review_depth?.selected,
    parallel_safe: d.parallel_safe?.selected,
    integration_strategy: d.integration_strategy?.selected,
  };
  const parsed = DecisionProfileSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

export class ExecutionDecider {
  private readonly allowedExecutors: ReadonlySet<string>;
  private readonly providerTimeoutMs: number;

  constructor(
    private readonly policy: PolicyConfig,
    private readonly provider: JudgmentProvider,
    allowedExecutors: Iterable<string>,
    providerTimeoutMs?: number,
  ) {
    PolicyConfigSchema.parse(policy);
    const parsedExecutors = [...allowedExecutors].map((executor) => ExecutorSchema.parse(executor));
    if (parsedExecutors.length === 0) throw new Error("At least one executor must be allowed");
    this.allowedExecutors = new Set(parsedExecutors);
    this.providerTimeoutMs = parseProviderTimeoutMs(providerTimeoutMs);
  }

  async decide(rawTask: TaskInput): Promise<ExecutionDecision> {
    const task = TaskInputSchema.parse(rawTask);
    const policy = PolicyConfigSchema.parse(this.policy);

    const pre = evaluatePolicy(task, policy, "pre");
    // The deterministic skip never evaluates post-only rules, so a matching post floor
    // (for example conflicting risk flags) cancels the skip instead of being bypassed.
    const postFloorMatched = pre.skipProvider && evaluatePolicy(
      task, { ...policy, rules: policy.rules.filter((rule) => rule.phase === "post") }, "post",
    ).trace.length > 0;
    if (pre.skipProvider && !postFloorMatched) {
      return ExecutionDecisionSchema.parse({
        schema_version: "2",
        source: "deterministic",
        profile: pre.profile,
        policy_trace: pre.trace,
      });
    }
    const preTrace = postFloorMatched ? [...pre.trace, "provider_skip_blocked_by_post_policy"] : pre.trace;

    if (!task.task_id || !task.attempt_id) {
      return ExecutionDecisionSchema.parse({
        schema_version: "2",
        source: "fallback",
        profile: policy.fallback,
        policy_trace: [...preTrace, "spending_identity_required"],
      });
    }

    let judgment: RawJudgment;
    try {
      const parsed = RawJudgmentSchema.safeParse(
        await callProviderWithTimeout(this.providerTimeoutMs, (signal) => this.provider.decide(task, signal)),
      );
      if (!parsed.success) {
        return ExecutionDecisionSchema.parse({
          schema_version: "2",
          source: "fallback",
          profile: policy.fallback,
          policy_trace: [...preTrace, "provider_unavailable_or_invalid"],
        });
      }
      judgment = parsed.data;
    } catch {
      return ExecutionDecisionSchema.parse({
        schema_version: "2",
        source: "fallback",
        profile: policy.fallback,
        policy_trace: [...preTrace, "provider_unavailable_or_invalid"],
      });
    }

    const judgedProfile = profileFromJudgment(judgment);
    if (!judgedProfile) {
      return ExecutionDecisionSchema.parse({
        schema_version: "2",
        source: "fallback",
        profile: policy.fallback,
        policy_trace: [...preTrace, "provider_unavailable_or_invalid"],
        judgment,
      });
    }

    // Re-apply deterministic pre-policy sets on top of provider output so
    // matched pre rules remain authoritative even when the provider runs.
    const providerWithPrePolicy = evaluatePolicy(task, policy, "pre", undefined, judgedProfile).profile;
    const post = evaluatePolicy(task, policy, "post", judgment, providerWithPrePolicy);

    if (!this.allowedExecutors.has(post.profile.executor)) {
      return ExecutionDecisionSchema.parse({
        schema_version: "2",
        source: "fallback",
        profile: policy.fallback,
        policy_trace: [...preTrace, ...post.trace, "provider_executor_unconfigured"],
        judgment,
      });
    }

    return ExecutionDecisionSchema.parse({
      schema_version: "2",
      source: "provider+policy",
      profile: post.profile,
      policy_trace: [...preTrace, ...post.trace],
      judgment,
    });
  }
}
