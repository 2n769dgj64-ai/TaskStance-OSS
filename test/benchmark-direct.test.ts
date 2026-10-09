// Fixture-only tests for the direct comparison arm. The Codex protocol double is the only executor; no hosted process,
// provider, judgment call or network access is used. Generated records are test doubles, never performance evidence.
import { execFileSync, spawnSync } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BenchmarkManifestSchema, BenchmarkResultSchema } from "../src/benchmark/schemas.js";
import { PairingError, runBenchmark, runDirectBenchmark, verifyPairing } from "../src/benchmark/runner.js";
import { generateBenchmarkReport } from "../src/benchmark/report.js";
import { canonicalValueSha256 } from "../src/benchmark/provenance.js";
import { CodexExecutorAdapter } from "../src/integrations/codex.js";
import * as processes from "../src/benchmark/process.js";
import { defaultProjectConfig } from "../src/project-config.js";

const own = resolve(".");
const dirs: string[] = [];
const git = (cwd: string, args: string[]) => execFileSync("git", ["-c", `safe.directory=${cwd.replaceAll("\\", "/")}`, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
beforeAll(() => execFileSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.build.json"], { cwd: own }), 30_000);
beforeEach(() => { vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden in fixture tests")); });
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(d => rm(d, { force: true, recursive: true, maxRetries: 5, retryDelay: 100 }))); });

async function fixture(mode = "success") {
  const root = await mkdtemp(resolve(tmpdir(), "taskstance-direct-test-")); dirs.push(root);
  const source = resolve(root, "source"); await mkdir(source);
  git(source, ["init"]);
  await writeFile(resolve(source, "README.md"), "# Synthetic fixture\nStatus: pending\n");
  git(source, ["add", "README.md"]);
  git(source, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture baseline"]);
  const baseline = git(source, ["rev-parse", "HEAD"]);
  await writeFile(resolve(root, "project.json"), JSON.stringify(defaultProjectConfig));
  await writeFile(resolve(root, "adapter.json"), JSON.stringify({ version: "1", executor: "primary", executable: process.execPath,
    cli_entrypoint: resolve(own, "test/fixtures/codex-cli.mjs"), models: { cheap: mode, balanced: mode, strong: mode, max: mode }, timeout_ms: 2000 }));
  const manifest = BenchmarkManifestSchema.parse({ schema_version: "1", benchmark_id: "synthetic-docs",
    upstream_repository: "https://github.com/example/fixture", baseline_commit: baseline,
    task: { data_classification: "engineering_non_sensitive", summary: "Update README status", flags: { docs_only: true } },
    initial_context_paths: ["README.md"], taskstance_config: "project.json", executor: { adapter: "codex", config: "adapter.json" },
    verification: [{ id: "readme", executable: process.execPath, args: ["-e", "if(!require('fs').readFileSync('README.md','utf8').includes('Status: ready'))process.exit(1)"], timeout_ms: 2000 }],
    allowed_changed_paths: ["README.md", "launch.json"], timeout_ms: 10_000 });
  const options = { local_source: source, config_root: root, taskstance_repository: own, workspace_root: root };
  return { root, source, manifest, options };
}
/** TaskStance-arm record produced by the existing protocol double (fixture only). */
async function pair(mode = "success") {
  const f = await fixture(mode);
  const paired = await runBenchmark(f.manifest, f.options);
  return { ...f, paired };
}
/** Windows CI: every fixture runs real git and process launches (3-6s there); bounded timeout for this file only, vitest.config unchanged. */
vi.setConfig({ testTimeout: 20_000 });
const tampered =(paired: any, patch: Record<string, unknown>) => ({ ...paired, ...patch });
const withConfig = (paired: any, patch: Record<string, unknown>) => ({ ...paired, configuration: { ...paired.configuration, ...patch } });

describe("direct arm evidence", () => {
  it("records an honest direct PASS with only observed fields", async () => {
    const f = await pair();
    expect(f.paired.outcome).toBe("passed");
    const direct = await runDirectBenchmark(f.manifest, f.paired, f.options);
    expect(direct).toMatchObject({ schema_version: "3", mode: "direct", outcome: "passed", failures: [], scope_conformant: true,
      source_kind: "local_fixture", verification: [{ id: "readme", status: "passed", exit_code: 0 }],
      measurements: { schema_version: "1", executor: { status: "completed", model: "success", reasoning_effort: "low", usage: { input_tokens: 30, output_tokens: 7 } } } });
    expect(Object.keys(direct.measurements!).sort()).toEqual(["executor", "schema_version"]);
    // No TaskStance-only measurement exists in the serialized record, not even as null/zero.
    expect(JSON.stringify(direct)).not.toMatch(/decision_source|"profile"|judgment|initial_context|mandatory_context|escalation|requires_replan|taskstance_config/);
    expect(direct.changed_paths).toEqual(["README.md", "launch.json"]);
    expect(direct.change_evidence).toMatchObject({ algorithm: "taskstance-change-evidence-v1", artifact_count: 2 });
    expect(direct.pairing.model).toBe("success");
    expect(JSON.stringify(direct)).not.toMatch(/private raw|Synthetic fixture|Update README/);
    expect((await readdir(f.root)).filter(n => n.startsWith("taskstance-benchmark-"))).toEqual([]);
    expect(git(f.source, ["status", "--porcelain"])).toBe("");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("references the pair by hashes without copying TaskStance data", async () => {
    const f = await pair(); const direct = await runDirectBenchmark(f.manifest, f.paired, f.options);
    expect(direct.pairing).toEqual({ taskstance_benchmark_id: "synthetic-docs", taskstance_result_canonical_sha256: canonicalValueSha256(f.paired),
      manifest_sha256: f.paired.configuration.manifest_sha256, executor_config_canonical_sha256: f.paired.configuration.executor_config_canonical_sha256!,
      model: "success", reasoning_effort: "low" });
    expect(direct.configuration.manifest_sha256).toBe(f.paired.configuration.manifest_sha256);
    expect(direct.configuration.executor_config_sha256).toBe(f.paired.configuration.executor_config_sha256);
    expect(direct.configuration.executor_config_canonical_sha256).toBe(f.paired.configuration.executor_config_canonical_sha256);
    expect(BenchmarkResultSchema.parse(JSON.parse(JSON.stringify(direct)))).toEqual(direct);
  });

  it("records a direct FAIL when verification fails (executor made no change)", async () => {
    const f = await pair("noop");
    const direct = await runDirectBenchmark(f.manifest, f.paired, f.options);
    expect(direct).toMatchObject({ outcome: "failed", failures: ["verification_failed"], verification: [{ status: "failed" }],
      measurements: { executor: { status: "completed" } } });
  });

  it("records a direct FAIL for scope violations and keeps the changed path", async () => {
    const f = await pair("outside");
    const direct = await runDirectBenchmark(f.manifest, f.paired, f.options);
    expect(direct).toMatchObject({ outcome: "failed", scope_conformant: false, failures: ["scope_violation"] });
    expect(direct.changed_paths).toContain("outside.txt");
  });

  it.each(["failed", "invalid", "nonzero"])("records a failed executor (%s) without raw output", async mode => {
    const f = await pair(mode);
    const direct = await runDirectBenchmark(f.manifest, f.paired, f.options);
    expect(direct.outcome).toBe("failed"); expect(direct.failures).toContain("execution_failed");
    expect(direct.verification[0]!.status).not.toBe("not_run");
    expect(JSON.stringify(direct)).not.toMatch(/private raw|secret raw/);
  });

  it("detects repository mutation in the direct arm", async () => {
    // A detached checkout's HEAD file holds the commit id, which is a valid content for a new ref.
    const f = await pair(); f.manifest.verification[0]!.args = ["-e", "const fs=require('fs');fs.writeFileSync('.git/refs/heads/mutated',fs.readFileSync('.git/HEAD','utf8'))"];
    // Same verification ids, different argv: pairing hash would differ, so re-pair against the changed manifest.
    const paired = await runBenchmark(f.manifest, f.options);
    expect((await runDirectBenchmark(f.manifest, paired, f.options)).failures).toContain("repository_mutated");
    expect(git(f.source, ["show-ref"])).not.toContain("mutated");
  });

  it("fails both arms closed when verification rewrites repository Git configuration", async () => {
    const f = await pair(); f.manifest.verification[0]!.args = ["-e", "require('fs').appendFileSync('.git/config','\\n# mutated\\n')"];
    // Git is not run after the rewrite, so changed paths and scope stay unknown and the record cannot be paired.
    const paired = await runBenchmark(f.manifest, f.options);
    expect(paired).toMatchObject({ outcome: "failed", failures: ["repository_mutated"], scope_conformant: null, change_evidence: null });
    await expect(runDirectBenchmark(f.manifest, paired, f.options)).rejects.toThrow(PairingError);
    expect(await readFile(resolve(f.source, ".git/config"), "utf8")).not.toContain("mutated");
  });

  it("refuses a dirty source before launching the executor", async () => {
    const f = await pair(); await writeFile(resolve(f.source, "README.md"), "dirty");
    const direct = await runDirectBenchmark(f.manifest, f.paired, f.options);
    expect(direct).toMatchObject({ outcome: "failed", failures: ["dirty_workspace"], measurements: null });
  });
});

describe("direct prompt and launch", () => {
  it("builds the launch from task, shared safety sentences and pinned model/effort only", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "taskstance-direct-adapter-")); dirs.push(workspace);
    await writeFile(join(workspace, "README.md"), "# Synthetic fixture\nStatus: pending\n");
    const adapter = new CodexExecutorAdapter({ version: "1", executor: "primary", models: { cheap: "m", balanced: "m", strong: "m", max: "m" },
      cli_entrypoint: resolve(own, "test/fixtures/codex-cli.mjs"), timeout_ms: 5000 }, workspace, []);
    const task = { data_classification: "engineering_non_sensitive" as const, summary: "Update README status", flags: {} };
    const result = await adapter.execute(await adapter.prepareDirect({ task, model: "success", reasoning_effort: "high" }));
    expect(result).toMatchObject({ status: "completed", model: "success", reasoning_effort: "high" });
    const launch = JSON.parse(await readFile(join(workspace, "launch.json"), "utf8"));
    expect(launch.args).toEqual(expect.arrayContaining(["--no-daemon", "exec", "--sandbox", "workspace-write", "--ignore-user-config", "--ephemeral", "--json", "--model", "success", "-"]));
    expect(launch.args).toContain("features.multi_agent=false");
    expect(launch.args).toContain('approval_policy="never"');
    expect(launch.args).toContain('model_reasoning_effort="high"');
    expect(launch.prompt).toContain("Update README status");
    expect(launch.prompt).toContain("Do not commit, push, publish, install dependencies, launch other agents, or change permissions.");
    expect(launch.prompt).not.toMatch(/profile|Test depth|Review depth|context_budget|"files"|authoritative/);
  });
  it("validates its input and cannot be executed twice", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "taskstance-direct-adapter-")); dirs.push(workspace);
    const adapter = new CodexExecutorAdapter({ version: "1", executor: "primary", models: { cheap: "m", balanced: "m", strong: "m", max: "m" },
      cli_entrypoint: resolve(own, "test/fixtures/codex-cli.mjs") }, workspace, []);
    const task = { data_classification: "engineering_non_sensitive" as const, summary: "x", flags: {} };
    await expect(adapter.prepareDirect({ task, model: "bad model", reasoning_effort: "low" })).rejects.toThrow();
    await expect(adapter.prepareDirect({ task, model: "m", reasoning_effort: "minimal" as never })).rejects.toThrow();
    await expect(adapter.execute({} as never)).rejects.toThrow();
  });
});

describe("pairing validation fails closed before any launch", () => {
  const cases: Array<[string, (p: any) => unknown]> = [
    ["baseline commit", p => tampered(p, { baseline_commit: "1".repeat(40) })],
    ["benchmark id", p => tampered(p, { benchmark_id: "other-task" })],
    ["upstream repository", p => tampered(p, { upstream_repository: "https://github.com/example/other" })],
    ["manifest hash", p => withConfig(p, { manifest_sha256: "0".repeat(64) })],
    ["executor config hash", p => withConfig(p, { executor_config_canonical_sha256: "0".repeat(64) })],
    ["executor config reference", p => withConfig(p, { executor_config_ref: "other.json" })],
    ["source kind", p => tampered(p, { source_kind: "public_upstream" })],
    ["verification ids", p => tampered(p, { verification: [{ id: "other", status: "passed", exit_code: 0, duration_ms: 1 }] })],
    ["verification not run", p => tampered(p, { verification: [{ id: "readme", status: "not_run", exit_code: null, duration_ms: null }], outcome: "failed", failures: ["execution_failed"], scope_conformant: true })],
    ["scope evidence", p => tampered(p, { scope_conformant: false, outcome: "failed", failures: ["scope_violation"] })],
    ["missing measurements", p => tampered(p, { measurements: null, outcome: "failed", failures: ["execution_failed"], configuration: { ...p.configuration, model: null, reasoning_effort: null } })],
    ["model outside the executor configuration", p => ({ ...p, configuration: { ...p.configuration, model: "stronger" },
      measurements: { ...p.measurements, executor: { ...p.measurements.executor, model: "stronger" } } })],
  ];
  it.each(cases)("refuses a mismatched %s", async (_name, mutate) => {
    const f = await pair();
    const launched = vi.spyOn(processes, "runProcess"); const execute = vi.spyOn(CodexExecutorAdapter.prototype, "execute");
    await expect(runDirectBenchmark(f.manifest, mutate(f.paired), f.options)).rejects.toThrow();
    expect(launched).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it("refuses pairing with a direct record, a legacy record or an unparsable record", async () => {
    const f = await pair(); const direct = await runDirectBenchmark(f.manifest, f.paired, f.options);
    await expect(verifyPairing(f.manifest, direct, f.options)).rejects.toBeInstanceOf(PairingError);
    await expect(verifyPairing(f.manifest, { schema_version: "1" }, f.options)).rejects.toThrow();
    await expect(verifyPairing(f.manifest, null, f.options)).rejects.toThrow();
  });
  it("refuses a changed task, scope, verification or executor configuration", async () => {
    const f = await pair();
    for (const change of [(m: any) => { m.task.summary = "Different task"; }, (m: any) => { m.allowed_changed_paths.push("extra.md"); },
      (m: any) => { m.verification[0].timeout_ms = 3000; }, (m: any) => { m.timeout_ms = 20_000; }]) {
      const manifest = structuredClone(f.manifest); change(manifest);
      await expect(verifyPairing(manifest, f.paired, f.options)).rejects.toBeInstanceOf(PairingError);
    }
    await writeFile(resolve(f.root, "adapter.json"), JSON.stringify({ version: "1", executor: "primary", executable: process.execPath,
      cli_entrypoint: resolve(own, "test/fixtures/codex-cli.mjs"), models: { cheap: "success", balanced: "success", strong: "success", max: "success" }, timeout_ms: 1999 }));
    await expect(verifyPairing(f.manifest, f.paired, f.options)).rejects.toBeInstanceOf(PairingError);
  });
  it("accepts a pairing that only reformats the executor configuration", async () => {
    const f = await pair(); const text = await readFile(resolve(f.root, "adapter.json"), "utf8");
    await writeFile(resolve(f.root, "adapter.json"), JSON.stringify(JSON.parse(text), null, 4));
    await expect(verifyPairing(f.manifest, f.paired, f.options)).resolves.toMatchObject({ pairing: { model: "success" } });
  });
});

describe("authorization", () => {
  it("requires explicit live authorization and refuses live+local combinations before any launch", async () => {
    const f = await pair(); const launched = vi.spyOn(processes, "runProcess"); const { local_source, ...noLocal } = f.options;
    // Fixture pair + no live flag + no local source: refused as unauthorized (and the pairing's source kind mismatches).
    await expect(runDirectBenchmark(f.manifest, f.paired, noLocal)).rejects.toBeInstanceOf(PairingError);
    // Matching source kind but live and local source together are refused as a record.
    const both = await runDirectBenchmark(f.manifest, f.paired, { ...f.options, live: true });
    expect(both).toMatchObject({ outcome: "failed", failures: ["workspace_refused"], measurements: null });
    expect(launched.mock.calls.some(call => call[1].includes("clone"))).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("refuses a public-source direct run without live opt-in before any network access", async () => {
    const f = await pair(); const { local_source, ...noLocal } = f.options;
    const publicPair = { ...f.paired, source_kind: "public_upstream" as const };
    const result = await runDirectBenchmark(f.manifest, publicPair, noLocal);
    expect(result).toMatchObject({ outcome: "failed", failures: ["workspace_refused"], measurements: null, source_kind: "public_upstream" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("refuses a hosted executor configuration in local fixture mode", async () => {
    const f = await pair();
    const config = { version: "1", executor: "primary", models: { cheap: "success", balanced: "success", strong: "success", max: "success" }, timeout_ms: 2000 };
    await writeFile(resolve(f.root, "adapter.json"), JSON.stringify(config));
    const hosted = { ...f.paired, configuration: { ...f.paired.configuration, executor_config_canonical_sha256: (await import("../src/benchmark/provenance.js")).canonicalJsonSha256(JSON.stringify(config)) } };
    expect(await runDirectBenchmark(f.manifest, hosted, f.options)).toMatchObject({ failures: ["configuration_invalid"], measurements: null });
  });

  const cli = (args: string[]) => spawnSync(process.execPath, [resolve(own, "dist/benchmark/cli.js"), ...args], { encoding: "utf8", timeout: 20_000 });
  async function cliFiles() {
    const f = await pair();
    await writeFile(resolve(f.root, "manifest.json"), JSON.stringify(f.manifest));
    await writeFile(resolve(f.root, "paired.json"), JSON.stringify(f.paired));
    return { ...f, manifest_path: resolve(f.root, "manifest.json"), paired_path: resolve(f.root, "paired.json"), output: resolve(f.root, "direct.json") };
  }
  const exists = (p: string) => access(p).then(() => true, () => false);
  it.each([
    ["without --live", (c: any) => ["run", c.manifest_path, c.output, "--mode", "direct", "--pair-with", c.paired_path]],
    ["without --pair-with", (c: any) => ["run", c.manifest_path, c.output, "--live", "--mode", "direct"]],
    ["with an unknown mode", (c: any) => ["run", c.manifest_path, c.output, "--live", "--mode", "comparison", "--pair-with", c.paired_path]],
    ["with --live in the wrong position", (c: any) => ["run", c.manifest_path, c.output, "--mode", "direct", "--live", "--pair-with", c.paired_path]],
  ])("CLI refuses direct mode %s and creates no result", async (_name, args) => {
    const c = await cliFiles(); const r = cli(args(c));
    expect(r.status).toBe(1); expect(r.stderr).toContain("Benchmark command refused");
    expect(await exists(c.output)).toBe(false);
  });
  it("CLI refuses a mismatched or fixture pairing before creating output or touching the network", async () => {
    const c = await cliFiles();
    // A fixture-sourced pair cannot authorize a live public run (source kind mismatch).
    expect(cli(["run", c.manifest_path, c.output, "--live", "--mode", "direct", "--pair-with", c.paired_path]).status).toBe(1);
    expect(await exists(c.output)).toBe(false);
    await writeFile(c.paired_path, JSON.stringify({ ...c.paired, baseline_commit: "2".repeat(40), source_kind: "public_upstream" }));
    expect(cli(["run", c.manifest_path, c.output, "--live", "--mode", "direct", "--pair-with", c.paired_path]).status).toBe(1);
    expect(await exists(c.output)).toBe(false);
  });
  it("leaves the existing TaskStance command form unchanged", async () => {
    const c = await cliFiles();
    expect(cli(["run", c.manifest_path, c.output]).status).toBe(1);
    expect(await exists(c.output)).toBe(false);
  });
});

describe("schema strictness", () => {
  it("rejects fabricated TaskStance fields and impossible direct passes", async () => {
    const f = await pair(); const direct: any = JSON.parse(JSON.stringify(await runDirectBenchmark(f.manifest, f.paired, f.options)));
    expect(BenchmarkResultSchema.parse(direct)).toBeTruthy();
    for (const patch of [{ decision_source: "deterministic" }, { escalation_status: "not_observed" }, { raw_output: "x" },
      { measurements: { ...direct.measurements, profile: {} } }, { measurements: { ...direct.measurements, initial_context_estimated_tokens: 0 } },
      { mode: "comparison" }, { mode: "taskstance" }, { measurements: null }, { change_evidence: null },
      { configuration: { ...direct.configuration, model: "different" } },
      { pairing: { ...direct.pairing, model: "different" } },
      { pairing: { ...direct.pairing, manifest_sha256: "0".repeat(64) } },
      { configuration: { ...direct.configuration, executor_config_canonical_sha256: "0".repeat(64) } },
      { verification: [{ id: "readme", status: "failed", exit_code: 1, duration_ms: 1 }] }, { scope_conformant: false },
      { failures: ["verification_failed"] }, { outcome: "failed" }])
      expect(() => BenchmarkResultSchema.parse({ ...direct, ...patch })).toThrow();
  });
});

describe("report", () => {
  it("is deterministic and shows both arms side by side without derived metrics", async () => {
    const f = await pair(); const direct = await runDirectBenchmark(f.manifest, f.paired, f.options);
    const report = generateBenchmarkReport([f.paired, direct]);
    expect(generateBenchmarkReport([direct, f.paired])).toBe(report);
    expect(generateBenchmarkReport([f.paired, direct])).toBe(report);
    const section = report.slice(report.indexOf("## Paired comparison"), report.indexOf("## Methodology"));
    expect(section).toContain("| Executor input tokens (reported by executor; unknown is not zero) | 30 | 30 |");
    expect(section).toContain("| Decision source (TaskStance only) | deterministic | n/a |");
    expect(section).toContain("| Initial context estimated tokens (estimate of selected file content only; not executor usage) |");
    expect(section).toContain("| Judgment calls (invocations only; judgment tokens and cost not observed) | 0 | n/a |");
    expect(section).not.toMatch(/%|NaN|Infinity|undefined/);
    expect(report).toContain("| synthetic-docs | direct | local_fixture | passed |");
    expect(report).toContain("| synthetic-docs | taskstance | local_fixture | passed |");
    expect(report).toContain("## Direct-mode notes");
    expect(report).toContain("provenance=direct (schema v3)");
    expect(report).not.toMatch(/private raw|Status: pending|Update README/);
    expect(report).not.toContain("this harness only runs TaskStance");
    expect(report).toContain("Direct execution is supported through schema-v3 records");
    expect(report).toContain("comparisons are descriptive only and do not establish savings, causal effects or superiority");
  });
  it("keeps the TaskStance-only limitation wording when no direct record is present", async () => {
    const f = await pair();
    expect(generateBenchmarkReport([f.paired])).toContain("Comparison records are representable but this harness only runs TaskStance.");
  });
  it("marks an absent paired record instead of inventing its values", async () => {
    const f = await pair(); const direct = await runDirectBenchmark(f.manifest, f.paired, f.options);
    const report = generateBenchmarkReport([direct]);
    expect(report).toContain("| Outcome | paired record not supplied | passed |");
    expect(report).toContain("| Initial context files (TaskStance only) | paired record not supplied | n/a |");
  });
  it("renders failed direct rows and leaves unreported usage unknown", async () => {
    const f = await pair("no-usage"); const direct = await runDirectBenchmark(f.manifest, f.paired, f.options);
    expect(direct.measurements?.executor.usage).toBeUndefined();
    const report = generateBenchmarkReport([f.paired, direct]);
    expect(report).toContain("| Executor input tokens (reported by executor; unknown is not zero) | unknown | unknown |");
  });
  it("keeps the report byte-for-byte unchanged when no direct record exists", async () => {
    const dir = resolve(own, "benchmarks/results");
    const files = (await readdir(dir)).filter(n => n.endsWith(".json")).sort();
    expect(files).toHaveLength(5);
    const records = await Promise.all(files.map(async n => JSON.parse(await readFile(resolve(dir, n), "utf8")) as unknown));
    // The working copy may carry CRLF (autocrlf); the committed blob is LF.
    const expected = (await readFile(resolve(own, "benchmarks/REPORT.md"), "utf8")).replaceAll("\r\n", "\n");
    expect(generateBenchmarkReport(records)).toBe(expected);
    for (const r of records) expect(["1", "2"]).toContain((r as { schema_version: string }).schema_version);
  });
});
