# @aikdna/kdna-cli

[![npm](https://img.shields.io/npm/v/@aikdna/kdna-cli)](https://www.npmjs.com/package/@aikdna/kdna-cli) [![CI](https://github.com/aikdna/kdna-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/aikdna/kdna-cli/actions/workflows/ci.yml) [![License](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)

The official command-line runtime for KDNA judgment assets.

KDNA CLI inspects, validates, packs, unpacks, plans, authorizes, and loads
`.kdna` files. Formal authoring belongs to KDNA Studio. The recommended user
path starts from one explicit file; neither a global asset library nor a Skill
installation is required by the protocol.

## Install

```bash
npm install -g @aikdna/kdna-cli
```

## File-first quick start

```bash
kdna demo judgment ./demo-judgment
kdna pack ./demo-judgment ./demo-judgment.kdna
kdna inspect ./demo-judgment.kdna
kdna validate ./demo-judgment.kdna
kdna plan-load ./demo-judgment.kdna
kdna load ./demo-judgment.kdna --profile=compact --as=json
```

To approve that exact file for one workspace, save the current task text in a
regular file and use the workspace contract:

```bash
kdna attach ./demo-judgment.kdna --cwd ./my-project \
  --role article-writing --applies-to draft --does-not-apply-to code --yes
kdna attachments --cwd ./my-project
kdna resolve --cwd ./my-project --task-file ./current-task.txt
```

`attach` copies the validated bytes to an immutable digest snapshot under
`./my-project/.kdna/`. The source file may then move without changing the
workspace fact. Omit `--yes` for an interactive approval prompt; non-interactive
callers must provide it explicitly.

| Command                               | Responsibility                                                      |
| ------------------------------------- | ------------------------------------------------------------------- |
| `kdna inspect <file>`                 | Read container metadata without adopting its judgment               |
| `kdna validate <file>`                | Check format, schema, payload, integrity, and load contract         |
| `kdna plan-load <file>`               | Return the authorization/readiness decision before projection       |
| `kdna load <file>`                    | Produce a Runtime Capsule or prompt projection                      |
| `kdna pack` / `kdna unpack`           | Package or inspect a portable asset                                 |
| `kdna attach` / `kdna attachments`    | Approve or list exact workspace-local attachments                   |
| `kdna resolve`                        | Return `load`, `ask`, `skip`, or `block` without projecting content |
| `kdna disable` / `enable`             | Retain an attachment while controlling eligibility                  |
| `kdna switch` / `rollback` / `remove` | Replace, restore, or remove only the workspace relation             |

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
directory, scans for unrelated assets, or merges parent and child workspace
records. The record and snapshots are ignored by Git by default because they
may expose private preferences and asset identity.

Saving, discovery, attachment, authorization, applicability, and loading are
separate events. A Host must expose active asset identity, version or digest,
scope, and reason, and provide controls to disable it, switch it, or roll it
back.

## Closed release surface

The npm package has one executable, `kdna`, and one machine-readable top-level
command allowlist at
`release-surface/cli-command-allowlist.json`. Commands outside that allowlist
are rejected with exit code 2. The exact package file list is frozen separately
at `release-surface/npm-file-allowlist.json`.

The distributed runtime contains only the explicit file/workspace path shown
above, the two maintained demo fixtures, runtime authorization support, and
the closed remote projection client. Development and historical modules that
remain in the source repository are not callable and are not distributed.

`remove` means only removal of one workspace attachment relation. It never
selects a package by name and never deletes an immutable asset snapshot.

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
