# Phase 2.7: deterministic pre-launch audit

This gate is a maintainer-side static audit of this repository's tracked files and package scope. It does not publish anything and it is not a legal, privacy, security, or quality certification.

## Run

```bash
npm run audit:prelaunch
```

The audit is also wired into CI immediately before `npm pack --dry-run`.

It uses only the checked-out Git tree and local files. There are no network, registry, provider, executor, or model calls.

## Rules

The gate currently checks:

- `PKG001`: package identity, Apache-2.0 license metadata, `private:true`, and no `publishConfig`;
- `PKG002`: no install/prepare/pack/publish lifecycle scripts;
- `PKG003`: current-main package-files, export keys and targets, main/types/bin contracts, and included-directory file allowlists (including untracked/ignored files and symlinks);
- `META001/META002`: expected repository URLs plus README, LICENSE, SECURITY and lockfile presence;
- `CORE001`: the transitive Core dependency closure stays within neutral root modules, Node built-ins, Zod and the MCP server;
- `ART001`: obvious secret-bearing/local-config filenames are not tracked;
- `ART002`: local evaluation run artifacts and unexpected benchmark result paths are not tracked;
- `ART003`: the five owner-approved historical records remain present with exact approved SHA-256 bytes (LF or Git autocrlf CRLF checkout);
- `WF001`: no package-publication wiring exists in workflows while the package is private;
- `RESIDUE001`: standalone public-scope text does not contain private-project naming residue. The public term list contains only generic placeholder markers plus a regulated-data phrase check; it deliberately holds no real private names or hashes of them (low-entropy names are guessable from hashes). Real private names are checked by the separate owner-side scan below;
- `CLAIM001`: the current benchmark REPORT and comparison protocol retain their no-overclaim language;
- `GIT001`: required local config/credential/evaluation ignore rules exist and effective Git ignore probes pass.

Failures print only a rule ID, repository-relative path, and generic message. File contents and secret values are never printed by the audit.

## Compatibility and self-tests

The standalone snapshot includes the optional
judgment-process integration. Evidence checks use
the benchmark report and comparison protocol
included in this repository.

Only these historical result paths are approved: `clsx-pr82-readme-bench-links`,
`is-stream-pr21-http-streams`, `minimist-pr17-long-option-single-dash`,
`yocto-queue-pr13-drain-undefined`, and `yoctocolors-pr26-bold-dim`, each as a JSON
file under `benchmarks/results/`. Exact bytes are pinned in the script. No other
file under that directory is exempt. New evidence requires explicit review of
this allowlist; the ignore rules allow only those five tracked records.
`*.local.example.json` configuration templates remain valid; `*.local.json` and
`.local/` machine configuration remain forbidden when tracked.

`node scripts/prelaunch-audit.mjs self-test` creates a disposable temporary Git
fixture and intentionally violates every rule family, including transitive Core
imports, export target changes, untracked package-scope files, altered/missing
historical results, and later ignore negations. It never edits the checkout.
The Vitest wrapper runs these tests in the existing Ubuntu Node 22/24 and Windows
Node 24 matrix. The normal gate is read-only, has stable ordinal output ordering,
and invokes only local Git inspection commands. It requires Git and Node 22+.

## Boundary

A green result means only that these deterministic checks passed for the current checkout.

It does **not** mean:

- the package has been approved for publication;
- vulnerability review is complete;
- a privacy/security review has passed;
- real-task evaluation has passed;
- performance or cost claims are justified.

The npm package remains `private: true` and unpublished. Making the source repository public and any future npm release each require explicit owner approval; neither is implied by a green audit.

## Owner-side private-name scan

`RESIDUE001` cannot detect real private project names because they must never appear in this public repository, not even hashed. The owner therefore runs a separate scan whose rules and output live **outside** this repository. It must pass on the exact tree and package that will be published, before the first public push and before each later release.

1. **Terms file, outside the repository** (for example `%USERPROFILE%\taskstance-private-scan\terms.txt`, or `~/taskstance-private-scan/terms.txt`). One literal term per line, never committed, copied into issues, or placed under the checkout. Include:
   - every private project, product, codename, package, repository and organization name, plus the private repository URL;
   - spelling variants of each: original case, lowercase, and with space, hyphen, underscore, dot and no separator between words (for example `Foo Bar`, `foo-bar`, `foo_bar`, `foo.bar`, `foobar`, `FooBar`);
   - personal real names, private e-mail addresses, machine and OS account names, internal hostnames and private paths that must not be published;
   - any encoded form previously used to hide a term (for example its base64 or hex text), as additional literal lines.
   Avoid terms shorter than four characters unless they are distinctive; review every hit rather than dropping noisy terms.
2. **Tracked tree** (from the repository root; searches the working-tree content of every tracked file, then the index):
   ```text
   git grep -n -I -i -F -f <terms-file> > <scan-dir>/tracked-hits.txt
   git grep --cached -n -I -i -F -f <terms-file> > <scan-dir>/index-hits.txt
   ```
3. **Exact package contents**: build, pack outside the repository, extract, and scan the extracted files:
   ```text
   npm run build
   npm pack --ignore-scripts --pack-destination <scan-dir>
   tar -xzf <scan-dir>/taskstance-0.1.0.tgz -C <scan-dir>
   cd <scan-dir>
   git grep --no-index -n -I -i -F -f <terms-file> -- package > package-hits.txt
   ```
   (`git grep --no-index` only accepts paths below the current directory, hence the `cd`.)
4. **Commit metadata**, after the first commit and before pushing (run the first command in the repository, the second in `<scan-dir>`):
   ```text
   git log --all --format=%an%n%ae%n%cn%n%ce%n%B > <scan-dir>/log.txt
   git grep --no-index -n -i -F -f <terms-file> -- log.txt > log-hits.txt
   ```
   Also confirm that the author and committer identity is the intended public pseudonymous identity.

`git grep` exits with status 1 when nothing matches. **Pass** means every hits file is empty, or each remaining hit was reviewed and is intentionally public. Record the date, commit SHA and pass/fail privately next to the terms file. Never paste hits into the repository, issues, pull requests or CI logs. Until this scan has passed for the commit being published, treat publication as blocked.

## Owner publication gates

These are owner-only actions that this repository cannot verify:

- configure a public pseudonymous Git author/committer identity before the first commit;
- complete the owner-side private-name scan above for the exact commit and package;
- after creating the GitHub repository and before making it public, enable **private vulnerability reporting** (Settings → Security → Private vulnerability reporting), which `SECURITY.md` relies on;
- confirm the CI action versions referenced in `.github/workflows/ci.yml` exist, and let the first CI run pass;
- keep `private: true` and npm publication disabled unless a separate release decision is made.
