import { z } from "zod";
import {
  DecisionProfileSchema,
  type DecisionProfile,
  TaskInputSchema,
  type TaskInput,
  type RawJudgment,
} from "./contracts.js";

const PartialDecisionProfileSchema = DecisionProfileSchema.partial();

const RuleConditionSchema = z.strictObject({
  categories: z.array(z.string().min(1).max(40)).optional(),
  flags_all: z.array(z.string().min(1).max(64)).optional(),
  flags_any: z.array(z.string().min(1).max(64)).optional(),
  flags_none: z.array(z.string().min(1).max(64)).optional(),
  min_confidence_below: z.number().min(0).max(1).optional(),
});

const PolicyRuleSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/),
  priority: z.number().int().default(0),
  phase: z.enum(["pre", "post", "both"]).default("both"),
  when: RuleConditionSchema.default({}),
  set: PartialDecisionProfileSchema.default({}),
  skip_provider: z.boolean().default(false),
});

export const PolicyConfigSchema = z.strictObject({
  version: z.literal("1"),
  defaults: DecisionProfileSchema,
  fallback: DecisionProfileSchema,
  rules: z.array(PolicyRuleSchema).default([]),
});
export type PolicyConfig = z.infer<typeof PolicyConfigSchema>;

type PolicyPhase = "pre" | "post";

export interface PolicyEvaluation {
  profile: DecisionProfile;
  skipProvider: boolean;
  trace: string[];
}

function enabled(task: TaskInput, flag: string): boolean {
  return task.flags[flag] === true;
}

function minimumJudgmentConfidence(judgment?: RawJudgment): number | undefined {
  if (!judgment?.available || !judgment.decisions) return undefined;
  const confidences = [
    judgment.decisions.executor?.confidence,
    judgment.decisions.model_tier?.confidence,
    judgment.decisions.reasoning_effort?.confidence,
    judgment.decisions.context_budget?.confidence,
    judgment.decisions.test_depth?.confidence,
    judgment.decisions.review_depth?.confidence,
    judgment.decisions.integration_strategy?.confidence,
  ].filter((value): value is number => typeof value === "number");
  return confidences.length > 0 ? Math.min(...confidences) : undefined;
}

function matches(
  task: TaskInput,
  rule: z.infer<typeof PolicyRuleSchema>,
  phase: PolicyPhase,
  judgment?: RawJudgment,
): boolean {
  if (rule.phase !== "both" && rule.phase !== phase) return false;

  const { when } = rule;
  if (when.categories && (!task.category || !when.categories.includes(task.category))) return false;
  if (when.flags_all && !when.flags_all.every((flag) => enabled(task, flag))) return false;
  if (when.flags_any && !when.flags_any.some((flag) => enabled(task, flag))) return false;
  if (when.flags_none && when.flags_none.some((flag) => enabled(task, flag))) return false;

  if (typeof when.min_confidence_below === "number") {
    if (phase !== "post") return false;
    const min = minimumJudgmentConfidence(judgment);
    if (min === undefined || min >= when.min_confidence_below) return false;
  }

  return true;
}

export function evaluatePolicy(
  rawTask: TaskInput,
  rawPolicy: PolicyConfig,
  phase: PolicyPhase,
  judgment?: RawJudgment,
  baseProfile?: DecisionProfile,
): PolicyEvaluation {
  const task = TaskInputSchema.parse(rawTask);
  const policy = PolicyConfigSchema.parse(rawPolicy);
  let profile = DecisionProfileSchema.parse(baseProfile ?? policy.defaults);
  let skipProvider = false;
  const trace: string[] = [];

  const rules = [...policy.rules].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  for (const rule of rules) {
    if (!matches(task, rule, phase, judgment)) continue;
    profile = DecisionProfileSchema.parse({ ...profile, ...rule.set });
    skipProvider ||= phase === "pre" && rule.skip_provider;
    trace.push(rule.id);
  }

  return { profile, skipProvider, trace };
}
