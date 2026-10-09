# Comparison protocol: TaskStance-controlled Codex vs direct Codex

Status: **protocol (Phase 2.4f); harness support implemented in Phase 2.4g (fixture-tested).** No comparison has been run or
authorized. The five existing records in `results/` are TaskStance-mode records,
are unchanged, and must never be relabelled as comparison evidence. Nothing here
is a performance, savings or cost claim.

## 1. Fair comparison

The question is narrow: for the same task, on the same pinned checkout, using the
same Codex executor, model and reasoning effort, does TaskStance control (judgment,
policy profile, selected initial context, test/review depth instructions) change
observable outcomes and executor-reported usage compared with launching Codex
directly with only the task statement?

Fairness rules:

- Pair, don't pool. One task, one baseline commit, one `taskstance` run and one
  `direct` run, each from a fresh disposable clone.
- The direct arm is pinned to the model and reasoning effort **observed** in the
  TaskStance arm's record (`measurements.executor.model` / `reasoning_effort`),
  so TaskStance cannot "win" by silently choosing a stronger model, and direct
  cannot win by using one.
- Both arms are judged by the same deterministic verification and the same
  allowed-path scope check. Neither is judged by a model or a reviewer.
- A single pair is an anecdote. Repeated pairs (section 9) are required before
  any statement beyond "the harness can record both arms".

## 2. Must be identical

| Input | How identity is shown |
|---|---|
| Upstream repository and `baseline_commit` | same manifest values; same record fields |
| Task statement (`task.summary`) | same text |
| Verification commands and timeouts | same manifest |
| `allowed_changed_paths` | same manifest |
| Executor adapter, `cli_entrypoint`, `timeout_ms`, `max_output_bytes` | equal `executor_config_canonical_sha256` |
| Model and actual reasoning effort | equal `measurements.executor.model` / `.reasoning_effort` |
| Codex fixed flags (`--sandbox workspace-write`, `approval_policy=never`, `features.multi_agent=false`, `--ephemeral`, `--ignore-user-config`) | same adapter code path |
| Codex CLI version, Node version, OS, account/quota state | recorded manually by the operator (the harness records only OS and Node version) |
| Instructions forbidding commit/push/install/other agents | shared sentences in both prompts |

The operator must compare every manifest value other than the mode explicitly
rather than rely on a single hash.

Executor implementation changes (for example the minimal child-process environment
and `inherit_env`, or the harness's Git ignoring user-level Git configuration such
as `core.autocrlf`) can affect historical comparability even when config hashes
match, because the hash covers the config text, not the adapter code. Records
produced before such a change ran with the full inherited parent environment.

## 3. What differs

| | TaskStance arm | Direct arm |
|---|---|---|
| Decision | judgment process + policy (`provider+policy`; fixed-control judgment in current tasks) | none |
| Profile (tier, effort, budget, test/review depth) | selected by TaskStance | none; model/effort pinned from the paired record |
| Initial context | declared files hydrated within the context budget and embedded in the prompt | no embedded files; the agent discovers files in the checkout itself |
| Prompt | TaskStance prompt with profile JSON and selected files | task statement plus the same safety sentences |
| Test/review depth instruction | from profile | none |

The current judgment is the fixed-control judgment, so the TaskStance arm exercises
the real boundary and deterministic policy path, **not adaptive judgment quality**.
Any difference is attributable to "controlled prompt and initial context", not to
smarter routing.

## 4. Comparable and non-comparable metrics

Comparable (observed the same way in both arms):

- `outcome`, `failures`, verification status and exit codes
- `scope_conformant` and `changed_paths`; `change_evidence` is a fingerprint only
  (byte-identical output is neither expected nor a goal)
- `duration_ms` (wall clock, noisy; the TaskStance arm also includes judgment time)
- `executor.usage.input_tokens` / `output_tokens` **when reported** in both arms
- `executor.event_count`, `status`, `reason`

Not comparable, or descriptive only:

- Judgment cost: only the TaskStance arm has judgment calls, and their tokens/cost
  are not observed (`judgment_calls` counts invocations only). This must be stated
  next to any usage figure, never silently dropped.
- Any savings percentage, cost or quality score. None is computed or permitted.
- Semantic correctness: a dependency-free check plus path scope does not prove the
  two patches are equivalent or good.
- `decision_source`, `profile`, `judgment_calls`, `initial_context_*`: no direct-mode
  meaning (section 6).

## 5. Initial context estimate vs total executor usage

- `initial_context_estimated_tokens` is a UTF-8 byte-based estimate of the
  **selected initial file content only**, taken before the executor starts. It is
  TaskStance's own estimator, not a provider tokenizer.
- `executor.usage.*` is what Codex reports for the whole turn: system/tool overhead,
  context repeated across tool round trips, files the agent read itself, and output.
- They are different quantities. The five records show initial estimates of 741 to
  1,828 against 51,286 to 131,821 executor input tokens; the ratio is not stable.
- Rules: never subtract, divide or plot one against the other; never call the
  initial estimate "tokens used"; unreported usage is `null`/unknown, never zero.
  The direct arm has no initial estimate, so the only cross-arm token comparison is
  `executor.usage` against `executor.usage`.

## 6. Honest direct-mode evidence

- `mode: "comparison"` already exists in the result schema, but it reuses
  `RunMeasurementsSchema`, which **requires** `decision_source`, `profile`,
  `judgment_calls`, `initial_context_*` and `mandatory_context_retained`. A direct
  record cannot satisfy that without false values (an invented profile, or
  `decision_source: "deterministic"`). Doing so is fabrication and is prohibited.
- A direct record therefore needs a distinct measurements shape holding only what
  was observed: executor result (adapter, status, reason, exit code, model, actual
  reasoning, event count, usage), duration, verification, changed paths, scope,
  change evidence and hashes. TaskStance-only fields are absent, not zero, `null`
  or defaulted.
- The paired TaskStance record is referenced by `benchmark_id` plus manifest and
  executor-config hashes; the direct record must not copy its profile.
- Model and reasoning for the direct arm come from what Codex reports; the pair is
  invalid if they differ from the paired record.

## 7. Smallest implementation (implemented in Phase 2.4g; schema version 3, CLI form `--live --mode direct --pair-with`)

Uses only the existing Codex executor integration; no second agent, reviewer or
provider.

1. `src/benchmark/schemas.ts`: add a direct measurements variant (executor result
   only) selected by `mode: "comparison"`; keep `taskstance` strict and unchanged;
   add a schema version only if v2 cannot stay backward compatible.
2. `src/integrations/codex.ts`: a prepare path building the launch from task +
   pinned model + reasoning, with no context packet or profile, reusing the same
   spawn, timeout, output bounds, event parser and fixed flags.
3. `src/benchmark/runner.ts`: a `direct` branch reusing clone, clean check,
   verification, scope, mutation checks and `change_evidence`, skipping judgment and
   the CLI `run` pipeline.
4. `src/benchmark/cli.ts`: opt-in `--mode direct` that still requires `--live`, plus
   `--pair-with <taskstance-result>` verifying baseline, task, verification, scope,
   model/effort and executor-config canonical hash.
5. `src/benchmark/report.ts`: group by `benchmark_id`, print only the section 4
   comparable metrics side by side with the section 5 warning; blank TaskStance-only
   fields for direct rows.
6. Tests: fixtures only (existing Codex protocol double); no hosted calls in CI.

Core and policy need no change.

## 8. Recommended task

**`minimist-pr17-long-option-single-dash`** (`minimistjs/minimist` @
`ba92fe6ebbdc0431cca9a2ea8f27beb492f5e4ec`).

- Largest declared initial context among the genuine records (1,828 estimated
  tokens across `index.js` and `test/dash.js`), so controlled versus discovered
  context is most likely to differ observably.
- A code bug fix on the typical `provider+policy` path, with a dependency-free
  verification that fails on the baseline.
- It already has a passing TaskStance record, so the model/effort to pin
  (`gpt-6.1-sol`, `medium`) is known and spend is small and bounded.

Limitation: one small-library task is not representative of large repositories or
multi-file work.

## 9. Threats to validity, limitations, launch-budget controls

Threats and limitations:

- **n = 1 per arm.** Model sampling is nondeterministic; one pair cannot separate
  effect from variance. Duration and usage vary run to run.
- Order, time-of-day, provider load and quota effects.
- Codex CLI/model drift; the harness does not record the CLI version.
- The historical TaskStance record may predate environment changes; a fair pair
  re-runs both arms close together rather than reusing the old record.
- Direct mode may explore more or fewer files; a usage difference may reflect
  exploration style rather than TaskStance control.
- Judgment cost is unobserved, and fixed-control judgment says nothing about
  adaptive judgment.
- Weak oracle: no human or model review; passing checks do not establish quality.
- Windows / Node v24 observations only; public-repo tasks may be known to the model.

Launch-budget controls (each authorized separately):

- Written authorization naming task, mode and run count.
- Initial pair: exactly one run per arm, no retries; a failed run is kept as
  evidence, not rerun to improve results.
- Any repetition needs a new budget decision, with a total launch cap stated up
  front and the manifest `timeout_ms` per run.
- Arm order fixed in advance (or randomized and recorded), not chosen after seeing
  results.
- Zero provider, judgment or Codex launches in CI, tests or documentation phases.
- Results are created exclusively, never edited, and labelled with their true `mode`.
