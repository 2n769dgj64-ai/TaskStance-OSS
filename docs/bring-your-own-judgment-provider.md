# Bring Your Own Judgment Provider

TaskStance applies deterministic policy, safety constraints, context bounds, and execution preparation. A judgment model supplies advisory choices and confidence. TaskStance complements JEV and similar models; it does not replace them or route between models.

## Run offline

From a source checkout with Node.js 22 or newer:

```sh
npm ci
npm run build
node dist/cli.js init
node dist/cli.js plan --task examples/judgment/task.json
```

Run `init` in a directory without existing `taskstance.config.json` or `taskstance.task.example.json`; it refuses to overwrite them. The task above needs judgment, so the offline plan uses conservative `replan` fallback. The task created by `init` is docs-only and normally receives a deterministic decision. Neither command launches a model or executor.

## Configure one process provider

The supported CLI integration is the existing `--judgment process --judgment-config <path>` on `plan` and `run`. Both flags are required together. Omitting them stays offline. Unknown adapters and invalid configurations stop before planning. There are no retries, parallel provider calls, or automatic model switches. Deterministic policy may skip the configured provider entirely. Tasks that need judgment must include `task_id` and `attempt_id`.

[Example configuration](../examples/judgment/process.example.json) uses the existing strict version-1 configuration. Adapt its absolute `cli_entrypoint` to your trusted bridge. With a Node entry point, TaskStance launches its own Node executable; the `executable` field is still required. For native bridges without `cli_entrypoint`, use an absolute native executable path. Shell launchers are unsupported.

This command creates a working local configuration using the actual checkout path on Windows or POSIX:

```sh
node --input-type=module -e "import {writeFileSync} from 'node:fs'; import {resolve} from 'node:path'; writeFileSync('judgment.local.json', JSON.stringify({version:'1',provider_id:'reference-mock',executors:['primary','replan'],executable:process.execPath,cli_entrypoint:resolve('examples/judgment/reference-bridge.mjs'),args:['valid'],max_output_bytes:262144},null,2));"
node dist/cli.js plan --task examples/judgment/task.json --judgment process --judgment-config judgment.local.json
```

The result reports `decision_source: "provider+policy"`. This is a local synthetic decision, not a real model call. Change `args` to `["missing"]`, `["low-confidence"]`, `["unavailable"]`, or `["invalid"]` to exercise conservative behavior. Executor names must exist in the project configuration; the example explicitly maps `implementer` to `primary` and `planner` to `replan`.

## Protocol and mappings

TaskStance writes one UTF-8 JSON document plus newline to stdin, closes stdin, and expects one JSON document on stdout followed by exit code zero. The request contains `schema_version: "1"`, the strict structured `task`, and `choices` containing configured executors and Core enum domains. No repository contents, context candidates, adapter configuration, or credentials are sent.

The response has `schema_version: "1"`, `available`, and optional `decisions`. Each categorical decision has `selected`, `confidence` in `[0,1]`, and optional `probabilities`. `parallel_safe` has a boolean `selected` and `probability_true` in `[0,1]`. Missing decisions remain missing; the bridge must not supply invented confidence or defaults. The process cannot set `provider`: configuration owns identity. See the complete [request/response protocol and resource limits](phase2-3.md).

The [reference bridge](../examples/judgment/reference-bridge.mjs) reuses the exported process request/response schemas. It explicitly maps every categorical field and probability key, preserves probability and confidence values and optional fields, and rejects unknown labels or choices outside the advertised domains. Its source labels and mock response are illustrative, **not a documented JEV format**.

No verified JEV endpoints, SDK, authentication flow, or response protocol are present in this repository. To connect real JEV, supply public protocol documentation, an authorized credential mechanism compatible with the process boundary, and a verified response-to-Core mapping. Replace the mock call with one documented request, respecting cancellation and the parent deadline. Do not infer URLs or authentication from this example. Real JEV connectivity is not implemented or tested here.

Embedding applications can instead implement the existing `JudgmentProvider.decide(task, signal?)` and inject it through `createDecisionRuntime`. Return a Core `RawJudgment` with `schema_version: "2"` and a configured provider identity, and honor the supplied signal. The CLI process wire version remains `1`; its adapter performs that conversion. Context scoring is a separate interface and remains unavailable in this CLI integration.

## Failure and privacy boundaries

Unavailable, incomplete, invalid, out-of-domain, nonzero-exit, oversized, or timed-out responses fall back conservatively. Under the default policy, categorical confidence below `0.7` forces `replan`; security/destructive flags impose deterministic safety floors on valid judgments. Configurable policy retains final authority over model advice.

Core keeps its existing 30-second default deadline and configurable bounded timeout; CLI signals join that deadline. The process adapter kills the process tree on cancellation or output overflow and caps stdout (262144 bytes by default). No repair call or second provider call occurs. The reference bridge additionally bounds stdin to 65536 bytes.

Only configure trusted executables. The child starts in the OS temporary directory with an empty environment, `shell: false`, discarded stderr, and bounded stdout. This prevents inherited credentials but is not an OS sandbox: a trusted bridge still has the user's filesystem/network permissions. Do not weaken that environment boundary to make an SDK work. Credentials in environment variables are unavailable to the process integration; credentials in arguments, task text, JSON config, or logs are unsafe. Real connectivity needs a separately designed, least-privilege credential mechanism; none is added here.

Use nonsensitive engineering summaries only; caller-authored text is not redacted. Do not emit prompts, secrets, or raw provider errors. Keep local configuration out of source control (`*.local.json` is ignored). This example makes no network calls and provides no evidence of token or cost savings.
