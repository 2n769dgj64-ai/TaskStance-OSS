import { spawn } from "node:child_process";
import { resolveTrustedExecutable, windowsTaskkillPath } from "../integrations/local-context.js";

export interface ProcessResult { exit_code: number | null; stdout: string; duration_ms: number; ok: boolean }
/**
 * Every child starts from `MINIMAL_ENV` (process lookup, system root, temporary directory and locale names), so ambient
 * credentials do not reach it. `inherit` adds explicitly named parent variables (the caller owns that trust decision);
 * `fixed` adds constant values. There is no full-inheritance mode. A command that needs anything else fails (and is
 * recorded as failed) instead of being granted more. Not a filesystem or network sandbox. On Windows, libuv
 * additionally copies its fixed system/profile set (e.g. USERNAME, USERPROFILE) into every child.
 */
export interface ProcessEnvironment { inherit?: readonly string[]; fixed?: Readonly<Record<string, string>> }
export const MINIMAL_ENV: readonly string[] = process.platform === "win32"
  ? ["PATH", "PATHEXT", "SystemRoot", "WINDIR", "ComSpec", "SystemDrive", "TEMP", "TMP", "LANG", "LC_ALL", "LC_CTYPE"]
  : ["PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE"];
// Windows environment names are case-insensitive; compare uppercased there.
const envKey = (name: string) => (process.platform === "win32" ? name.toUpperCase() : name);
export function childEnvironment(environment: ProcessEnvironment = {}): NodeJS.ProcessEnv {
  const wanted = new Set([...MINIMAL_ENV, ...(environment.inherit ?? [])].map(envKey));
  const base: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && wanted.has(envKey(name))) base[name] = value;
  }
  return { ...base, ...environment.fixed, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "" };
}
/**
 * Bounded transient stdout; stderr is drained and discarded. No shell or raw error text.
 * The executable is resolved to an absolute path first, so a clone cannot shadow git, node or verifiers.
 */
export async function runProcess(executable: string, args: string[], cwd: string, timeout_ms: number, capture_stdout = true,
  environment: ProcessEnvironment = {}): Promise<ProcessResult> {
  const start = performance.now();
  let command: string;
  try { command = await resolveTrustedExecutable(executable); }
  catch { return { exit_code: null, stdout: "", duration_ms: Math.round(performance.now() - start), ok: false }; }
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true,
      detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
      env: childEnvironment(environment) });
    let stdout = ""; let size = 0; let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (!child.pid) return;
      if (process.platform === "win32") {
        const killer = spawn(windowsTaskkillPath(),["/pid", String(child.pid), "/T", "/F"], { shell: false, windowsHide: true, stdio: "ignore" });
        killer.on("error", () => child.kill("SIGKILL"));
        killer.on("close", code => { if (code !== 0) child.kill("SIGKILL"); });
      } else { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
    };
    const timer = setTimeout(stop, timeout_ms);
    child.stdout.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 1_000_000) stop(); else if (capture_stdout) stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 1_000_000) stop(); });
    child.on("error", () => { stopped = true; });
    child.on("close", code => { clearTimeout(timer); resolve({ exit_code: code, stdout: stopped ? "" : stdout,
      duration_ms: Math.round(performance.now() - start), ok: !stopped && code === 0 }); });
  });
}
