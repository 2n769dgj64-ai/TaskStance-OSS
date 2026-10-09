# Security Policy

## Supported versions

TaskStance v0.1.0 is a **Developer Preview** whose source is public on GitHub. No npm release is published (`package.json` keeps `private: true`). Security fixes are made on the repository's default branch only; there is no stable-release, backport, or long-term-support commitment before 1.0.

## Reporting a vulnerability

Report suspected vulnerabilities privately through GitHub's **private vulnerability reporting** for this repository: open the repository's **Security** tab and choose **Report a vulnerability**. Do not put vulnerability details in a public issue, discussion, or pull request.

If the **Report a vulnerability** option is not shown, open a public issue that only asks the maintainer for a private contact channel. Include no technical details, affected code, reproduction steps, credentials, private source code, personal information, regulated data, or exploit details in that issue.

A useful report includes:

- affected version or commit
- affected public API/tool
- minimal reproduction using synthetic, non-sensitive data
- expected versus observed security boundary
- impact and preconditions

Do not send real provider API keys, personal data, proprietary source code, or production secrets.

## Security boundary

The Developer Preview includes a provider-neutral execution decision/control Core, an offline CLI, and optional Codex CLI and external-process judgment integrations. The integrations are separately exported as `taskstance/integrations/codex` and `taskstance/integrations/judgment-process`. CLI users must explicitly select real execution and process judgment; embedding applications can configure these integrations through their exports. The package does not bundle credentials, a hosted service, or a public network listener.

The Codex integration can launch one authenticated external coding-agent process using the user's separately installed CLI and local login. Its environment is minimal by default; additional variables require an explicit name allowlist. A native launcher named by `executable` is resolved to an absolute path before launch, searching only absolute `PATH` entries (never the workspace or relative/empty entries; on Windows only `.com`/`.exe`, never `.cmd`/`.bat`). The judgment process is trusted local configuration and retains its separate environment behavior. Benchmark verification commands receive only a minimal process/temporary-directory/locale environment, never parent credentials; this is environment sanitization, not a filesystem or network sandbox (see [benchmarks](benchmarks/README.md)). Context budgets bound initial selected content, not filesystem access or total executor cost. See [executor setup and boundaries](docs/phase2-2.md) and [process judgment boundaries](docs/phase2-3.md).

The core is designed for **non-sensitive engineering metadata**. Applications embedding it remain responsible for deciding what data may be sent to their configured judgment/context-scoring providers.

Important boundaries include:

- deterministic policy remains authoritative over provider suggestions; a provider-skip rule never bypasses a matching post-policy safety floor
- incomplete discovery fails conservatively
- mandatory context cannot be removed by provider scoring
- provider calls are bounded in count and are not retried automatically
- configured executors and policy executor references are validated fail-closed
- aggregate telemetry is off by default and must not retain task summaries, code, candidate identifiers, prompts, credentials, or raw request payloads
- the package must not contain bundled credentials or environment-variable values; documented variable names and explicit runtime opt-ins are permitted

## In scope

Examples include:

- bypasses of deterministic safety/policy authority
- mandatory-context loss or fail-open behavior
- executor/policy validation bypasses
- unexpected provider invocation or retry behavior
- sensitive payload retention in aggregate telemetry
- secret or private-file leakage into the published package
- unsafe MCP schema/validation behavior that crosses documented trust boundaries
- dependency or packaging issues that materially affect the shipped core, CLI, or optional integrations

## Generally out of scope

Unless they cross a documented security boundary:

- model/provider answer quality
- prompt quality or execution preference disagreements
- benchmark accuracy claims
- denial of service that requires trusted local callers to intentionally supply inputs beyond documented bounds
- issues in third-party provider adapters that are not shipped in this package

## Disclosure

Please allow reasonable time to investigate and prepare a fix before public disclosure. Security fixes should include a regression test when practical, without embedding real secrets or sensitive data in the repository.
