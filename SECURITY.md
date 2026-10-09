# Security Policy

## Supported versions

The published `0.36.x` line remains supported; earlier versions are unsupported.
The current source candidate is `0.39.0-rc.native-sections.3`. It is not an
npm release and does not change the published version's command contract.
Reports should identify which surface is affected.

## Current source boundary

The candidate supports local `create`, `inspect`, `validate`, `read`,
`source-open` and `source-pack`, including a process-local retained Read session.
It delegates native production, admission, disclosure and Source operations to
the exact Core `0.37.1-rc.browser.1` and Read `0.11.2-rc.browser.1` archives bound in
[`public-contract-binding.json`](./public-contract-binding.json).
Matching version strings alone do not identify those archives.

Technical admission does not establish authorship, Creation acceptance,
permission to disclose content or authorization to act. Read defaults to denial;
`--allow-read` grants this process permission to disclose the selected local
file. Output can contain asset content and goes to the caller's chosen stdout.
The CLI runs with the local account's privileges.

Session input must be valid UTF-8, with at most 1 MiB per line. Expansion handles
are valid only for their original process-local snapshot and issuing Host
provider. Reopening an asset or copying a serialized handle does not preserve
that authority. A failed output write is not acknowledged as delivery: `run`
rejects and the binary exits with code 1. Writable callbacks control local write
completion; they do not prove remote consumption. See README for iterator and
output-cleanup limits.

`--allow-create` permits encoding the supplied authored JSON into a new file.
`--allow-source` permits opening or repacking the explicitly named public asset;
the original asset's exact SHA256 is also required as `--expected-a`.
Both save routes refuse existing files and symlinks. Source edits are complete
Manifest and Payload replacements; original resource members are retained.
These flags do not confer human confirmation or action authority.

Creation here produces public unsigned containers; it does not create encrypted,
signature or checksum members. Public Source can admit signed or checksum-bearing
inputs only when the bound native Core verifies them. Repacking retains and
reverifies those members; an edit that invalidates them is rejected. The CLI
does not strip integrity members, re-sign an asset or open protected logical
profiles through this Source route. Protected assets require a separate Host
route.

Plan admission, load/execution, legacy pack/unpack, conversion, migration,
attachment, remote projection and action execution remain unavailable. There
is no password, secret-store or agent-host command surface. Historical
code under `retired/` is excluded from the current CLI archive and does
not define the candidate's supported behavior. The supported published line has
its separate command and security contract at the
[0.36.1 source baseline](https://github.com/aikdna/kdna-cli/blob/8bbd47c2f436bf638e6393aeda029e5fcba1bd32/SECURITY.md).

## Reporting a vulnerability

Do not open a public issue for a vulnerability. Report privately to
security@aikdna.com or through
[GitHub Private Vulnerability Reporting](https://github.com/aikdna/kdna-cli/security/advisories/new).
Include the affected version or source commit, archive digest when applicable,
runtime version, reproduction steps and observed impact. Avoid including private
asset content unless it is necessary for the reproduction.

We will acknowledge within 5 business days and provide a timeline for a fix.

## Supply chain

Install the current source from `package-lock.json` and the exact archives in
`vendor/`, using offline mode, disabled install scripts and `--omit=optional` as
documented in README. Archive SHA256 and integrity values are recorded in
`release-surface/dependency-archives.json`. Optional native acceleration is
excluded. The candidate package is marked private and its publication hook fails
closed; source availability does not imply npm registry availability.

## Preserved historical dependency graph

The byte-preserved `retired/package-lock.json` contains `fast-uri@3.1.5`,
which is affected by the published
[fast-uri security advisories](https://github.com/advisories/GHSA-5jgf-p345-68v8).
The current source graph instead pins `fast-uri@3.1.8` in its exact archive
inventory. Historical files are excluded from the current CLI package.

Keep the preserved graph for reproducing the historical contract; do not use
it as the dependency baseline for a new deployment or expose it to untrusted
input. Historical CI results check that contract on controlled fixtures and do
not certify its dependencies as secure. The supported published line and an
installed package's resolved dependencies must be assessed separately; the
source candidate does not silently repair a previously installed release.
