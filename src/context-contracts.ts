import { z } from "zod";
import { ProviderIdSchema } from "./contracts.js";

export const ContextCandidateIdSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[^\p{Cc}]+$/u)
  .refine((value) => value.trim() === value, "candidate id must not have leading or trailing whitespace");

export const ContextCandidateKindSchema = z.enum([
  "file",
  "symbol",
  "test",
  "doc",
  "history",
  "artifact",
]);

export const ContextCandidateSchema = z.strictObject({
  id: ContextCandidateIdSchema,
  kind: ContextCandidateKindSchema,
  summary: z.string().min(1).max(500),
  estimated_tokens: z.number().int().min(1).max(250_000),
  mandatory: z.boolean().default(false),
});
export type ContextCandidate = z.infer<typeof ContextCandidateSchema>;

export const ContextPruneInputSchema = z.strictObject({
  data_classification: z.literal("engineering_non_sensitive"),
  task_id: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  attempt_id: z.string().regex(/^[A-Za-z0-9-]{1,32}$/),
  task_summary: z.string().min(1).max(2000),
  discovery_complete: z.boolean(),
  max_estimated_tokens: z.number().int().min(1).max(1_000_000),
  min_relevance: z.number().min(0).max(1).default(0.5),
  candidates: z.array(ContextCandidateSchema).min(1).max(64),
});
export type ContextPruneRequest = z.input<typeof ContextPruneInputSchema>;
export type ContextPruneInput = z.infer<typeof ContextPruneInputSchema>;

export const ContextCandidateScoreSchema = z.strictObject({
  id: ContextCandidateIdSchema,
  relevance: z.number().min(0).max(1),
});
export type ContextCandidateScore = z.infer<typeof ContextCandidateScoreSchema>;

export const ContextScoreJudgmentSchema = z.strictObject({
  schema_version: z.literal("1"),
  available: z.boolean(),
  unavailable_reason_code: z
    .enum(["NETWORK_ERROR", "TIMEOUT", "AUTH_ERROR", "RATE_LIMITED", "INVALID_RESPONSE", "UNKNOWN"])
    .optional(),
  provider: ProviderIdSchema,
  model: z.string().min(1).max(128).optional(),
  usage: z
    .strictObject({
      input_tokens: z.number().nonnegative(),
      output_tokens: z.number().nonnegative(),
    })
    .optional(),
  scores: z.array(ContextCandidateScoreSchema).max(64).optional(),
});
export type ContextScoreJudgment = z.infer<typeof ContextScoreJudgmentSchema>;

export const MinimalContextPacketSchema = z.strictObject({
  schema_version: z.literal("1"),
  source: z.enum(["deterministic", "provider", "fallback"]),
  selected_ids: z.array(ContextCandidateIdSchema).max(64),
  selected_estimated_tokens: z.number().int().nonnegative(),
  mandatory_estimated_tokens: z.number().int().nonnegative(),
  budget_exceeded_by_mandatory: z.boolean(),
  requires_replan: z.boolean(),
  reason: z.enum([
    "selected",
    "mandatory_only",
    "no_relevant_optional_candidates",
    "no_candidate_fits_budget",
    "incomplete_discovery",
    "provider_unavailable_or_invalid",
  ]),
  judgment: ContextScoreJudgmentSchema.optional(),
});
export type MinimalContextPacket = z.infer<typeof MinimalContextPacketSchema>;
