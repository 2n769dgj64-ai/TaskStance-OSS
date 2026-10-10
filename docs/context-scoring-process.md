# Optional Context Scoring Process Adapter (Phase 4 / PR #4)

This developer-only integration implements the existing `ContextScoringProvider` interface. It is not enabled by the CLI, the default MCP tools, or offline configuration. Embedding applications can inject `new ContextScoringProcessAdapter(config)` as `contextScoringProvider` into `createDecisionRuntime`, without modifying the Core API.

## Configuration and invocation

Import `ContextScoringProcessAdapter` from `taskstance/integrations/context-scoring-process`. Configure only a trusted native executable at an absolute path, or give an absolute `cli_entrypoint` for a trusted JavaScript bridge (launched using TaskStance's `process.execPath`, never a shell). Configuration schema version is `1`; `provider_id` is application-owned. `args` are optional static strings. **Do not place credentials, secrets, task data or sensitive local paths in arguments.**

This interface is deliberately limited to metadata-only scoring. It does not select or execute coding agents, access a repository, search for candidate files, or perform external inference on its own. There is no implicit endpoint, model selection, retry, fallback provider, provider credential or discovery. Any real model must be integrated separately behind a trusted process implementation.

Request: one UTF-8 JSON document with `schema_version: "1"`, a `task` object containing `data_classification`, `task_id`, `attempt_id`, and `task_summary`, and a `candidates` array containing only optional candidate `id`, `kind`, `summary`, and `estimated_tokens`. Explicit `mandatory` candidates are never sent for scoring. Source file contents, absolute workspace paths as separate fields, full discovery records, project settings, environment variables and raw prompts are not forwarded. Candidate IDs may themselves be relative file paths or symbol names, so treat them as potentially identifying metadata. **Caller-authored summaries are NOT automatically redacted.** Use nonsensitive engineering metadata only.

Response: one UTF-8 JSON document with `schema_version: "1"`, `available`, and (when available) exactly one `{id, relevance}` score per candidate. Relevance must be finite and within `[0,1]`. An unavailable response can contain an allowed `unavailable_reason_code`, but no scores. The process cannot claim another `provider`, `model`, or token usage. Missing, duplicate, unknown, malformed, oversized, or out-of-range scores reject the response; `ContextPruner` retains all mandatory context and requires replan.

## Safety boundary

- Child process: `shell: false`, working directory is the OS temporary directory, stdout bounded to 256 KiB by default (configurable up to 1 MiB), stderr discarded, and no inherited environment variables (`env: {}`). Windows may add fixed platform identity variables.
- Input: 64 KiB max; subprocess calls are subject to the existing provider timeout and cancellation with process-tree termination. No automatic retries, secondary model, or telemetry payload capture.
- Identity and validation: `provider_id` comes from trusted configuration only; response keys and candidate IDs are verified. The deterministic `ContextPruner` still owns relevance filtering, token budgets, mandatory retention, incomplete-discovery handling and fail-closed behavior.
- **Not a sandbox:** A configured executable still has the account's filesystem and network privileges. An untrusted bridge could read credentials from files or make its own network requests. Configuration and execution of a real provider requires separate review and explicit opt-in.

Offline fixtures are under `test/context-scoring-process.test.ts` and `test/fixtures/context-scoring-process.mjs`. They do not call Codex, Claude, JEV, System One, the network or any paid provider. No cost-saving claim is made without later measured benchmarks.

This change intentionally does not add CLI `--context-scoring` flags. Preview support and runtime wiring belong to subsequent PRs.
