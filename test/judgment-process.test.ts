import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, expect, it } from "vitest";
import { RawJudgmentSchema, type TaskInput } from "../src/contracts.js";
import { defaultPolicy } from "../src/default-policy.js";
import { createDecisionRuntime } from "../src/runtime-core.js";
import { defaultProjectConfig } from "../src/project-config.js";
import { AggregateTelemetry } from "../src/telemetry.js";
import { JudgmentProcessAdapter, JudgmentProcessRequestSchema } from "../src/integrations/judgment-process.js";
import { selectJudgmentAdapter } from "../src/integrations/judgment-registry.js";
import * as core from "../src/core-index.js";

const exec = promisify(execFile);
const fixture = resolve("test/fixtures/judgment-process.mjs");
const cli = resolve("dist/cli.js");
const dirs: string[] = [];
const task: TaskInput = { data_classification: "engineering_non_sensitive", task_id: "fixture", attempt_id: "a1",
  summary: "Task summary sentinel", flags: {} };
const config = (mode = "valid", marker?: string, executors = ["primary", "replan"]) => ({
  version: "1" as const, provider_id: "local-judgment", executors, executable: process.execPath,
  cli_entrypoint: fixture, args: [mode, ...(marker ? [marker] : [])],
});
const runtime = (raw: unknown = config(), extra = {}) => createDecisionRuntime(
  selectJudgmentAdapter("process")(raw, ["primary", "secondary", "replan"]),
  { executors: { primary: null, secondary: null, replan: null }, ...extra });
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), "taskstance-judgment-")); dirs.push(dir); return dir;
}
async function waitFile(path: string) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    try { return JSON.parse(await readFile(path, "utf8")); } catch { /* wait for fixture readiness */ }
    await new Promise(done => setTimeout(done, 20));
  }
  throw new Error("Fixture readiness timeout");
}
async function waitDead(pid: number) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise(done => setTimeout(done, 20));
  }
  throw new Error("Fixture process survived cancellation");
}
beforeAll(async () => {
  await exec(process.execPath, [resolve("node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json"]);
}, 30000);
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

it("maps one valid process response into existing Core v2 with configuration-owned identity", async () => {
  const marker = join(await directory(), "request");
  const decision = await runtime(config("valid", marker)).decider.decide(task);
  expect(decision).toMatchObject({ source: "provider+policy", judgment: { schema_version: "2", provider: "local-judgment" },
    profile: { executor: "primary", model_tier: "balanced" } });
  expect(RawJudgmentSchema.safeParse(decision.judgment).success).toBe(true);
  expect(await readFile(`${marker}.calls`, "utf8")).toBe("1\n");
  const telemetry = new AggregateTelemetry("aggregate"); telemetry.recordDecision(decision);
  expect(JSON.stringify(telemetry.snapshot())).not.toMatch(/Task summary|local-judgment|RAW_STDOUT|RAW_STDERR/);
});

it("reapplies deterministic pre-policy and keeps post-policy final", async () => {
  const policy = { ...defaultPolicy, rules: [...defaultPolicy.rules, {
    id: "pre-floor", priority: 20, phase: "pre" as const, when: { flags_all: ["floor"] },
    set: { context_budget: "large" as const }, skip_provider: false,
  }] };
  const decision = await runtime(config(), { policy }).decider.decide({ ...task, flags: { floor: true, security_critical: true } });
  expect(decision.source).toBe("provider+policy");
  expect(decision.profile).toMatchObject({ context_budget: "large", model_tier: "strong", test_depth: "full",
    review_depth: "full", parallel_safe: false, integration_strategy: "staged" });
  expect(decision.policy_trace).toEqual(expect.arrayContaining(["pre-floor", "security-critical-floor"]));
});

it("keeps low-confidence post-policy authoritative", async () => {
  const decision = await runtime(config("low-confidence")).decider.decide(task);
  expect(decision.profile).toMatchObject({ executor: "replan", integration_strategy: "replan" });
  expect(decision.policy_trace).toContain("low-confidence-replan");
});

it.each(["malformed", "schema-invalid", "unavailable", "nonzero", "oversized", "missing", "duplicate",
  "conflicting", "spoof", "unknown", "extra", "bad-choice", "incomplete", "duplicate-member", "escaped-duplicate",
  "invalid-utf8"])("%s output falls back without retry or raw output", async mode => {
  const dir = await directory(); const marker = join(dir, "request");
  const decision = await runtime(config(mode, marker)).decider.decide(task);
  expect(decision.source).toBe("fallback");
  expect(decision.profile.executor).toBe("replan");
  expect(JSON.stringify(decision)).not.toMatch(/RAW_STDOUT|RAW_STDERR|spoofed-provider/);
  expect(await readFile(`${marker}.calls`, "utf8")).toBe("1\n");
  expect((await readdir(dir)).sort()).toEqual(["request", "request.calls"]);
});

it("leaves Core's configured-executor check intact", async () => {
  const adapter = new JudgmentProcessAdapter(config("secondary", undefined, ["primary", "secondary", "replan"]));
  const bundle = selectJudgmentAdapter("process")(config(), ["primary", "replan"]);
  const decision = await createDecisionRuntime({ ...bundle, judgmentProvider: adapter }, {
    executors: { primary: null, replan: null },
  }).decider.decide(task);
  expect(decision.source).toBe("fallback");
  expect(decision.policy_trace).toContain("provider_executor_unconfigured");
});

it("launch failure is conservative and does not expose process configuration", async () => {
  const { cli_entrypoint: _entrypoint, ...native } = config();
  const decision = await runtime({ ...native, executable: join(await directory(), "absent.exe") })
    .decider.decide(task);
  expect(decision.source).toBe("fallback");
  expect(JSON.stringify(decision)).not.toContain("absent.exe");
});

it("pre-abort launches nothing", async () => {
  const marker = join(await directory(), "request");
  const controller = new AbortController(); controller.abort();
  await expect(new JudgmentProcessAdapter(config("valid", marker)).decide(task, controller.signal)).rejects.toThrow("cancelled");
  await expect(access(`${marker}.calls`)).rejects.toThrow();
});

it("synchronous launch errors expose no raw process configuration", async () => {
  const { cli_entrypoint: _entrypoint, ...native } = config();
  await expect(new JudgmentProcessAdapter({ ...native, executable: "SECRET_SENTINEL\u0000" }).decide(task))
    .rejects.toThrow("Judgment process launch failure");
});

it.each(["cancel", "timeout"])("%s kills the process and its descendant with one launch", async mode => {
  const marker = join(await directory(), "request");
  const controller = new AbortController();
  const adapterConfig = config("hold", marker);
  const pending = mode === "timeout" ? runtime(adapterConfig, { providerTimeoutMs: 2000 }).decider.decide(task) :
    new JudgmentProcessAdapter(adapterConfig).decide(task, controller.signal).catch(error => error);
  let parent: { pid: number } | undefined; let leaf: { pid: number } | undefined;
  try {
    parent = await waitFile(marker); leaf = await waitFile(`${marker}.leaf`);
    if (mode === "cancel") controller.abort();
    const result = await pending;
    if (mode === "timeout") expect(result).toMatchObject({ source: "fallback" });
    else expect(result).toBeInstanceOf(Error);
    await Promise.all([waitDead(parent!.pid), waitDead(leaf!.pid)]);
    expect(await readFile(`${marker}.calls`, "utf8")).toBe("1\n");
  } finally {
    controller.abort();
    // Cleanup only recorded fixture PIDs if an assertion fails.
    for (const processInfo of [parent, leaf]) if (processInfo) {
      try { process.kill(processInfo.pid, "SIGKILL"); } catch { /* already dead */ }
    }
    await pending;
  }
}, 15000);

it("sends only strict task and choice data, with no repository context, configuration, or inherited secrets", async () => {
  const marker = join(await directory(), "request");
  process.env.TASKSTANCE_TEST_SECRET = "ENV_SECRET_SENTINEL";
  try { await new JudgmentProcessAdapter(config("valid", marker)).decide(task); }
  finally { delete process.env.TASKSTANCE_TEST_SECRET; }
  const { request, env } = await waitFile(marker);
  expect(JudgmentProcessRequestSchema.safeParse(request).success).toBe(true);
  expect(Object.keys(request).sort()).toEqual(["choices", "schema_version", "task"]);
  expect(request.task).toEqual(task);
  expect(request.choices.executors).toEqual(["primary", "replan"]);
  expect(env).not.toHaveProperty("TASKSTANCE_TEST_SECRET");
  expect(JSON.stringify(request)).not.toMatch(/estimated_tokens|candidate|README|content|executable|provider_id|cli_entrypoint|ENV_SECRET/);
  await expect(new JudgmentProcessAdapter(config()).decide({ ...task, repo_contents: "secret" } as TaskInput))
    .rejects.toThrow();
});

it("pairs process judgment with unavailable context scoring", async () => {
  const r = runtime();
  expect(r.info).toMatchObject({ configured: true, provider: "local-judgment" });
  const bundle = selectJudgmentAdapter("process")(config(), ["primary", "replan"]);
  expect(await bundle.contextScoringProvider.score({} as never, [])).toMatchObject({ available: false });
});

it("static registry and configuration fail closed", () => {
  for (const name of [undefined, "unknown", "constructor", "__proto__"]) expect(() => selectJudgmentAdapter(name)).toThrow();
  for (const changed of [{ provider_id: "bad identity" }, { executors: ["unknown"] }, { args: [], extra: true },
    { cli_entrypoint: "relative.mjs" }, { executable: "script.cmd" }, { executable: "powershell.exe" },
    { executors: ["primary", "primary"] }]) {
    expect(() => selectJudgmentAdapter("process")({ ...config(), ...changed }, ["primary", "replan"])).toThrow();
  }
});

async function cliSetup() {
  const dir = await directory();
  const json = async (name: string, value: unknown) => { const path = join(dir, name); await writeFile(path, JSON.stringify(value)); return path; };
  const taskPath = await json("task.json", task);
  const project = await json("config.json", defaultProjectConfig);
  const marker = join(dir, "request");
  const judgment = await json("judgment.json", config("valid", marker));
  return { dir, marker, judgment, args: ["--task", taskPath, "--config", project] };
}

it("CLI default stays offline; explicit process judgment produces provider+policy", async () => {
  const { marker, judgment, args } = await cliSetup();
  const offline = JSON.parse((await exec(process.execPath, [cli, "plan", ...args])).stdout);
  expect(offline.decision_source).toBe("fallback");
  await expect(access(`${marker}.calls`)).rejects.toThrow();
  const online = JSON.parse((await exec(process.execPath, [cli, "plan", ...args, "--judgment", "process", "--judgment-config", judgment])).stdout);
  expect(online.decision_source).toBe("provider+policy");
  expect(await readFile(`${marker}.calls`, "utf8")).toBe("1\n");
});

it.each([["--judgment", "unknown"], ["--judgment", "process"], ["--judgment-config", "absent"], ["--judgment"],
  ["--judgment", "process", "--judgment", "unknown"]].map(flags => ({ flags })))
  ("CLI fails closed for judgment flags $flags before reading inputs", async ({ flags }) => {
    for (const command of ["plan", "run"]) {
      await expect(exec(process.execPath, [cli, command, ...flags, "--task", "absent"]))
        .rejects.toMatchObject({ stderr: expect.stringMatching(/judgment/i) });
    }
  });

it("CLI run combines process judgment with explicit Codex execution without a context scorer call", async () => {
  const { dir, marker, judgment, args } = await cliSetup();
  await writeFile(join(dir, "README.md"), "Repository source sentinel\nStatus: pending\n");
  const context = join(dir, "context.json"); await writeFile(context, '["README.md"]');
  const adapter = join(dir, "adapter.json"); await writeFile(adapter, JSON.stringify({ version: "1", executor: "primary",
    cli_entrypoint: resolve("test/fixtures/codex-cli.mjs"), models: { cheap: "success", balanced: "success", strong: "success", max: "success" } }));
  const output = JSON.parse((await exec(process.execPath, [cli, "run", "--adapter", "codex", ...args,
    "--context", context, "--workspace", dir, "--adapter-config", adapter, "--judgment", "process", "--judgment-config", judgment])).stdout);
  expect(output.status).toBe("completed");
  expect(await readFile(marker, "utf8")).not.toMatch(/Repository source sentinel|estimated_tokens|README/);
  expect(await readFile(`${marker}.calls`, "utf8")).toBe("1\n");
});

it("deterministic skip still launches no judgment process", async () => {
  const marker = join(await directory(), "request");
  expect((await runtime(config("valid", marker)).decider.decide({ ...task, flags: { docs_only: true } })).source).toBe("deterministic");
  await expect(access(`${marker}.calls`)).rejects.toThrow();
});

it("root export has no process integration and package exposes only a separate subpath", async () => {
  expect(Object.keys(core).join(" ")).not.toMatch(/JudgmentProcess|selectJudgmentAdapter/);
  expect(await readFile(resolve("dist/core-index.js"), "utf8")).not.toMatch(/judgment-process|judgment-registry|integrations/);
  const pkg = JSON.parse(await readFile(resolve("package.json"), "utf8"));
  expect(pkg.private).toBe(true);
  expect(pkg.exports["./integrations/judgment-process"].import).toBe("./dist/integrations/judgment-process.js");
});
