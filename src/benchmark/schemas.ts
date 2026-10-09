import { z } from "zod";
import { DecisionProfileSchema, ExecutionDecisionSchema, TaskInputSchema } from "../contracts.js";

const id = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/);
const count = z.number().int().nonnegative();
const path = z.string().min(1).max(240).regex(/^[A-Za-z0-9_.*/-]+$/)
  .refine(p => !p.startsWith("/") && !p.split("/").some(s => s === ".." || s === ".git" || s.startsWith(".env")));
const file = path.refine(p => !p.includes("*"));
const changedPath = z.string().min(1).max(4096).regex(/^[^\p{Cc}]+$/u)
  .refine(p => !p.startsWith("/") && !p.includes("\\") && !p.split("/").includes(".."));
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const upstream = z.string().regex(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
  .refine(p => !p.toLowerCase().endsWith(".git") && p.toLowerCase() !== "https://github.com/2n769dgj64-ai/taskstance-oss");
const configuration = z.strictObject({ adapter: z.literal("codex"), config: file });
export const VerificationSchema = z.strictObject({
  id, executable: z.string().min(1).max(240).refine(s => !/[\r\n\0]/.test(s) && !/\.(cmd|bat|ps1)$/i.test(s)),
  args: z.array(z.string().max(2000).refine(s => !s.includes("\0"))).max(64),
  timeout_ms: z.number().int().min(100).max(3_600_000),
});
export const BenchmarkManifestSchema = z.strictObject({
  schema_version: z.literal("1"), benchmark_id: id, upstream_repository: upstream,
  baseline_commit: z.string().regex(/^[a-f0-9]{40}$/), task: TaskInputSchema,
  initial_context_paths: z.array(file).min(1).max(64).refine(p => new Set(p).size === p.length),
  taskstance_config: file, executor: configuration,
  judgment: z.strictObject({ adapter: z.literal("process"), config: file }).optional(),
  verification: z.array(VerificationSchema).min(1).max(16).refine(v => new Set(v.map(c => c.id)).size === v.length),
  allowed_changed_paths: z.array(path).min(1).max(64),
  timeout_ms: z.number().int().min(100).max(3_600_000),
  notes: z.array(z.string().min(1).max(1000)).max(16).optional(),
});
export type BenchmarkManifest = z.infer<typeof BenchmarkManifestSchema>;
export const BenchmarkCatalogSchema = z.strictObject({ schema_version: z.literal("1"), tasks: z.array(BenchmarkManifestSchema) });
export const ExecutorResultSchema = z.strictObject({
  schema_version: z.literal("1"), adapter_id: z.literal("codex-cli-v1"),
  status: z.enum(["completed", "failed", "cancelled", "timed_out"]),
  reason: z.enum(["turn_completed", "turn_failed", "process_error", "invalid_output", "output_limit", "cancelled", "timeout"]),
  exit_code: z.number().int().nullable(), model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/),
  reasoning_effort: z.enum(["low", "medium", "high"]), event_count: count,
  usage: z.strictObject({ input_tokens: count, output_tokens: count }).optional(),
}).superRefine((r, ctx) => {
  if (r.status === "completed" && (r.reason !== "turn_completed" || r.exit_code !== 0))
    ctx.addIssue({ code: "custom", message: "Inconsistent completion" });
});
export const RunMeasurementsSchema = z.strictObject({
  schema_version: z.literal("1"), decision_source: ExecutionDecisionSchema.shape.source,
  profile: DecisionProfileSchema, judgment_calls: count,
  initial_context_files: count, initial_context_estimated_tokens: count,
  mandatory_context_retained: z.boolean(), requires_replan: z.boolean(),
  executor: ExecutorResultSchema,
});
export const FailureCodeSchema = z.enum(["workspace_refused", "baseline_mismatch", "dirty_workspace", "configuration_invalid",
  "execution_failed", "result_invalid", "verification_failed", "scope_violation", "repository_mutated", "harness_failed"]);
const evidence = z.strictObject({ algorithm: z.literal("taskstance-change-evidence-v1"), artifact_count: count, sha256: digest });
const baseConfiguration = {
  executor_adapter: id, executor_config_ref: file, taskstance_config_ref: file,
  judgment_config_ref: file.nullable(), model: ExecutorResultSchema.shape.model.nullable(),
  reasoning_effort: ExecutorResultSchema.shape.reasoning_effort.nullable(),
  manifest_sha256: digest, taskstance_config_sha256: digest.nullable(), executor_config_sha256: digest.nullable(),
  judgment_config_sha256: digest.nullable(),
};
const baseResult = {
  benchmark_id: id, mode: z.enum(["taskstance", "comparison"]),
  upstream_repository: upstream, baseline_commit: BenchmarkManifestSchema.shape.baseline_commit,
  source_kind: z.enum(["local_fixture", "public_upstream"]),
  environment: z.strictObject({ platform: z.enum(["aix", "android", "darwin", "freebsd", "haiku", "linux", "openbsd", "sunos", "win32", "cygwin", "netbsd"]),
    node_version: z.string().regex(/^v\d+\.\d+\.\d+$/) }),
  measurements: RunMeasurementsSchema.nullable(),
  escalation_status: z.enum(["not_observed", "requires_replan", "unknown"]),
  duration_ms: count,
  verification: z.array(z.strictObject({ id, status: z.enum(["passed", "failed", "not_run"]),
    exit_code: z.number().int().nullable(), duration_ms: count.nullable() })).max(16),
  changed_paths: z.array(changedPath),
  scope_conformant: z.boolean().nullable(),
  failures: z.array(FailureCodeSchema), outcome: z.enum(["passed", "failed"]),
};
/** Legacy Phase 2.4b records (Pilot A/B): no canonical hashes and no change evidence; never reconstructed. */
const BenchmarkResultV1Shape = z.strictObject({
  schema_version: z.literal("1"), ...baseResult, configuration: z.strictObject(baseConfiguration),
});
/**
 * Phase 2.4c records: hardened provenance keys are structurally required. Values may be null only on failed runs
 * (execution stopped before the evidence existed); a passed record must carry every one of them.
 */
const BenchmarkResultV2Shape = z.strictObject({
  schema_version: z.literal("2"), ...baseResult,
  configuration: z.strictObject({ ...baseConfiguration, taskstance_config_canonical_sha256: digest.nullable(),
    executor_config_canonical_sha256: digest.nullable(), judgment_config_canonical_sha256: digest.nullable() }),
  change_evidence: evidence.nullable(),
});
type Common = z.infer<typeof BenchmarkResultV1Shape> | z.infer<typeof BenchmarkResultV2Shape>;
function checkTaskStanceResult(r: Common, ctx: z.RefinementCtx) {
  if (r.outcome === "passed" && (r.failures.length || !r.scope_conformant || !r.measurements ||
      r.measurements.executor.status !== "completed" || r.measurements.requires_replan || !r.measurements.mandatory_context_retained ||
      r.measurements.initial_context_files === 0 || r.measurements.initial_context_estimated_tokens === 0 ||
      r.verification.length === 0 || r.verification.some(v => v.status !== "passed" || v.exit_code !== 0)))
    ctx.addIssue({ code: "custom", message: "Pass requires complete successful evidence" });
  if (r.outcome === "failed" && !r.failures.length) ctx.addIssue({ code: "custom", message: "Failure needs a code" });
  if (r.measurements && (r.configuration.model !== r.measurements.executor.model ||
      r.configuration.reasoning_effort !== r.measurements.executor.reasoning_effort))
    ctx.addIssue({ code: "custom", message: "Configuration must match executor evidence" });
  if (r.schema_version !== "2") return;
  const c = r.configuration;
  if (r.change_evidence && r.change_evidence.artifact_count !== r.changed_paths.length)
    ctx.addIssue({ code: "custom", message: "Change evidence must cover every changed path" });
  if (c.judgment_config_ref === null && (c.judgment_config_sha256 !== null || c.judgment_config_canonical_sha256 !== null))
    ctx.addIssue({ code: "custom", message: "Judgment hashes require a judgment config reference" });
  if (r.outcome !== "passed") return;
  const required = [c.taskstance_config_sha256, c.executor_config_sha256, c.taskstance_config_canonical_sha256,
    c.executor_config_canonical_sha256, r.change_evidence,
    ...(c.judgment_config_ref === null ? [] : [c.judgment_config_sha256, c.judgment_config_canonical_sha256])];
  if (required.some(v => v === null)) ctx.addIssue({ code: "custom", message: "Pass requires complete hardened provenance" });
}
/**
 * Phase 2.4g direct-execution records (comparison arm). Holds only what was observed for a direct launch:
 * no decision_source, profile, judgment or initial-context fields exist here, so none can be fabricated.
 * The paired TaskStance record is referenced by identity and hashes, never copied.
 */
export const DirectMeasurementsSchema = z.strictObject({ schema_version: z.literal("1"), executor: ExecutorResultSchema });
const BenchmarkResultV3Shape = z.strictObject({
  schema_version: z.literal("3"), mode: z.literal("direct"), benchmark_id: id,
  upstream_repository: upstream, baseline_commit: BenchmarkManifestSchema.shape.baseline_commit,
  source_kind: baseResult.source_kind, environment: baseResult.environment,
  configuration: z.strictObject({ executor_adapter: id, executor_config_ref: file, manifest_sha256: digest,
    executor_config_sha256: digest.nullable(), executor_config_canonical_sha256: digest.nullable(),
    model: ExecutorResultSchema.shape.model.nullable(), reasoning_effort: ExecutorResultSchema.shape.reasoning_effort.nullable() }),
  pairing: z.strictObject({ taskstance_benchmark_id: id, taskstance_result_canonical_sha256: digest, manifest_sha256: digest,
    executor_config_canonical_sha256: digest, model: ExecutorResultSchema.shape.model,
    reasoning_effort: ExecutorResultSchema.shape.reasoning_effort }),
  measurements: DirectMeasurementsSchema.nullable(), duration_ms: count,
  verification: baseResult.verification, changed_paths: baseResult.changed_paths,
  change_evidence: evidence.nullable(), scope_conformant: z.boolean().nullable(),
  failures: z.array(FailureCodeSchema), outcome: z.enum(["passed", "failed"]),
}).superRefine((r, ctx) => {
  const c = r.configuration; const p = r.pairing; const m = r.measurements;
  if (r.outcome === "failed" && !r.failures.length) ctx.addIssue({ code: "custom", message: "Failure needs a code" });
  if (c.manifest_sha256 !== p.manifest_sha256) ctx.addIssue({ code: "custom", message: "Pairing must reference the same manifest" });
  if (m && (c.model !== m.executor.model || c.reasoning_effort !== m.executor.reasoning_effort))
    ctx.addIssue({ code: "custom", message: "Configuration must match executor evidence" });
  if (r.change_evidence && r.change_evidence.artifact_count !== r.changed_paths.length)
    ctx.addIssue({ code: "custom", message: "Change evidence must cover every changed path" });
  if (r.outcome !== "passed") return;
  if (r.failures.length || !r.scope_conformant || !m || m.executor.status !== "completed" ||
      m.executor.model !== p.model || m.executor.reasoning_effort !== p.reasoning_effort ||
      r.verification.length === 0 || r.verification.some(v => v.status !== "passed" || v.exit_code !== 0) ||
      !r.change_evidence || !c.executor_config_sha256 || c.executor_config_canonical_sha256 !== p.executor_config_canonical_sha256)
    ctx.addIssue({ code: "custom", message: "Pass requires complete successful evidence" });
});
export type BenchmarkResultV3 = z.infer<typeof BenchmarkResultV3Shape>;
export const BenchmarkResultSchema = z.discriminatedUnion("schema_version", [
  BenchmarkResultV1Shape.superRefine(checkTaskStanceResult), BenchmarkResultV2Shape.superRefine(checkTaskStanceResult), BenchmarkResultV3Shape]);
export type BenchmarkResult = z.infer<typeof BenchmarkResultSchema>;
export type BenchmarkResultV2 = z.infer<typeof BenchmarkResultV2Shape>;
