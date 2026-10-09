import { z } from "zod";
import type { MinimalContextPacket } from "./context-contracts.js";
import type { ExecutionDecision } from "./contracts.js";
import type { DiscoveryAssemblyResult } from "./discovery-contracts.js";
import type { ResolvedContextBudget } from "./execution-presets.js";

export const TelemetryModeSchema = z.enum(["off", "aggregate"]);
export type TelemetryMode = z.infer<typeof TelemetryModeSchema>;

const DecisionSourceCountsSchema = z.strictObject({
  deterministic: z.number().int().nonnegative(),
  "provider+policy": z.number().int().nonnegative(),
  fallback: z.number().int().nonnegative(),
});

const ContextBudgetCountsSchema = z.strictObject({
  tiny: z.number().int().nonnegative(),
  small: z.number().int().nonnegative(),
  medium: z.number().int().nonnegative(),
  large: z.number().int().nonnegative(),
});

const PruneSourceCountsSchema = z.strictObject({
  deterministic: z.number().int().nonnegative(),
  provider: z.number().int().nonnegative(),
  fallback: z.number().int().nonnegative(),
});

export const TelemetrySnapshotSchema = z.strictObject({
  schema_version: z.literal("1"),
  mode: TelemetryModeSchema,
  decisions: z.strictObject({
    total: z.number().int().nonnegative(),
    by_source: DecisionSourceCountsSchema,
    provider_attempts: z.number().int().nonnegative(),
    provider_available: z.number().int().nonnegative(),
    input_tokens: z.number().nonnegative(),
    output_tokens: z.number().nonnegative(),
  }),
  context_budgets: z.strictObject({
    total: z.number().int().nonnegative(),
    by_tier: ContextBudgetCountsSchema,
  }),
  discovery: z.strictObject({
    total: z.number().int().nonnegative(),
    incomplete: z.number().int().nonnegative(),
    replans: z.number().int().nonnegative(),
    input_hits: z.number().int().nonnegative(),
    deduplicated_candidates: z.number().int().nonnegative(),
    dropped_optional: z.number().int().nonnegative(),
  }),
  pruning: z.strictObject({
    total: z.number().int().nonnegative(),
    by_source: PruneSourceCountsSchema,
    replans: z.number().int().nonnegative(),
    provider_attempts: z.number().int().nonnegative(),
    provider_available: z.number().int().nonnegative(),
    input_tokens: z.number().nonnegative(),
    output_tokens: z.number().nonnegative(),
    selected_estimated_tokens: z.number().int().nonnegative(),
    mandatory_estimated_tokens: z.number().int().nonnegative(),
  }),
});
export type TelemetrySnapshot = z.infer<typeof TelemetrySnapshotSchema>;

function emptySnapshot(mode: TelemetryMode): TelemetrySnapshot {
  return TelemetrySnapshotSchema.parse({
    schema_version: "1",
    mode,
    decisions: {
      total: 0,
      by_source: { deterministic: 0, "provider+policy": 0, fallback: 0 },
      provider_attempts: 0,
      provider_available: 0,
      input_tokens: 0,
      output_tokens: 0,
    },
    context_budgets: {
      total: 0,
      by_tier: { tiny: 0, small: 0, medium: 0, large: 0 },
    },
    discovery: {
      total: 0,
      incomplete: 0,
      replans: 0,
      input_hits: 0,
      deduplicated_candidates: 0,
      dropped_optional: 0,
    },
    pruning: {
      total: 0,
      by_source: { deterministic: 0, provider: 0, fallback: 0 },
      replans: 0,
      provider_attempts: 0,
      provider_available: 0,
      input_tokens: 0,
      output_tokens: 0,
      selected_estimated_tokens: 0,
      mandatory_estimated_tokens: 0,
    },
  });
}

export function parseTelemetryMode(raw: string | undefined): TelemetryMode {
  if (!raw?.trim()) return "off";
  return TelemetryModeSchema.parse(raw.trim());
}

export class AggregateTelemetry {
  private state: TelemetrySnapshot;

  constructor(public readonly mode: TelemetryMode = "off") {
    this.state = emptySnapshot(mode);
  }

  private enabled(): boolean {
    return this.mode === "aggregate";
  }

  recordDecision(decision: ExecutionDecision): void {
    if (!this.enabled()) return;
    this.state.decisions.total += 1;
    this.state.decisions.by_source[decision.source] += 1;
    if (decision.judgment) {
      this.state.decisions.provider_attempts += 1;
      if (decision.judgment.available) this.state.decisions.provider_available += 1;
      this.state.decisions.input_tokens += decision.judgment.usage?.input_tokens ?? 0;
      this.state.decisions.output_tokens += decision.judgment.usage?.output_tokens ?? 0;
    }
  }

  recordContextBudget(result: ResolvedContextBudget): void {
    if (!this.enabled()) return;
    this.state.context_budgets.total += 1;
    this.state.context_budgets.by_tier[result.context_budget] += 1;
  }

  recordDiscovery(result: DiscoveryAssemblyResult): void {
    if (!this.enabled()) return;
    this.state.discovery.total += 1;
    if (!result.discovery_complete) this.state.discovery.incomplete += 1;
    if (result.requires_replan) this.state.discovery.replans += 1;
    this.state.discovery.input_hits += result.input_hit_count;
    this.state.discovery.deduplicated_candidates += result.deduplicated_candidate_count;
    this.state.discovery.dropped_optional += result.dropped_optional_count;
  }

  recordPrune(result: MinimalContextPacket): void {
    if (!this.enabled()) return;
    this.state.pruning.total += 1;
    this.state.pruning.by_source[result.source] += 1;
    if (result.requires_replan) this.state.pruning.replans += 1;
    this.state.pruning.selected_estimated_tokens += result.selected_estimated_tokens;
    this.state.pruning.mandatory_estimated_tokens += result.mandatory_estimated_tokens;
    if (result.judgment) {
      this.state.pruning.provider_attempts += 1;
      if (result.judgment.available) this.state.pruning.provider_available += 1;
      this.state.pruning.input_tokens += result.judgment.usage?.input_tokens ?? 0;
      this.state.pruning.output_tokens += result.judgment.usage?.output_tokens ?? 0;
    }
  }

  snapshot(): TelemetrySnapshot {
    return TelemetrySnapshotSchema.parse(structuredClone(this.state));
  }
}
