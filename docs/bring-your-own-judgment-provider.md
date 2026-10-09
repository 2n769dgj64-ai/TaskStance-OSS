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

No JEV SDK, authentication flow, or verified JEV response mapping is integrated in this repository. To connect real JEV, supply public protocol documentation, an authorized credential mechanism compatible with the process boundary, and a verified response-to-Core mapping. Replace the mock call with one documented request, respecting cancellation and the parent deadline. Do not infer URLs or authentication from this example. Real JEV connectivity is not implemented or tested here.

Embedding applications can instead implement the existing `JudgmentProvider.decide(task, signal?)` and inject it through `createDecisionRuntime`. Return a Core `RawJudgment` with `schema_version: "2"` and a configured provider identity, and honor the supplied signal. The CLI process wire version remains `1`; its adapter performs that conversion. Context scoring is a separate interface and remains unavailable in this CLI integration.

## Failure and privacy boundaries

Unavailable, incomplete, invalid, out-of-domain, nonzero-exit, oversized, or timed-out responses fall back conservatively. Under the default policy, categorical confidence below `0.7` forces `replan`; security/destructive flags impose deterministic safety floors on valid judgments. Configurable policy retains final authority over model advice.

Core keeps its existing 30-second default deadline and configurable bounded timeout; CLI signals join that deadline. The process adapter kills the process tree on cancellation or output overflow and caps stdout (262144 bytes by default). No repair call or second provider call occurs. The reference bridge additionally bounds stdin to 65536 bytes.

Only configure trusted executables. The child starts in the OS temporary directory with an empty environment, `shell: false`, discarded stderr, and bounded stdout. This prevents inherited credentials but is not an OS sandbox: a trusted bridge still has the user's filesystem/network permissions. Do not weaken that environment boundary to make an SDK work. Credentials in environment variables are unavailable to the process integration; credentials in arguments, task text, JSON config, or logs are unsafe. Real connectivity needs a separately designed, least-privilege credential mechanism; none is added here.

Use nonsensitive engineering summaries only; caller-authored text is not redacted. Do not emit prompts, secrets, or raw provider errors. Keep local configuration out of source control (`*.local.json` is ignored). The synthetic reference example makes no network calls. The explicitly selected local HTTP bridge below performs local inference. Neither provides evidence of token or cost savings.

## Opt in to a real local chat model (Phase 2)

The [local HTTP bridge](../examples/judgment/local-http-bridge.mjs) is a small Node.js 22 adapter for `POST /v1/chat/completions`. It uses the same process provider, wire schemas, CLI selection, deadlines, cancellation, and deterministic policy as the reference bridge. Core and offline defaults are unchanged. Ordinary chat models provide advisory judgment; they are not equivalent to specialized decision models such as JEV or its native decision capabilities. Real JEV-compatible System One integration is outside this phase.

Configure a trusted, already installed server with authentication disabled and an already installed **local** model that supports structured output. Bind it to loopback. Do not select a cloud model, remote worker, tunnel, or forwarding backend. No server installation, model download, discovery, credentials, or authentication is performed by TaskStance. The bridge cannot verify how a trusted local server internally processes or forwards a request; loopback validation bounds its own network destination only.

[LM Studio configuration](../examples/judgment/lm-studio.example.json) uses `http://127.0.0.1:1234/v1/chat/completions` and the exact loaded model identifier. [Ollama configuration](../examples/judgment/ollama.example.json) uses `http://127.0.0.1:11434/v1/chat/completions` and the exact installed local model tag. Both examples require replacing the absolute bridge path and model placeholder. Executor choices must exist in the project configuration. The bridge receives exactly two arguments: endpoint and model identifier.

The documented compatibility target is `response_format: { type: "json_schema", json_schema: { name, strict: true, schema } }`, with nonstreaming output in `choices[0].message.content`. See [LM Studio structured output](https://lmstudio.ai/docs/developer/openai-compat/structured-output), [Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility), and [Ollama structured outputs](https://docs.ollama.com/capabilities/structured-outputs). Server versions, model capabilities, and supported JSON Schema subsets vary. The schema is derived from TaskStance's existing response contract, including optional decisions. If the server rejects that schema or cannot supply a valid result, TaskStance falls back; there is no downgrade, repair prompt, or replacement model.

### Explicit local inference smoke test

This optional test makes one real local inference request. It is not part of the automated tests. Start your existing local server and load your chosen local model yourself. From the built checkout, create the project configuration with `node dist/cli.js init` if it does not already exist. Then generate `judgment.local.json` using your chosen exact model identifier:

```sh
node --input-type=module -e "import {writeFileSync} from 'node:fs'; import {resolve} from 'node:path'; writeFileSync('judgment.local.json', JSON.stringify({version:'1',provider_id:'local-chat',executors:['primary','replan'],executable:process.execPath,cli_entrypoint:resolve('examples/judgment/local-http-bridge.mjs'),args:['http://127.0.0.1:1234/v1/chat/completions','REPLACE_WITH_LOADED_LOCAL_MODEL_ID'],max_output_bytes:262144},null,2));"
node dist/cli.js plan --task examples/judgment/task.json --judgment process --judgment-config judgment.local.json
```

For Ollama, change the endpoint port to `11434` and replace the model argument with your installed local tag. A complete, sufficiently confident valid response yields `decision_source: "provider+policy"`; unavailable, incomplete, unsupported, or low-confidence output yields conservative `replan`. Deterministic policy remains authoritative. A valid response is evidence of protocol compatibility only, not decision quality or confidence calibration. Model-reported confidence and `probability_true` are uncalibrated advisory information, **not verified probabilities**. Missing fields stay missing; the bridge never synthesizes confidence, probabilities, or decisions.

To run the same task offline, omit the opt-in flags:

```sh
node dist/cli.js plan --task examples/judgment/task.json
```

Offline mode makes zero HTTP calls even when a local server is running.

### Local bridge boundaries and deterministic tests

Only canonical `http://127.0.0.1:<port>/v1/chat/completions` and `http://[::1]:<port>/v1/chat/completions` are accepted. Ports must be 1–65535. DNS names (including `localhost`), alternate IP spellings, other loopback addresses, remote addresses, credentials, query strings, fragments, and alternate paths are rejected. Node's built-in `http` connects directly, without proxies or redirects. There are no API keys, authorization headers, retries, automatic model substitution, streaming, or tools.

One invocation performs at most one HTTP inference request. The bridge caps stdin and the serialized HTTP request at 65536 bytes, HTTP response bytes at 262144, headers at 8192, and output generation at 2048 requested tokens. Its HTTP deadline is 25 seconds, within Core's default 30-second deadline; a shorter parent deadline or cancellation kills the process through the existing adapter. Direct bridge callers can also supply an AbortSignal. Servers may continue inference internally after disconnection; TaskStance cannot control their cancellation behavior.

The response must be HTTP 200 with JSON content type and no compression, contain exactly one completed (`finish_reason: "stop"`) assistant message with JSON string content, and pass the existing strict response schema and all advertised choice domains (including probability keys). Invalid UTF-8, duplicate JSON members, prose, Markdown fences, truncation, refusals, tool calls, and oversized responses fail conservatively. Optional envelope metadata is ignored. Failures emit only a fixed unavailable protocol document; raw HTTP, prompt, model output, and schema diagnostics are discarded.

The child still starts in the temporary directory with an empty environment and discarded stderr. Only the strict nonsensitive task and permitted choices are sent, alongside static format instructions and schema. Caller-authored summaries are not redacted. The trusted server may have its own logs: configure its privacy settings separately. The process boundary is not an OS sandbox.

Run the deterministic local HTTP fixtures without a model server:

```sh
npx vitest run test/judgment-local.test.js test/judgment-reference.test.js test/judgment-process.test.ts
npm run typecheck
```

These tests use temporary loopback HTTP servers and synthetic responses. They cover structured success, invalid/unsupported output, missing confidence/decisions, low confidence, unavailable servers, timeout, cancellation, size limits, endpoint restrictions, IPv6, deterministic safety overrides, and zero offline HTTP calls. No live inference or hosted requests are used.
