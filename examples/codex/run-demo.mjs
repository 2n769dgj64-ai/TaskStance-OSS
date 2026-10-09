import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createDecisionRuntime, createUnavailableProviderBundle, executeWithExecutorAdapter } from "../../dist/core-index.js";
import { prepareLocalExecution } from "../../dist/integrations/local-context.js";
import { CodexExecutorAdapter } from "../../dist/integrations/codex.js";

// Requires an explicit model; no default model, credential, or provider is embedded in Core.
const model = process.env.TASKSTANCE_DEMO_MODEL;
if (!model) throw new Error("Set TASKSTANCE_DEMO_MODEL to an available Codex model id");
const workspace = await mkdtemp(join(tmpdir(), "taskstance-demo-"));
execFileSync("git", ["init", "--quiet", workspace], { windowsHide: true });
await writeFile(join(workspace, "README.md"), "# Synthetic demo\n\nStatus: pending\n");
const task = {
  data_classification: "engineering_non_sensitive", task_id: "synthetic-docs", attempt_id: "a1",
  summary: "In README.md replace exactly 'Status: pending' with 'Status: ready'. Change no other file. Do not commit.",
  flags: { docs_only: true },
};
const runtime = createDecisionRuntime(createUnavailableProviderBundle(), {
  executors: { primary: "Local coding executor", replan: "Stop and replan" }, defaultExecutor: "primary",
});
const local = await prepareLocalExecution(runtime, task, workspace, ["README.md"]);
const adapter = new CodexExecutorAdapter({
  version: "1", executor: "primary", models: { cheap: model, balanced: model, strong: model, max: model },
  ...(process.env.TASKSTANCE_CODEX_ENTRYPOINT ? { cli_entrypoint: resolve(process.env.TASKSTANCE_CODEX_ENTRYPOINT) } : {}),
}, workspace, local.files);
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
const result = await executeWithExecutorAdapter(adapter, local.preparation, controller.signal);
const expected = "# Synthetic demo\n\nStatus: ready\n";
const fileCheck = (await readFile(join(workspace, "README.md"), "utf8")).replaceAll("\r\n", "\n") === expected;
const changed = execFileSync("git", ["-C", workspace, "ls-files", "--others", "--exclude-standard"], { encoding: "utf8", windowsHide: true }).trim().split(/\r?\n/);
const onlyExpectedFile = changed.length === 1 && changed[0] === "README.md";
const noCommit = execFileSync("git", ["-C", workspace, "rev-list", "--all", "--count"], { encoding: "utf8", windowsHide: true }).trim() === "0";
console.log(JSON.stringify({ workspace, decision_source: local.preparation.decision.source,
  selected_files: local.preparation.context_packet.selected_ids,
  selected_estimated_tokens: local.preparation.context_packet.selected_estimated_tokens,
  provider_calls: 0, result, file_check: fileCheck, only_expected_file: onlyExpectedFile, no_commit: noCommit }, null, 2));
if (result.status !== "completed" || !fileCheck || !onlyExpectedFile || !noCommit) process.exitCode = 1;
