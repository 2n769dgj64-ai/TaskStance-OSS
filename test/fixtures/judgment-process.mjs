import { appendFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const [mode = "valid", marker] = process.argv.slice(2);
if (mode === "leaf") {
  writeFileSync(`${marker}.leaf`, JSON.stringify({ pid: process.pid }));
  setInterval(() => {}, 1000);
} else {
  if (marker) appendFileSync(`${marker}.calls`, "1\n");
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => { input += chunk; });
  process.stdin.on("end", () => {
    const request = JSON.parse(input);
    if (marker) writeFileSync(marker, JSON.stringify({ request, pid: process.pid, env: process.env }));
    process.stderr.write("RAW_STDERR_SECRET_SENTINEL\n");
    if (mode === "hold") {
      spawn(process.execPath, [fileURLToPath(import.meta.url), "leaf", marker], { stdio: "ignore" });
      setInterval(() => {}, 1000);
      return;
    }
    const choice = selected => ({ selected, confidence: 0.95 });
    const response = {
      schema_version: "1", available: true,
      decisions: {
        executor: choice("primary"), model_tier: choice("balanced"), reasoning_effort: choice("medium"),
        context_budget: choice("small"), test_depth: choice("targeted"), review_depth: choice("targeted"),
        parallel_safe: { selected: true, probability_true: 0.95 }, integration_strategy: choice("direct"),
      },
    };
    if (mode === "malformed") return process.stdout.write("RAW_STDOUT_SECRET_SENTINEL{");
    if (mode === "missing") return;
    if (mode === "nonzero") { process.stdout.write(JSON.stringify(response)); process.exitCode = 2; return; }
    if (mode === "oversized") return process.stdout.write("x".repeat(300000));
    if (mode === "invalid-utf8") return process.stdout.write(Buffer.from([0xff, 0xfe]));
    if (mode === "duplicate-member") return process.stdout.write(JSON.stringify(response).replace('"available":true', '"available":false,"available":true'));
    if (mode === "escaped-duplicate") return process.stdout.write(JSON.stringify(response).replace('"available":true', '"avail\\u0061ble":false,"available":true'));
    if (mode === "unavailable") { response.available = false; delete response.decisions; }
    if (mode === "schema-invalid") response.decisions.executor.confidence = 2;
    if (mode === "spoof") response.provider = "spoofed-provider";
    if (mode === "unknown") response.decisions.executor.selected = "unknown";
    if (mode === "secondary") response.decisions.executor.selected = "secondary";
    if (mode === "bad-choice") response.decisions.model_tier.selected = "nonsense";
    if (mode === "incomplete") delete response.decisions.review_depth;
    if (mode === "low-confidence") response.decisions.context_budget.confidence = 0.2;
    if (mode === "extra") response.raw = "RAW_STDOUT_SECRET_SENTINEL";
    if (mode === "duplicate" || mode === "conflicting") {
      process.stdout.write(`${JSON.stringify(response)}\n`);
      if (mode === "conflicting") response.decisions.executor.selected = "replan";
    }
    process.stdout.write(`${JSON.stringify(response)}\n`);
  });
}
