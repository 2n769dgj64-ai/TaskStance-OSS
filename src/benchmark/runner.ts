import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { BASE_ENV as EXECUTOR_BASE_ENV, CodexAdapterConfigSchema, CodexExecutorAdapter } from "../integrations/codex.js";
import { parseProjectConfig } from "../project-config.js";
import { selectJudgmentAdapter } from "../integrations/judgment-registry.js";
import { type BenchmarkManifest, BenchmarkManifestSchema, BenchmarkResultSchema, ExecutorResultSchema, RunMeasurementsSchema, type BenchmarkResult, type BenchmarkResultV2, type BenchmarkResultV3 } from "./schemas.js";
import { runProcess } from "./process.js";
import { canonicalJsonSha256, canonicalValueSha256, computeChangeEvidence } from "./provenance.js";

type Failure = BenchmarkResult["failures"][number];
class Refusal extends Error { constructor(readonly code: Failure) { super(code); } }
const refuse = (code: Failure): never => { throw new Refusal(code); };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export function pathAllowed(path: string, patterns: string[]): boolean {
  return patterns.some(pattern => {
    const escaped = pattern.split("/").map(part => part === "**" ? ".*" : part.split("*").map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")).join("/");
    return new RegExp(`^${escaped}$`).test(path);
  });
}
/**
 * Git gets the minimal environment (no parent GIT_*, proxy or credential variables) and never reads user-level
 * (global/XDG) configuration, which may hold credential helpers, token-bearing `url.*.insteadOf`, hooks or filters.
 * Machine-level system configuration remains trusted. Discovery cannot climb above `cwd`'s parent. Repository config
 * is checked unchanged before Git runs in an executor-touched checkout (`gitBoundary`); fsmonitor is disabled here too.
 */
const gitEnvironment = (cwd: string) => ({ fixed: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CEILING_DIRECTORIES: dirname(cwd) } });
async function runGit(cwd: string, args: string[]) {
  return runProcess("git", ["-c", `safe.directory=${cwd.replaceAll("\\", "/")}`, "-c", "credential.helper=", "-c", "core.fsmonitor=", ...args],
    cwd, 60_000, true, gitEnvironment(cwd));
}
let gitSupported = false;
async function git(cwd: string, args: string[]): Promise<string> {
  if (!gitSupported) {
    // GIT_CONFIG_GLOBAL needs Git 2.32+; older Git would silently read user configuration, so it is refused.
    const v = await runGit(cwd, ["version"]);
    const [, major, minor] = /^git version (\d+)\.(\d+)/.exec(v.stdout) ?? [];
    if (!v.ok || !(Number(major) > 2 || (Number(major) === 2 && Number(minor) >= 32))) refuse("harness_failed");
    gitSupported = true;
  }
  const r = await runGit(cwd, args);
  if (!r.ok) refuse("harness_failed");
  return r.stdout;
}
async function maskedTrackedPaths(cwd: string): Promise<string[]> {
  // -v lowercases assume-unchanged tags; S (or s with both flags) means skip-worktree.
  // NUL records preserve path whitespace and avoid Git's quoted-path format.
  const entries = await git(cwd, ["ls-files", "-v", "-z"]);
  return entries.split("\0").filter(entry => entry[0] === "S" || /^[a-z]$/.test(entry[0] ?? ""))
    .map(entry => entry.slice(2));
}
async function clean(cwd: string) {
  // Include ignored/untracked files: a fixture cannot hide dirty baseline data behind .gitignore.
  if ((await git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"])) ||
      (await git(cwd, ["ls-files", "--others", "-z"]))) refuse("dirty_workspace");
  if ((await maskedTrackedPaths(cwd)).length) refuse("dirty_workspace");
}
async function configFile(root: string, path: string): Promise<string> {
  const target = await realpath(resolve(root, path));
  const rel = relative(root, target);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) refuse("configuration_invalid");
  return target;
}
/**
 * Repository-controlled Git configuration of a checkout: `.git` must stay a real directory with the same `config` and no
 * `commondir`/`config.worktree` redirect. Config written by the executor or a verifier could otherwise make the harness's
 * own Git commands launch helpers (e.g. `filter.<name>.clean`, `core.fsmonitor`) outside any executor sandbox.
 */
async function gitBoundary(cwd: string): Promise<string> {
  const dir = resolve(cwd, ".git");
  const absent = (name: string) => lstat(resolve(dir, name)).then(() => false, () => true);
  try {
    const info = await lstat(dir);
    return JSON.stringify([info.isDirectory() && !info.isSymbolicLink(), await readFile(resolve(dir, "config"), "utf8"),
      await absent("commondir"), await absent("config.worktree")]);
  } catch { return "unavailable"; }
}
interface CheckoutSnapshot { boundary: string; metadata: string }
async function snapshot(cwd: string): Promise<CheckoutSnapshot> {
  // The boundary is read first, so it is captured before this call runs Git itself.
  const boundary = await gitBoundary(cwd);
  return { boundary, metadata: JSON.stringify([await git(cwd, ["rev-parse", "HEAD"]), await git(cwd, ["show-ref"]),
    await readFile(resolve(cwd, ".git/config"), "utf8"), await readFile(resolve(cwd, ".git/logs/HEAD"), "utf8")]) };
}
/** Live/fixture gate and source validation shared by both arms. Returns the TaskStance repository and clone source. */
async function resolveSource(manifest: BenchmarkManifest, options: BenchmarkOptions): Promise<{ own: string; source: string }> {
  if (!options.local_source && !options.live) refuse("workspace_refused");
  // A local source cannot be combined with live mode; fixture runs must never invoke a hosted executor.
  if (options.local_source && options.live) refuse("workspace_refused");
  const own = await realpath(options.taskstance_repository);
  let source = manifest.upstream_repository;
  if (options.local_source) {
    source = await realpath(options.local_source);
    const ownCommon = (await git(own, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
    const sourceCommon = (await git(source, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
    const origin = (await git(source, ["remote", "-v"])).toLowerCase();
    if (ownCommon.toLowerCase() === sourceCommon.toLowerCase() || origin.includes("2n769dgj64-ai/taskstance")) refuse("workspace_refused");
    await clean(source);
    if ((await git(source, ["rev-parse", "HEAD"])).trim() !== manifest.baseline_commit) refuse("baseline_mismatch");
  } else {
    // Anonymous metadata lookup prevents a private target from being accepted via ambient Git credentials.
    const repository = manifest.upstream_repository.slice("https://github.com/".length);
    const response = await fetch(`https://api.github.com/repos/${repository}`, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) refuse("workspace_refused");
    const info = await response.json() as { private?: unknown; full_name?: unknown };
    if (info.private !== false || typeof info.full_name !== "string" || info.full_name.toLowerCase() !== repository.toLowerCase()) refuse("workspace_refused");
  }
  return { own, source };
}
/** Fresh disposable clone at the pinned baseline; the path is recorded in `holder` before cloning so cleanup always runs. */
async function cloneBaseline(manifest: BenchmarkManifest, options: BenchmarkOptions, source: string, holder: { disposable?: string }): Promise<{ disposable: string; checkout: string }> {
  const disposable = holder.disposable = await mkdtemp(resolve(options.workspace_root ?? tmpdir(), "taskstance-benchmark-"));
  const checkout = resolve(disposable, "checkout");
  await git(disposable, ["clone", "--no-local", "--no-hardlinks", "--no-checkout", "--", source, checkout]);
  await git(checkout, ["checkout", "--detach", manifest.baseline_commit]);
  if ((await git(checkout, ["rev-parse", "HEAD"])).trim() !== manifest.baseline_commit) refuse("baseline_mismatch");
  await clean(checkout);
  return { disposable, checkout };
}
export interface EvidenceTarget {
  verification: BenchmarkResult["verification"]; failures: Failure[]; changed_paths: string[];
  change_evidence: BenchmarkResultV2["change_evidence"]; scope_conformant: boolean | null;
}
/** Verification, mutation detection, changed paths, hardened change evidence and scope check shared by both arms. */
async function collectEvidence(checkout: string, manifest: BenchmarkManifest, before: CheckoutSnapshot, result: EvidenceTarget): Promise<void> {
  // Failed executions remain in evidence, including their verification and changed paths.
  for (const [i, command] of manifest.verification.entries()) {
    // Verification may run executor-modified code: minimal environment, never the parent's credentials.
    const checked = await runProcess(command.executable, command.args, checkout, command.timeout_ms, false);
    result.verification[i] = { id: command.id, status: checked.ok ? "passed" : "failed", exit_code: checked.exit_code, duration_ms: checked.duration_ms };
    if (!checked.ok && !result.failures.includes("verification_failed")) result.failures.push("verification_failed");
  }
  // Fail closed without running Git at all: changed paths, change evidence and scope stay unknown.
  if (await gitBoundary(checkout) !== before.boundary) { result.failures.push("repository_mutated"); return; }
  const maskedPaths = await maskedTrackedPaths(checkout);
  if ((await snapshot(checkout)).metadata !== before.metadata || maskedPaths.length) result.failures.push("repository_mutated");
  const tracked = await git(checkout, ["diff", manifest.baseline_commit, "--name-only", "--no-renames", "-z"]);
  const untracked = await git(checkout, ["ls-files", "--others", "-z"]);
  result.changed_paths = [...new Set([...maskedPaths, ...(tracked + untracked).split("\0").filter(Boolean)])].sort();
  // Must run before cleanup; any failure propagates to harness_failed (fail closed).
  const states = new Map<string, string>();
  const status = (await git(checkout, ["diff", manifest.baseline_commit, "--name-status", "--no-renames", "-z"])).split("\0").filter(Boolean);
  for (let i = 0; i + 1 < status.length; i += 2) states.set(status[i + 1]!, status[i]!);
  for (const p of untracked.split("\0").filter(Boolean)) states.set(p, "untracked");
  for (const p of result.changed_paths) if (!states.has(p)) states.set(p, "masked");
  result.change_evidence = await computeChangeEvidence(checkout, states);
  result.scope_conformant = result.changed_paths.every(p => pathAllowed(p, manifest.allowed_changed_paths));
  if (!result.scope_conformant) result.failures.push("scope_violation");
}
export interface BenchmarkOptions {
  /** Local fixture source only. Omit for explicit public upstream runs. */
  local_source?: string;
  live?: boolean;
  config_root: string;
  taskstance_repository: string;
  workspace_root?: string;
}
/** Always creates a new isolated clone; never resets, cleans, commits or pushes a source checkout. */
export async function runBenchmark(raw: unknown, options: BenchmarkOptions): Promise<BenchmarkResultV2> {
  const manifest = BenchmarkManifestSchema.parse(raw);
  const start = performance.now();
  const result: BenchmarkResultV2 = {
    schema_version: "2", benchmark_id: manifest.benchmark_id, mode: "taskstance",
    upstream_repository: manifest.upstream_repository, baseline_commit: manifest.baseline_commit,
    source_kind: options.local_source ? "local_fixture" : "public_upstream",
    environment: { platform: process.platform, node_version: process.version },
    configuration: { executor_adapter: manifest.executor.adapter, executor_config_ref: manifest.executor.config,
      taskstance_config_ref: manifest.taskstance_config, judgment_config_ref: manifest.judgment?.config ?? null,
      model: null, reasoning_effort: null, manifest_sha256: hash(JSON.stringify(manifest)),
      taskstance_config_sha256: null, executor_config_sha256: null, judgment_config_sha256: null,
      taskstance_config_canonical_sha256: null, executor_config_canonical_sha256: null, judgment_config_canonical_sha256: null },
    measurements: null, escalation_status: "unknown", duration_ms: 0,
    verification: manifest.verification.map(v => ({ id: v.id, status: "not_run", exit_code: null, duration_ms: null })),
    changed_paths: [], change_evidence: null, scope_conformant: null, failures: [], outcome: "failed",
  };
  const workspace: { disposable?: string } = {};
  try {
    const { own, source } = await resolveSource(manifest, options);
    const root = await realpath(options.config_root);
    let config: string; let adapter: string; let judgment: string | undefined;
    let configText: string; let adapterText: string; let judgmentText: string | undefined;
    let expectedAdapter: ReturnType<typeof CodexAdapterConfigSchema.parse>;
    try {
      config = await configFile(root, manifest.taskstance_config);
      adapter = await configFile(root, manifest.executor.config);
      configText = await readFile(config, "utf8"); adapterText = await readFile(adapter, "utf8");
      const project = parseProjectConfig(JSON.parse(configText));
      const adapterConfig = expectedAdapter = CodexAdapterConfigSchema.parse(JSON.parse(adapterText));
      result.configuration.taskstance_config_sha256 = hash(configText);
      result.configuration.executor_config_sha256 = hash(adapterText);
      result.configuration.taskstance_config_canonical_sha256 = canonicalJsonSha256(configText);
      result.configuration.executor_config_canonical_sha256 = canonicalJsonSha256(adapterText);
      if (!(adapterConfig.executor in project.executors)) refuse("configuration_invalid");
      // Fixture mode requires the checked-in local Codex double, never an arbitrary executable/provider.
      if (options.local_source && (adapterConfig.executable !== process.execPath ||
          adapterConfig.cli_entrypoint !== resolve(own, "test/fixtures/codex-cli.mjs") || manifest.judgment)) refuse("configuration_invalid");
      if (manifest.judgment) {
        judgment = await configFile(root, manifest.judgment.config);
        judgmentText = await readFile(judgment, "utf8");
        selectJudgmentAdapter(manifest.judgment.adapter)(JSON.parse(judgmentText), Object.keys(project.executors));
        result.configuration.judgment_config_sha256 = hash(judgmentText);
        result.configuration.judgment_config_canonical_sha256 = canonicalJsonSha256(judgmentText);
      }
    } catch { refuse("configuration_invalid"); }
    const { disposable, checkout } = await cloneBaseline(manifest, options, source, workspace);
    const before = await snapshot(checkout);
    const task = resolve(disposable, "task.json"); const context = resolve(disposable, "context.json");
    // CLI reads immutable snapshots of the reviewed bytes whose hashes are recorded.
    config = resolve(disposable, "project.json"); adapter = resolve(disposable, "adapter.json");
    await writeFile(config, configText!); await writeFile(adapter, adapterText!);
    if (judgmentText !== undefined) { judgment = resolve(disposable, "judgment.json"); await writeFile(judgment, judgmentText); }
    await writeFile(task, JSON.stringify(manifest.task));
    await writeFile(context, JSON.stringify(manifest.initial_context_paths));
    const cli = resolve(own, "dist/cli.js");
    // The CLI launches the executor on the checkout. It receives only the names its Codex adapter would forward anyway
    // (the executor base set plus the reviewed config's `inherit_env`), never the rest of the parent environment.
    const execution = await runProcess(process.execPath, [cli, "run", "--adapter", manifest.executor.adapter,
      "--config", config!, "--task", task, "--adapter-config", adapter!, "--workspace", checkout,
      "--context", context, "--benchmark-json", ...(judgment ? ["--judgment", "process", "--judgment-config", judgment] : [])], own, manifest.timeout_ms, true,
      { inherit: [...EXECUTOR_BASE_ENV, ...expectedAdapter!.inherit_env] });
    try {
      const measured = RunMeasurementsSchema.parse(JSON.parse(execution.stdout));
      if (measured.profile.executor !== expectedAdapter!.executor ||
          measured.executor.model !== expectedAdapter!.models[measured.profile.model_tier] ||
          measured.executor.reasoning_effort !== (measured.profile.reasoning_effort === "minimal" ? "low" : measured.profile.reasoning_effort) ||
          measured.initial_context_files !== manifest.initial_context_paths.length) refuse("result_invalid");
      result.measurements = measured;
      result.configuration.model = result.measurements.executor.model;
      result.configuration.reasoning_effort = result.measurements.executor.reasoning_effort;
      result.escalation_status = result.measurements.requires_replan ? "requires_replan" : "not_observed";
    } catch { result.failures.push("result_invalid"); }
    if (!execution.ok || result.measurements?.executor.status !== "completed") result.failures.push("execution_failed");
    await collectEvidence(checkout, manifest, before, result);
    result.outcome = result.failures.length ? "failed" : "passed";
  } catch (error) {
    result.failures.push(error instanceof Refusal ? error.code : "harness_failed");
  } finally {
    if (workspace.disposable) {
      try { await rm(workspace.disposable, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
      catch { result.failures.push("harness_failed"); result.outcome = "failed"; }
    }
  }
  result.duration_ms = Math.round(performance.now() - start);
  return BenchmarkResultSchema.parse(result) as BenchmarkResultV2;
}

/** A direct run is refused before any clone, network access or executor launch when the pairing is not exact. */
export class PairingError extends Error {}
export interface VerifiedPairing {
  adapter_config: ReturnType<typeof CodexAdapterConfigSchema.parse>;
  adapter_text: string;
  pairing: BenchmarkResultV3["pairing"];
}
/**
 * Fail-closed pairing check. The paired record must be a schema-v2 TaskStance record for the same benchmark, baseline,
 * manifest bytes (hence task, verification and scope), executor configuration meaning and source kind. The direct arm's
 * model and reasoning effort are those the paired record observed; they are never chosen from the direct side.
 */
export async function verifyPairing(raw: unknown, paired: unknown, options: Pick<BenchmarkOptions, "config_root" | "local_source">): Promise<VerifiedPairing> {
  const manifest = BenchmarkManifestSchema.parse(raw);
  const bad = (): never => { throw new PairingError("Pairing mismatch"); };
  const record = BenchmarkResultSchema.parse(paired);
  if (record.schema_version !== "2" || record.mode !== "taskstance") return bad();
  const m = record.measurements;
  if (record.benchmark_id !== manifest.benchmark_id || record.upstream_repository !== manifest.upstream_repository ||
      record.baseline_commit !== manifest.baseline_commit || record.configuration.manifest_sha256 !== hash(JSON.stringify(manifest)) ||
      record.source_kind !== (options.local_source ? "local_fixture" : "public_upstream") ||
      record.configuration.executor_adapter !== manifest.executor.adapter ||
      record.configuration.executor_config_ref !== manifest.executor.config || !m ||
      record.configuration.executor_config_canonical_sha256 === null ||
      record.verification.length !== manifest.verification.length ||
      record.verification.some((v, i) => v.id !== manifest.verification[i]!.id || v.status === "not_run") ||
      record.scope_conformant === null ||
      record.scope_conformant !== record.changed_paths.every(p => pathAllowed(p, manifest.allowed_changed_paths))) return bad();
  let adapterText: string;
  let config: ReturnType<typeof CodexAdapterConfigSchema.parse>;
  try {
    adapterText = await readFile(await configFile(await realpath(options.config_root), manifest.executor.config), "utf8");
    config = CodexAdapterConfigSchema.parse(JSON.parse(adapterText));
    if (canonicalJsonSha256(adapterText) !== record.configuration.executor_config_canonical_sha256) return bad();
  } catch { return bad(); }
  if (!Object.values(config.models).includes(m.executor.model)) return bad();
  return { adapter_config: config, adapter_text: adapterText, pairing: {
    taskstance_benchmark_id: record.benchmark_id, taskstance_result_canonical_sha256: canonicalValueSha256(record),
    manifest_sha256: record.configuration.manifest_sha256, executor_config_canonical_sha256: record.configuration.executor_config_canonical_sha256,
    model: m.executor.model, reasoning_effort: m.executor.reasoning_effort } };
}
/**
 * Direct (no TaskStance control) arm: same disposable clone, checks, verification, scope and change evidence as
 * `runBenchmark`, but the Codex adapter is launched in-process with only the task statement, the shared safety
 * sentences and the paired record's model/reasoning. No judgment, profile or context packet exists on this path.
 */
export async function runDirectBenchmark(raw: unknown, paired: unknown, options: BenchmarkOptions): Promise<BenchmarkResultV3> {
  const manifest = BenchmarkManifestSchema.parse(raw);
  const pin = await verifyPairing(manifest, paired, options);
  const start = performance.now();
  const result: BenchmarkResultV3 = {
    schema_version: "3", mode: "direct", benchmark_id: manifest.benchmark_id,
    upstream_repository: manifest.upstream_repository, baseline_commit: manifest.baseline_commit,
    source_kind: options.local_source ? "local_fixture" : "public_upstream",
    environment: { platform: process.platform, node_version: process.version },
    configuration: { executor_adapter: manifest.executor.adapter, executor_config_ref: manifest.executor.config,
      manifest_sha256: hash(JSON.stringify(manifest)), executor_config_sha256: hash(pin.adapter_text),
      executor_config_canonical_sha256: canonicalJsonSha256(pin.adapter_text), model: null, reasoning_effort: null },
    pairing: pin.pairing, measurements: null, duration_ms: 0,
    verification: manifest.verification.map(v => ({ id: v.id, status: "not_run", exit_code: null, duration_ms: null })),
    changed_paths: [], change_evidence: null, scope_conformant: null, failures: [], outcome: "failed",
  };
  const workspace: { disposable?: string } = {};
  try {
    const { own, source } = await resolveSource(manifest, options);
    // Fixture mode requires the checked-in local Codex double, never an arbitrary executable/provider.
    if (options.local_source && (pin.adapter_config.executable !== process.execPath ||
        pin.adapter_config.cli_entrypoint !== resolve(own, "test/fixtures/codex-cli.mjs"))) refuse("configuration_invalid");
    const { checkout } = await cloneBaseline(manifest, options, source, workspace);
    const before = await snapshot(checkout);
    try {
      const adapter = new CodexExecutorAdapter(pin.adapter_config, checkout, []);
      const launch = await adapter.prepareDirect({ task: manifest.task, model: pin.pairing.model, reasoning_effort: pin.pairing.reasoning_effort });
      let executed: unknown;
      try { executed = await adapter.execute(launch, AbortSignal.timeout(manifest.timeout_ms)); }
      catch { result.failures.push("execution_failed"); }
      if (executed !== undefined) {
        try {
          const executor = ExecutorResultSchema.parse(executed);
          result.measurements = { schema_version: "1", executor };
          result.configuration.model = executor.model;
          result.configuration.reasoning_effort = executor.reasoning_effort;
          if (executor.model !== pin.pairing.model || executor.reasoning_effort !== pin.pairing.reasoning_effort) result.failures.push("result_invalid");
          if (executor.status !== "completed") result.failures.push("execution_failed");
        } catch { result.failures.push("result_invalid"); }
      }
    } catch { result.failures.push("execution_failed"); }
    await collectEvidence(checkout, manifest, before, result);
    result.outcome = result.failures.length ? "failed" : "passed";
  } catch (error) {
    result.failures.push(error instanceof Refusal ? error.code : "harness_failed");
  } finally {
    if (workspace.disposable) {
      try { await rm(workspace.disposable, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
      catch { result.failures.push("harness_failed"); result.outcome = "failed"; }
    }
  }
  result.duration_ms = Math.round(performance.now() - start);
  return BenchmarkResultSchema.parse(result) as BenchmarkResultV3;
}
