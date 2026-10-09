import {
  ContextPruneInputSchema,
  ContextScoreJudgmentSchema,
  MinimalContextPacketSchema,
  type ContextCandidate,
  type ContextPruneInput,
  type ContextPruneRequest,
  type ContextScoreJudgment,
  type MinimalContextPacket,
} from "./context-contracts.js";
import { callProviderWithTimeout, parseProviderTimeoutMs } from "./provider-call.js";

export interface ContextScoringProvider {
  score(input: ContextPruneInput, candidates: ContextCandidate[], signal?: AbortSignal): Promise<unknown>;
}

function sumTokens(candidates: ContextCandidate[]): number {
  return candidates.reduce((total, candidate) => total + candidate.estimated_tokens, 0);
}

function assertUniqueCandidateIds(candidates: ContextCandidate[]): void {
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.id)) throw new Error(`Duplicate context candidate id: ${candidate.id}`);
    seen.add(candidate.id);
  }
}

function validateScores(
  judgment: ContextScoreJudgment,
  expectedCandidates: ContextCandidate[],
): Map<string, number> | undefined {
  if (!judgment.available || !judgment.scores) return undefined;
  if (judgment.scores.length !== expectedCandidates.length) return undefined;

  const expected = new Set(expectedCandidates.map((candidate) => candidate.id));
  const scores = new Map<string, number>();
  for (const score of judgment.scores) {
    if (!expected.has(score.id) || scores.has(score.id)) return undefined;
    scores.set(score.id, score.relevance);
  }
  if (scores.size !== expected.size) return undefined;
  return scores;
}

function makePacket(args: {
  source: MinimalContextPacket["source"];
  selected: ContextCandidate[];
  mandatory: ContextCandidate[];
  maxEstimatedTokens: number;
  requiresReplan: boolean;
  reason: MinimalContextPacket["reason"];
  judgment?: ContextScoreJudgment;
}): MinimalContextPacket {
  const mandatoryTokens = sumTokens(args.mandatory);
  return MinimalContextPacketSchema.parse({
    schema_version: "1",
    source: args.source,
    selected_ids: args.selected.map((candidate) => candidate.id),
    selected_estimated_tokens: sumTokens(args.selected),
    mandatory_estimated_tokens: mandatoryTokens,
    budget_exceeded_by_mandatory: mandatoryTokens > args.maxEstimatedTokens,
    requires_replan: args.requiresReplan,
    reason: args.reason,
    ...(args.judgment ? { judgment: args.judgment } : {}),
  });
}

export class ContextPruner {
  private readonly providerTimeoutMs: number;

  constructor(
    private readonly provider: ContextScoringProvider,
    providerTimeoutMs?: number,
  ) {
    this.providerTimeoutMs = parseProviderTimeoutMs(providerTimeoutMs);
  }

  async prune(rawInput: ContextPruneRequest): Promise<MinimalContextPacket> {
    const input = ContextPruneInputSchema.parse(rawInput);
    assertUniqueCandidateIds(input.candidates);

    const mandatory = input.candidates.filter((candidate) => candidate.mandatory);
    const optional = input.candidates.filter((candidate) => !candidate.mandatory);
    const mandatoryTokens = sumTokens(mandatory);

    if (!input.discovery_complete) {
      return makePacket({
        source: "fallback",
        selected: mandatory,
        mandatory,
        maxEstimatedTokens: input.max_estimated_tokens,
        requiresReplan: true,
        reason: "incomplete_discovery",
      });
    }

    if (optional.length === 0 || mandatoryTokens >= input.max_estimated_tokens) {
      return makePacket({
        source: "deterministic",
        selected: mandatory,
        mandatory,
        maxEstimatedTokens: input.max_estimated_tokens,
        requiresReplan: mandatoryTokens > input.max_estimated_tokens || mandatory.length === 0,
        reason: "mandatory_only",
      });
    }

    const remainingBudget = input.max_estimated_tokens - mandatoryTokens;
    const scoreable = optional.filter((candidate) => candidate.estimated_tokens <= remainingBudget);
    if (scoreable.length === 0) {
      return makePacket({
        source: "deterministic",
        selected: mandatory,
        mandatory,
        maxEstimatedTokens: input.max_estimated_tokens,
        requiresReplan: mandatory.length === 0,
        reason: mandatory.length === 0 ? "no_candidate_fits_budget" : "mandatory_only",
      });
    }

    let judgment: ContextScoreJudgment;
    try {
      const parsed = ContextScoreJudgmentSchema.safeParse(
        await callProviderWithTimeout(this.providerTimeoutMs, (signal) =>
          this.provider.score(input, scoreable, signal),
        ),
      );
      if (!parsed.success) {
        return makePacket({
          source: "fallback",
          selected: mandatory,
          mandatory,
          maxEstimatedTokens: input.max_estimated_tokens,
          requiresReplan: true,
          reason: "provider_unavailable_or_invalid",
        });
      }
      judgment = parsed.data;
    } catch {
      return makePacket({
        source: "fallback",
        selected: mandatory,
        mandatory,
        maxEstimatedTokens: input.max_estimated_tokens,
        requiresReplan: true,
        reason: "provider_unavailable_or_invalid",
      });
    }

    const scores = validateScores(judgment, scoreable);
    if (!scores) {
      return makePacket({
        source: "fallback",
        selected: mandatory,
        mandatory,
        maxEstimatedTokens: input.max_estimated_tokens,
        requiresReplan: true,
        reason: "provider_unavailable_or_invalid",
        judgment,
      });
    }

    const originalOrder = new Map(input.candidates.map((candidate, index) => [candidate.id, index]));
    const ranked = scoreable
      .filter((candidate) => (scores.get(candidate.id) ?? 0) >= input.min_relevance)
      .sort((left, right) => {
        const scoreDelta = (scores.get(right.id) ?? 0) - (scores.get(left.id) ?? 0);
        if (scoreDelta !== 0) return scoreDelta;
        return (originalOrder.get(left.id) ?? 0) - (originalOrder.get(right.id) ?? 0);
      });

    const selected = [...mandatory];
    let usedTokens = mandatoryTokens;
    for (const candidate of ranked) {
      if (usedTokens + candidate.estimated_tokens > input.max_estimated_tokens) continue;
      selected.push(candidate);
      usedTokens += candidate.estimated_tokens;
    }

    const selectedOptionalCount = selected.length - mandatory.length;
    return makePacket({
      source: "provider",
      selected,
      mandatory,
      maxEstimatedTokens: input.max_estimated_tokens,
      requiresReplan: selected.length === 0,
      reason: selectedOptionalCount > 0 ? "selected" : "no_relevant_optional_candidates",
      judgment,
    });
  }
}
