import {
  ContextCandidateSchema,
  ContextPruneInputSchema,
  type ContextCandidate,
} from "./context-contracts.js";
import {
  DiscoveryAssemblyInputSchema,
  DiscoveryAssemblyResultSchema,
  type DiscoveryAssemblyRequest,
  type DiscoveryAssemblyResult,
  type DiscoveryHit,
} from "./discovery-contracts.js";

const SOURCE_PRIORITY: Record<DiscoveryHit["source"], number> = {
  explicit: 100,
  changed_file: 90,
  symbol: 80,
  dependency: 70,
  test_relation: 60,
  text_search: 50,
  documentation: 40,
  history: 30,
};

interface MergedCandidate {
  candidate: ContextCandidate;
  firstIndex: number;
  summaryPriority: number;
  sourcePriority: number;
}

function assertUniqueAdapterIds(adapterIds: string[]): void {
  const seen = new Set<string>();
  for (const adapterId of adapterIds) {
    if (seen.has(adapterId)) throw new Error(`Duplicate discovery adapter_id: ${adapterId}`);
    seen.add(adapterId);
  }
}

function buildResult(args: {
  reason: DiscoveryAssemblyResult["reason"];
  discoveryComplete: boolean;
  requiresReplan: boolean;
  inputHitCount: number;
  deduplicatedCandidateCount: number;
  droppedOptionalCount: number;
  candidates: ContextCandidate[];
  batches: DiscoveryAssemblyResult["batches"];
  pruneInput?: DiscoveryAssemblyResult["prune_input"];
}): DiscoveryAssemblyResult {
  return DiscoveryAssemblyResultSchema.parse({
    schema_version: "1",
    discovery_complete: args.discoveryComplete,
    requires_replan: args.requiresReplan,
    reason: args.reason,
    input_hit_count: args.inputHitCount,
    deduplicated_candidate_count: args.deduplicatedCandidateCount,
    dropped_optional_count: args.droppedOptionalCount,
    candidates: args.candidates,
    batches: args.batches,
    ...(args.pruneInput ? { prune_input: args.pruneInput } : {}),
  });
}

export function assembleDiscovery(rawInput: DiscoveryAssemblyRequest): DiscoveryAssemblyResult {
  const input = DiscoveryAssemblyInputSchema.parse(rawInput);
  assertUniqueAdapterIds(input.batches.map((batch) => batch.adapter_id));

  const batchResults = input.batches.map((batch) => ({
    adapter_id: batch.adapter_id,
    status: batch.status,
    hit_count: batch.hits.length,
  }));
  const inputHitCount = input.batches.reduce((total, batch) => total + batch.hits.length, 0);
  const sourceIncomplete = input.batches.some((batch) => batch.status !== "complete");

  const merged = new Map<string, MergedCandidate>();
  let globalIndex = 0;
  let conflictingKind = false;

  for (const batch of input.batches) {
    for (const hit of batch.hits) {
      const priority = SOURCE_PRIORITY[hit.source];
      const existing = merged.get(hit.id);
      if (!existing) {
        merged.set(hit.id, {
          candidate: ContextCandidateSchema.parse({
            id: hit.id,
            kind: hit.kind,
            summary: hit.summary,
            estimated_tokens: hit.estimated_tokens,
            mandatory: hit.mandatory,
          }),
          firstIndex: globalIndex,
          summaryPriority: priority,
          sourcePriority: priority,
        });
      } else {
        if (existing.candidate.kind !== hit.kind) {
          conflictingKind = true;
        } else {
          const useNewSummary = priority > existing.summaryPriority;
          existing.candidate = ContextCandidateSchema.parse({
            ...existing.candidate,
            summary: useNewSummary ? hit.summary : existing.candidate.summary,
            estimated_tokens: Math.max(existing.candidate.estimated_tokens, hit.estimated_tokens),
            mandatory: existing.candidate.mandatory || hit.mandatory,
          });
          existing.summaryPriority = Math.max(existing.summaryPriority, priority);
          existing.sourcePriority = Math.max(existing.sourcePriority, priority);
        }
      }
      globalIndex += 1;
    }
  }

  if (conflictingKind) {
    return buildResult({
      reason: "conflicting_candidate_kind",
      discoveryComplete: false,
      requiresReplan: true,
      inputHitCount,
      deduplicatedCandidateCount: merged.size,
      droppedOptionalCount: 0,
      candidates: [],
      batches: batchResults,
    });
  }

  const all = [...merged.values()];
  if (all.length === 0) {
    return buildResult({
      reason: "no_candidates",
      discoveryComplete: !sourceIncomplete,
      requiresReplan: true,
      inputHitCount,
      deduplicatedCandidateCount: 0,
      droppedOptionalCount: 0,
      candidates: [],
      batches: batchResults,
    });
  }

  const mandatory = all
    .filter((entry) => entry.candidate.mandatory)
    .sort((left, right) => left.firstIndex - right.firstIndex);
  const optional = all
    .filter((entry) => !entry.candidate.mandatory)
    .sort(
      (left, right) =>
        right.sourcePriority - left.sourcePriority || left.firstIndex - right.firstIndex,
    );

  if (mandatory.length > input.max_candidates) {
    return buildResult({
      reason: "mandatory_overflow",
      discoveryComplete: false,
      requiresReplan: true,
      inputHitCount,
      deduplicatedCandidateCount: all.length,
      droppedOptionalCount: optional.length,
      candidates: [],
      batches: batchResults,
    });
  }

  const optionalCapacity = input.max_candidates - mandatory.length;
  const keptOptional = optional.slice(0, optionalCapacity);
  const droppedOptionalCount = optional.length - keptOptional.length;
  const candidates = [...mandatory, ...keptOptional].map((entry) => entry.candidate);
  const capTruncated = droppedOptionalCount > 0;
  const discoveryComplete = !sourceIncomplete && !capTruncated;

  const pruneInput = ContextPruneInputSchema.parse({
    data_classification: input.data_classification,
    task_id: input.task_id,
    attempt_id: input.attempt_id,
    task_summary: input.task_summary,
    discovery_complete: discoveryComplete,
    max_estimated_tokens: input.max_estimated_tokens,
    min_relevance: input.min_relevance,
    candidates,
  });

  return buildResult({
    reason: sourceIncomplete
      ? "source_incomplete"
      : capTruncated
        ? "candidate_cap_truncated"
        : "ready",
    discoveryComplete,
    requiresReplan: !discoveryComplete,
    inputHitCount,
    deduplicatedCandidateCount: all.length,
    droppedOptionalCount,
    candidates,
    batches: batchResults,
    pruneInput,
  });
}
