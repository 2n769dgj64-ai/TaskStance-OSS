#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, lstat, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const defaultRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

const EXPECTED_PACKAGE_FILES = [
  "dist",
  "docs",
  "examples/codex",
  "examples/judgment",
  "README.md",
  "LICENSE",
];
const EXPECTED_EXPORTS = [
  ".",
  "./integrations/codex",
  "./integrations/local-context",
  "./integrations/judgment-process",
];
const EXPECTED_EXPORT_TARGETS = Object.fromEntries(EXPECTED_EXPORTS.map(key => {
  const stem = key === "." ? "core-index" : key.slice(2);
  return [key, { types: `./dist/${stem}.d.ts`, import: `./dist/${stem}.js` }];
}));
// Explicit owner-approved pre-publication historical evidence (LF and CRLF bytes). No directory-wide exemption.
const APPROVED_RESULTS = {
  "benchmarks/results/clsx-pr82-readme-bench-links.json": ["8f56fb9652f0e76810fdb930ff02158fd65eab39751c7d6b164ccfcaf5f14c72", "e0023868fff409715bd30df0f0172785388ab038a595bae2dba9a0186c1305ba"],
  "benchmarks/results/is-stream-pr21-http-streams.json": ["d729d36bcc9edf57b47ea92729cf7228e90f4bbac2b085184f80be9967932d87", "16b6158073fb7dbf7bb408fc1584adf0eec14562facef773be83969168a271f8"],
  "benchmarks/results/minimist-pr17-long-option-single-dash.json": ["5cf6fc5a3f4c547ad7987b02167a1fb87658c2acc6aab4e4326dc68d2a2ec0d5", "e419f683b35f5027248d295898bf52b35043668b32a65f34ec106cf577ccd86c"],
  "benchmarks/results/yocto-queue-pr13-drain-undefined.json": ["881b9cc58dc8aa66d40c19eec1a05763c86b4d2a33368f2dc56a09ecfa8567f4", "6f1284ba306ab524d8b55d8befba5aa2e59e6cd21acbff4770cfed9d26c6ef53"],
  "benchmarks/results/yoctocolors-pr26-bold-dim.json": ["c25674fe91f77463a28219047d643caf33506c7f213bd4d1c202ffa4916e4b5b", "e46283ce7ca113858d2039f6b0131406833900a62894c1ff192a2e6fa171e66f"],
};
const REQUIRED_IGNORES = [".env*", "*.local.json", ".local/", ".npmrc", ".netrc", ".git-credentials", "id_rsa", "id_ed25519", "*.crt", "*.cer", "*.pem", "*.key", "*.p12", "*.pfx", "*.jks", "*.keystore", "credentials*", "secrets*", "eval-run*/", "evaluation/results/", "evaluation-results/", "execution-report.json", "preflight.json", "*.evaluation-result.json", "/benchmarks/results/*", ...Object.keys(APPROVED_RESULTS).map(path => `!/${path}`)];
const PACKAGED_TEXT_FILES = new Set(["docs/phase2-2.md", "docs/phase2-3.md", "docs/phase2-7-prelaunch-audit.md", "docs/bring-your-own-judgment-provider.md", "examples/codex/run-demo.mjs", "examples/judgment/reference-bridge.mjs", "examples/judgment/task.json", "examples/judgment/process.example.json", "examples/judgment/local-http-bridge.mjs", "examples/judgment/lm-studio.example.json", "examples/judgment/ollama.example.json", "examples/judgment/system-one-bridge.mjs", "examples/judgment/lm-studio-system-one.example.json"]);
const FORBIDDEN_LIFECYCLE_SCRIPTS = new Set([
  "preinstall", "install", "postinstall", "preprepare", "prepare", "postprepare",
  "prepack", "postpack", "prepublish", "prepublishOnly", "publish", "postpublish",
]);
const TEXT_EXTENSIONS = new Set([".ts", ".js", ".mjs", ".cjs", ".md", ".json", ".yml", ".yaml", ".txt"]);
const PRIVATE_TERMS = [
  ["INTERNAL", "_ONLY"].join(""),
  ["CONFIDENTIAL", "_PROJECT"].join(""),
  ["PRIVATE", "_WORKSPACE"].join(""),
];

function failure(rule, path, message) {
  return { rule, path, message };
}

async function git(root, args) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, ...args], {
      encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    if (args[0] === "check-ignore" && error.code === 1) return error.stdout ?? "";
    throw new Error("Git metadata unavailable");
  }
}

async function trackedFiles(root) {
  const output = await git(root, ["ls-files", "-z"]);
  return output.split("\0").filter(Boolean).sort();
}

async function readText(root, path) {
  if ((await lstat(resolve(root, path))).isSymbolicLink()) throw new Error("Tracked symlink is not auditable");
  return await readFile(resolve(root, path), "utf8");
}

async function exists(root, path) {
  try {
    await access(resolve(root, path));
    return true;
  } catch {
    return false;
  }
}

function sameStringSet(actual, expected) {
  return Array.isArray(actual) &&
    actual.length === expected.length &&
    [...actual].sort().every((value, index) => value === [...expected].sort()[index]);
}

function isSecretLikePath(path) {
  const lower = path.toLowerCase();
  const name = basename(lower);
  const extension = extname(lower);
  if (lower.split("/").some(part => [".local", ".aws", ".ssh", ".codex", ".claude"].includes(part))) return true;
  if (name === ".env" || name.startsWith(".env.")) return true;
  if ([".npmrc", ".netrc", ".git-credentials", "id_rsa", "id_ed25519"].includes(name)) return true;
  if ([".crt", ".cer", ".pem", ".key", ".p12", ".pfx", ".jks", ".keystore"].includes(extension)) return true;
  if (/\.local\.json$/.test(name)) return true;
  if (/^(credentials?|secrets?)(\.|$)/.test(name)) return true;
  return false;
}

function isEvaluationArtifact(path) {
  const lower = path.toLowerCase();
  const name = basename(lower);
  return lower.startsWith("evaluation/results/") ||
    lower.startsWith("benchmarks/results/") ||
    lower.startsWith("evaluation-results/") ||
    lower.includes("/eval-run/") ||
    /^eval-run(?:-|$)/.test(lower) ||
    ["execution-report.json", "preflight.json"].includes(name) ||
    /\.evaluation-result\.json$/.test(name);
}

function isTextPath(path) {
  return path === "LICENSE" || path === ".gitignore" || TEXT_EXTENSIONS.has(extname(path).toLowerCase());
}

async function auditRepository(rootPath = defaultRoot) {
  const root = resolve(rootPath);
  const failures = [];
  const files = await trackedFiles(root);
  const fileSet = new Set(files);

  let packageJson;
  try {
    packageJson = JSON.parse(await readText(root, "package.json"));
  } catch {
    failures.push(failure("PKG001", "package.json", "package metadata is unreadable"));
    return failures;
  }

  if (packageJson.name !== "taskstance" || packageJson.private !== true || packageJson.license !== "Apache-2.0") {
    failures.push(failure("PKG001", "package.json", "package identity/private/license contract changed"));
  }
  if (packageJson.publishConfig !== undefined) {
    failures.push(failure("PKG001", "package.json", "publishConfig is forbidden before launch approval"));
  }

  for (const scriptName of Object.keys(packageJson.scripts ?? {})) {
    if (FORBIDDEN_LIFECYCLE_SCRIPTS.has(scriptName) || /\b(?:npm|pnpm|yarn|lerna)\b[^\r\n]*\bpublish\b|semantic-release/i.test(String(packageJson.scripts[scriptName]))) {
      failures.push(failure("PKG002", "package.json", "forbidden lifecycle or publication script"));
    }
  }

  if (!sameStringSet(packageJson.files, EXPECTED_PACKAGE_FILES)) {
    failures.push(failure("PKG003", "package.json", "package files allowlist changed"));
  }
  if (!packageJson.exports || !sameStringSet(Object.keys(packageJson.exports), EXPECTED_EXPORTS)) {
    failures.push(failure("PKG003", "package.json", "package export allowlist changed"));
  }
  if (EXPECTED_EXPORTS.some(key => {
    const target = packageJson.exports?.[key];
    return !target || !sameStringSet(Object.keys(target), ["types", "import"]) ||
      target.types !== EXPECTED_EXPORT_TARGETS[key].types || target.import !== EXPECTED_EXPORT_TARGETS[key].import;
  }) || packageJson.main !== "./dist/core-index.js" || packageJson.types !== "./dist/core-index.d.ts" ||
      JSON.stringify(packageJson.bin) !== JSON.stringify({ taskstance: "./dist/cli.js" })) {
    failures.push(failure("PKG003", "package.json", "package entrypoint targets changed"));
  }
  // Inspect included directories even for ignored/untracked files. Never follow symlinks.
  const packedPaths = new Set(PACKAGED_TEXT_FILES);
  for (const path of files.filter(path => /^src\/.*\.ts$/.test(path))) {
    const stem = path.replace(/^src\//, "dist/").replace(/\.ts$/, "");
    packedPaths.add(`${stem}.js`);
    packedPaths.add(`${stem}.d.ts`);
  }
  async function checkPackageDirectory(path) {
    let stat;
    try { stat = await lstat(resolve(root, path)); } catch { return; }
    if (stat.isSymbolicLink()) {
      failures.push(failure("PKG003", path, "symlink in package scope is forbidden"));
    } else if (stat.isDirectory()) {
      for (const child of (await readdir(resolve(root, path))).sort()) await checkPackageDirectory(`${path}/${child}`);
    } else if (!packedPaths.has(path)) {
      failures.push(failure("PKG003", path, "unexpected file in package scope"));
    }
  }
  for (const path of ["dist", "docs", "examples/codex", "examples/judgment"]) await checkPackageDirectory(path);

  const repositoryUrl = packageJson.repository?.url;
  if (repositoryUrl !== "git+https://github.com/2n769dgj64-ai/TaskStance-OSS.git" ||
      packageJson.homepage !== "https://github.com/2n769dgj64-ai/TaskStance-OSS#readme" ||
      packageJson.bugs?.url !== "https://github.com/2n769dgj64-ai/TaskStance-OSS/issues" ||
      !fileSet.has("LICENSE") || !fileSet.has("SECURITY.md")) {
    failures.push(failure("META001", "package.json", "repository/license/security metadata is incomplete"));
  }

  // Walk the static Core dependency closure, including type exports and literal dynamic imports.
  const pending = ["src/core-index.ts"], seen = new Set();
  while (pending.length) {
    const path = pending.pop();
    if (seen.has(path)) continue;
    seen.add(path);
    let text;
    try { text = await readText(root, path); } catch {
      failures.push(failure("CORE001", path, "Core dependency is unreadable"));
      continue;
    }
    const imports = [...text.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["']([^"']+)["']/g)];
    if (/\b(?:import|require)\s*\(\s*[^\s"']/.test(text)) {
      failures.push(failure("CORE001", path, "nonliteral Core dependency cannot be audited"));
    }
    for (const [, specifier] of imports) {
      if (specifier.startsWith(".")) {
        const target = posix.normalize(posix.join(posix.dirname(path), specifier)).replace(/\.js$/, ".ts");
        if (!/^src\/[^/]+\.ts$/.test(target) || !fileSet.has(target)) {
          failures.push(failure("CORE001", path, "optional or unknown dependency leaked into Core"));
        } else pending.push(target);
      } else if (!specifier.startsWith("node:") && !["zod", "@modelcontextprotocol/server"].includes(specifier)) {
        failures.push(failure("CORE001", path, "non-neutral external dependency leaked into Core"));
      }
    }
  }

  for (const path of files) {
    if (isSecretLikePath(path) || (await lstat(resolve(root, path)).catch(() => null))?.isSymbolicLink()) {
      failures.push(failure("ART001", path, "secret-like or local configuration artifact is tracked"));
    }
    if (isEvaluationArtifact(path) && !Object.hasOwn(APPROVED_RESULTS, path)) {
      failures.push(failure("ART002", path, "local evaluation run artifact is tracked"));
    }
  }
  for (const [path, hash] of Object.entries(APPROVED_RESULTS)) {
    let actual;
    try {
      if (!(await lstat(resolve(root, path))).isSymbolicLink()) {
        actual = createHash("sha256").update(await readFile(resolve(root, path))).digest("hex");
      }
    } catch {}
    if (!fileSet.has(path) || !hash.includes(actual)) failures.push(failure("ART003", path, "approved historical evidence is missing or changed"));
  }

  const workflowFiles = files.filter(path => /^\.github\/workflows\/.*\.ya?ml$/i.test(path));
  if (packageJson.private === true) {
    for (const path of workflowFiles) {
      const text = await readText(root, path);
      if (/\b(?:npm|pnpm|yarn|lerna)\b[^\r\n]*\bpublish\b/i.test(text) ||
          /\bpnpm\s+publish\b/i.test(text) ||
          /\byarn\s+(?:npm\s+)?publish\b/i.test(text) ||
          /npmjs\.org/i.test(text) ||
          /(?:semantic-release|release-please|npm-publish|changesets\/action|lerna\s+publish)/i.test(text) ||
          /NODE_AUTH_TOKEN/i.test(text) ||
          /registry-url\s*:\s*[^\n]*npm/i.test(text)) {
        failures.push(failure("WF001", path, "package publication wiring exists while package is private"));
      }
    }
  }

  for (const path of files.filter(isTextPath)) {
    let text;
    try {
      text = await readText(root, path);
    } catch {
      failures.push(failure("TEXT001", path, "tracked text file is unreadable as UTF-8"));
      continue;
    }
    const lower = text.toLowerCase();
    if (PRIVATE_TERMS.some(term => {
      const needle = term.toLowerCase();
      if (needle.length <= 3) return new RegExp(`\\b${needle}\\b`, "i").test(text);
      return lower.includes(needle);
    }) || /\bpatient[-_ ](?:data|records?|names?|identifiers?)\b/i.test(text)) {
      failures.push(failure("RESIDUE001", path, "private-project naming residue detected"));
    }
  }

  const claimChecks = [
    ["benchmarks/REPORT.md", [
      "initial selected context estimates are not total executor token usage",
      "no token or cost savings metric is calculated",
      "path conformance does not establish semantic correctness",
    ]],
    ["benchmarks/COMPARISON_PROTOCOL.md", [
      "not adaptive judgment quality",
      "judgment cost is unobserved",
      "one pair cannot separate",
    ]],
  ];
  for (const [path, required] of claimChecks) {
    let text = "";
    try { text = (await readText(root, path)).toLowerCase().replace(/\s+/g, " "); } catch {}
    if (required.some(phrase => !text.includes(phrase))) {
      failures.push(failure("CLAIM001", path, "evaluation claim boundary is missing"));
    }
  }

  let ignore = "";
  try { ignore = await readText(root, ".gitignore"); } catch {}
  for (const required of REQUIRED_IGNORES) {
    if (!ignore.split(/\r?\n/).includes(required)) {
      failures.push(failure("GIT001", ".gitignore", `missing local-artifact ignore rule: ${required}`));
    }
  }
  // Check effective rules too: later negations must not re-enable credentials or new results.
  const probes = [".env", "nested/.env.production", "codex.local.json", "nested/.local/config.json", "secret.pem", "nested/.npmrc", "nested/.netrc", "nested/id_rsa", "certificate.pfx", "credentials.json", "secrets.json", "eval-run-private/run.json", "evaluation/results/run.json", "execution-report.json", "preflight.json", "new.evaluation-result.json", "benchmarks/results/unapproved.json"];
  const ignored = new Set((await git(root, ["check-ignore", "--no-index", ...probes])).split(/\r?\n/).filter(Boolean));
  if (probes.some(path => !ignored.has(path))) failures.push(failure("GIT001", ".gitignore", "local-artifact ignore rules are ineffective"));

  for (const required of ["README.md", "LICENSE", "SECURITY.md", "package-lock.json"]) {
    if (!fileSet.has(required) || !(await exists(root, required))) {
      failures.push(failure("META002", required, "required release metadata file is missing"));
    }
  }

  return failures.sort((left, right) =>
    compare(left.rule, right.rule) || compare(left.path, right.path) || compare(left.message, right.message));
}

function compare(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

async function writeFixture(root) {
  // Positive fixture uses the current checked-out tracked tree, including approved bytes.
  for (const path of await trackedFiles(defaultRoot)) {
    await mkdir(dirname(resolve(root, path)), { recursive: true });
    await writeFile(resolve(root, path), await readFile(resolve(defaultRoot, path)));
  }
  await execFileAsync("git", ["init", "--quiet", root], { windowsHide: true });
  await git(root, ["config", "user.name", "TaskStance Audit"]);
  await git(root, ["config", "user.email", "audit@example.invalid"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "--quiet", "-m", "fixture"]);
}

async function resetFixture(root) {
  await git(root, ["reset", "--hard", "HEAD"]);
  await git(root, ["clean", "-fd"]);
}

function hasRule(failures, rule) {
  return failures.some(item => item.rule === rule);
}

async function selfTest() {
  const root = await mkdtemp(resolve(tmpdir(), "taskstance-prelaunch-"));
  try {
    await writeFixture(root);
    const positive = await auditRepository(root);
    if (positive.length !== 0) throw new Error("Positive pre-launch fixture failed");

    const packagePath = resolve(root, "package.json");
    let p = JSON.parse(await readFile(packagePath, "utf8"));
    p.scripts.postinstall = "echo unexpected";
    await writeFile(packagePath, JSON.stringify(p));
    if (!hasRule(await auditRepository(root), "PKG002")) throw new Error("Lifecycle-script rule failed");
    await resetFixture(root);

    await writeFile(resolve(root, "secret.pem"), "PRIVATE VALUE THAT MUST NEVER BE PRINTED");
    await git(root, ["add", "-f", "secret.pem"]);
    const secretFailures = await auditRepository(root);
    if (!hasRule(secretFailures, "ART001") ||
        JSON.stringify(secretFailures).includes("PRIVATE VALUE")) throw new Error("Secret-artifact rule failed");
    await resetFixture(root);

    const privateName = ["INTERNAL", "_ONLY"].join("");
    await writeFile(resolve(root, "README.md"), `# TaskStance\n${privateName}\n`);
    if (!hasRule(await auditRepository(root), "RESIDUE001")) throw new Error("Residue rule failed");
    await resetFixture(root);

    await writeFile(resolve(root, "src/core-index.ts"), 'export * from "./integrations/codex.js";\n');
    if (!hasRule(await auditRepository(root), "CORE001")) throw new Error("Core-neutrality rule failed");
    await resetFixture(root);

    await writeFile(resolve(root, ".github/workflows/ci.yml"), "name: CI\nsteps:\n  - run: npm publish\n");
    if (!hasRule(await auditRepository(root), "WF001")) throw new Error("Publish-workflow rule failed");
    await resetFixture(root);

    await mkdir(resolve(root, "evaluation/results"), { recursive: true });
    await writeFile(resolve(root, "evaluation/results/run.json"), "{}\n");
    await git(root, ["add", "-f", "evaluation/results/run.json"]);
    if (!hasRule(await auditRepository(root), "ART002")) throw new Error("Evaluation-artifact rule failed");
    await resetFixture(root);

    async function violation(rule, mutate) {
      await mutate();
      const failures = await auditRepository(root);
      if (!hasRule(failures, rule) || JSON.stringify(failures).includes("SENTINEL_PRIVATE_CONTENT")) {
        throw new Error("Policy self-test failed");
      }
      await resetFixture(root);
    }
    async function changePackage(mutate) {
      const value = JSON.parse(await readFile(packagePath, "utf8"));
      mutate(value);
      await writeFile(packagePath, JSON.stringify(value));
    }
    for (const mutate of [p => p.name = "other", p => p.private = false, p => p.license = "MIT", p => p.publishConfig = {}]) {
      await violation("PKG001", () => changePackage(mutate));
    }
    for (const name of FORBIDDEN_LIFECYCLE_SCRIPTS) {
      await violation("PKG002", () => changePackage(p => p.scripts[name] = "echo unexpected"));
    }
    await violation("PKG002", () => changePackage(p => p.scripts.release = "npm --access public publish"));
    await violation("PKG003", () => changePackage(p => p.files.push("benchmarks")));
    await violation("PKG003", () => changePackage(p => p.exports["."].import = "./dist/cli.js"));
    await violation("PKG003", () => writeFile(resolve(root, "docs/unexpected.json"), "SENTINEL_PRIVATE_CONTENT"));
    await violation("CORE001", () => writeFile(resolve(root, "src/contracts.ts"), 'export * from "./integrations/judgment-process.js";\n'));
    await violation("CORE001", () => writeFile(resolve(root, "src/contracts.ts"), 'import "openai";\n'));
    await violation("ART002", async () => {
      await writeFile(resolve(root, "benchmarks/results/unapproved.json"), "SENTINEL_PRIVATE_CONTENT");
      await git(root, ["add", "-f", "benchmarks/results/unapproved.json"]);
    });
    const approved = Object.keys(APPROVED_RESULTS)[0];
    await violation("ART003", () => writeFile(resolve(root, approved), "SENTINEL_PRIVATE_CONTENT"));
    await violation("ART003", () => rm(resolve(root, approved)));
    await violation("CLAIM001", () => writeFile(resolve(root, "benchmarks/COMPARISON_PROTOCOL.md"), "# Claims\n"));
    await violation("META001", () => changePackage(p => delete p.repository));
    await violation("META002", () => rm(resolve(root, "SECURITY.md")));
    await violation("GIT001", async () => {
      const ignore = await readFile(resolve(root, ".gitignore"), "utf8");
      await writeFile(resolve(root, ".gitignore"), `${ignore}\n!.env\n`);
    });
    await violation("GIT001", async () => {
      const ignore = await readFile(resolve(root, ".gitignore"), "utf8");
      await writeFile(resolve(root, ".gitignore"), ignore.replace("*.local.json", ""));
    });

    return {
      ok: true,
      positive_fixture: true,
      lifecycle_script_rejected: true,
      secret_like_artifact_rejected: true,
      private_residue_rejected: true,
      core_integration_leak_rejected: true,
      publish_workflow_rejected: true,
      evaluation_artifact_rejected: true,
      no_secret_contents_reported: true,
      identity_and_entrypoints_rejected: true,
      transitive_core_leak_rejected: true,
      unexpected_benchmark_result_rejected: true,
      historical_evidence_changes_rejected: true,
      claims_and_metadata_required: true,
      ineffective_ignore_rules_rejected: true,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "self-test") {
    process.stdout.write(`${JSON.stringify(await selfTest(), null, 2)}\n`);
    return;
  }
  if (args.length > 0) throw new Error("prelaunch audit accepts no arguments");
  const failures = await auditRepository(defaultRoot);
  process.stdout.write(`${JSON.stringify({
    schema_version: "1",
    kind: "taskstance-prelaunch-audit",
    ok: failures.length === 0,
    failures,
  }, null, 2)}\n`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch(() => {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    error: "Pre-launch audit failed; local metadata or files are unavailable",
  })}\n`);
  process.exitCode = 1;
});

export { auditRepository };
