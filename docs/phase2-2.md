# Phase 2.2: first real executor integration

## Documentation scope

This document describes the TaskStance v0.1.0
executor integration and its security boundaries.
Internal development history is not included in
the independent source distribution.

## Architecture

```text
Task -> existing authoritative decision -> resolved budget
     -> explicit local file discovery -> assembly -> mandatory context pruning
     -> generic execution gates -> optional Codex adapter prepare
     -> shell-free Codex process -> bounded JSONL parsing -> aggregate result
```

Core exports only the generic `ExecutableExecutorAdapter`, `assertRunnablePreparation`, and `executeWithExecutorAdapter` additions. The integration is separately imported through `taskstance/integrations/codex`; filesystem discovery is `taskstance/integrations/local-context`. No provider credentials, models, SDK dependency, scheduler, new MCP tool, or hosted judgment provider enters Core.

The CLI selects an explicit adapter name through a small static integration factory, then calls the generic `executeWithExecutorAdapter()`. Only `codex` is registered. Missing or unknown names fail before input files are read or external processes are started. Adapter configuration validation and concrete imports stay in the integration layer; there is no dynamic loading or plugin framework.

Preparation makes no executor network call. `execute` launches the external installed CLI exactly once. The caller's existing Codex login provides authentication. Model tiers must be mapped explicitly in an adapter-only configuration. `minimal` reasoning maps to `low`, reported in the result; other efforts pass through unchanged. No automatic model substitution, retry, executor handoff, second reviewer, or concurrent execution within a process is introduced.

Only `direct` integration is supported. `isolated`, `staged`, and `replan` are rejected before launch. Context must be nonempty, hydrated, consistent with its packet, and within the resolved candidate/token budget. Explicit paths are all mandatory; no advisory context call is needed. Missing files, binary/non-UTF-8 content, duplicate real paths, escaping paths/symlinks, Git metadata, environment files, and oversized reads fail before execution. File token estimates use UTF-8 bytes / 4, rounded up; this is an estimate, not the model's tokenizer.

Codex runs as an independent process (`--no-daemon`) with `workspace-write`, `approval_policy="never"`, `--ignore-user-config`, and `--ephemeral`. On Windows the adapter explicitly selects the `elevated` sandbox backend by default; this is the stronger restricted-user sandbox, not full-access execution. An existing installation can explicitly configure `windows_sandbox:"unelevated"` if its deployment requires that backend; there is no automatic fallback or sandbox setup. See [Windows sandbox documentation](https://developers.openai.com/codex/windows). The adapter does not use shell launchers, bypass flags, added writable directories, or automatic approval escalation. Authentication still uses the user's existing CLI auth. Repository instructions and managed requirements still apply. Deployment-specific sandbox support must be available; failures remain failures.

Test/review depth is conveyed as an instruction to the single executor. It is not a deterministic verification engine. `parallel_safe` never enables additional agents: this version always executes sequentially and disables the CLI multi-agent feature. The integration strategy is enforced before launch. The context budget controls only initial selected file content; the agent can inspect workspace files and consumes additional reasoning/output tokens. It is not an access-control boundary or a total cost limit.

The parser requires a successful process exit and one valid `turn.completed` with usage, and rejects error/failure events, malformed/missing completion, output overflow, process errors, timeout, or cancellation. Future event types are accepted and ignored. A completed result means the agent turn completed; task correctness needs independent outcome checks. Process trees are terminated on timeout/cancellation; changes already made are retained for inspection, with no automatic rollback or retry. Preparations are adapter-owned and single-use.

Raw stdout/stderr, prompts, task contents, selected code, and final agent answers are not persisted or returned. Results contain model/effort, status/reason, exit code, event count, and token counts. This does not replace the external CLI/provider's own data handling. `--ignore-user-config` avoids inherited user plugins/settings; the executor environment is minimal by default (see above), but this is not a claim of hermetic execution: the CLI keeps the user's filesystem permissions and any variables you allow. Use only the engineering non-sensitive task contract.

## Setup and run

Install and authenticate Codex CLI separately. This integration was built against CLI 0.160.0 and the [official non-interactive interface](https://developers.openai.com/codex/noninteractive), including JSONL completion events. See the [CLI reference](https://developers.openai.com/codex/cli/reference) for sandbox/config options.

Keep the ordinary project config provider-neutral. Create a separate, local adapter file:

```json
{
  "version": "1",
  "executor": "primary",
  "models": {
    "cheap": "YOUR_AVAILABLE_MODEL_ID",
    "balanced": "YOUR_AVAILABLE_MODEL_ID",
    "strong": "YOUR_AVAILABLE_MODEL_ID",
    "max": "YOUR_AVAILABLE_MODEL_ID"
  },
  "timeout_ms": 300000,
  "max_output_bytes": 1000000
}
```

**Executor environment.** The Codex child process does not inherit the TaskStance process environment. It receives only a minimal platform set (Windows: `PATH`, `PATHEXT`, `SystemRoot`, `WINDIR`, `ComSpec`, `SystemDrive`, `TEMP`, `TMP`, `HOME`, `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH`, `LOCALAPPDATA`, `APPDATA`, `LANG`, `LC_ALL`, `LC_CTYPE`; other platforms: `PATH`, `HOME`, `TMPDIR`, `TMP`, `TEMP`, `LANG`, `LC_ALL`, `LC_CTYPE`), which keeps executable lookup and file-based CLI login working. Provider API keys, proxy settings and unrelated user secrets are excluded. Anything else must be named explicitly in the optional `inherit_env` array (default empty, at most 32 names, valid identifier names only, duplicates rejected case-insensitively on Windows; no wildcards or inherit-all), for example `"inherit_env": ["HTTPS_PROXY"]`, or a variable you deliberately authenticate with. Only names are configured; values are read from the parent at launch and never stored, logged or returned. This applies to both the TaskStance and the direct-comparison launch. The judgment-provider command environment is unchanged. Adding `inherit_env` changes the executor config hash.

Choose model IDs available to the authenticated CLI. The labels are policy tiers, not built-in model pricing promises. With the npm install on Windows, add `cli_entrypoint` containing the absolute path to `node_modules/@openai/codex/bin/codex.js`; the adapter uses the current Node executable to run it, avoiding `.cmd`/PowerShell quoting. A native binary can instead be named via `executable`. The config and launcher are trusted user inputs.

**Launcher resolution.** Before launch, the adapter turns `executable` into an absolute path so that a file in the workspace cannot shadow it. An absolute path is used as given. A relative path (`./codex`, `bin/codex`, or a Windows drive-relative name) is refused. A bare name (default `codex`) is looked up only in **absolute** `PATH` entries of the TaskStance process; empty and relative entries such as `.` are skipped, and the workspace directory is never searched. On Windows only `.com` and `.exe` files match, so npm `.cmd`/`.bat` shims are never selected; use `cli_entrypoint` for npm installs. If nothing matches, preparation fails before any lock or process is created. Windows process-tree termination uses `%SystemRoot%\System32\taskkill.exe` by absolute path. The benchmark harness resolves `git`, verification executables and `taskkill.exe` the same way.

Create a context manifest containing workspace-relative file paths:

```json
["README.md"]
```

Run in an existing Git workspace that you intend to modify:

```text
taskstance run --adapter codex --task taskstance.task.example.json --config taskstance.config.json --adapter-config codex.local.json --workspace /absolute/path/to/workspace --context context.local.json
```

The offline CLI executes deterministic tasks such as `docs_only`; tasks needing unavailable judgment stop at replan. Applications can still inject their own judgment/scoring providers through existing Core contracts. Do not misclassify a task to force execution. Exit status is nonzero for execution failure/cancellation/timeout. Ctrl+C cancels the running process tree.

## Workspace locking

Immediately before launching the executor, the integration exclusively creates (`open` with `wx`) a lock at `<user home>/.taskstance/workspace-locks/<sha256>.lock`. The key hashes the workspace's resolved real path, lowercased on Windows; symlink aliases share a lock. The stable per-user location avoids Git-visible workspace files and differences in temporary directories. No native addon is needed. Processes must run under the same OS user/home on a local filesystem with atomic exclusive creation; this is not a distributed or multi-user lock.

Metadata contains only the TaskStance format marker, schema version, PID, creation time, and a random ownership token. It contains no workspace path, task, context, source, prompt, credentials, or responses. The directory requests mode `0700` and files `0600` on POSIX; Windows uses the user's filesystem permissions. The in-memory concurrency guard remains in place.

Success, failure, invalid output, process error, synchronous launch failure, output overflow, timeout, and handled cancellation release the lock in `finally`, after process close when a child was started. Cancellation during acquisition is checked again before launch. Cleanup verifies the file's identity and exact metadata; changed/unrecognized files are retained and execution reports an error.

Every existing lock fails closed, whether live, old, malformed, or apparently stale. There is no automatic recovery, PID-based stealing, retry, or age threshold. Abrupt TaskStance termination (including SIGKILL or machine failure) or a metadata-write/cleanup error can leave a lock. Inspect the exact file and verify its recognized format and that both the owning TaskStance process and its executor tree have stopped before manually removing it. Age or a missing owner PID alone is insufficient: an executor may have survived its parent. Never remove an unrecognized file. Lock-directory permission errors also prevent launch.

## Reproducible synthetic demo

```powershell
$env:TASKSTANCE_DEMO_MODEL = 'YOUR_AVAILABLE_MODEL_ID'
# Windows npm installation only; use the actual installed path:
$env:TASKSTANCE_CODEX_ENTRYPOINT = 'C:\path\to\node_modules\@openai\codex\bin\codex.js'
npm run build
npm run demo:codex
```

The demo creates a new temporary Git workspace with a synthetic README. The real executor replaces `Status: pending` with `Status: ready`. The harness independently checks exact content, file scope, and absence of commits. It prints aggregate results and the workspace path for inspection, keeping the workspace afterward. All tiers use the explicitly selected model for this tiny demo. This is not a real-task benchmark or a production-savings claim.

CI uses an explicitly labeled protocol fixture for subprocess failure/timeout/cancellation coverage; it does not call the hosted executor or consume quota. Live demo validation is recorded separately from these tests.

Live validation on 2026-10-06 with the installed Codex CLI 0.160.0 and the user's configured model `gpt-6.1-sol`: deterministic decision, 1 selected mandatory file, 9 estimated file tokens, 0 advisory provider calls; actual executor usage 46,464 input tokens and 252 output tokens. Exact README outcome, expected-file-only scope, and zero commits all passed. These actual usage figures demonstrate why selected context estimates must not be advertised as total-token savings. An earlier completed turn made no edit under a read-only execution environment; the independent file check correctly failed. Independent-process launch and explicit Windows sandbox configuration were then validated with a fresh workspace.

## Remaining Phase 2 work

**Developer Preview authenticated compatibility smoke (2026-10-08, owner-authorized):** On Windows, against a pre-publication development revision whose history is not part of this repository, one real Codex CLI turn ran through the existing synthetic demo with default `inherit_env: []` (sanitized child environment) and the configured Windows sandbox. Observed `status: completed`, `reason: turn_completed`, `exit_code: 0`, and smoke exit code 0. The synthetic README content check, expected-file-only check and no-commit check were all true; provider/judgment calls were 0. Codex reported 46,060 input tokens and 284 output tokens for this turn versus 9 estimated tokens of selected initial file content. This confirms one local authentication/execution compatibility path only. It does **not** validate other machines, provider modes, production safety, quality, or token/cost savings. The later launcher-resolution hardening (above) does not change the `cli_entrypoint` command used on Windows npm installs; it is covered by local fixture tests only and has not been re-run with an authenticated turn.

Hosted judgment adapter, broader integration strategies, and final launch review remain separate milestones. Five historical public OSS task records are available in the repository's `benchmarks/REPORT.md`; they do not establish performance or savings claims, and no direct comparison has been run. The source is public as a Developer Preview; npm publication remains disabled (`package.json` keeps `private: true`).
