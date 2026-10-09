# Phase 2.3: generic external judgment process

The process integration implements the existing `JudgmentProvider.decide(task, signal?)` interface. Core remains provider-neutral and retains its existing timeout, RawJudgmentSchema v2 validation, conservative fallback, pre-policy reapplication, post-policy authority, and configured-executor check. The integration is exported only from `taskstance/integrations/judgment-process`.

## CLI selection

```sh
taskstance plan --task task.json --judgment process --judgment-config judgment.local.json
taskstance run --adapter codex --task task.json --adapter-config codex.local.json --workspace /absolute/workspace --context context.local.json --judgment process --judgment-config judgment.local.json
```

Both commands accept the existing `--config` project configuration. The project configuration stays unchanged. Judgment defaults to offline/unavailable when no judgment flags are supplied. Unknown selections, missing selection/configuration, repeated judgment flags, invalid configuration, and process choices absent from the project executor list fail closed. Only `process` is registered in the small static factory; there is no dynamic module loading or discovery.

Tasks still require `task_id` and `attempt_id` for provider calls. Deterministic pre-policy can skip the provider entirely, including for docs-only work. Selecting a process does not force a provider call when Core skips it.

## Adapter configuration

```json
{
  "version": "1",
  "provider_id": "local-judgment",
  "executors": ["primary", "replan"],
  "executable": "node",
  "cli_entrypoint": "C:\\absolute\\path\\judgment-cli.mjs",
  "args": [],
  "max_output_bytes": 262144
}
```

`executable` is required. With `cli_entrypoint`, the adapter uses the current Node executable and prepends that absolute entry point to `args`; without it, the adapter invokes the configured native executable directly. Configure `executable` as an absolute path: the process starts with an empty environment, so bare-name lookup is platform-dependent and unsupported. Relative entry points, shell scripts (`.cmd`, `.bat`, `.ps1`, `.sh`), and known shell executables are rejected. `args` defaults to an empty array. Stdout defaults to a 262144-byte limit; configuration permits 1024–16000000 bytes. Executors must be a unique list of 1–16 identifiers. The strict schema accepts no extra keys, environment configuration, executor adapter configuration, or provider secrets.

The config exclusively owns `provider_id`. The process cannot return a `provider` field. Configure only trusted executable code and nonsecret arguments. This integration is a data-transfer boundary, not an operating-system sandbox: a configured executable has the user's filesystem permissions and could read files independently. It runs in the OS temporary directory with an empty environment, without inheriting provider credentials, environment dumps, or Node preload options. Providers requiring inherited credentials or shell initialization are unsupported in this phase.

## Stdin request

Each judgment call launches exactly one process with `shell: false`. It writes one UTF-8 JSON document followed by a newline to stdin and closes stdin:

```json
{
  "schema_version": "1",
  "task": {
    "data_classification": "engineering_non_sensitive",
    "task_id": "example-task",
    "attempt_id": "a1",
    "summary": "Refactor the request validation boundary.",
    "flags": {}
  },
  "choices": {
    "executors": ["primary", "replan"],
    "model_tiers": ["cheap", "balanced", "strong", "max"],
    "reasoning_efforts": ["minimal", "low", "medium", "high"],
    "context_budgets": ["tiny", "small", "medium", "large"],
    "test_depths": ["none", "targeted", "standard", "full"],
    "review_depths": ["none", "targeted", "standard", "full"],
    "integration_strategies": ["direct", "isolated", "staged", "replan"]
  }
}
```

`task` is the existing strict TaskInput, including its optional project/category identifiers. The other top-level and choice fields are strict too. Executor identifiers come from adapter configuration; other domains reuse Core's enumerations. There are no repository contents, search results, context candidates, candidate/selected token estimates, machine metadata, adapter config, credentials, or provider secrets in the request. Task summaries must themselves contain only the declared nonsensitive engineering data; the adapter does not redact caller-authored summaries.

## Stdout response

The process emits exactly one UTF-8 JSON document and exits with code zero. Whitespace and pretty printing are allowed; logging or additional JSON documents on stdout are rejected. A usable example is:

```json
{
  "schema_version": "1",
  "available": true,
  "decisions": {
    "executor": { "selected": "primary", "confidence": 0.95 },
    "model_tier": { "selected": "balanced", "confidence": 0.95 },
    "reasoning_effort": { "selected": "medium", "confidence": 0.95 },
    "context_budget": { "selected": "small", "confidence": 0.95 },
    "test_depth": { "selected": "targeted", "confidence": 0.95 },
    "review_depth": { "selected": "targeted", "confidence": 0.95 },
    "parallel_safe": { "selected": true, "probability_true": 0.95 },
    "integration_strategy": { "selected": "direct", "confidence": 0.95 }
  }
}
```

The strict response schema is derived directly from RawJudgmentSchema v2, with wire version `1` and no `provider` field. Existing optional `model`, `usage`, `unavailable_reason_code`, and choice probability fields retain their Core semantics. An unavailable response can be `{"schema_version":"1","available":false,"unavailable_reason_code":"UNKNOWN"}`. Response members cannot repeat, including escaped spellings of the same key. Unknown fields and identity spoofing fail validation.

The adapter adds the configured identity and maps the version to `2`, validates with RawJudgmentSchema, and returns that structured object. It rejects executor selections outside its advertised choices. It does not fill missing decisions, substitute choice values, or repair invalid profiles. Existing Core profile validation and policy retain final authority over incomplete/invalid choices, confidence, and executors.

## Failure, cancellation, and context boundaries

Nonzero exit, launch/input error, malformed JSON, invalid UTF-8, invalid response schema, missing/duplicate/conflicting responses, oversized stdout, or cancellation reject with fixed safe error messages. Core handles those failures conservatively. No raw stdout, stderr, parse diagnostic, prompt, or repository content is returned or persisted by the adapter. Stderr goes directly to the null device. Bounded stdout is held only in memory until parsing and discarded afterward. Existing aggregate telemetry remains unchanged.

Core's existing AbortSignal controls the normal deadline (30 seconds by default). Pre-abort launches nothing. Running cancellation or output overflow kills the POSIX process group or invokes Windows `taskkill.exe /T /F` without a shell. CLI SIGINT/SIGTERM joins Core's deadline signal during planning and execution. Direct calls without a signal use the existing default bounded provider helper; direct calls with a signal must arrange their own deadline. There is no automatic retry, second provider call, model substitution, or executor launch inside judgment.

The runtime factory pairs process judgment with the existing unavailable context scorer. Explicit local context hydration/pruning for `run` still happens separately, after judgment. The process receives no context candidates and cannot act as a repository/context scoring provider.

Validation uses only a local protocol fixture. It covers policy authority, safe requests, failure paths, one launch/no retry, identity ownership, CLI defaults and selection, separate exports, aggregate telemetry, and process-tree cancellation. CI makes no hosted model/provider calls. This phase adds no provider SDK, dependency, scheduler, MCP tool, publish workflow, or npm release.
