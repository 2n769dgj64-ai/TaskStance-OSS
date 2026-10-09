import { BenchmarkResultSchema } from "./schemas.js";
import { canonicalValueSha256 } from "./provenance.js";

const cell = (v: unknown) => String(v ?? "unknown").replaceAll("|", "\\|").replaceAll("\n", " ");
const unavailable = (v: unknown) => v ? cell(v) : "unavailable";
type Parsed = ReturnType<typeof BenchmarkResultSchema.parse>;
type TaskStanceRecord = Exclude<Parsed, { schema_version: "3" }>;
type DirectRecord = Extract<Parsed, { schema_version: "3" }>;
const NA = "n/a";
/** v1 records predate hardened provenance: say so; never fabricate values. v2 fields are shown as recorded. */
function hardened(r: TaskStanceRecord): string {
  if (r.schema_version === "1") return "provenance=legacy (schema v1; canonical hashes and change evidence unavailable)";
  const c = r.configuration;
  return `provenance=hardened (schema v2); canonical JSON SHA-256: project=${unavailable(c.taskstance_config_canonical_sha256)}, executor=${unavailable(c.executor_config_canonical_sha256)}, judgment=${unavailable(c.judgment_config_canonical_sha256)}; change evidence: ${r.change_evidence ? `${r.change_evidence.algorithm} count=${r.change_evidence.artifact_count} sha256=${r.change_evidence.sha256}` : "unavailable"}`;
}
/** Stable ordering, no timestamps, prompts, task statements, or process output. */
export function generateBenchmarkReport(raw: unknown[]): string {
  const results = raw.map(r => BenchmarkResultSchema.parse(r)).sort((a, b) =>
    a.benchmark_id.localeCompare(b.benchmark_id, "en") || a.mode.localeCompare(b.mode, "en") ||
    JSON.stringify(a).localeCompare(JSON.stringify(b), "en"));
  const rows = results.map(r => {
    if (r.schema_version === "3") {
      // Direct records have no decision, profile, judgment, initial-context or escalation measurements: n/a, never zero.
      const e = r.measurements?.executor;
      return [r.benchmark_id, r.mode, r.source_kind, r.outcome, r.verification.map(v => `${v.id}:${v.status}`).join(", "),
        NA, NA, r.configuration.model, r.configuration.reasoning_effort, NA, NA, NA, NA, NA, e?.status,
        e?.usage?.input_tokens, e?.usage?.output_tokens, r.duration_ms, r.scope_conformant, r.failures.join(", ") || "none"].map(cell).join(" | ");
    }
    const m = r.measurements;
    return [r.benchmark_id, r.mode, r.source_kind, r.outcome,
      r.verification.map(v => `${v.id}:${v.status}`).join(", "), m?.decision_source,
      m ? `${m.profile.executor}/${m.profile.model_tier}/${m.profile.reasoning_effort}/${m.profile.context_budget}; tests=${m.profile.test_depth}; review=${m.profile.review_depth}; integration=${m.profile.integration_strategy}; parallel=${m.profile.parallel_safe}` : null,
      r.configuration.model, r.configuration.reasoning_effort, m?.judgment_calls,
      m?.initial_context_files, m?.initial_context_estimated_tokens, m?.mandatory_context_retained,
      r.escalation_status, m?.executor.status, m?.executor.usage?.input_tokens,
      m?.executor.usage?.output_tokens, r.duration_ms, r.scope_conformant,
      r.failures.join(", ") || "none"].map(cell).join(" | ");
  });
  return `# TaskStance benchmark evidence\n\n${results.length} result record(s); ${results.filter(r => r.outcome === "passed").length} passed; ${results.filter(r => r.outcome === "failed").length} failed.\n\n` +
    "| Task | Mode | Source | Outcome | Verification | Decision | Profile | Model | Actual reasoning | Judgment calls | Initial files | Initial estimated tokens | Mandatory retained | Escalation | Executor | Executor input tokens | Executor output tokens | Duration ms | Scope | Failures |\n" +
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n" +
    rows.map(r => `| ${r} |`).join("\n") +
    "\n\n## Provenance\n\n" + results.map(r => r.schema_version === "3" ? directProvenance(r) : `- ${cell(r.benchmark_id)} (${r.mode}): ${r.upstream_repository} @ ${r.baseline_commit}; environment=${r.environment.platform}/${r.environment.node_version}; configuration references: ${cell(r.configuration.taskstance_config_ref)}, ${cell(r.configuration.executor_config_ref)}, judgment=${cell(r.configuration.judgment_config_ref)}; SHA-256: manifest=${r.configuration.manifest_sha256}, project=${cell(r.configuration.taskstance_config_sha256)}, executor=${cell(r.configuration.executor_config_sha256)}, judgment=${cell(r.configuration.judgment_config_sha256)}; ${hardened(r)}; changed paths: ${r.changed_paths.map(cell).join(", ") || "none observed"}.`).join("\n") +
    pairedSection(results) + "\n\n## Methodology\n\nRaw configuration SHA-256 values are exact-byte provenance; canonical JSON SHA-256 values (sorted object keys, ordered arrays, no insignificant whitespace) compare configuration meaning across formatting differences only. Change evidence is a content-free SHA-256 over each changed path, its Git change state and the SHA-256 of its final bytes (or an explicit deleted marker). Schema-v1 records (Phase 2.4b pilots) are legacy: they predate these fields, are reported as legacy provenance and are never reconstructed. Schema-v2 records require the fields on every passed result; null appears only on failed runs that stopped before the evidence existed. `taskstance-change-evidence-v1` does not distinguish mode-only changes. Every input record is strictly validated; failed tasks remain visible. Duration is monotonic wall-clock time from harness entry through cleanup, including setup and verification. Verification runs sequentially with argument arrays; only exit status and duration are retained. All declared local context files are mandatory. Judgment calls count observed configured provider invocations, including unsuccessful attempts, not internal retries or hosted billing calls.\n\n" +
    "## Limitations\n\nInitial selected context estimates are not total executor token usage. Executor tokens are reported only when observed; unknown values are not zero. No token or cost savings metric is calculated. Local fixtures provide harness evidence, not real OSS/model performance evidence. " + comparisonSentence(results) + " Compare baseline, task, declared inputs, verification, configuration contents, executor/model/reasoning and environment before drawing conclusions; matching configuration references alone do not establish fairness. Replan or escalation before a valid CLI result is unknown. Configurations and commands require review; the harness is not a security sandbox. Path conformance does not establish semantic correctness.\n" + directNotes(results);
}

const directProvenance = (r: DirectRecord) => `- ${cell(r.benchmark_id)} (${r.mode}): ${r.upstream_repository} @ ${r.baseline_commit}; environment=${r.environment.platform}/${r.environment.node_version}; provenance=direct (schema v3); executor configuration reference: ${cell(r.configuration.executor_config_ref)}; SHA-256: manifest=${r.configuration.manifest_sha256}, executor=${cell(r.configuration.executor_config_sha256)}; canonical executor=${unavailable(r.configuration.executor_config_canonical_sha256)}; change evidence: ${r.change_evidence ? `${r.change_evidence.algorithm} count=${r.change_evidence.artifact_count} sha256=${r.change_evidence.sha256}` : "unavailable"}; paired with: ${cell(r.pairing.taskstance_benchmark_id)} taskstance result canonical SHA-256 ${r.pairing.taskstance_result_canonical_sha256}, pinned model=${cell(r.pairing.model)}, pinned reasoning=${r.pairing.reasoning_effort}; changed paths: ${r.changed_paths.map(cell).join(", ") || "none observed"}.`;
const evidenceCell = (r: { change_evidence: { artifact_count: number; sha256: string } | null }) =>
  r.change_evidence ? `count=${r.change_evidence.artifact_count} sha256=${r.change_evidence.sha256}` : "unavailable";
/** Side-by-side observations only. Nothing is subtracted, divided or converted to cost or savings. */
function pairedSection(results: Parsed[]): string {
  const directs = results.filter((r): r is DirectRecord => r.schema_version === "3");
  if (!directs.length) return "";
  const out = ["\n\n## Paired comparison (descriptive observations; no savings or cost is calculated)\n"];
  for (const d of directs) {
    const t = results.find((r): r is TaskStanceRecord => r.schema_version !== "3" && r.mode === "taskstance" &&
      r.benchmark_id === d.benchmark_id && canonicalValueSha256(r) === d.pairing.taskstance_result_canonical_sha256);
    const ts = (f: (r: TaskStanceRecord) => unknown) => t ? cell(f(t)) : "paired record not supplied";
    const de = d.measurements?.executor; const te = t?.measurements?.executor;
    out.push(`### ${cell(d.benchmark_id)}\n`, "| Observation | TaskStance | Direct |", "|---|---|---|",
      `| Outcome | ${ts(r => r.outcome)} | ${cell(d.outcome)} |`,
      `| Failures | ${ts(r => r.failures.join(", ") || "none")} | ${cell(d.failures.join(", ") || "none")} |`,
      `| Verification | ${ts(r => r.verification.map(v => `${v.id}:${v.status}`).join(", "))} | ${cell(d.verification.map(v => `${v.id}:${v.status}`).join(", "))} |`,
      `| Scope conformant | ${ts(r => r.scope_conformant)} | ${cell(d.scope_conformant)} |`,
      `| Changed paths | ${ts(r => r.changed_paths.join(", ") || "none observed")} | ${cell(d.changed_paths.join(", ") || "none observed")} |`,
      `| Change evidence (fingerprint; byte-identical output is not expected) | ${ts(r => r.schema_version === "2" ? evidenceCell(r) : "unavailable")} | ${cell(evidenceCell(d))} |`,
      `| Duration ms (wall clock; TaskStance includes judgment time) | ${ts(r => r.duration_ms)} | ${cell(d.duration_ms)} |`,
      `| Executor status / reason | ${ts(() => te ? `${te.status} / ${te.reason}` : undefined)} | ${cell(de ? `${de.status} / ${de.reason}` : undefined)} |`,
      `| Executor event count | ${ts(() => te?.event_count)} | ${cell(de?.event_count)} |`,
      `| Model | ${ts(r => r.configuration.model)} | ${cell(d.configuration.model)} |`,
      `| Actual reasoning | ${ts(r => r.configuration.reasoning_effort)} | ${cell(d.configuration.reasoning_effort)} |`,
      `| Executor input tokens (reported by executor; unknown is not zero) | ${ts(() => te?.usage?.input_tokens)} | ${cell(de?.usage?.input_tokens)} |`,
      `| Executor output tokens (reported by executor; unknown is not zero) | ${ts(() => te?.usage?.output_tokens)} | ${cell(de?.usage?.output_tokens)} |`,
      `| Decision source (TaskStance only) | ${ts(r => r.measurements?.decision_source)} | ${NA} |`,
      `| Initial context files (TaskStance only) | ${ts(r => r.measurements?.initial_context_files)} | ${NA} |`,
      `| Initial context estimated tokens (estimate of selected file content only; not executor usage) | ${ts(r => r.measurements?.initial_context_estimated_tokens)} | ${NA} |`,
      `| Judgment calls (invocations only; judgment tokens and cost not observed) | ${ts(r => r.measurements?.judgment_calls)} | ${NA} |`, "");
  }
  return out.join("\n").trimEnd();
}
function comparisonSentence(results: Parsed[]): string {
  return results.some(r => r.schema_version === "3")
    ? "Direct execution is supported through schema-v3 records, so TaskStance and direct results can be compared side by side; comparisons are descriptive only and do not establish savings, causal effects or superiority."
    : "Comparison records are representable but this harness only runs TaskStance.";
}

function directNotes(results: Parsed[]): string {
  if (!results.some(r => r.schema_version === "3")) return "";
  return "\n## Direct-mode notes\n\nSchema-v3 direct records hold only observed executor, verification, scope and change-evidence data; decision, profile, judgment and initial-context fields do not exist for them and are shown as n/a, never zero. A direct record pins model and reasoning effort to its paired TaskStance record. Initial-context estimates describe selected file content only and are a different quantity from executor-reported token usage; neither is subtracted from, divided by or plotted against the other. TaskStance judgment tokens and cost are not observed. A single pair is an anecdote: no cost, savings or quality conclusion follows from it.\n";
}
