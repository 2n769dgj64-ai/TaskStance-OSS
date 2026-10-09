import { constants } from "node:fs";
import { access, open, realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { assembleDiscovery } from "../discovery-assembler.js";
import { buildExecutionPreparation } from "../execution-control.js";
import { ExecutionPreparationSchema, type ExecutionPreparation } from "../executor-adapter.js";
import type { TaskInput } from "../contracts.js";
import type { DecisionRuntime } from "../runtime-core.js";

export const LocalContextPathsSchema = z.array(z.string().min(1).max(240)).min(1).max(64);
export interface LocalContextFile { path: string; content: string }
export interface LocalExecutionInput {
  workspace: string;
  preparation: ExecutionPreparation;
  files: LocalContextFile[];
}

/**
 * Resolves a launcher to an absolute path before spawning, so the child's working directory
 * (an untrusted workspace or clone) and relative/empty PATH entries are never searched.
 * Absolute paths are used as given; relative paths are refused; bare names search only absolute
 * PATH entries (Windows: `.com`/`.exe` only, so `.cmd`/`.bat` shims are never selected).
 */
export async function resolveTrustedExecutable(name: string, searchPath = process.env.PATH ?? ""): Promise<string> {
  if (!name || name.includes("\0")) throw new Error("Invalid executable");
  if (isAbsolute(name)) return name;
  const windows = process.platform === "win32";
  if (/[\\/]/.test(name) || (windows && name.includes(":"))) {
    throw new Error("Executable must be an absolute path or a bare command name");
  }
  const names = windows ? (/\.(com|exe)$/i.test(name) ? [name] : [`${name}.com`, `${name}.exe`]) : [name];
  for (const entry of searchPath.split(delimiter)) {
    const directory = windows ? entry.replace(/^"(.*)"$/, "$1") : entry;
    if (!isAbsolute(directory)) continue;
    for (const candidate of names.map((file) => join(directory, file))) {
      try {
        if (!(await stat(candidate)).isFile()) continue;
        if (!windows) await access(candidate, constants.X_OK);
        return candidate;
      } catch {}
    }
  }
  throw new Error("Executable was not found on an absolute PATH entry");
}

/** Fixed system location for Windows process-tree termination; never resolved through PATH. */
export function windowsTaskkillPath(): string {
  const root = process.env.SystemRoot;
  return join(root && isAbsolute(root) ? root : "C:\\Windows", "System32", "taskkill.exe");
}

export async function resolveWorkspace(path: string): Promise<string> {
  const workspace = await realpath(resolve(path));
  if (!(await stat(workspace)).isDirectory()) throw new Error("Workspace must be a directory");
  return workspace;
}

/** Explicit local discovery: all listed files are mandatory, with no hidden repository scan. */
export async function prepareLocalExecution(
  runtime: DecisionRuntime, task: TaskInput, workspacePath: string, rawPaths: string[],
): Promise<LocalExecutionInput> {
  const workspace = await resolveWorkspace(workspacePath);
  const preparation = await buildExecutionPreparation(runtime, task);
  if (preparation.decision.profile.integration_strategy !== "direct") {
    throw new Error("Local execution currently supports only direct integration; replan or provision isolation separately");
  }
  const paths = LocalContextPathsSchema.parse(rawPaths);
  const budget = preparation.resolved_context_budget;
  if (paths.length > budget.max_candidates) throw new Error("Mandatory context exceeds candidate budget");
  const files: LocalContextFile[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const path of paths) {
    if (isAbsolute(path)) throw new Error("Context paths must be relative to the workspace");
    const target = await realpath(resolve(workspace, path));
    const within = relative(workspace, target);
    if (!within || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) {
      throw new Error("Context path escapes workspace");
    }
    const id = within.split(sep).join("/");
    const key = process.platform === "win32" ? target.toLowerCase() : target;
    if (seen.has(key)) throw new Error("Duplicate context file");
    seen.add(key);
    if (id.split("/").some((part) => part.toLowerCase() === ".git" || part.toLowerCase().startsWith(".env"))) {
      throw new Error("Git metadata and environment files cannot be context");
    }
    const handle = await open(target, "r");
    let bytes: Buffer;
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error("Context must be a regular file");
      const limit = Math.min(1_000_000, budget.max_estimated_tokens * 4 - totalBytes);
      if (info.size > limit) throw new Error("Mandatory context exceeds byte budget");
      // Bounded even if a file grows after stat. Never read an unbounded stream.
      const buffer = Buffer.alloc(limit + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > limit) throw new Error("Mandatory context exceeds byte budget");
      bytes = buffer.subarray(0, length);
    } finally { await handle.close(); }
    if (bytes.includes(0)) throw new Error("Binary context is unsupported");
    totalBytes += bytes.length;
    files.push({ path: id, content: new TextDecoder("utf-8", { fatal: true }).decode(bytes) });
  }
  const assembly = assembleDiscovery({
    data_classification: task.data_classification,
    task_id: task.task_id ?? "local-task",
    attempt_id: task.attempt_id ?? "a1",
    task_summary: task.summary,
    max_estimated_tokens: budget.max_estimated_tokens,
    max_candidates: budget.max_candidates,
    min_relevance: budget.min_relevance,
    batches: [{ adapter_id: "local-explicit", status: "complete", hits: files.map((file) => ({
      id: file.path, kind: "file", summary: "Explicit mandatory local file",
      estimated_tokens: Math.max(1, Math.ceil(Buffer.byteLength(file.content, "utf8") / 4)),
      mandatory: true, source: "explicit",
    })) }],
  });
  if (assembly.requires_replan || !assembly.prune_input) throw new Error("Local discovery requires replan");
  const packet = await runtime.contextPruner.prune(assembly.prune_input);
  return { workspace, files, preparation: ExecutionPreparationSchema.parse({ ...preparation, context_packet: packet }) };
}
