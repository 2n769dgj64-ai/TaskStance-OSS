import { z } from "zod";
import { ContextBudgetSchema } from "./contracts.js";

export const ContextBudgetPresetSchema = z.strictObject({
  max_estimated_tokens: z.number().int().min(1).max(1000000),
  max_candidates: z.number().int().min(1).max(64),
  min_relevance: z.number().min(0).max(1),
});
export type ContextBudgetPreset = z.infer<typeof ContextBudgetPresetSchema>;

export const ExecutionPresetsConfigSchema = z.strictObject({
  version: z.literal("1"),
  context_budgets: z.strictObject({
    tiny: ContextBudgetPresetSchema,
    small: ContextBudgetPresetSchema,
    medium: ContextBudgetPresetSchema,
    large: ContextBudgetPresetSchema,
  }),
});
export type ExecutionPresetsConfig = z.infer<typeof ExecutionPresetsConfigSchema>;

export const ResolvedContextBudgetSchema = z.strictObject({
  schema_version: z.literal("1"),
  context_budget: ContextBudgetSchema,
  max_estimated_tokens: z.number().int().min(1).max(1000000),
  max_candidates: z.number().int().min(1).max(64),
  min_relevance: z.number().min(0).max(1),
});
export type ResolvedContextBudget = z.infer<typeof ResolvedContextBudgetSchema>;

export const defaultExecutionPresets: ExecutionPresetsConfig = {
  version: "1",
  context_budgets: {
    tiny: { max_estimated_tokens: 4000, max_candidates: 8, min_relevance: 0.5 },
    small: { max_estimated_tokens: 12000, max_candidates: 16, min_relevance: 0.5 },
    medium: { max_estimated_tokens: 32000, max_candidates: 32, min_relevance: 0.5 },
    large: { max_estimated_tokens: 64000, max_candidates: 64, min_relevance: 0.5 },
  },
};

const ORDER = ["tiny", "small", "medium", "large"] as const;

export function parseExecutionPresets(raw: unknown): ExecutionPresetsConfig {
  const parsed = ExecutionPresetsConfigSchema.parse(raw);
  for (let index = 1; index < ORDER.length; index += 1) {
    const previousName = ORDER[index - 1]!;
    const currentName = ORDER[index]!;
    const previous = parsed.context_budgets[previousName];
    const current = parsed.context_budgets[currentName];

    if (current.max_estimated_tokens < previous.max_estimated_tokens) {
      throw new Error(`Context budget token limits must be non-decreasing: ${currentName} < ${previousName}`);
    }
    if (current.max_candidates < previous.max_candidates) {
      throw new Error(`Context budget candidate limits must be non-decreasing: ${currentName} < ${previousName}`);
    }
  }
  return parsed;
}

export function resolveContextBudget(
  rawConfig: ExecutionPresetsConfig,
  rawBudget: z.input<typeof ContextBudgetSchema>,
): ResolvedContextBudget {
  const config = parseExecutionPresets(rawConfig);
  const contextBudget = ContextBudgetSchema.parse(rawBudget);
  const preset = config.context_budgets[contextBudget];
  return ResolvedContextBudgetSchema.parse({
    schema_version: "1",
    context_budget: contextBudget,
    ...preset,
  });
}
