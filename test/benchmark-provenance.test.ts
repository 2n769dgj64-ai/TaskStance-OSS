import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJsonSha256, computeChangeEvidence } from "../src/benchmark/provenance.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, { force: true, recursive: true, maxRetries: 5, retryDelay: 100 }))); });
async function workspace(files: Record<string, string>) {
  const root = await mkdtemp(resolve(tmpdir(), "taskstance-provenance-")); dirs.push(root);
  for (const [name, text] of Object.entries(files)) {
    await mkdir(resolve(root, name, ".."), { recursive: true });
    await writeFile(resolve(root, name), text);
  }
  return root;
}
const states = (entries: Record<string, string>) => new Map(Object.entries(entries));

describe("change evidence", () => {
  it("is deterministic for the same workspace state", async () => {
    const a = await workspace({ "a.txt": "one", "dir/b.txt": "two" });
    const b = await workspace({ "dir/b.txt": "two", "a.txt": "one" });
    const s = { "a.txt": "M", "dir/b.txt": "untracked" };
    const first = await computeChangeEvidence(a, states(s));
    expect(await computeChangeEvidence(b, states(s))).toEqual(first);
    expect(first).toMatchObject({ algorithm: "taskstance-change-evidence-v1", artifact_count: 2, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });
  it("changes when file contents change", async () => {
    const a = await workspace({ "a.txt": "one" }); const b = await workspace({ "a.txt": "two" });
    expect((await computeChangeEvidence(a, states({ "a.txt": "M" }))).sha256).not.toBe((await computeChangeEvidence(b, states({ "a.txt": "M" }))).sha256);
  });
  it("changes when path or change state changes even with identical content", async () => {
    const a = await workspace({ "a.txt": "same" }); const b = await workspace({ "b.txt": "same" });
    const base = (await computeChangeEvidence(a, states({ "a.txt": "M" }))).sha256;
    expect((await computeChangeEvidence(b, states({ "b.txt": "M" }))).sha256).not.toBe(base);
    expect((await computeChangeEvidence(a, states({ "a.txt": "untracked" }))).sha256).not.toBe(base);
    const split = await workspace({ "a.txt": "x", "b.txt": "y" }); const swapped = await workspace({ "a.txt": "y", "b.txt": "x" });
    const both = states({ "a.txt": "M", "b.txt": "M" });
    expect((await computeChangeEvidence(split, both)).sha256).not.toBe((await computeChangeEvidence(swapped, both)).sha256);
  });
  it("represents deletion explicitly and distinctly from an empty file", async () => {
    const gone = await workspace({}); const empty = await workspace({ "a.txt": "" });
    const deleted = await computeChangeEvidence(gone, states({ "a.txt": "D" }));
    expect(deleted.artifact_count).toBe(1);
    expect(deleted.sha256).not.toBe((await computeChangeEvidence(empty, states({ "a.txt": "D" }))).sha256);
  });
  it("covers untracked files and keeps result JSON content-free", async () => {
    const root = await workspace({ "new.txt": "TOP SECRET SOURCE" });
    const evidence = await computeChangeEvidence(root, states({ "new.txt": "untracked" }));
    expect(evidence.artifact_count).toBe(1);
    expect(JSON.stringify(evidence)).not.toContain("TOP SECRET");
    expect(Object.keys(evidence).sort()).toEqual(["algorithm", "artifact_count", "sha256"]);
  });
  it("fails closed on traversal, directories and symlinked parents", async () => {
    const root = await workspace({ "a.txt": "x" });
    await expect(computeChangeEvidence(root, states({ "../escape.txt": "M" }))).rejects.toThrow();
    await mkdir(resolve(root, "sub"));
    await expect(computeChangeEvidence(root, states({ sub: "M" }))).rejects.toThrow();
    const outside = await workspace({ "secret.txt": "x" });
    try { await symlink(outside, resolve(root, "link"), "junction"); } catch { return; }
    await expect(computeChangeEvidence(root, states({ "link/secret.txt": "M" }))).rejects.toThrow();
  });
});

describe("canonical config hashes", () => {
  const lf = '{\n  "b": [1, 2],\n  "a": { "y": true, "x": null }\n}\n';
  it("ignores CRLF, indentation, whitespace and key order", () => {
    const base = canonicalJsonSha256(lf);
    expect(canonicalJsonSha256(lf.replaceAll("\n", "\r\n"))).toBe(base);
    expect(canonicalJsonSha256('{"a":{"x":null,"y":true},"b":[1,2]}')).toBe(base);
    expect(canonicalJsonSha256('{\t"a": {"x": null, "y": true},\n\t"b": [ 1 , 2 ]}')).toBe(base);
  });
  it("distinguishes value changes and array order", () => {
    const base = canonicalJsonSha256(lf);
    expect(canonicalJsonSha256(lf.replace("true", "false"))).not.toBe(base);
    expect(canonicalJsonSha256(lf.replace("[1, 2]", "[2, 1]"))).not.toBe(base);
    expect(canonicalJsonSha256(lf.replace('"x"', '"z"'))).not.toBe(base);
  });
  it("rejects invalid JSON and leaves raw byte hashes meaningful", async () => {
    expect(() => canonicalJsonSha256("{ nope")).toThrow();
    const { createHash } = await import("node:crypto");
    const raw = (t: string) => createHash("sha256").update(t).digest("hex");
    expect(raw(lf)).not.toBe(raw(lf.replaceAll("\n", "\r\n")));
  });
});
