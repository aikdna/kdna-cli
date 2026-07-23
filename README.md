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
kdna plan-load ./demo-judgment.kdna --json
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

## Maintained advanced modules and historical surfaces

The repository still maintains routing, composition, Cluster, WorkPack, Trace,
evaluation, identity, encryption, activation, remote-loading, and historical
Store implementation modules. They retain their tests and release history but
are not workspace attachment authority.

The default dispatcher no longer exposes `available`, `match`, Store
`install`, package `remove`, `update`, package `list`, `registry`, or `setup`.
`remove` now means only removal of one workspace attachment relation and never
deletes an immutable snapshot.

In particular:

- historical Store state does not authorize or attach an asset;
- an `active_version` in the legacy Store is not Host consent;
- Skill-file presence does not prove an Agent integration;
- routing and matching may operate only inside an already user-approved
  attachment set;
- evaluation output is claimant-scoped and is not Core validity or an official
  quality score.

See the KDNA repository's
[tool status matrix](https://github.com/aikdna/kdna/blob/main/docs/tool-status-matrix.md)
and this package's [CHANGELOG](./CHANGELOG.md) for exact-version facts.

## Agent adapters

The bundled `kdna-loader` Skill is currently **Unassessed**. Its allowed target
contract is a thin adapter for one explicit file or exact user-approved
attachment. It may not scan a global Store, infer consent from task keywords,
autonomously select judgment, or hide whether KDNA is active.

Until a Host adapter is independently recertified, call the file-first
CLI/Core path directly.

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
