# Security Policy

## Supported versions

The current `@aikdna/kdna-cli` `0.43.x` line (`0.43.5`) is supported; earlier
pre-`0.6.0` (`<= 0.36.1`) and `0.40.x`–`0.42.x` releases are unsupported.
Reports should identify the exact package version or source commit affected.

## Current source boundary

`@aikdna/kdna-cli@0.43.5` supports local offline `init`, `compile`,
`validate-input`, `create`, `protect`, `diff`, `convert`, `source-open`,
`source-pack`, `inspect`, `validate`, and `read`, including a process-local
retained Read session (`read --session`). It delegates native container
production, admission, disclosure, migration, and Source operations to the exact
`@aikdna/kdna-core@0.37.9` and `@aikdna/kdna-read@0.13.3` archives bound in
[`public-contract-binding.json`](./public-contract-binding.json). Matching
version strings alone do not substitute for those archive digests.

Technical admission does not establish authorship, Creation acceptance,
permission to disclose content, or authorization to act. Read defaults to
denial; `--allow-read` grants this process permission to disclose the selected
local file. Output can contain asset content and goes to the caller's chosen
`stdout`. The CLI runs offline with the local OS account's privileges and makes
no network requests during asset operations.

Local password protection (`kdna protect`) encrypts `payload.kdnab` locally with
an authenticated-encryption envelope (`PBKDF2-HMAC-SHA256` + `AES-256-GCM`).
Passwords are read once per invocation from `--password-file <path>` or an
inherited file descriptor `--password-fd <fd>` (`>= 3`), never from command-line
arguments, and secret buffers are zeroed when the invocation completes. Keep an
unencrypted authoring draft or public `.kdna` copy for future `source-open` /
`source-pack` revisions, as Source operations accept public containers only.

Session input must be valid UTF-8, with at most 1 MiB per line. Expansion
handles are valid only for their original process-local snapshot and issuing
Host provider. Reopening an asset or copying a serialized handle does not
preserve that authority. A failed output write is not acknowledged as delivery:
`run` rejects and the binary exits with code `1`. Writable callbacks control
local write completion; they do not prove remote consumption.

`--allow-create` permits encoding the supplied authored JSON or compiled draft
into a new file. `--allow-source` permits opening, migrating (`0.5.0` -> `0.6.0`
via `convert`), or repacking the explicitly named public asset when paired with
its exact SHA-256 (`--expected-a`). All file-writing routes (`init --output`,
`compile --output`, `create`, `protect`, `source-pack`, `convert`) refuse
existing files and symlinks (`wx`). Source edits are complete Manifest and
Payload replacements; original resource members are retained and reverified.
These flags do not confer human confirmation or action authority.

Plan admission (`plan`), load/execution (`load`), legacy `pack`/`unpack`,
remote projection, and external action execution remain unavailable. Historical
code under `retired/` is excluded from the published npm package archive and
does not define supported behavior.

## Reporting a vulnerability

Do not open a public issue for a vulnerability. Report privately through
[GitHub Private Vulnerability Reporting](https://github.com/aikdna/kdna-cli/security/advisories/new)
or by email to `hi@aikdna.com` (`security@aikdna.com` also routes to the same
security inbox). Include the affected version or source commit, archive digest
when applicable, Node.js runtime version, reproduction steps, and observed
impact. Avoid including private `.kdna` content unless required to reproduce the
issue.

We acknowledge vulnerability reports within 5 business days and provide a
remediation timeline after triage.

## Supply chain

`@aikdna/kdna-cli` is published only through the repository's audited release
workflow with npm provenance attestations; the local `prepublishOnly` hook fails
closed to prevent ad-hoc local `npm publish` runs. For offline source builds,
install from `release-surface/native-offline-host` using exact vendored
archives, `--offline`, `--ignore-scripts`, and `--omit=optional` as documented
in [`README.md`](./README.md) and [`docs/native-delivery.md`](./docs/native-delivery.md).
Archive SHA-256 and SRI values are recorded in
`release-surface/dependency-archives.json`. Note that KDNA publishes official
packages on **npm under `@aikdna/*` only** (`@aikdna/kdna-cli`,
`@aikdna/kdna-core`, `@aikdna/kdna-read`)—never install unrelated third-party
packages on PyPI or unscoped npm names.

## Preserved historical dependency graph

The byte-preserved `retired/package-lock.json` contains `fast-uri@3.1.5`,
which is affected by the published
[fast-uri security advisories](https://github.com/advisories/GHSA-5jgf-p345-68v8).
The active dependency graph pins `fast-uri@3.1.8` in its exact archive
inventory, and `retired/` is excluded from the published `@aikdna/kdna-cli`
tarball. Keep the preserved `retired/` tree solely for historical baseline
checks on controlled local fixtures; do not deploy it or expose it to untrusted
input.
