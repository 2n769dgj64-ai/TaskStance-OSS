# TaskStance

TaskStance is a provider-neutral, policy-first execution decision and context-control layer for AI coding agents.

It turns one engineering task into a bounded execution stance across:

- executor
- model tier
- reasoning effort
- context budget
- test depth
- review depth
- parallel safety
- integration strategy

TaskStance is **not** an LLM gateway or model router. Deterministic policy remains authoritative. Optional judgment and context-scoring providers are advisory and injected by the embedding application.

## Status: v0.1.0 Developer Preview

- The source code is publicly available on GitHub under Apache-2.0.
- The npm package is **not published**. `package.json` deliberately keeps `"private": true`; the CLI preview below uses a tarball you build locally.
- This is a Developer Preview, not a stable release: interfaces, configuration and schemas may change, and there is no production-support or long-term-support commitment.
- Report vulnerabilities privately as described in [SECURITY.md](./SECURITY.md), never in a public issue.

## Core pipeline

```text
Task
  ↓
Deterministic pre-policy
  ↓
Optional judgment provider
  ↓
Deterministic post-policy / authority
  ↓
Execution profile
  ↓
Context budget
  ↓
Deterministic local discovery
  ↓
Bounded context pruning
  ↓
Executor adapter
```

## Public MCP tools

The MCP tool surface is frozen to:

- `decide_execution`
- `resolve_context_budget`
- `assemble_context_candidates`
- `prune_context`
- `telemetry_snapshot`
- `runtime_health`

## Phase 2 execution boundary

The execution layer is intentionally split into two steps:

1. `buildExecutionPreparation(...)` combines a validated task, policy-authoritative execution decision, resolved context budget, and optional Minimal Context Packet.
2. `prepareWithExecutorAdapter(...)` hands that preparation to an executor-specific adapter after validating that the adapter handles the selected executor.

Adapters own executor-specific translation. The TaskStance core does not embed executor credentials, invoke hosted provider APIs, or silently substitute a different executor.

`DryRunExecutorAdapter` is included as a safe reference adapter. It produces a validated execution plan without launching an external coding agent.

Phase 2.2 adds an optional **real Codex CLI executor** through `taskstance/integrations/codex`, outside the Core export surface. The `run` command connects authoritative decisions, bounded explicit local context, and one external executor process. See [setup, architecture, limitations, and the synthetic demo](./docs/phase2-2.md). npm publication remains disabled.

Phase 2.3 adds optional advisory judgment through `taskstance/integrations/judgment-process`. Select it explicitly with `--judgment process --judgment-config judgment.local.json` on `plan` or `run`. It sends only the structured task and configured choice domains to one external process, then validates its response against the existing Core judgment contract. Without those flags, the CLI retains its offline behavior. See the [process protocol, configuration, and failure boundary](./docs/phase2-3.md).

Real execution requires explicit adapter selection:

```bash
taskstance run --adapter codex --task task.json --adapter-config codex.local.json --workspace /absolute/workspace --context context.local.json [--config taskstance.config.json]
```

`codex` is the sole registered real adapter. Missing/unknown adapters stop before execution. An atomic per-user workspace lock prevents concurrent TaskStance processes from launching into the same workspace; existing locks require manual inspection and are never automatically stolen. See the lock behavior below in the [integration documentation](./docs/phase2-2.md#workspace-locking).

## CLI preview

For a locally supplied Developer Preview tarball (npm publication remains disabled):

```bash
npm install /path/to/taskstance-0.1.0.tgz
npx --no-install taskstance init
npx --no-install taskstance validate
npx --no-install taskstance plan --task taskstance.task.example.json
```

The Phase 2 CLI currently supports a provider-neutral offline path:

```bash
npm ci
npm run build
node dist/cli.js init
node dist/cli.js validate
node dist/cli.js plan --task taskstance.task.example.json
```

`init` creates:

- `taskstance.config.json`
- `taskstance.task.example.json`

The default CLI path does not make provider or executor network calls. Tasks that need advisory judgment fall back conservatively to the configured `replan` executor until process judgment is explicitly configured or a provider is supplied by an embedding application.

## Safety boundaries

- deterministic policy is authoritative over provider suggestions
- incomplete discovery fails conservatively
- mandatory context cannot be removed by provider scoring
- provider calls are bounded in count and are not automatically retried
- executor adapters must match the executor selected by the final decision
- real execution stops before launch for replan, incomplete/over-budget context, or unsupported integration strategies
- telemetry is aggregate-only, opt-in, and must not retain raw task/code/prompt payloads
- the core contains no bundled provider credentials or provider-specific adapter

## Requirements

- Node.js 22 or newer
- no executor login or provider configuration is required for offline `init`, `validate`, and `plan`
- real Codex execution requires the separately installed/authenticated Codex CLI and explicit adapter configuration; embedding applications can supply other executors and advisory providers

An owner-authorized Windows synthetic smoke test on 2026-10-08 verified authenticated Codex CLI execution through TaskStance's default sanitized child environment, the documented Windows `cli_entrypoint` launch path, and the configured Windows sandbox. It ran against a pre-publication development revision; that development history is not part of this repository. The single run completed with exit code 0; the exact README edit, expected-file-only scope, and no-commit checks all passed. The reported executor usage was 46,060 input tokens and 284 output tokens. This is a narrow compatibility check, **not** a benchmark, a production quality claim, or evidence of token/cost savings. The later executable-resolution hardening leaves the `cli_entrypoint` launch command unchanged and has been validated with local fixtures only, not with a new authenticated turn. See the [executor limitations](./docs/phase2-2.md#remaining-phase-2-work).

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run audit:prelaunch
npm pack --dry-run
```

The offline [pre-launch audit](./docs/phase2-7-prelaunch-audit.md) checks packaging, Core neutrality, local artifacts and evidence boundaries. Passing it does not approve public launch.

## License

Apache-2.0. See [LICENSE](./LICENSE).
