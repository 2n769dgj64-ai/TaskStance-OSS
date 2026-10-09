import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm, access, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { beforeAll, afterEach, expect, it } from "vitest";
import { defaultProjectConfig } from "../src/project-config.js";
import { selectAdapter } from "../src/integrations/adapter-registry.js";
import { acquireWorkspaceLock, workspaceLockPath } from "../src/integrations/workspace-lock.js";
import * as core from "../src/core-index.js";

const exec = promisify(execFile);
const cli = resolve("dist/cli.js");
const dirs: string[] = [];
beforeAll(async () => {
  await exec(process.execPath, [resolve("node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json"]);
}, 30000);
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function setup(mode = "success") {
  const workspace = await mkdtemp(join(tmpdir(), "taskstance-cli-"));
  dirs.push(workspace);
  const json = async (name: string, value: unknown) => {
    const path = join(workspace, name); await writeFile(path, JSON.stringify(value)); return path;
  };
  await writeFile(join(workspace, "README.md"), "# Sensitive source sentinel\nStatus: pending\n");
  const task = await json("task.json", { data_classification: "engineering_non_sensitive", summary: "Task prompt sentinel", flags: { docs_only: true } });
  const config = await json("config.json", defaultProjectConfig);
  const context = await json("context.json", ["README.md"]);
  const adapter = await json("adapter.json", { version: "1", executor: "primary",
    models: { cheap: mode, balanced: mode, strong: mode, max: mode },
    cli_entrypoint: resolve("test/fixtures/codex-cli.mjs"), timeout_ms: 5000 });
  return { workspace, args: ["--task", task, "--config", config, "--context", context,
    "--workspace", workspace, "--adapter-config", adapter] };
}

it("selects only the statically registered Codex adapter", () => {
  expect(selectAdapter("codex")({ version: "1", executor: "primary",
    models: { cheap: "x", balanced: "x", strong: "x", max: "x" } }).create("unused", []).id).toBe("codex-cli-v1");
  for (const name of [undefined, "unknown", "constructor", "__proto__"]) expect(() => selectAdapter(name)).toThrow();
});

it.each([undefined, "unknown"])("CLI rejects %s adapter before reading inputs or launching", async name => {
  const { workspace, args } = await setup();
  await expect(exec(process.execPath, [cli, "run", ...(name ? ["--adapter", name] : []), ...args]))
    .rejects.toMatchObject({ stderr: expect.stringContaining(name ? "Unknown adapter" : "requires --adapter") });
  await expect(access(join(workspace, "launch.json"))).rejects.toThrow();
  await expect(access(await workspaceLockPath(workspace))).rejects.toThrow();
  await expect(exec(process.execPath, [cli, "run", ...(name ? ["--adapter", name] : []), "--task", "absent-input"]))
    .rejects.toMatchObject({ stderr: expect.stringContaining(name ? "Unknown adapter" : "requires --adapter") });
});

it("CLI runs explicitly selected Codex and releases the lock", async () => {
  const { workspace, args } = await setup();
  const { stdout } = await exec(process.execPath, [cli, "run", "--adapter", "codex", ...args]);
  expect(JSON.parse(stdout)).toMatchObject({ adapter_id: "codex-cli-v1", status: "completed" });
  await expect(access(await workspaceLockPath(workspace))).rejects.toThrow();
});

it("independent Node processes cannot launch concurrently in one workspace", async () => {
  const { workspace, args } = await setup("hold");
  const first = spawn(process.execPath, [cli, "run", "--adapter", "codex", ...args], { stdio: "pipe" });
  const finished = new Promise<number | null>((done, reject) => { first.on("error", reject); first.on("close", done); });
  try {
    // Wait for the protocol fixture's launch marker, not a timing assumption.
    const deadline = Date.now() + 4000;
    while (true) {
      try { await readFile(join(workspace, "launch.json")); break; }
      catch { if (Date.now() > deadline) throw new Error("Fixture did not launch"); }
      await new Promise(done => setTimeout(done, 20));
    }
    const marker = await readFile(join(workspace, "launch.json"), "utf8");
    const metadata = JSON.parse(await readFile(await workspaceLockPath(workspace), "utf8"));
    expect(Object.keys(metadata).sort()).toEqual(["created_at", "format", "pid", "schema_version", "token"]);
    expect(metadata.pid).toBe(first.pid);
    expect(JSON.stringify(metadata)).not.toMatch(/sentinel|README|prompt|source|credential|hold/);
    await expect(exec(process.execPath, [cli, "run", "--adapter", "codex", ...args])).rejects
      .toMatchObject({ stderr: expect.stringContaining("Workspace lock exists") });
    expect(await readFile(join(workspace, "launch.json"), "utf8")).toBe(marker);
  } finally {
    await writeFile(join(workspace, "release.fixture"), "release");
    await finished;
  }
  await expect(access(await workspaceLockPath(workspace))).rejects.toThrow();
}, 15000);

it("retains live, stale, malformed, and unrecognized locks without stealing", async () => {
  const { workspace } = await setup();
  const release = await acquireWorkspaceLock(workspace);
  const path = await workspaceLockPath(workspace);
  try { await expect(acquireWorkspaceLock(workspace)).rejects.toThrow("lock exists"); }
  finally { await release(); }
  for (const metadata of [JSON.stringify({ format: "taskstance-workspace-lock", schema_version: "1", pid: 2147483647,
    created_at: "2000-01-01T00:00:00.000Z", token: "stale" }), "{", "foreign lock"]) {
    await writeFile(path, metadata, { flag: "wx" });
    try {
      await expect(acquireWorkspaceLock(workspace)).rejects.toThrow("lock exists");
      expect(await readFile(path, "utf8")).toBe(metadata);
    } finally { await rm(path); } // Remove only the fixture we created.
  }
});

it("refuses to delete changed lock metadata", async () => {
  const { workspace } = await setup();
  const release = await acquireWorkspaceLock(workspace);
  const path = await workspaceLockPath(workspace);
  await writeFile(path, "foreign replacement");
  try {
    await expect(release()).rejects.toThrow("identity changed");
    expect(await readFile(path, "utf8")).toBe("foreign replacement");
  } finally { await rm(path); }
});

it("workspace aliases share the same lock", async () => {
  const { workspace } = await setup();
  const parent = await mkdtemp(join(tmpdir(), "taskstance-alias-")); dirs.push(parent);
  const alias = join(parent, "alias");
  await symlink(workspace, alias, process.platform === "win32" ? "junction" : "dir");
  expect(await workspaceLockPath(alias)).toBe(await workspaceLockPath(workspace));
  const release = await acquireWorkspaceLock(workspace);
  try { await expect(acquireWorkspaceLock(alias)).rejects.toThrow("lock exists"); }
  finally { await release(); }
});

it("keeps the root Core export free of concrete integration exports and imports", async () => {
  expect(Object.keys(core).join(" ")).not.toMatch(/codex/i);
  expect(Object.keys(core)).not.toContain("selectAdapter");
  expect(Object.keys(core)).not.toContain("acquireWorkspaceLock");
  expect(await readFile(resolve("dist/core-index.js"), "utf8")).not.toMatch(/codex|integrations/);
});
