import { z } from "zod";

export const ExecutorSchema = z.string().min(1).max(64);
export const ProviderIdSchema = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/);
export const ModelTierSchema = z.enum(["cheap", "balanced", "strong", "max"]);
export const ReasoningEffortSchema = z.enum(["minimal", "low", "medium", "high"]);
export const ContextBudgetSchema = z.enum(["tiny", "small", "medium", "large"]);
export const TestDepthSchema = z.enum(["none", "targeted", "standard", "full"]);
export const ReviewDepthSchema = z.enum(["none", "targeted", "standard", "full"]);
export const IntegrationStrategySchema = z.enum(["direct", "isolated", "staged", "replan"]);

export const DecisionProfileSchema = z.strictObject({
  executor: ExecutorSchema,
  model_tier: ModelTierSchema,
  reasoning_effort: ReasoningEffortSchema,
  context_budget: ContextBudgetSchema,
  test_depth: TestDepthSchema,
  review_depth: ReviewDepthSchema,
  parallel_safe: z.boolean(),
  integration_strategy: IntegrationStrategySchema,
});
export type DecisionProfile = z.infer<typeof DecisionProfileSchema>;

export const TaskInputSchema = z.strictObject({
  data_classification: z.literal("engineering_non_sensitive"),
  task_id: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/).optional(),
  attempt_id: z.string().regex(/^[A-Za-z0-9-]{1,32}$/).optional(),
  project: z.string().min(1).max(80).optional(),
  category: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).optional(),
  summary: z.string().min(1).max(2000),
  flags: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/), z.boolean()).default({}),
});
export type TaskInput = z.infer<typeof TaskInputSchema>;

const ProbabilitiesSchema = z.record(z.string(), z.number().min(0).max(1));
export const ChoiceDecisionSchema = z.strictObject({
  selected: z.string().min(1).max(64),
  confidence: z.number().min(0).max(1),
  probabilities: ProbabilitiesSchema.optional(),
});

const UsageSchema = z.strictObject({
  input_tokens: z.number().nonnegative(),
  output_tokens: z.number().nonnegative(),
});

const ParallelDecisionSchema = z.strictObject({
  selected: z.boolean(),
  probability_true: z.number().min(0).max(1),
});

const DecisionsSchema = z.strictObject({
  executor: ChoiceDecisionSchema.optional(),
  model_tier: ChoiceDecisionSchema.optional(),
  reasoning_effort: ChoiceDecisionSchema.optional(),
  context_budget: ChoiceDecisionSchema.optional(),
  test_depth: ChoiceDecisionSchema.optional(),
  review_depth: ChoiceDecisionSchema.optional(),
  parallel_safe: ParallelDecisionSchema.optional(),
  integration_strategy: ChoiceDecisionSchema.optional(),
});

export const RawJudgmentSchema = z.strictObject({
  schema_version: z.literal("2"),
  available: z.boolean(),
  unavailable_reason_code: z.enum([
    "NETWORK_ERROR",
    "TIMEOUT",
    "AUTH_ERROR",
    "RATE_LIMITED",
    "INVALID_RESPONSE",
    "UNKNOWN",
  ]).optional(),
  provider: ProviderIdSchema,
  model: z.string().min(1).max(128).optional(),
  usage: UsageSchema.optional(),
  decisions: DecisionsSchema.optional(),
});
export type RawJudgment = z.infer<typeof RawJudgmentSchema>;

export const ExecutionDecisionSchema = z.strictObject({
  schema_version: z.literal("2"),
  source: z.enum(["deterministic", "provider+policy", "fallback"]),
  profile: DecisionProfileSchema,
  policy_trace: z.array(z.string()),
  judgment: RawJudgmentSchema.optional(),
});
export type ExecutionDecision = z.infer<typeof ExecutionDecisionSchema>;
