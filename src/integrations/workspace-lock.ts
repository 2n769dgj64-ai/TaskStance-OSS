import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Stable per-user location, outside the workspace and independent of TMPDIR. */
export async function workspaceLockPath(workspace: string): Promise<string> {
  const canonical = await realpath(workspace);
  const key = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  return join(homedir(), ".taskstance", "workspace-locks", `${createHash("sha256").update(key).digest("hex")}.lock`);
}

/** Existing locks always fail closed, including stale, malformed, and foreign files. */
export async function acquireWorkspaceLock(workspace: string): Promise<() => Promise<void>> {
  const path = await workspaceLockPath(workspace);
  await mkdir(join(homedir(), ".taskstance", "workspace-locks"), { recursive: true, mode: 0o700 });
  const metadata = JSON.stringify({ format: "taskstance-workspace-lock", schema_version: "1",
    pid: process.pid, created_at: new Date().toISOString(), token: randomUUID() });
  const handle = await open(path, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") throw new Error("Workspace lock exists; concurrent execution is unsupported (manual inspection required)");
    throw error;
  });
  const identity = await handle.stat();
  try {
    await handle.writeFile(metadata, "utf8");
  } finally {
    await handle.close();
  }
  // A failed metadata write intentionally retains the lock for manual inspection.
  return async () => {
    const current = await lstat(path);
    if (!current.isFile() || current.dev !== identity.dev || current.ino !== identity.ino ||
        await readFile(path, "utf8") !== metadata) {
      throw new Error("Workspace lock identity changed; refusing cleanup");
    }
    await unlink(path);
  };
}
