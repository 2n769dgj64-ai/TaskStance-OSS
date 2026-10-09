import { mkdtemp, readFile, rm, writeFile, access, symlink, copyFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createDecisionRuntime } from "../src/runtime-core.js";
import { createUnavailableProviderBundle } from "../src/offline-providers.js";
import { executeWithExecutorAdapter } from "../src/executor-adapter.js";
import { CodexExecutorAdapter } from "../src/integrations/codex.js";
import { prepareLocalExecution, resolveTrustedExecutable, windowsTaskkillPath } from "../src/integrations/local-context.js";
import { workspaceLockPath } from "../src/integrations/workspace-lock.js";

const fixture = fileURLToPath(new URL("./fixtures/codex-cli.mjs", import.meta.url));
const dirs: string[] = [];
const task = { data_classification: "engineering_non_sensitive" as const, summary: "Update README. $(echo injected)", flags: { docs_only: true } };
const runtime = () => createDecisionRuntime(createUnavailableProviderBundle(), {
  executors: { primary: "Local executor", replan: "Stop and replan" }, defaultExecutor: "primary",
});
async function setup(mode = "success", timeout = 5000) {
  const workspace = await mkdtemp(join(tmpdir(), "taskstance-test-"));
  dirs.push(workspace);
  await writeFile(join(workspace, "README.md"), "# Synthetic fixture\nStatus: pending\n");
  const local = await prepareLocalExecution(runtime(), task, workspace, ["README.md"]);
  const adapter = new CodexExecutorAdapter({ version: "1", executor: "primary",
    models: { cheap: mode, balanced: mode, strong: mode, max: mode }, cli_entrypoint: fixture,
    timeout_ms: timeout, max_output_bytes: 2048 }, workspace, local.files);
  return { workspace, local, adapter };
}
afterEach(async () => {
  for (const dir of dirs) await expect(access(await workspaceLockPath(dir))).rejects.toThrow();
  // Windows can briefly retain a directory handle after process-tree cancellation.
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

describe("Codex executor process integration", () => {
  it("discovers/prunes mandatory files, launches stdin JSONL, modifies a real file, and returns aggregate results", async () => {
    const { workspace, local, adapter } = await setup();
    const result = await executeWithExecutorAdapter(adapter, local.preparation);
    expect(result).toMatchObject({ status: "completed", reason: "turn_completed", model: "success", reasoning_effort: "low", usage: { input_tokens: 30, output_tokens: 7 } });
    expect(await readFile(join(workspace, "README.md"), "utf8")).toContain("Status: ready");
    const launch = JSON.parse(await readFile(join(workspace, "launch.json"), "utf8"));
    expect(launch.args).toEqual(expect.arrayContaining(["--no-daemon", "exec", "--sandbox", "workspace-write", "--ignore-user-config", "--ephemeral", "--json", "-"]));
    expect(launch.args).toContain('features.multi_agent=false');
    expect(launch.prompt).toContain(task.summary);
    expect(launch.prompt).toContain('"test_depth":"none"');
    expect(JSON.stringify(result)).not.toMatch(/private raw|secret raw|Update README|Synthetic fixture/);
    expect(local.preparation.context_packet).toMatchObject({ source: "deterministic", selected_ids: ["README.md"], requires_replan: false });
  });

  it.each(["invalid", "missing", "no-usage", "nonzero", "failed", "overflow", "closed-stdin"])("fails conservatively for %s output", async (mode) => {
    const { local, adapter } = await setup(mode);
    const result = await executeWithExecutorAdapter(adapter, local.preparation);
    expect(result.status).toBe("failed");
    expect(JSON.stringify(result)).not.toContain("secret raw error");
  });

  it("reports a missing executable without exposing raw process errors", async () => {
    const { local, workspace } = await setup();
    const adapter = new CodexExecutorAdapter({ version: "1", executor: "primary", executable: join(workspace, "absent"),
      models: { cheap: "model", balanced: "model", strong: "model", max: "model" } }, workspace, local.files);
    expect(await executeWithExecutorAdapter(adapter, local.preparation)).toMatchObject({ status: "failed", reason: "process_error" });
  });

  it("releases the lock after synchronous launch failure", async () => {
    const { local, workspace } = await setup();
    const adapter = new CodexExecutorAdapter({ version: "1", executor: "primary", executable: "invalid\u0000executable",
      models: { cheap: "model", balanced: "model", strong: "model", max: "model" } }, workspace, local.files);
    await expect(executeWithExecutorAdapter(adapter, local.preparation)).rejects.toThrow();
    await expect(access(join(workspace, "launch.json"))).rejects.toThrow();
  });

  it("kills the process tree on timeout", async () => {
    const { local, adapter, workspace } = await setup("hang", 250);
    const result = await executeWithExecutorAdapter(adapter, local.preparation);
    expect(result).toMatchObject({ status: "timed_out", reason: "timeout" });
    await new Promise((resolve) => setTimeout(resolve, 800));
    await expect(access(join(workspace, "descendant.txt"))).rejects.toThrow();
  });

  it("cancels an active execution", async () => {
    const { local, adapter } = await setup("hang");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 200);
    try {
      expect(await executeWithExecutorAdapter(adapter, local.preparation, controller.signal)).toMatchObject({ status: "cancelled" });
    } finally { clearTimeout(timer); }
  });

  it("does not start on pre-abort, replan, mismatch, missing hydration, overflow, or unsupported strategy", async () => {
    const { local, adapter, workspace } = await setup();
    const controller = new AbortController(); controller.abort();
    await expect(executeWithExecutorAdapter(adapter, local.preparation, controller.signal)).rejects.toThrow("cancelled");
    for (const strategy of ["replan", "isolated", "staged"] as const) {
      const input = structuredClone(local.preparation); input.decision.profile.integration_strategy = strategy;
      await expect(executeWithExecutorAdapter(adapter, input)).rejects.toThrow();
    }
    const input = structuredClone(local.preparation); input.decision.profile.executor = "secondary";
    await expect(executeWithExecutorAdapter(adapter, input)).rejects.toThrow("mismatch");
    const missing = structuredClone(local.preparation); missing.context_packet!.selected_ids = ["missing"];
    await expect(executeWithExecutorAdapter(adapter, missing)).rejects.toThrow("hydrated");
    const overflow = structuredClone(local.preparation); overflow.context_packet!.selected_estimated_tokens = 9999;
    await expect(executeWithExecutorAdapter(adapter, overflow)).rejects.toThrow("budget");
    await expect(access(join(workspace, "launch.json"))).rejects.toThrow();
  });

  it("rejects replay and foreign prepared launches", async () => {
    const { adapter, local } = await setup();
    const launch = await adapter.prepare(local.preparation);
    await adapter.execute(launch);
    await expect(adapter.execute(launch)).rejects.toThrow("unused preparation");
    await expect(adapter.execute({ ...launch })).rejects.toThrow("unused preparation");
  });

  it("rejects simultaneous adapters in the same workspace", async () => {
    const { adapter, local, workspace } = await setup("hang");
    const second = new CodexExecutorAdapter({ version: "1", executor: "primary",
      models: { cheap: "success", balanced: "success", strong: "success", max: "success" },
      cli_entrypoint: fixture }, workspace, local.files);
    const launch = await adapter.prepare(local.preparation);
    const other = await second.prepare(local.preparation);
    const controller = new AbortController();
    const running = adapter.execute(launch, controller.signal);
    try { await expect(second.execute(other)).rejects.toThrow("Concurrent"); }
    finally { controller.abort(); await running; }
  });
});

describe("executor environment isolation", () => {
  const SECRET = "sentinel-secret-value-1f3a";
  const ALLOWED = "sentinel-allowed-value-9c2e";
  const models = { cheap: "success", balanced: "success", strong: "success", max: "success" };
  const saved = { s: process.env.TASKSTANCE_SECRET_SENTINEL, a: process.env.TASKSTANCE_ALLOWED_SENTINEL };
  const restore = (name: string, value: string | undefined) => { if (value === undefined) delete process.env[name]; else process.env[name] = value; };
  afterEach(() => {
    restore("TASKSTANCE_SECRET_SENTINEL", saved.s); restore("TASKSTANCE_ALLOWED_SENTINEL", saved.a);
  });
  const adapterWith = async (inherit_env?: string[]) => {
    const { workspace, local } = await setup();
    const adapter = new CodexExecutorAdapter({ version: "1", executor: "primary", models, cli_entrypoint: fixture,
      timeout_ms: 5000, ...(inherit_env ? { inherit_env } : {}) }, workspace, local.files);
    return { workspace, local, adapter };
  };
  const readEnv = async (workspace: string) => JSON.parse(await readFile(join(workspace, "launch.json"), "utf8")).environment;

  it("withholds arbitrary parent secrets, keeps standard home/path, and leaks nothing into results (TaskStance path)", async () => {
    process.env.TASKSTANCE_SECRET_SENTINEL = SECRET; process.env.TASKSTANCE_ALLOWED_SENTINEL = ALLOWED;
    const { workspace, local, adapter } = await adapterWith();
    const result = await executeWithExecutorAdapter(adapter, local.preparation);
    expect(result.status).toBe("completed");
    expect(await readEnv(workspace)).toMatchObject({ secret_sentinel: null, allowed_sentinel: null, has_home: true, has_path: true });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain(ALLOWED);
  });

  it("passes only an explicitly allowed variable (TaskStance path)", async () => {
    process.env.TASKSTANCE_SECRET_SENTINEL = SECRET; process.env.TASKSTANCE_ALLOWED_SENTINEL = ALLOWED;
    const { workspace, local, adapter } = await adapterWith(["TASKSTANCE_ALLOWED_SENTINEL"]);
    const result = await executeWithExecutorAdapter(adapter, local.preparation);
    expect(await readEnv(workspace)).toMatchObject({ secret_sentinel: null, allowed_sentinel: ALLOWED });
    expect(JSON.stringify(result)).not.toContain(ALLOWED);
  });

  it("applies the same isolation to the direct launch path", async () => {
    process.env.TASKSTANCE_SECRET_SENTINEL = SECRET; process.env.TASKSTANCE_ALLOWED_SENTINEL = ALLOWED;
    for (const inherit of [undefined, ["TASKSTANCE_ALLOWED_SENTINEL"]]) {
      const { workspace, adapter } = await adapterWith(inherit);
      const launch = await adapter.prepareDirect({ task, model: "success", reasoning_effort: "low" });
      const result = await adapter.execute(launch);
      expect(result.status).toBe("completed");
      expect(await readEnv(workspace)).toMatchObject({ secret_sentinel: null, allowed_sentinel: inherit ? ALLOWED : null, has_home: true });
      expect(JSON.stringify(result)).not.toMatch(new RegExp(`${SECRET}|${ALLOWED}`));
    }
  });

  it("rejects invalid allowlists before any launch", async () => {
    const { workspace, local } = await setup();
    const bad: unknown[] = [["*"], ["A-B"], ["1ABC"], ["A=B"], [""], ["A B"], ["DUP", "DUP"],
      Array.from({ length: 33 }, (_, i) => `VAR_${i}`), "ALL", [["NESTED"]]];
    for (const inherit_env of bad) {
      expect(() => new CodexExecutorAdapter({ version: "1", executor: "primary", models, cli_entrypoint: fixture,
        inherit_env: inherit_env as string[] }, workspace, local.files)).toThrow();
    }
    if (process.platform === "win32") {
      expect(() => new CodexExecutorAdapter({ version: "1", executor: "primary", models, cli_entrypoint: fixture,
        inherit_env: ["Proxy_Var", "PROXY_VAR"] }, workspace, local.files)).toThrow();
    }
    expect(() => new CodexExecutorAdapter({ version: "1", executor: "primary", models, cli_entrypoint: fixture,
      inherit_env: Array.from({ length: 32 }, (_, i) => `VAR_${i}`) }, workspace, local.files)).not.toThrow();
    await expect(access(join(workspace, "launch.json"))).rejects.toThrow();
  });
});

describe("explicit local context discovery", () => {
  it("rejects traversal, duplicate, binary, missing, environment, and excessive context before launch", async () => {
    const { workspace } = await setup();
    await writeFile(join(workspace, "binary"), Buffer.from([0, 1]));
    await writeFile(join(workspace, ".env"), "DO_NOT_SEND=yes");
    await writeFile(join(workspace, "large"), "x".repeat(16001));
    for (const paths of [["../outside"], ["README.md", "README.md"], ["binary"], ["missing"], [".env"], ["large"]]) {
      await expect(prepareLocalExecution(runtime(), task, workspace, paths)).rejects.toThrow();
    }
  });

  it("rejects an escaping symlink", async () => {
    const { workspace } = await setup();
    const outside = await mkdtemp(join(tmpdir(), "taskstance-outside-")); dirs.push(outside);
    await writeFile(join(outside, "secret"), "outside workspace");
    // Junctions avoid Windows developer-mode requirements.
    await symlink(outside, join(workspace, "link"), process.platform === "win32" ? "junction" : "dir");
    await expect(prepareLocalExecution(runtime(), task, workspace, ["link/secret"])).rejects.toThrow("escapes");
  });

  it("keeps unavailable judgment on replan before reading context", async () => {
    const { workspace } = await setup();
    await expect(prepareLocalExecution(runtime(), { ...task, flags: {} }, workspace, ["README.md"])).rejects.toThrow("only direct");
  });
});

/** A real executable file that is never the intended program (Windows: a renamed system binary). */
async function plantedExecutable(dir: string, name: string): Promise<string> {
  const path = join(dir, process.platform === "win32" ? `${name}.exe` : name);
  if (process.platform === "win32") await copyFile(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "hostname.exe"), path);
  else { await writeFile(path, "#!/bin/sh\nexit 7\n"); await chmod(path, 0o755); }
  return path;
}
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "taskstance-test-"));
  dirs.push(dir);
  return dir;
}
/** Relative and empty PATH entries; one of them points at the untrusted directory from the current cwd. */
function untrustedEntries(untrusted: string): string {
  const fromCwd = relative(process.cwd(), untrusted);
  return [".", "", ...(isAbsolute(fromCwd) ? [] : [fromCwd])].join(delimiter);
}

describe("trusted executable resolution", () => {
  it("resolves bare names only from absolute PATH entries, never the workspace or relative/empty entries", async () => {
    const workspace = await tempDir(); const trusted = await tempDir();
    await plantedExecutable(workspace, "codex-fixture");
    const expected = await plantedExecutable(trusted, "codex-fixture");
    expect(await resolveTrustedExecutable("codex-fixture", `${untrustedEntries(workspace)}${delimiter}${trusted}`)).toBe(expected);
    await expect(resolveTrustedExecutable("codex-fixture", untrustedEntries(workspace))).rejects.toThrow("absolute PATH entry");
  });

  it("returns absolute paths unchanged and refuses relative, drive-relative and NUL names", async () => {
    expect(await resolveTrustedExecutable(process.execPath, "")).toBe(process.execPath);
    for (const name of ["./codex", "bin/codex", "bin\\codex", "", "co\u0000dex", ...(process.platform === "win32" ? ["C:codex.exe"] : [])]) {
      await expect(resolveTrustedExecutable(name, process.env.PATH)).rejects.toThrow();
    }
  });

  it.runIf(process.platform === "win32")("never selects .cmd or .bat launchers on Windows", async () => {
    const trusted = await tempDir();
    await writeFile(join(trusted, "shim.cmd"), "@echo off\r\n");
    await writeFile(join(trusted, "shim.bat"), "@echo off\r\n");
    await expect(resolveTrustedExecutable("shim", trusted)).rejects.toThrow("absolute PATH entry");
  });

  it.runIf(process.platform !== "win32")("skips non-executable files on POSIX", async () => {
    const trusted = await tempDir();
    await writeFile(join(trusted, "plain"), "#!/bin/sh\n");
    await expect(resolveTrustedExecutable("plain", trusted)).rejects.toThrow("absolute PATH entry");
  });

  it("terminates Windows process trees through a fixed absolute taskkill path", () => {
    expect(isAbsolute(windowsTaskkillPath())).toBe(true);
    expect(windowsTaskkillPath().toLowerCase().endsWith(join("System32", "taskkill.exe").toLowerCase())).toBe(true);
  });

  it("launches Codex from a trusted absolute path even when the workspace holds a same-named executable", async () => {
    const workspace = await tempDir(); const trusted = await tempDir();
    await plantedExecutable(workspace, "codex");
    const expected = await plantedExecutable(trusted, "codex");
    const original = process.env.PATH;
    const adapter = new CodexExecutorAdapter({ version: "1", executor: "primary",
      models: { cheap: "model", balanced: "model", strong: "model", max: "model" } }, workspace, []);
    try {
      process.env.PATH = `${untrustedEntries(workspace)}${delimiter}${trusted}`;
      const launch = await adapter.prepareDirect({ task, model: "model", reasoning_effort: "low" });
      expect(launch.command).toBe(expected);
      process.env.PATH = untrustedEntries(workspace);
      await expect(adapter.prepareDirect({ task, model: "model", reasoning_effort: "low" })).rejects.toThrow("absolute PATH entry");
    } finally {
      if (original === undefined) delete process.env.PATH; else process.env.PATH = original;
    }
    await expect(access(join(workspace, "launch.json"))).rejects.toThrow();
  });
});
