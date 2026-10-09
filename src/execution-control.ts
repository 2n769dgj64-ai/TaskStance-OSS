import { MinimalContextPacketSchema, type MinimalContextPacket } from "./context-contracts.js";
import { TaskInputSchema, type TaskInput } from "./contracts.js";
import {
  DryRunExecutionPlanSchema,
  DryRunExecutorAdapter,
  ExecutionPreparationSchema,
  prepareWithExecutorAdapter,
  type DryRunExecutionPlan,
  type ExecutionPreparation,
} from "./executor-adapter.js";
import { resolveContextBudget } from "./execution-presets.js";
import type { DecisionRuntime } from "./runtime-core.js";

export interface BuildExecutionPreparationOptions {
  contextPacket?: MinimalContextPacket;
}

export async function buildExecutionPreparation(
  runtime: DecisionRuntime,
  rawTask: TaskInput,
  options: BuildExecutionPreparationOptions = {},
): Promise<ExecutionPreparation> {
  const task = TaskInputSchema.parse(rawTask);
  const decision = await runtime.decider.decide(task);
  const resolvedContextBudget = resolveContextBudget(
    runtime.executionPresets,
    decision.profile.context_budget,
  );
  const contextPacket = options.contextPacket
    ? MinimalContextPacketSchema.parse(options.contextPacket)
    : undefined;

  return ExecutionPreparationSchema.parse({
    task,
    decision,
    resolved_context_budget: resolvedContextBudget,
    ...(contextPacket ? { context_packet: contextPacket } : {}),
  });
}

export async function prepareTaskExecution(
  runtime: DecisionRuntime,
  rawTask: TaskInput,
  options: BuildExecutionPreparationOptions = {},
): Promise<DryRunExecutionPlan> {
  const preparation = await buildExecutionPreparation(runtime, rawTask, options);
  const result = await prepareWithExecutorAdapter(
    new DryRunExecutorAdapter(preparation.decision.profile.executor),
    preparation,
  );
  return DryRunExecutionPlanSchema.parse(result);
}
