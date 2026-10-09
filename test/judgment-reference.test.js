import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { beforeAll, expect, it } from "vitest";
import { JudgmentProcessAdapter, JudgmentProcessRequestSchema } from "../src/integrations/judgment-process.js";
import { createDecisionRuntime } from "../src/runtime-core.js";
import { selectJudgmentAdapter } from "../src/integrations/judgment-registry.js";
import { defaultProjectConfig } from "../src/project-config.js";

let mapReferenceJudgment, mockJudgment;
const task = { data_classification: "engineering_non_sensitive", task_id: "reference", attempt_id: "a1",
  summary: "Refactor validation", flags: {} };
const config = mode => ({ version: "1", provider_id: "reference-mock", executors: ["primary", "replan"],
  executable: process.execPath, cli_entrypoint: resolve("examples/judgment/reference-bridge.mjs"), args: [mode] });
const runtime = mode => createDecisionRuntime(selectJudgmentAdapter("process")(config(mode), ["primary", "replan"]),
  { executors: { primary: null, replan: null } });
const request = () => JudgmentProcessRequestSchema.parse({ schema_version: "1", task, choices: {
  executors: ["primary", "replan"], model_tiers: ["cheap", "balanced", "strong", "max"],
  reasoning_efforts: ["minimal", "low", "medium", "high"], context_budgets: ["tiny", "small", "medium", "large"],
  test_depths: ["none", "targeted", "standard", "full"], review_depths: ["none", "targeted", "standard", "full"],
  integration_strategies: ["direct", "isolated", "staged", "replan"],
} });

beforeAll(async () => {
  await promisify(execFile)(process.execPath, [resolve("node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json"]);
  ({ mapReferenceJudgment, mockJudgment } = await import("../examples/judgment/reference-bridge.mjs"));
}, 30000);

it("maps executor labels and probability keys without changing confidence or missing decisions", () => {
  const raw = mockJudgment("missing");
  raw.decisions.executor.probabilities = { implementer: 0.81, planner: 0.19 };
  const mapped = mapReferenceJudgment(request(), raw);
  expect(mapped.decisions.executor).toEqual({ selected: "primary", confidence: 0.95,
    probabilities: { primary: 0.81, replan: 0.19 } });
  expect(mapped.decisions).not.toHaveProperty("review_depth");
  expect(mapped.decisions.parallel_safe).toEqual(raw.decisions.parallel_safe);
  expect(raw.decisions.executor.selected).toBe("implementer");
});

it.each(["executor", "model_tier", "reasoning_effort", "context_budget", "test_depth", "review_depth", "integration_strategy"])
  ("rejects invalid %s mappings and probability labels", field => {
    const raw = mockJudgment(); raw.decisions[field].selected = "constructor";
    expect(() => mapReferenceJudgment(request(), raw)).toThrow();
    const probabilities = mockJudgment(); probabilities.decisions[field].probabilities = { unknown: 0.1 };
    expect(() => mapReferenceJudgment(request(), probabilities)).toThrow();
  });

it("rejects invalid schema and mappings outside advertised choices", () => {
  const raw = mockJudgment(); raw.decisions.executor.confidence = 2;
  expect(() => mapReferenceJudgment(request(), raw)).toThrow();
  const limited = request(); limited.choices.executors = ["replan"];
  expect(() => mapReferenceJudgment(limited, mockJudgment())).toThrow();
});

it("preserves absent decisions, unavailable status, and optional model usage", () => {
  const raw = { schema_version: "1", available: false, unavailable_reason_code: "UNKNOWN",
    model: "synthetic-model", usage: { input_tokens: 5, output_tokens: 2 } };
  expect(mapReferenceJudgment(request(), raw)).toEqual(raw);
  expect(mapReferenceJudgment(request(), { schema_version: "1", available: true })).not.toHaveProperty("decisions");
});

it.each(["valid", "missing", "low-confidence", "unavailable", "invalid"])("runs local bridge mode %s through Core", async mode => {
  const decision = await runtime(mode).decider.decide(task);
  if (mode === "valid") expect(decision).toMatchObject({ source: "provider+policy", profile: { executor: "primary" } });
  else expect(decision.profile.executor).toBe("replan");
  if (mode === "missing") expect(decision.judgment.decisions).not.toHaveProperty("review_depth");
  if (mode === "low-confidence") {
    expect(decision.judgment.decisions.executor.confidence).toBe(0.2);
    expect(decision.policy_trace).toContain("low-confidence-replan");
  }
});

it("keeps deterministic safety authority over the mapped mock response", async () => {
  const decision = await runtime("valid").decider.decide({ ...task, flags: { security_critical: true } });
  expect(decision.profile).toMatchObject({ model_tier: "strong", test_depth: "full", review_depth: "full",
    parallel_safe: false, integration_strategy: "staged" });
});

it("returns safe unavailable output for malformed input without leaking it", async () => {
  const { spawn } = await import("node:child_process");
  const output = await new Promise((done, reject) => {
    const child = spawn(process.execPath, [config("valid").cli_entrypoint], { stdio: ["pipe", "pipe", "pipe"], env: {} });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => done({ stdout, stderr, code }));
    child.stdin.end("SECRET_SENTINEL{");
  });
  expect(output.code).toBe(0); expect(output.stderr).toBe("");
  expect(JSON.parse(output.stdout)).toEqual({ schema_version: "1", available: false, unavailable_reason_code: "INVALID_RESPONSE" });
  expect(output.stdout).not.toContain("SECRET_SENTINEL");
});

it("respects pre-cancellation in the existing adapter", async () => {
  const controller = new AbortController(); controller.abort();
  await expect(new JudgmentProcessAdapter(config("valid")).decide(task, controller.signal)).rejects.toThrow("cancelled");
});

it("runs the documented offline and explicitly configured mock CLI plans", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "taskstance-reference-"));
  try {
    const project = resolve(dir, "project.json"), judgment = resolve(dir, "judgment.json");
    await writeFile(project, JSON.stringify(defaultProjectConfig));
    await writeFile(judgment, JSON.stringify(config("valid")));
    const exec = promisify(execFile);
    const args = [resolve("dist/cli.js"), "plan", "--config", project, "--task", resolve("examples/judgment/task.json")];
    const offline = JSON.parse((await exec(process.execPath, args)).stdout);
    expect(offline.decision_source).toBe("fallback");
    const selected = JSON.parse((await exec(process.execPath, [...args, "--judgment", "process", "--judgment-config", judgment])).stdout);
    expect(selected.decision_source).toBe("provider+policy");
    expect(selected.profile.executor).toBe("primary");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
