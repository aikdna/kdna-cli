# @aikdna/kdna-cli

[![npm](https://img.shields.io/npm/v/@aikdna/kdna-cli)](https://www.npmjs.com/package/@aikdna/kdna-cli) [![CI](https://github.com/aikdna/kdna-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/aikdna/kdna-cli/actions/workflows/ci.yml) [![License](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)

The official command-line runtime for KDNA judgment assets.

KDNA CLI inspects, validates, packs, unpacks, plans, authorizes, and loads
`.kdna` files. Formal authoring belongs to KDNA Studio. The recommended user
path starts from one explicit file; neither a global asset library nor a Skill
installation is required by the protocol.

## Published install

```bash
npm install -g @aikdna/kdna-cli
```

The registry `latest` release is `0.35.1`. It supports the published,
explicit-file path below. It does not include the workspace attachment
commands shown later in this README.

## Published 0.35.1 file-first quick start

```bash
kdna demo judgment ./demo-judgment
kdna pack ./demo-judgment ./demo-judgment.kdna
kdna inspect ./demo-judgment.kdna
kdna validate ./demo-judgment.kdna
kdna plan-load ./demo-judgment.kdna
kdna load ./demo-judgment.kdna --profile=compact --as=json
```

## Unreleased 0.36.0 source candidate

The workspace attachment commands are an unreleased `0.36.0` source candidate,
not the npm `latest` surface. To evaluate them without confusing the candidate
with an installed release, obtain an exact candidate commit from a
machine-readable source receipt, detach at that immutable commit, verify the
recorded HEAD, install its locked dependencies, and invoke the source entry
point directly:

```bash
git clone https://github.com/aikdna/kdna-cli.git kdna-cli-candidate
cd kdna-cli-candidate
git fetch origin <exact-commit-from-candidate-receipt>
git switch --detach <exact-commit-from-candidate-receipt>
git rev-parse HEAD
npm ci
node ./src/cli.js --version
```

Alternatively, an evaluator may use a candidate package supplied with an exact
SHA-256 receipt; its digest must be verified before installation. Neither path
changes what npm `latest` promises.

To approve one exact file for one workspace from that detached source
candidate, save the current task text in a regular file and use:

```bash
node ./src/cli.js attach ./demo-judgment.kdna --cwd ./my-project \
  --role article-writing --applies-to draft --does-not-apply-to code --yes
node ./src/cli.js attachments --cwd ./my-project
node ./src/cli.js resolve --cwd ./my-project --task-file ./current-task.txt
```

`attach` copies the validated bytes to an immutable digest snapshot under
`./my-project/.kdna/`. The source file may then move without changing the
workspace fact. Omit `--yes` for an interactive approval prompt; non-interactive
callers must provide it explicitly.

For direct CLI use, `--cwd` is also the explicit workspace root boundary, so
lookup does not walk into its parent. A Host that launches from a nested
directory must additionally pass its known root, for example
`resolve --cwd ./my-project/packages/app --workspace-root ./my-project ...`.
Only the nearest record between those two coordinates can be selected. A start
outside the boundary, a symlinked coordinate, or a home-level
`~/.kdna/attachments.json` fails closed; the latter is never treated as
project authority.

| Command                               | Responsibility                                                      |
| ------------------------------------- | ------------------------------------------------------------------- |
| `kdna inspect <file>`                 | Read container metadata without adopting its judgment               |
| `kdna validate <file>`                | Check format, schema, payload, integrity, and load contract         |
| `kdna plan-load <file>`               | Return a LoadPlan or explicit-file Host ConsumptionPlan             |
| `kdna load <file>`                    | Produce a projection or deliver a Capsule to a registered Host      |
| `kdna pack` / `kdna unpack`           | Package or inspect a portable asset                                 |
| `kdna attach` / `kdna attachments`    | Approve or list exact workspace-local attachments                   |
| `kdna resolve`                        | Return `load`, `ask`, `skip`, or `block` without projecting content |
| `kdna disable` / `enable`             | Retain an attachment while controlling eligibility                  |
| `kdna switch` / `rollback` / `remove` | Replace, restore, or remove only the workspace relation             |
| `kdna cleanup`                        | Preview or explicitly delete only unreferenced workspace snapshots  |

Successful loading proves technical delivery of a named projection. It does
not prove that an Agent followed the judgment or that the result became better.
An explicit-file load is one-shot and creates no persistent CLI state by
default. Add `--audit` only when you want a content-neutral local receipt;
receipts omit source paths, judgment content, and authorization material.

## User and Host contract

A consuming Host must start from:

- a file the user explicitly selected for the current operation; or
- an exact workspace, application, session, or user attachment that the Host
  previously recorded as user-approved.

The CLI reference implementation records that approval only in
`<workspace>/.kdna/attachments.json`, with immutable snapshots in
`<workspace>/.kdna/assets/`. It never falls back to a user-global package
directory, searches above the explicit Host root, scans for unrelated assets,
or merges parent and child workspace records. Within the boundary it selects
only the nearest record. The record and snapshots are ignored by Git by default
because they may expose private preferences and asset identity.

Saving, discovery, attachment, authorization, applicability, and loading are
separate events. A Host must expose active asset identity, version or digest,
scope, and reason, and provide controls to disable it, switch it, or roll it
back.

The source-candidate resolver is a conservative deterministic interpreter of
user-approved scope hints, not an AI classifier for arbitrary natural
language. Latin and numeric phrases use token boundaries, hyphens and spaces
are normalized as phrase separators, and CJK hints use normalized explicit
phrase matching. Near matches, word-form overlap, empty hints, and
contradictions ask instead of auto-loading. Scope metadata is evaluated before
snapshot authorization or integrity only to exclude an explicitly
out-of-scope attachment; the closed attachment record schema is still validated
first, and every possible load/ask candidate receives full checks.
## Closed release surface

The npm package has one executable, `kdna`, and one machine-readable top-level
command allowlist at
`release-surface/cli-command-allowlist.json`. Commands outside that allowlist
are rejected with exit code 2. The exact package file list is frozen separately
at `release-surface/npm-file-allowlist.json`.

The distributed runtime contains only the explicit file/workspace path shown
above, the two maintained demo fixtures, runtime authorization support, and
the closed remote projection and explicit process Host clients. Process Host
delivery requires an exact `.kdna` file, task, executable, ordered arguments,
and a process-bound capability registration; it never resolves a package name
or consults a global Store. Development and historical modules that remain in
the source repository are not callable and are not distributed.

`remove` means only removal of one workspace attachment relation. Its JSON
distinguishes `attachment_removed` from `snapshot_retained` and reports the
retained count and reason; it never implies that private asset bytes were
deleted. `cleanup` is the separate explicit storage action: without `--yes` it
only previews eligible and retained counts plus a plan digest. Execution
requires both that exact digest and `--yes`; a changed record or candidate set
requires a new preview. It deletes only unreferenced workspace snapshots and
writes exact partial/recovery facts if a multi-file deletion is interrupted. It
never selects a package by name, touches the source file or attachment record,
removes rollback-referenced bytes, or runs as automatic garbage collection.

```bash
node ./src/cli.js cleanup --cwd ./my-project
node ./src/cli.js cleanup --cwd ./my-project \
  --plan-digest sha256:<digest-from-preview> --yes
```

## Authoring

```bash
npm install -g @aikdna/kdna-studio-cli
kdna-studio create ./my-domain --name @yourscope/my-domain
kdna-studio card add ./my-domain axiom \
  --field one_sentence="Prefer specific evidence over broad claims" \
  --field full_statement="When reviewing content, require concrete support for material claims." \
  --field why="Unsupported generalizations conceal the basis of judgment." \
  --field applies_when='["reviewing analytical content"]' \
  --field does_not_apply_when='["pure formatting"]' \
  --field failure_risk="generic advice"
kdna-studio export ./my-domain --out ./my-domain.kdna
kdna validate ./my-domain.kdna
```

Core is author-neutral. Subject confirmation is required only when an asset
claims to represent a particular person or organization.

## Runtime authorization authority

Shared schemas, conformance vectors, and protocol documents live in
[`aikdna/kdna`](https://github.com/aikdna/kdna), including LoadPlan and Runtime
Capsule contracts. Published coordinates retain their own contracts;
unpublished corrective source must not be described as already released.

## License

Apache-2.0
