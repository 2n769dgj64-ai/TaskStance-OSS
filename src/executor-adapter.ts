import { z } from "zod";
import { MinimalContextPacketSchema } from "./context-contracts.js";
import {
  ExecutionDecisionSchema,
  ExecutorSchema,
  TaskInputSchema,
} from "./contracts.js";
import { ResolvedContextBudgetSchema } from "./execution-presets.js";

export const ExecutorAdapterIdSchema = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/);

export const ExecutionPreparationSchema = z.strictObject({
  task: TaskInputSchema,
  decision: ExecutionDecisionSchema,
  resolved_context_budget: ResolvedContextBudgetSchema,
  context_packet: MinimalContextPacketSchema.optional(),
});
export type ExecutionPreparation = z.infer<typeof ExecutionPreparationSchema>;

export const DryRunExecutionPlanSchema = z.strictObject({
  schema_version: z.literal("1"),
  mode: z.literal("dry-run"),
  adapter_id: ExecutorAdapterIdSchema,
  executor: ExecutorSchema,
  decision_source: ExecutionDecisionSchema.shape.source,
  profile: ExecutionDecisionSchema.shape.profile,
  resolved_context_budget: ResolvedContextBudgetSchema,
  context_packet: MinimalContextPacketSchema.optional(),
});
export type DryRunExecutionPlan = z.infer<typeof DryRunExecutionPlanSchema>;

export interface ExecutorAdapter<TPrepared = unknown> {
  readonly id: string;
  readonly executor: string;
  prepare(input: ExecutionPreparation): Promise<TPrepared>;
}

export interface ExecutableExecutorAdapter<TPrepared, TResult> extends ExecutorAdapter<TPrepared> {
  execute(prepared: TPrepared, signal?: AbortSignal): Promise<TResult>;
}

/** Execution gates are shared by real adapters; planning remains side-effect free. */
export function assertRunnablePreparation(rawInput: ExecutionPreparation): ExecutionPreparation {
  const input = ExecutionPreparationSchema.parse(rawInput);
  const { profile } = input.decision;
  const budget = input.resolved_context_budget;
  const packet = input.context_packet;
  if (profile.executor === "replan" || profile.integration_strategy === "replan") {
    throw new Error("Execution requires replan");
  }
  if (budget.context_budget !== profile.context_budget) throw new Error("Context budget mismatch");
  if (!packet || packet.requires_replan || packet.budget_exceeded_by_mandatory ||
      packet.selected_ids.length === 0 || new Set(packet.selected_ids).size !== packet.selected_ids.length ||
      packet.selected_ids.length > budget.max_candidates ||
      packet.selected_estimated_tokens > budget.max_estimated_tokens ||
      packet.mandatory_estimated_tokens > packet.selected_estimated_tokens) {
    throw new Error("Execution requires a complete context packet within budget");
  }
  return input;
}

export async function executeWithExecutorAdapter<TPrepared, TResult>(
  adapter: ExecutableExecutorAdapter<TPrepared, TResult>,
  rawInput: ExecutionPreparation,
  signal?: AbortSignal,
): Promise<TResult> {
  if (signal?.aborted) throw new Error("Execution cancelled");
  const prepared = await prepareWithExecutorAdapter(adapter, assertRunnablePreparation(rawInput));
  return adapter.execute(prepared, signal);
}

export async function prepareWithExecutorAdapter<TPrepared>(
  adapter: ExecutorAdapter<TPrepared>,
  rawInput: ExecutionPreparation,
): Promise<TPrepared> {
  const input = ExecutionPreparationSchema.parse(rawInput);
  ExecutorAdapterIdSchema.parse(adapter.id);
  const executor = ExecutorSchema.parse(adapter.executor);
  if (input.decision.profile.executor !== executor) {
    throw new Error(
      `Executor adapter mismatch: decision selected ${input.decision.profile.executor}, adapter handles ${executor}`,
    );
  }
  return adapter.prepare(input);
}

export class DryRunExecutorAdapter implements ExecutorAdapter<DryRunExecutionPlan> {
  public readonly id: string;
  public readonly executor: string;

  constructor(executor: string, id = `dry-run-${executor}`) {
    this.executor = ExecutorSchema.parse(executor);
    this.id = ExecutorAdapterIdSchema.parse(id);
  }

  async prepare(input: ExecutionPreparation): Promise<DryRunExecutionPlan> {
    return DryRunExecutionPlanSchema.parse({
      schema_version: "1",
      mode: "dry-run",
      adapter_id: this.id,
      executor: this.executor,
      decision_source: input.decision.source,
      profile: input.decision.profile,
      resolved_context_budget: input.resolved_context_budget,
      ...(input.context_packet ? { context_packet: input.context_packet } : {}),
    });
  }
}
