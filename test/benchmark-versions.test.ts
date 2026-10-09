import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BenchmarkResultSchema } from "../src/benchmark/schemas.js";
import { generateBenchmarkReport } from "../src/benchmark/report.js";

const names = ["clsx-pr82-readme-bench-links", "yoctocolors-pr26-bold-dim"];
const hash = (c: string) => c.repeat(64);
// Minimal valid schema-v2 PASS (no judgment configured); tests mutate copies of it.
const v2 = (): any => ({
  schema_version: "2", benchmark_id: "synthetic", mode: "taskstance", upstream_repository: "https://github.com/example/fixture",
  baseline_commit: "a".repeat(40), source_kind: "local_fixture", environment: { platform: "linux", node_version: "v22.0.0" },
  configuration: { executor_adapter: "codex", executor_config_ref: "adapter.json", taskstance_config_ref: "project.json",
    judgment_config_ref: null, model: "m", reasoning_effort: "low", manifest_sha256: hash("1"),
    taskstance_config_sha256: hash("2"), executor_config_sha256: hash("3"), judgment_config_sha256: null,
    taskstance_config_canonical_sha256: hash("4"), executor_config_canonical_sha256: hash("5"), judgment_config_canonical_sha256: null },
  measurements: { schema_version: "1", decision_source: "deterministic", judgment_calls: 0, initial_context_files: 1,
    initial_context_estimated_tokens: 5, mandatory_context_retained: true, requires_replan: false,
    profile: { executor: "primary", model_tier: "cheap", reasoning_effort: "minimal", context_budget: "tiny", test_depth: "none",
      review_depth: "none", parallel_safe: true, integration_strategy: "direct" },
    executor: { schema_version: "1", adapter_id: "codex-cli-v1", status: "completed", reason: "turn_completed", exit_code: 0,
      model: "m", reasoning_effort: "low", event_count: 1 } },
  escalation_status: "not_observed", duration_ms: 1,
  verification: [{ id: "v", status: "passed", exit_code: 0, duration_ms: 1 }],
  changed_paths: ["README.md"], change_evidence: { algorithm: "taskstance-change-evidence-v1", artifact_count: 1, sha256: hash("6") },
  scope_conformant: true, failures: [], outcome: "passed",
});
const withConfig = (r: any, patch: Record<string, unknown>) => ({ ...r, configuration: { ...r.configuration, ...patch } });
const withoutKey = (r: any, key: string) => { const { [key]: _, ...rest } = r; return rest; };
const withoutConfigKey = (r: any, key: string) => ({ ...r, configuration: withoutKey(r.configuration, key) });

describe("benchmark result schema versions", () => {
  it("keeps the checked-in Pilot A/B schema-v1 records valid, unchanged and reported as legacy", async () => {
    const records = await Promise.all(names.map(async n => JSON.parse(await readFile(resolve("benchmarks/results", `${n}.json`), "utf8"))));
    for (const r of records) {
      expect(r.schema_version).toBe("1");
      expect(BenchmarkResultSchema.parse(r)).toEqual(r);
    }
    const report = generateBenchmarkReport(records);
    expect(report.match(/provenance=legacy \(schema v1/g)).toHaveLength(2);
    expect(report).not.toContain("provenance=hardened");
  });
  it("lets a schema-v1 historical result omit the Phase 2.4c fields, and forbids hybrid v1 records", () => {
    const { change_evidence, ...rest } = v2();
    const configuration = withoutKey(withoutKey(withoutKey(rest.configuration, "taskstance_config_canonical_sha256"),
      "executor_config_canonical_sha256"), "judgment_config_canonical_sha256");
    const v1 = { ...rest, schema_version: "1", configuration };
    expect(BenchmarkResultSchema.parse(v1).schema_version).toBe("1");
    expect(() => BenchmarkResultSchema.parse({ ...v1, change_evidence })).toThrow();
    expect(() => BenchmarkResultSchema.parse({ ...v1, configuration: { ...configuration, taskstance_config_canonical_sha256: hash("4") } })).toThrow();
  });
  it("accepts a complete schema-v2 PASS and reports hardened provenance", () => {
    expect(BenchmarkResultSchema.parse(v2()).schema_version).toBe("2");
    const report = generateBenchmarkReport([v2()]);
    expect(report).toContain("provenance=hardened (schema v2)");
    expect(report).toContain(`change evidence: taskstance-change-evidence-v1 count=1 sha256=${hash("6")}`);
    expect(report).toContain(`canonical JSON SHA-256: project=${hash("4")}, executor=${hash("5")}, judgment=unavailable`);
  });
  it("rejects a schema-v2 PASS with change_evidence omitted or null", () => {
    expect(() => BenchmarkResultSchema.parse(withoutKey(v2(), "change_evidence"))).toThrow();
    expect(() => BenchmarkResultSchema.parse({ ...v2(), change_evidence: null })).toThrow();
  });
  it("rejects change evidence that does not cover every changed path", () => {
    const r = v2();
    expect(() => BenchmarkResultSchema.parse({ ...r, change_evidence: { ...r.change_evidence, artifact_count: 2 } })).toThrow();
  });
  it.each(["taskstance_config_canonical_sha256", "executor_config_canonical_sha256"])("rejects a schema-v2 PASS missing or null %s", key => {
    expect(() => BenchmarkResultSchema.parse(withConfig(v2(), { [key]: null }))).toThrow();
    expect(() => BenchmarkResultSchema.parse(withoutConfigKey(v2(), key))).toThrow();
  });
  it.each(["taskstance_config_sha256", "executor_config_sha256"])("rejects a schema-v2 PASS with null raw %s", key => {
    expect(() => BenchmarkResultSchema.parse(withConfig(v2(), { [key]: null }))).toThrow();
  });
  it("requires raw and canonical judgment hashes on a schema-v2 PASS only when judgment is configured", () => {
    const configured = withConfig(v2(), { judgment_config_ref: ".local/judgment.json", judgment_config_sha256: hash("7"), judgment_config_canonical_sha256: hash("8") });
    expect(BenchmarkResultSchema.parse(configured).schema_version).toBe("2");
    expect(() => BenchmarkResultSchema.parse(withConfig(configured, { judgment_config_canonical_sha256: null }))).toThrow();
    expect(() => BenchmarkResultSchema.parse(withConfig(configured, { judgment_config_sha256: null }))).toThrow();
    expect(() => BenchmarkResultSchema.parse(withoutConfigKey(configured, "judgment_config_canonical_sha256"))).toThrow();
  });
  it("accepts a v2 PASS without judgment config when both judgment hashes are null, and rejects stray hashes", () => {
    expect(BenchmarkResultSchema.parse(v2()).schema_version).toBe("2");
    expect(() => BenchmarkResultSchema.parse(withConfig(v2(), { judgment_config_sha256: hash("7") }))).toThrow();
    expect(() => BenchmarkResultSchema.parse(withConfig(v2(), { judgment_config_canonical_sha256: hash("8") }))).toThrow();
  });
  it("rejects a v2 FAILED result with a judgment hash but no judgment config", () => {
    const failed = { ...withConfig(v2(), { judgment_config_sha256: hash("7") }), measurements: null, escalation_status: "unknown",
      change_evidence: null, changed_paths: [], scope_conformant: null,
      verification: [{ id: "v", status: "not_run", exit_code: null, duration_ms: null }], failures: ["configuration_invalid"], outcome: "failed" };
    expect(() => BenchmarkResultSchema.parse(failed)).toThrow();
    expect(() => BenchmarkResultSchema.parse({ ...failed, configuration: { ...failed.configuration, judgment_config_sha256: null,
      judgment_config_canonical_sha256: hash("8") } })).toThrow();
  });
  it("lets a schema-v2 failed result retain null provenance, but still requires the keys", () => {
    const failed = { ...withConfig(v2(), { taskstance_config_sha256: null, executor_config_sha256: null, taskstance_config_canonical_sha256: null,
      executor_config_canonical_sha256: null, model: null, reasoning_effort: null }),
      measurements: null, escalation_status: "unknown", change_evidence: null, changed_paths: [], scope_conformant: null,
      verification: [{ id: "v", status: "not_run", exit_code: null, duration_ms: null }], failures: ["configuration_invalid"], outcome: "failed" };
    expect(BenchmarkResultSchema.parse(failed).outcome).toBe("failed");
    expect(generateBenchmarkReport([failed])).toContain("change evidence: unavailable");
    expect(() => BenchmarkResultSchema.parse(withoutKey(failed, "change_evidence"))).toThrow();
  });
});
