import { ContextPruner, type ContextScoringProvider } from "./context-pruner.js";
import { defaultPolicy } from "./default-policy.js";
import {
  defaultExecutionPresets,
  parseExecutionPresets,
  type ExecutionPresetsConfig,
} from "./execution-presets.js";
import { ProviderIdSchema } from "./contracts.js";
import { PolicyConfigSchema, type PolicyConfig } from "./policy.js";
import { parseProviderTimeoutMs } from "./provider-call.js";
import { ExecutionDecider, type JudgmentProvider } from "./execution-decider.js";

const MIN_EXECUTORS = 2;
const MAX_EXECUTORS = 16;
const MAX_EXECUTOR_DESCRIPTION_LENGTH = 240;

export interface RuntimeInfo {
  provider: string;
  configured: boolean;
  model: string | null;
  policy_version: string;
  executors: string[];
  default_executor: string;
  policy_source: "built-in" | "file";
  execution_presets_source: "built-in" | "file";
  provider_timeout_ms: number;
}

export interface RuntimeProviderBundle {
  id: string;
  configured: boolean;
  model?: string | null;
  judgmentProvider: JudgmentProvider;
  contextScoringProvider: ContextScoringProvider;
}

export interface DecisionRuntime {
  decider: ExecutionDecider;
  contextPruner: ContextPruner;
  executionPresets: ExecutionPresetsConfig;
  info: RuntimeInfo;
}

export interface DecisionRuntimeConfig {
  executors: Record<string, string | null>;
  defaultExecutor?: string;
  policy?: PolicyConfig;
  policySource?: "built-in" | "file";
  executionPresets?: ExecutionPresetsConfig;
  executionPresetsSource?: "built-in" | "file";
  providerTimeoutMs?: number;
}

export function validateExecutors(executors: Record<string, string | null>): Record<string, string | null> {
  const entries = Object.entries(executors);
  if (entries.length < MIN_EXECUTORS || entries.length > MAX_EXECUTORS) {
    throw new Error(`Executor configuration must define between ${MIN_EXECUTORS} and ${MAX_EXECUTORS} executors`);
  }

  const result: Record<string, string | null> = {};
  for (const [key, value] of entries) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(key)) throw new Error(`Invalid executor key: ${key}`);
    if (value !== null && typeof value !== "string") {
      throw new Error(`Executor description must be string or null: ${key}`);
    }
    if (typeof value === "string") {
      const description = value.trim();
      if (!description || description.length > MAX_EXECUTOR_DESCRIPTION_LENGTH) {
        throw new Error(
          `Executor description must be 1-${MAX_EXECUTOR_DESCRIPTION_LENGTH} characters when provided: ${key}`,
        );
      }
      result[key] = description;
    } else {
      result[key] = null;
    }
  }
  return result;
}

export function chooseDefaultExecutor(
  executors: Record<string, string | null>,
  requested?: string,
): string {
  const requestedExecutor = requested?.trim();
  if (requestedExecutor) {
    if (!(requestedExecutor in executors)) {
      throw new Error("Default executor must name a configured executor");
    }
    return requestedExecutor;
  }

  const keys = Object.keys(executors);
  const selected = keys.find((key) => key !== "replan") ?? keys[0];
  if (!selected) throw new Error("At least one executor must be configured");
  return selected;
}

function resolveDefaultExecutor(policy: PolicyConfig, defaultExecutor: string): PolicyConfig {
  const replace = <T extends { executor?: string | undefined }>(profile: T): T =>
    profile.executor === "default" ? { ...profile, executor: defaultExecutor } : profile;

  return PolicyConfigSchema.parse({
    ...policy,
    defaults: replace(policy.defaults),
    fallback: replace(policy.fallback),
    rules: policy.rules.map((rule) => ({
      ...rule,
      set: replace(rule.set),
    })),
  });
}

function validatePolicyExecutors(policy: PolicyConfig, executors: Record<string, string | null>): void {
  const referenced = new Set<string>([policy.defaults.executor, policy.fallback.executor]);
  for (const rule of policy.rules) {
    if (rule.set.executor) referenced.add(rule.set.executor);
  }

  const unknown = [...referenced].filter((executor) => !(executor in executors));
  if (unknown.length > 0) {
    throw new Error(`Policy references unconfigured executor(s): ${unknown.sort().join(", ")}`);
  }
}

export function createDecisionRuntime(
  providers: RuntimeProviderBundle,
  config: DecisionRuntimeConfig,
): DecisionRuntime {
  const providerId = ProviderIdSchema.parse(providers.id);
  const executors = validateExecutors(config.executors);
  const defaultExecutor = chooseDefaultExecutor(executors, config.defaultExecutor);
  const rawPolicy = config.policy ?? defaultPolicy;
  const policy = resolveDefaultExecutor(PolicyConfigSchema.parse(rawPolicy), defaultExecutor);
  validatePolicyExecutors(policy, executors);
  const executionPresets = parseExecutionPresets(config.executionPresets ?? defaultExecutionPresets);
  const providerTimeoutMs = parseProviderTimeoutMs(config.providerTimeoutMs);

  return {
    decider: new ExecutionDecider(
      policy,
      providers.judgmentProvider,
      Object.keys(executors),
      providerTimeoutMs,
    ),
    contextPruner: new ContextPruner(providers.contextScoringProvider, providerTimeoutMs),
    executionPresets,
    info: {
      provider: providerId,
      configured: providers.configured,
      model: providers.model?.trim() || null,
      policy_version: policy.version,
      executors: Object.keys(executors),
      default_executor: defaultExecutor,
      policy_source: config.policySource ?? "built-in",
      execution_presets_source: config.executionPresetsSource ?? "built-in",
      provider_timeout_ms: providerTimeoutMs,
    },
  };
}
