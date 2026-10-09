// Protocol test fixture, never represented as the hosted Codex executor.
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
const args = process.argv.slice(2);
const mode = args[args.indexOf("--model") + 1];
if (mode === "closed-stdin") process.exit(2);
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
await writeFile("launch.json", JSON.stringify({ args, prompt, environment: {
  secret_sentinel: process.env.TASKSTANCE_SECRET_SENTINEL ?? null,
  allowed_sentinel: process.env.TASKSTANCE_ALLOWED_SENTINEL ?? null,
  has_home: Boolean(process.env.HOME || process.env.USERPROFILE),
  has_path: Boolean(process.env.PATH || process.env.Path),
} }));
if (mode === "hold") {
  while (true) {
    try { await readFile("release.fixture"); break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
if (mode === "hang") {
  spawn(process.execPath, ["-e", "setTimeout(()=>require('fs').writeFileSync('descendant.txt','alive'),700)"], { stdio: "ignore" });
  setInterval(() => {}, 1000);
} else if (mode === "invalid") console.log("not json");
else if (mode === "overflow") console.log("x".repeat(10000));
else if (mode === "missing") console.log(JSON.stringify({ type: "thread.started" }));
else if (mode === "failed") console.log(JSON.stringify({ type: "turn.failed", error: { message: "secret raw error" } }));
else if (mode === "no-usage") console.log(JSON.stringify({ type: "turn.completed" }));
else {
  const body = JSON.parse(prompt.split("\n").at(-1));
  // TaskStance prompts embed selected files; direct prompts carry only the task (no profile, files or context budget).
  if (body.files) {
    const selected = body.files.find((file) => file.path === "README.md");
    if (!selected || !selected.content.includes("Status: pending")) process.exit(3);
  } else if (!body.task || "profile" in body || "context_budget" in body || /execution profile is authoritative/.test(prompt)) process.exit(4);
  if (mode !== "noop") await writeFile("README.md", (await readFile("README.md", "utf8")).replace("Status: pending", "Status: ready"));
  if (mode === "outside") await writeFile("outside.txt", "out of scope");
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "private raw answer" } }));
  const event = JSON.stringify({ type: "turn.completed", usage: { input_tokens: 30, output_tokens: 7, cached_input_tokens: 0 } });
  // Chunk boundaries and an unterminated final JSONL event are intentional.
  process.stdout.write(event.slice(0, 12));
  process.stdout.write(event.slice(12));
  if (mode === "nonzero") process.exitCode = 5;
}
