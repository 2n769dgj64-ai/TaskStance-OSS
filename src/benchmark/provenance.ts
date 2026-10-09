import { createHash } from "node:crypto";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export const CHANGE_EVIDENCE_ALGORITHM = "taskstance-change-evidence-v1";
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

/** Deterministic JSON text: recursive key sort, array order kept, no whitespace. Values are never dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(",")}}`;
  }
  throw new Error("Unsupported JSON value");
}
/** SHA-256 of the canonical form of strict JSON text. Throws on invalid JSON. */
export const canonicalJsonSha256 = (text: string): string => sha256(canonicalJson(JSON.parse(text)));

export interface ChangeEvidence { algorithm: typeof CHANGE_EVIDENCE_ALGORITHM; artifact_count: number; sha256: string }

/**
 * Content-free fingerprint of the final workspace state of every changed path.
 * `states` maps path -> Git change state (e.g. M, A, D, T, untracked). Only digests are produced;
 * nothing read from the files is retained. Throws (fail closed) on unsafe or unreadable paths.
 */
export async function computeChangeEvidence(checkout: string, states: ReadonlyMap<string, string>): Promise<ChangeEvidence> {
  const rootReal = await realpath(checkout);
  const inside = (p: string) => { const rel = relative(rootReal, p); return rel !== "" && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`); };
  const lines: string[] = [];
  for (const path of [...states.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const target = resolve(rootReal, path);
    if (path.includes("\0") || !inside(target)) throw new Error("Unsafe changed path");
    let info;
    try { info = await lstat(target); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    let kind: string; let digest: string;
    if (!info) { kind = "deleted"; digest = ""; }
    else {
      // Parent directories must resolve inside the checkout so no symlinked directory escapes it.
      const parent = await realpath(dirname(target));
      if (parent !== rootReal && !inside(parent)) throw new Error("Path escapes checkout");
      if (info.isSymbolicLink()) { kind = "symlink"; digest = sha256(await readlink(target)); }
      else if (info.isFile()) { kind = "file"; digest = sha256(await readFile(target)); }
      else throw new Error("Unsupported changed artifact type");
    }
    lines.push(JSON.stringify([path, states.get(path), kind, digest]));
  }
  return { algorithm: CHANGE_EVIDENCE_ALGORITHM, artifact_count: lines.length, sha256: sha256(`${CHANGE_EVIDENCE_ALGORITHM}\n${lines.join("\n")}`) };
}
/** SHA-256 of the canonical form of an already-parsed JSON value (used to reference a paired result record). */
export const canonicalValueSha256 = (value: unknown): string => sha256(canonicalJson(value));
