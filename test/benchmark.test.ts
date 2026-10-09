import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir, copyFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BenchmarkCatalogSchema, BenchmarkManifestSchema, BenchmarkResultSchema, RunMeasurementsSchema } from "../src/benchmark/schemas.js";
import { runBenchmark, pathAllowed } from "../src/benchmark/runner.js";
import { generateBenchmarkReport } from "../src/benchmark/report.js";
import * as processes from "../src/benchmark/process.js";
import { defaultProjectConfig } from "../src/project-config.js";
import { RawJudgmentSchema } from "../src/contracts.js";
import { JudgmentProcessAdapter } from "../src/integrations/judgment-process.js";
import { BASE_ENV } from "../src/integrations/codex.js";

const own = resolve(".");
const dirs: string[] = [];
const git = (cwd: string, args: string[]) => execFileSync("git", ["-c", `safe.directory=${cwd.replaceAll("\\", "/")}`, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
beforeAll(() => execFileSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.build.json"], { cwd: own }), 30_000);
beforeEach(() => { vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden in fixture tests")); });
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(d => rm(d, { force: true, recursive: true, maxRetries: 5, retryDelay: 100 }))); });
async function fixture(mode = "success") {
  const root = await mkdtemp(resolve(tmpdir(), "taskstance-benchmark-test-")); dirs.push(root);
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
  return { root, source, baseline, manifest, options };
}

describe("benchmark schemas and scope", () => {
  it("strictly validates manifest and nested fields", async () => {
    const { manifest } = await fixture();
    expect(BenchmarkManifestSchema.parse(manifest)).toEqual(manifest);
    expect(() => BenchmarkManifestSchema.parse({ ...manifest, answer: "patch" })).toThrow();
    expect(() => BenchmarkManifestSchema.parse({ ...manifest, executor: { ...manifest.executor, secret: "credential" } })).toThrow();
    expect(() => BenchmarkManifestSchema.parse({ ...manifest, task: { ...manifest.task, hints: [] } })).toThrow();
  });
  it("keeps the catalog identical to the checked-in pilot manifests", async () => {
    const catalog = BenchmarkCatalogSchema.parse(JSON.parse(await readFile(resolve(own, "benchmarks/catalog.json"), "utf8")));
    expect(catalog.tasks.map(t => t.benchmark_id)).toEqual(["clsx-pr82-readme-bench-links", "yoctocolors-pr26-bold-dim",
      "minimist-pr17-long-option-single-dash", "yocto-queue-pr13-drain-undefined", "is-stream-pr21-http-streams"]);
    for (const task of catalog.tasks) {
      const manifest = JSON.parse(await readFile(resolve(own, "benchmarks/tasks", task.benchmark_id, "manifest.json"), "utf8"));
      expect(BenchmarkManifestSchema.parse(manifest)).toEqual(task);
      // Machine-specific launcher paths live only in ignored per-task .local configuration.
      for (const ref of [task.executor.config, task.judgment?.config].filter(Boolean)) expect(ref).toMatch(/^\.local\//);
    }
    expect(() => BenchmarkCatalogSchema.parse({ schema_version: "1", tasks: [], secret: true })).toThrow();
  });
  it("keeps the three Phase 2.4d tasks prepared, bounded and without results", async () => {
    const prepared = { "minimist-pr17-long-option-single-dash": "ba92fe6ebbdc0431cca9a2ea8f27beb492f5e4ec", "yocto-queue-pr13-drain-undefined": "6f20a6fad9323285e9f7c04dd1232ccc5e931e7e", "is-stream-pr21-http-streams": "6913e344ab2dd63041bb7c03095876ce5a7e0a8b" };
    const results = await readdir(resolve(own, "benchmarks/results"));
    for (const [id, sha] of Object.entries(prepared)) {
      const dir = resolve(own, "benchmarks/tasks", id);
      const manifest = BenchmarkManifestSchema.parse(JSON.parse(await readFile(resolve(dir, "manifest.json"), "utf8")));
      expect(manifest.baseline_commit).toBe(sha);
      expect(manifest.task.flags).toEqual({});
      expect(manifest.judgment?.config).toBe(".local/judgment.json");
      expect(manifest.allowed_changed_paths).toEqual(manifest.initial_context_paths);
      expect(manifest.notes?.[0]).toMatch(/^Prepared, not executed./);
      expect(manifest.verification).toHaveLength(1);
      expect(manifest.verification[0]!.executable).toBe("node");
      // Each Phase 2.4d task has exactly one authorized live result.
      expect(results).toContain(id + ".json");
      const codex = JSON.parse(await readFile(resolve(dir, "codex.local.example.json"), "utf8"));
      expect(Object.values(codex.models)).toEqual(["gpt-6.1-sol", "gpt-6.1-sol", "gpt-6.1-sol", "gpt-6.1-sol"]);
    }
  });
  it.each(["https://user:password@github.com/a/b", "git@github.com:a/b", "https://github.com/2n769dgj64-ai/TaskStance-OSS", "https://internal.example/a/b"])("rejects repository %s", async url => {
    const { manifest } = await fixture(); expect(() => BenchmarkManifestSchema.parse({ ...manifest, upstream_repository: url })).toThrow();
  });
  it("rejects invalid baseline, context, verification and duplicate command ids", async () => {
    const { manifest } = await fixture();
    for (const change of [{ baseline_commit: "main" }, { initial_context_paths: ["../secret"] }, { initial_context_paths: [".git/config"] },
      { initial_context_paths: [".env"] }, { verification: [] }, { verification: [{ ...manifest.verification[0], shell: true }] },
      { verification: [...manifest.verification, ...manifest.verification] }, { verification: [{ ...manifest.verification[0], executable: "npm.cmd" }] },
      { verification: [{ ...manifest.verification[0], env: { TASKSTANCE_SENTINEL_API_KEY: "x" } }] }])
      expect(() => BenchmarkManifestSchema.parse({ ...manifest, ...change })).toThrow();
  });
  it("matches only anchored literal, single-star and double-star scopes", () => {
    expect(pathAllowed("src/a.ts", ["src/*.ts"])).toBe(true);
    expect(pathAllowed("src/nested/a.ts", ["src/*.ts"])).toBe(false);
    expect(pathAllowed("src/nested/a.ts", ["src/**"])).toBe(true);
    expect(pathAllowed("other/README.md", ["README.md"])).toBe(false);
    expect(pathAllowed("READMEzmd", ["README.md"])).toBe(false);
  });
});

describe("disposable local harness", () => {
  it("executes explicit CLI, verifies changes and leaves source/refs/remotes untouched", async () => {
    const f = await fixture(); const refs = git(f.source, ["show-ref"]); const config = await readFile(resolve(f.source, ".git/config"), "utf8");
    const launched = vi.spyOn(processes, "runProcess");
    const result = await runBenchmark(f.manifest, f.options);
    expect(result).toMatchObject({ outcome: "passed", scope_conformant: true, source_kind: "local_fixture", failures: [],
      verification: [{ status: "passed", exit_code: 0 }], measurements: { decision_source: "deterministic", judgment_calls: 0,
        initial_context_files: 1, initial_context_estimated_tokens: expect.any(Number), mandatory_context_retained: true,
        executor: { status: "completed", usage: { input_tokens: 30, output_tokens: 7 } } } });
    expect(result.changed_paths).toEqual(["README.md", "launch.json"]);
    expect(result.schema_version).toBe("2");
    expect(result.change_evidence).toMatchObject({ algorithm: "taskstance-change-evidence-v1", artifact_count: 2 });
    expect(result.configuration.taskstance_config_canonical_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.configuration.executor_config_canonical_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.configuration.judgment_config_canonical_sha256).toBeNull();
    // Git autocrlf can produce 36 LF bytes or 38 CRLF bytes in the disposable checkout.
    expect([9, 10]).toContain(result.measurements!.initial_context_estimated_tokens);
    expect(git(f.source, ["status", "--porcelain"])).toBe("");
    expect(git(f.source, ["show-ref"])).toBe(refs);
    expect(await readFile(resolve(f.source, ".git/config"), "utf8")).toBe(config);
    expect(await readFile(resolve(f.source, "README.md"), "utf8")).toContain("Status: pending");
    expect((await readdir(f.root)).filter(n => n.startsWith("taskstance-benchmark-"))).toEqual([]);
    expect(JSON.stringify(result)).not.toMatch(/private raw|secret raw|Synthetic fixture|Update README|prompt|stdout|stderr/);
    const gitCalls = launched.mock.calls.filter(call => call[0] === "git");
    expect(gitCalls.every(call => !call[1].some(arg => ["commit", "push", "reset", "set-url"].includes(arg)))).toBe(true);
    expect(gitCalls.filter(call => call[1].includes("clone")).every(call => !call[1].some(arg => arg.startsWith("https://")))).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["tracked", "untracked", "ignored"])("refuses dirty %s source before execution", async kind => {
    const f = await fixture();
    if (kind === "tracked") await writeFile(resolve(f.source, "README.md"), "dirty");
    else { if (kind === "ignored") { await writeFile(resolve(f.source, ".gitignore"), "hidden\n"); git(f.source, ["add", ".gitignore"]); git(f.source, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "ignore"]); f.manifest.baseline_commit = git(f.source, ["rev-parse", "HEAD"]); }
      await writeFile(resolve(f.source, kind === "ignored" ? "hidden" : "unexpected"), "dirty"); }
    expect(await runBenchmark(f.manifest, f.options)).toMatchObject({ outcome: "failed", failures: ["dirty_workspace"], measurements: null });
  });
  it("refuses baseline mismatch without resetting source", async () => {
    const f = await fixture(); f.manifest.baseline_commit = "0".repeat(40);
    expect(await runBenchmark(f.manifest, f.options)).toMatchObject({ failures: ["baseline_mismatch"] });
    expect(git(f.source, ["rev-parse", "HEAD"])).toBe(f.baseline);
  });
  it.each(["assume-unchanged", "skip-worktree"])("refuses %s source before executor launch without changing source", async flag => {
    const f = await fixture();
    git(f.source, ["update-index", `--${flag}`, "README.md"]);
    await writeFile(resolve(f.source, "README.md"), "MASKED SOURCE CONTENT\n");
    expect(git(f.source, ["status", "--porcelain"])).toBe("");
    const index = await readFile(resolve(f.source, ".git/index"));
    const launched = vi.spyOn(processes, "runProcess");
    expect(await runBenchmark(f.manifest, f.options)).toMatchObject({ outcome: "failed", failures: ["dirty_workspace"], measurements: null });
    expect(launched.mock.calls.some(call => call[1].includes("--benchmark-json") || call[1].includes("clone"))).toBe(false);
    expect(await readFile(resolve(f.source, ".git/index"))).toEqual(index);
    expect(await readFile(resolve(f.source, "README.md"), "utf8")).toBe("MASKED SOURCE CONTENT\n");
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["assume-unchanged", "skip-worktree"])("refuses %s source even without a worktree edit", async flag => {
    const f = await fixture();
    git(f.source, ["update-index", `--${flag}`, "README.md"]);
    expect(await runBenchmark(f.manifest, f.options)).toMatchObject({ failures: ["dirty_workspace"], measurements: null });
  });
  it.each(["assume-unchanged", "skip-worktree"])("refuses %s disposable checkout before executor launch", async flag => {
    const f = await fixture(); const original = processes.runProcess;
    const launched = vi.spyOn(processes, "runProcess").mockImplementation(async (exe, args, cwd, timeout, capture, env) => {
      const r = await original(exe, args, cwd, timeout, capture, env);
      if (exe === "git" && args.includes("checkout")) {
        git(cwd, ["update-index", `--${flag}`, "README.md"]);
        await writeFile(resolve(cwd, "README.md"), "MASKED CHECKOUT CONTENT\n");
        expect(git(cwd, ["status", "--porcelain"])).toBe("");
      }
      return r;
    });
    expect(await runBenchmark(f.manifest, f.options)).toMatchObject({ outcome: "failed", failures: ["dirty_workspace"], measurements: null });
    expect(launched.mock.calls.some(call => call[1].includes("--benchmark-json"))).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    ["assume-unchanged", false], ["skip-worktree", false],
    ["assume-unchanged", true], ["skip-worktree", true],
  ] as const)("fails post-run %s masking (path allowed: %s) with conservative scope evidence", async (flag, allowed) => {
    const f = await fixture();
    // Spaces in a tracked name must survive NUL-delimited parsing intact.
    const outside = "OUTSIDE file.md";
    await writeFile(resolve(f.source, outside), "Baseline\n");
    git(f.source, ["add", outside]);
    git(f.source, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "outside baseline"]);
    f.manifest.baseline_commit = git(f.source, ["rev-parse", "HEAD"]);
    if (allowed) f.manifest.allowed_changed_paths.push("OUTSIDE*.md");
    f.manifest.verification[0]!.args = ["-e",
      `require('child_process').execFileSync('git',['update-index','--${flag}','${outside}']);require('fs').writeFileSync('${outside}','MASKED PRIVATE CONTENT')`];
    const result = await runBenchmark(f.manifest, f.options);
    expect(result).toMatchObject({ outcome: "failed", scope_conformant: allowed, verification: [{ status: "passed" }] });
    expect(result.changed_paths).toEqual([outside, "README.md", "launch.json"]);
    expect(result.failures).toEqual(allowed ? ["repository_mutated"] : ["repository_mutated", "scope_violation"]);
    expect(JSON.stringify(result)).not.toContain("MASKED PRIVATE CONTENT");
    expect(generateBenchmarkReport([result])).not.toContain("MASKED PRIVATE CONTENT");
    expect(git(f.source, ["ls-files", "-v", outside])).toBe(`H ${outside}`);
    expect(await readFile(resolve(f.source, outside), "utf8")).toBe("Baseline\n");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("refuses TaskStance itself", async () => {
    const f = await fixture();
    expect(await runBenchmark(f.manifest, { ...f.options, local_source: own })).toMatchObject({ failures: ["workspace_refused"] });
  });
  it("requires live opt-in before any network access", async () => {
    const f = await fixture(); const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { local_source, ...options } = f.options;
    expect(await runBenchmark(f.manifest, options)).toMatchObject({ failures: ["workspace_refused"] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("refuses hosted executor or judgment in local fixture mode", async () => {
    const f = await fixture(); await writeFile(resolve(f.root, "adapter.json"), JSON.stringify({ version: "1", executor: "primary", models: { cheap: "m", balanced: "m", strong: "m", max: "m" } }));
    expect(await runBenchmark(f.manifest, f.options)).toMatchObject({ failures: ["configuration_invalid"] });
  });
  it("preserves verification failure and discards verification stdout/stderr", async () => {
    const f = await fixture(); f.manifest.verification[0]!.args = ["-e", "console.log('RAW SOURCE SECRET');console.error('RAW SOURCE SECRET');process.exit(7)"];
    const result = await runBenchmark(f.manifest, f.options);
    expect(result).toMatchObject({ outcome: "failed", failures: ["verification_failed"], verification: [{ status: "failed", exit_code: 7 }] });
    expect(JSON.stringify(result)).not.toContain("RAW SOURCE");
    expect(generateBenchmarkReport([result])).toContain("verification_failed");
  });
  it("rejects unexpected changed paths including ignored files", async () => {
    const f = await fixture(); f.manifest.allowed_changed_paths = ["README.md"];
    f.manifest.verification[0]!.args = ["-e", "require('fs').writeFileSync('.gitignore','outside.txt\\n');require('fs').writeFileSync('outside.txt','secret')"];
    const result = await runBenchmark(f.manifest, f.options);
    expect(result).toMatchObject({ scope_conformant: false, failures: ["scope_violation"], outcome: "failed" });
    expect(result.changed_paths).toContain("outside.txt");
  });
  it.each(["invalid", "failed", "nonzero"])("preserves failed executor %s without raw output", async mode => {
    const f = await fixture(mode); const result = await runBenchmark(f.manifest, f.options);
    expect(result.outcome).toBe("failed"); expect(result.failures).toContain("execution_failed");
    expect(result.verification[0]!.status).not.toBe("not_run");
    expect(JSON.stringify(result)).not.toMatch(/private raw|secret raw/);
  });
  it("rejects malformed result JSON without raw leakage", async () => {
    const f = await fixture(); const original = processes.runProcess;
    vi.spyOn(processes, "runProcess").mockImplementation(async (exe, args, cwd, timeout, capture, env) => args.includes("--benchmark-json")
      ? { ok: true, exit_code: 0, stdout: '{"raw":"SECRET"}', duration_ms: 1 } : original(exe, args, cwd, timeout, capture, env));
    const result = await runBenchmark(f.manifest, f.options);
    expect(result.failures).toContain("result_invalid"); expect(JSON.stringify(result)).not.toContain("SECRET");
  });
  it("detects repository configuration mutation in disposable checkout", async () => {
    const f = await fixture(); f.manifest.verification[0]!.args = ["-e", "require('fs').appendFileSync('.git/config','\\n# mutated\\n')"];
    expect((await runBenchmark(f.manifest, f.options)).failures).toContain("repository_mutated");
    expect(await readFile(resolve(f.source, ".git/config"), "utf8")).not.toContain("mutated");
  });
  it("fails malformed configuration before execution", async () => {
    const f = await fixture(); await writeFile(resolve(f.root, "project.json"), '{"secret":"RAW"}');
    expect(await runBenchmark(f.manifest, f.options)).toMatchObject({ failures: ["configuration_invalid"], measurements: null });
  });
  it("refuses a dirty disposable checkout before execution", async () => {
    const f = await fixture(); const original = processes.runProcess;
    vi.spyOn(processes, "runProcess").mockImplementation(async (exe, args, cwd, timeout, capture, env) => {
      const r = await original(exe, args, cwd, timeout, capture, env);
      if (exe === "git" && args.includes("checkout")) await writeFile(resolve(cwd, "unexpected.txt"), "dirty");
      return r;
    });
    expect(await runBenchmark(f.manifest, f.options)).toMatchObject({ failures: ["dirty_workspace"], measurements: null });
  });
  it("checks pinned HEAD again after disposable checkout", async () => {
    const f = await fixture(); const original = processes.runProcess;
    vi.spyOn(processes, "runProcess").mockImplementation(async (exe, args, cwd, timeout, capture, env) => {
      const r = await original(exe, args, cwd, timeout, capture, env);
      if (exe === "git" && cwd.endsWith("checkout") && args.includes("rev-parse") && args.includes("HEAD")) return { ...r, stdout: "0".repeat(40) };
      return r;
    });
    expect(await runBenchmark(f.manifest, f.options)).toMatchObject({ failures: ["baseline_mismatch"], measurements: null });
  });
  it("refuses non-public metadata before cloning (mocked network only)", async () => {
    const f = await fixture(); vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ private: true, full_name: "example/fixture" })));
    const launched = vi.spyOn(processes, "runProcess"); const { local_source, ...options } = f.options;
    expect(await runBenchmark(f.manifest, { ...options, live: true })).toMatchObject({ failures: ["workspace_refused"] });
    expect(launched.mock.calls.some(call => call[1].includes("clone"))).toBe(false);
  });
  it("bounds timeout and output of local verification processes", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "taskstance-benchmark-process-")); dirs.push(root);
    const timed = await processes.runProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], root, 100);
    expect(timed.ok).toBe(false); expect(timed.stdout).toBe("");
    const overflow = await processes.runProcess(process.execPath, ["-e", "console.log('x'.repeat(1000001))"], root, 2000);
    expect(overflow.ok).toBe(false); expect(overflow.stdout).toBe("");
  });
});

describe("strict results and deterministic reports", () => {
  it("supports comparison metadata, retains failures, and rejects impossible success/raw fields", async () => {
    const f = await fixture(); const passed = await runBenchmark(f.manifest, f.options);
    const failed = BenchmarkResultSchema.parse({ ...passed, benchmark_id: "failed-task", mode: "comparison", outcome: "failed", failures: ["verification_failed"] });
    expect(generateBenchmarkReport([passed, failed])).toBe(generateBenchmarkReport([failed, passed]));
    const report = generateBenchmarkReport([passed, failed]);
    expect(report).toContain("1 failed"); expect(report).toContain("comparison"); expect(report).toContain("failed-task");
    expect(report).toContain("Initial selected context estimates are not total executor token usage");
    expect(report).not.toMatch(/private raw|secret raw|Status: pending|Update README/);
    expect(() => BenchmarkResultSchema.parse({ ...passed, raw_model_output: "secret" })).toThrow();
    expect(() => BenchmarkResultSchema.parse({ ...passed, measurements: null })).toThrow();
    expect(() => RunMeasurementsSchema.parse({ ...passed.measurements, raw: "secret" })).toThrow();
    expect(() => BenchmarkResultSchema.parse({ ...passed, configuration: { ...passed.configuration, model: "different" } })).toThrow();
  });
  it("reports empty catalog honestly", () => {
    expect(generateBenchmarkReport([])).toContain("0 result record(s); 0 passed; 0 failed");
  });
});

describe("benchmark-only fixed-control judgment", () => {
  const config = { version: "1" as const, provider_id: "benchmark-fixed-control", executors: ["primary", "replan"],
    executable: process.execPath, cli_entrypoint: resolve(own, "benchmarks/tools/fixed-judgment.mjs") };
  const task = { data_classification: "engineering_non_sensitive" as const, task_id: "synthetic", attempt_id: "a1",
    summary: "FIXED_CONTROL_TASK_SENTINEL", flags: {} };
  it("returns the constant profile through the real process boundary with config-owned identity", async () => {
    const judgment = RawJudgmentSchema.parse(await new JudgmentProcessAdapter(config).decide(task));
    expect(judgment.provider).toBe("benchmark-fixed-control");
    expect(JSON.stringify(judgment)).not.toContain("FIXED_CONTROL_TASK_SENTINEL");
    const selected = Object.fromEntries(Object.entries(judgment.decisions ?? {}).map(([k, v]) => [k, v?.selected]));
    expect(selected).toEqual({ executor: "primary", model_tier: "balanced", reasoning_effort: "medium", context_budget: "small",
      test_depth: "targeted", review_depth: "targeted", parallel_safe: false, integration_strategy: "direct" });
    expect(judgment.decisions?.parallel_safe).toEqual({ selected: false, probability_true: 0.01 });
    expect(Object.entries(judgment.decisions ?? {}).filter(([k]) => k !== "parallel_safe").every(([, v]) => v !== undefined && "confidence" in v && v.confidence === 0.99)).toBe(true);
  });
  it("refuses executors it was not offered instead of emitting a profile", async () => {
    await expect(new JudgmentProcessAdapter({ ...config, executors: ["secondary", "replan"] }).decide(task)).rejects.toThrow();
  });
});

describe("benchmark process launcher", () => {
  const SENTINEL = "TASKSTANCE_SENTINEL_API_KEY"; const VALUE = "synthetic-sentinel-7f3c9e1a-not-a-credential";
  const withSentinel = async <T>(run: () => Promise<T>): Promise<T> => {
    process.env[SENTINEL] = VALUE;
    try { return await run(); } finally { delete process.env[SENTINEL]; }
  };
  const ALLOWED = "TASKSTANCE_ALLOWED_SENTINEL";
  const dump = ["-e", "process.stdout.write(JSON.stringify(process.env))"];
  const key = (n: string) => (process.platform === "win32" ? n.toUpperCase() : n);
  // On Windows libuv always copies its fixed required system/profile set into children; it is not configurable.
  const libuv = process.platform === "win32" ? ["HOMEDRIVE", "HOMEPATH", "LOGONSERVER", "USERDOMAIN", "USERNAME", "USERPROFILE"] : [];
  it("gives children only the minimal allowlist plus explicitly named variables, never parent secrets", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "taskstance-benchmark-env-")); dirs.push(root);
    process.env[ALLOWED] = "allowed-value";
    const [minimal, defaulted, named] = await withSentinel(() => Promise.all([
      processes.runProcess(process.execPath, dump, root, 10_000, true, {}),
      processes.runProcess(process.execPath, dump, root, 10_000),
      processes.runProcess(process.execPath, dump, root, 10_000, true, { inherit: [ALLOWED], fixed: { FIXED_NAME: "fixed", GIT_TERMINAL_PROMPT: "1" } })]))
      .finally(() => { delete process.env[ALLOWED]; });
    const allowed = new Set([...processes.MINIMAL_ENV, ...libuv, "GIT_TERMINAL_PROMPT", "GIT_ASKPASS", "SSH_ASKPASS"].map(key));
    for (const result of [minimal, defaulted, named]) {
      expect(result.ok).toBe(true);
      expect(result.stdout).not.toContain(VALUE);
      const env = JSON.parse(result.stdout) as Record<string, string>;
      expect(Object.keys(env).filter(n => !allowed.has(key(n)) && n !== ALLOWED && n !== "FIXED_NAME")).toEqual([]);
      expect(Object.keys(env).map(key)).toContain("PATH");
      if (process.platform === "win32") expect(Object.keys(env).map(key)).toContain("SYSTEMROOT");
      // Fixed values cannot re-enable Git prompts.
      expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    }
    const env = JSON.parse(named.stdout) as Record<string, string>;
    expect(env[ALLOWED]).toBe("allowed-value"); expect(env.FIXED_NAME).toBe("fixed");
    expect(JSON.parse(minimal.stdout)[ALLOWED]).toBeUndefined();
  });
  it("keeps the sentinel secret out of the real Git and TaskStance CLI subprocess environments", async () => {
    const f = await fixture();
    await writeFile(resolve(f.root, "adapter.json"), JSON.stringify({ ...JSON.parse(await readFile(resolve(f.root, "adapter.json"), "utf8")), inherit_env: [ALLOWED] }));
    const original = processes.runProcess; const observed: { kind: string; env: Record<string, string> }[] = [];
    vi.spyOn(processes, "runProcess").mockImplementation(async (exe, args, cwd, timeout, capture, env) => {
      const kind = exe === "git" ? "git" : args.includes("--benchmark-json") ? "cli" : "verifier";
      // Same environment specification, observed through a real child before the real command runs.
      const seen = await original(process.execPath, dump, cwd, 10_000, true, env);
      observed.push({ kind, env: JSON.parse(seen.stdout) as Record<string, string> });
      return original(exe, args, cwd, timeout, capture, env);
    });
    process.env[ALLOWED] = "allowed-value";
    const result = await withSentinel(() => runBenchmark(f.manifest, f.options)).finally(() => { delete process.env[ALLOWED]; });
    expect(result).toMatchObject({ outcome: "passed", failures: [] });
    expect(new Set(observed.map(o => o.kind))).toEqual(new Set(["git", "cli", "verifier"]));
    expect(JSON.stringify(observed)).not.toContain(VALUE);
    const gitEnvs = observed.filter(o => o.kind === "git").map(o => o.env);
    expect(gitEnvs.every(e => e.GIT_CONFIG_GLOBAL === "/dev/null" && Boolean(e.GIT_CEILING_DIRECTORIES) && e[ALLOWED] === undefined)).toBe(true);
    const cli = observed.find(o => o.kind === "cli")!.env;
    // Only names the Codex adapter would forward to the executor anyway reach the CLI.
    const executorNames = new Set([...BASE_ENV, ALLOWED, ...processes.MINIMAL_ENV, ...libuv, "GIT_TERMINAL_PROMPT", "GIT_ASKPASS", "SSH_ASKPASS"].map(key));
    expect(Object.keys(cli).filter(n => !executorNames.has(key(n)))).toEqual([]);
    expect(cli[ALLOWED]).toBe("allowed-value");
  });
  describe("repository-controlled Git configuration", () => {
    async function probe(root: string) {
      const marker = resolve(root, "helper-ran.txt"); const script = resolve(root, "probe.cjs");
      await writeFile(script, `require("fs").appendFileSync(${JSON.stringify(marker)}, "ran " + (process.env.${SENTINEL} || "") + "\\n");\nprocess.stdin.pipe(process.stdout);\n`);
      const command = `\\"${process.execPath.replaceAll("\\", "/")}\\" \\"${script.replaceAll("\\", "/")}\\"`;
      return { marker, config: `[filter "probe"]\n\tclean = ${command}\n[core]\n\tfsmonitor = ${command}\n` };
    }
    const exists = (path: string) => readFile(path).then(() => true, () => false);
    async function control(root: string, config: string, env: NodeJS.ProcessEnv = process.env) {
      // Proves the planted helper really executes under plain Git on this platform.
      const repo = resolve(root, "control"); await mkdir(repo); git(repo, ["init"]);
      await writeFile(resolve(repo, "a.txt"), "a\n"); git(repo, ["add", "a.txt"]);
      git(repo, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "c"]);
      if (config) await writeFile(resolve(repo, ".git/config"), `${await readFile(resolve(repo, ".git/config"), "utf8")}${config}`);
      await writeFile(resolve(repo, ".gitattributes"), "* filter=probe\n"); await writeFile(resolve(repo, "a.txt"), "changed\n");
      for (const args of [["status", "--porcelain"], ["diff", "HEAD", "--name-only"]]) {
        execFileSync("git", ["-c", `safe.directory=${repo.replaceAll("\\", "/")}`, ...args], { cwd: repo, env, stdio: "ignore" });
      }
    }
    it("never runs Git in a checkout whose repository config the executor or a verifier rewrote", async () => {
      const f = await fixture(); const { marker, config } = await probe(f.root);
      f.manifest.verification.push({ id: "plant", executable: process.execPath, timeout_ms: 2000,
        args: ["-e", `const fs=require("fs");fs.appendFileSync(".git/config",${JSON.stringify(config)});fs.writeFileSync(".gitattributes","* filter=probe\\n");fs.writeFileSync("README.md","Status: ready (planted)\\n")`] });
      const launched = vi.spyOn(processes, "runProcess");
      const result = await withSentinel(() => runBenchmark(f.manifest, f.options));
      expect(await exists(marker)).toBe(false);
      expect(result).toMatchObject({ outcome: "failed", failures: ["repository_mutated"], changed_paths: [], change_evidence: null, scope_conformant: null });
      const plant = launched.mock.calls.findIndex(call => call[1].some(arg => arg.includes("filter=probe")));
      expect(launched.mock.calls.slice(plant + 1).some(call => call[0] === "git")).toBe(false);
      await withSentinel(() => control(f.root, config));
      expect(await readFile(marker, "utf8")).toContain(`ran ${VALUE}`);
    });
    it("ignores parent-supplied Git configuration and fsmonitor even when repository config is unchanged", async () => {
      const f = await fixture(); const { marker, config } = await probe(f.root);
      const global = resolve(f.root, "parent.gitconfig"); await writeFile(global, config);
      f.manifest.allowed_changed_paths.push(".gitattributes");
      f.manifest.verification.push({ id: "attributes", executable: process.execPath, timeout_ms: 2000,
        args: ["-e", `require("fs").writeFileSync(".gitattributes","* filter=probe\\n")`] });
      const names = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"];
      const values = [global, "1", "core.fsmonitor", JSON.parse(`"${config.split("fsmonitor = ")[1]!.trim()}"`)];
      names.forEach((name, i) => { process.env[name] = values[i]; });
      const result = await withSentinel(() => runBenchmark(f.manifest, f.options)).finally(() => { for (const name of names) delete process.env[name]; });
      expect(await exists(marker)).toBe(false);
      expect(result).toMatchObject({ outcome: "passed", failures: [] });
      expect(result.changed_paths).toEqual([".gitattributes", "README.md", "launch.json"]);
      await withSentinel(() => control(f.root, "", { ...process.env, GIT_CONFIG_GLOBAL: global }));
      expect(await readFile(marker, "utf8")).toContain(`ran ${VALUE}`);
    });
  });
  it("runs manifest verification without parent secrets and fails closed when one is required", async () => {
    const f = await fixture();
    const probe = (failIfPresent: boolean) => ["-e", `process.exit(process.env.${SENTINEL} ${failIfPresent ? "!==" : "==="} undefined ? 3 : 0)`];
    const manifest = BenchmarkManifestSchema.parse({ ...f.manifest, verification: [...f.manifest.verification,
      { id: "secret-absent", executable: process.execPath, args: probe(true), timeout_ms: 2000 },
      { id: "secret-required", executable: process.execPath, args: probe(false), timeout_ms: 2000 }] });
    const launched = vi.spyOn(processes, "runProcess");
    const result = await withSentinel(() => runBenchmark(manifest, f.options));
    expect(result.verification.map(v => [v.id, v.status])).toEqual([["readme", "passed"], ["secret-absent", "passed"], ["secret-required", "failed"]]);
    expect(result).toMatchObject({ outcome: "failed", failures: ["verification_failed"] });
    expect(JSON.stringify(result)).not.toContain(VALUE);
    // Verifiers and Git add nothing from the parent; only the CLI receives the Codex adapter's explicit names.
    const verifiers = launched.mock.calls.filter(call => call[0] === process.execPath && !call[1].includes("--benchmark-json"));
    expect(verifiers).toHaveLength(3); expect(verifiers.every(call => call[5] === undefined)).toBe(true);
    const gits = launched.mock.calls.filter(call => call[0] === "git");
    expect(gits.length).toBeGreaterThan(0); expect(gits.every(call => call[5]?.inherit === undefined)).toBe(true);
    const cli = launched.mock.calls.filter(call => call[1].includes("--benchmark-json"));
    expect(cli).toHaveLength(1); expect(cli[0]![5]).toEqual({ inherit: [...BASE_ENV] });
  });
  it("runs the trusted PATH program instead of one planted in the clone or reached via a relative PATH entry", async () => {
    const clone = await mkdtemp(resolve(tmpdir(), "taskstance-benchmark-test-")); dirs.push(clone);
    if (process.platform === "win32") await copyFile(resolve(process.env.SystemRoot ?? "C:\\Windows", "System32", "hostname.exe"), resolve(clone, "node.exe"));
    else { await writeFile(resolve(clone, "node"), "#!/bin/sh\nexit 7\n"); await chmod(resolve(clone, "node"), 0o755); }
    const original = process.env.PATH;
    try {
      process.env.PATH = `.${delimiter}${original ?? ""}`;
      expect(await processes.runProcess("node", ["-e", "process.stdout.write('REAL-NODE')"], clone, 10_000))
        .toMatchObject({ ok: true, exit_code: 0, stdout: "REAL-NODE" });
      expect(await processes.runProcess("./node", [], clone, 10_000)).toMatchObject({ ok: false, exit_code: null, stdout: "" });
    } finally {
      if (original === undefined) delete process.env.PATH; else process.env.PATH = original;
    }
  });
});
