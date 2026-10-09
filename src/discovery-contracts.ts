import { z } from "zod";
import {
  ContextCandidateIdSchema,
  ContextCandidateKindSchema,
  ContextCandidateSchema,
  ContextPruneInputSchema,
} from "./context-contracts.js";

export const DiscoverySourceSchema = z.enum([
  "explicit",
  "changed_file",
  "symbol",
  "dependency",
  "test_relation",
  "text_search",
  "documentation",
  "history",
]);

export const DiscoveryStatusSchema = z.enum(["complete", "truncated", "failed"]);

export const DiscoveryHitSchema = z.strictObject({
  id: ContextCandidateIdSchema,
  kind: ContextCandidateKindSchema,
  summary: z.string().min(1).max(500),
  estimated_tokens: z.number().int().min(1).max(250_000),
  mandatory: z.boolean().default(false),
  source: DiscoverySourceSchema,
});
export type DiscoveryHit = z.infer<typeof DiscoveryHitSchema>;

export const DiscoveryBatchSchema = z.strictObject({
  adapter_id: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  status: DiscoveryStatusSchema,
  hits: z.array(DiscoveryHitSchema).max(128),
});
export type DiscoveryBatch = z.infer<typeof DiscoveryBatchSchema>;

export const DiscoveryAssemblyInputSchema = z.strictObject({
  data_classification: z.literal("engineering_non_sensitive"),
  task_id: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  attempt_id: z.string().regex(/^[A-Za-z0-9-]{1,32}$/),
  task_summary: z.string().min(1).max(2000),
  max_estimated_tokens: z.number().int().min(1).max(1_000_000),
  min_relevance: z.number().min(0).max(1).default(0.5),
  max_candidates: z.number().int().min(1).max(64).default(64),
  batches: z.array(DiscoveryBatchSchema).min(1).max(16),
});
export type DiscoveryAssemblyRequest = z.input<typeof DiscoveryAssemblyInputSchema>;
export type DiscoveryAssemblyInput = z.infer<typeof DiscoveryAssemblyInputSchema>;

export const DiscoveryBatchResultSchema = z.strictObject({
  adapter_id: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  status: DiscoveryStatusSchema,
  hit_count: z.number().int().nonnegative(),
});

export const DiscoveryAssemblyResultSchema = z.strictObject({
  schema_version: z.literal("1"),
  discovery_complete: z.boolean(),
  requires_replan: z.boolean(),
  reason: z.enum([
    "ready",
    "source_incomplete",
    "candidate_cap_truncated",
    "mandatory_overflow",
    "conflicting_candidate_kind",
    "no_candidates",
  ]),
  input_hit_count: z.number().int().nonnegative(),
  deduplicated_candidate_count: z.number().int().nonnegative(),
  dropped_optional_count: z.number().int().nonnegative(),
  candidates: z.array(ContextCandidateSchema).max(64),
  batches: z.array(DiscoveryBatchResultSchema).max(16),
  prune_input: ContextPruneInputSchema.optional(),
});
export type DiscoveryAssemblyResult = z.infer<typeof DiscoveryAssemblyResultSchema>;
