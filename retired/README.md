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

The registry `latest` release is `0.36.1`. It supports the published,
explicit-file path below and the workspace attachment commands shown later
in this README.

## Published file-first quick start

```bash
kdna demo judgment ./demo-judgment
kdna pack ./demo-judgment ./demo-judgment.kdna
kdna inspect ./demo-judgment.kdna
kdna validate ./demo-judgment.kdna
kdna plan-load ./demo-judgment.kdna
kdna load ./demo-judgment.kdna --profile=compact --as=json
```

## Workspace attachment surface

The workspace attachment commands (`attach`, `attachments`, `resolve`,
`disable`, `enable`, `switch`, `rollback`, `remove`) are shipped in the
published CLI, but they remain engineering foundation primitives
rather than a stable product API.

To approve one exact file for one workspace
and resolve a task without writing its text to disk, use:

```bash
node ./src/cli.js attach ./demo-judgment.kdna --cwd ./my-project \
  --attachment-stdin --yes --scope-user-approved
node ./src/cli.js attachments --cwd ./my-project
node ./src/cli.js resolve --cwd ./my-project --task-stdin
```

For `attach`, the invoking Agent writes one bounded strict-UTF-8 JSON object to
stdin with `role`, `applies_to`, `does_not_apply_to`, and optional
`scope_mode`/`matching_policy`. A positive task hint is required in the default
`task_hints` mode; negative hints are optional. Task hints default to
`matching_policy: "open_world_ask"`: no lexical match is unresolved rather than
proof that the asset is outside scope. A user may explicitly approve
`matching_policy: "closed_world_skip"` when the listed positive hints are a
complete routing whitelist; only then may a clean unmatched task skip. A user
may instead explicitly approve `scope_mode: "all_workspace"` with no positive
hints and optional exclusions.
Completely unspecified applicability is rejected. This keeps potentially
private role and scope text out of argv, environment variables, and
non-interactive diagnostics. Human terminal use may use `--applies-to`, add
`--closed-world-scope` only after explicitly approving a complete whitelist,
or use the explicit `--all-workspace` switch; `--does-not-apply-to` remains
optional. For
`resolve`, the invoking process writes bounded UTF-8 task bytes to stdin and
closes the stream. `--task-file` remains available only when the user already
has an explicit task file; exactly one task input mode is required.

`attach` copies the validated bytes to an immutable digest snapshot under
`./my-project/.kdna/`. The source file may then move without changing the
workspace fact. Before approval, the preview binds the safe relative workspace
root, final role and positive/negative scope, exact asset digest, authorization
need, and one consent digest. Any source, scope, or workspace-root drift before
the write is rejected. A user's explicit request naming the file, workspace,
role, and scope is one approval: an Agent carries that exact consent into this
one command with `--yes --scope-user-approved`; the CLI must not ask a second
time.

Approval of only “attach this KDNA to this project” does not authorize an Agent
to invent its role or scope. When the caller proposes or rewrites those routing
hints, it first runs the same command with `--preview`, shows the resulting
workspace, asset, role, positive/negative scope, and authorization nature once,
then executes only after the user confirms that exact proposal:

```bash
node ./src/cli.js attach ./demo-judgment.kdna --cwd ./my-project \
  --attachment-stdin --preview
node ./src/cli.js attach ./demo-judgment.kdna --cwd ./my-project \
  --attachment-stdin --yes \
  --consent-digest sha256:<digest-from-preview>
```

The current public manifest contract has no protocolized asset-wide pre-load
scope that the CLI can safely derive without reading judgment payload. It
therefore records attachment scope only as a `user_approved_routing_hint`;
summary text, keywords, filenames, and encrypted content are never treated as
scope authority. A future verified public asset boundary may be used only
unchanged or narrowed. Runtime and payload boundaries remain authoritative
after loading and cannot be widened by an attachment hint. Existing approved
attachments do not require repeated approval for resolve or load.

For `attach`, `--cwd` is the exact workspace being approved, not a lookup
start; a Host must pass its known workspace root there. For read, resolve, and
lifecycle commands, direct CLI use without `--workspace-root` searches upward
for the nearest record and stops at HOME or the filesystem root without ever
adopting a record at those global-looking boundaries. A Host that launches from
a nested directory must pass its known root, for example
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
| `kdna host-consent`                   | Low-level source-candidate broker for Host processing consent       |

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
only the nearest record. The record, snapshots, and `.kdna/.gitignore` control
file itself are ignored by Git by default because they may expose private
preferences and asset identity; a real Git worktree regression requires clean
porcelain status after attach.

Saving, discovery, attachment, authorization, applicability, and loading are
separate events. A Host's default user-facing status shows the asset name and
version, purpose and boundary, Host identity, named processing destination,
permissions, decision reason, and controls to disable, switch, or roll back.
Digests, receipts, record IDs, and plan coordinates remain available only in
technical details, JSON, or audit output; ordinary approval is never a hash
questionnaire.

The `host-consent` command is a low-level integration primitive.
A trusted Host launcher supplies one private strict-JSON draft through stdin
or a private `--input-file`, and sets
`KDNA_MCP_HOST_PROCESSING_CONSENT_FILE` to the fixed Host-private target:

```bash
trusted-host-draft-producer | node ./src/cli.js host-consent
node ./src/cli.js host-consent --from-workspace --cwd <dir> --host <host-id> --processor <provider>
node ./src/cli.js host-consent --status --json
node ./src/cli.js host-consent --revoke
```

`--from-workspace` is the human-readable surface: it derives the draft from
the user-approved workspace attachment record (exactly one enabled
attachment), and its terminal confirmation presents only human concepts —
asset name and version, purpose, used-for and not-for scopes, workspace,
Host, and named processing destination. Digests, attachment IDs, and scope
coordinates are hidden from the ordinary user and remain technical details.

The command requires a real terminal for Allow/Decline, writes atomically and
fails closed on unsafe paths. Ordinary users must not construct the draft or
copy IDs/digests from tool output.

These low-level flags are an integration surface, not a field questionnaire
for ordinary users. If the original natural-language instruction already binds
the exact file, workspace, purpose or scope, current Host, named destination,
and least projection, that is the one meaningful approval; the Host does not
ask again merely to display a digest. The Host keeps private task and scope
bytes off argv and mechanically supplies the workspace, scope mode, digests,
approval source, profile, and internal attachment ID. It asks again only for a
genuinely ambiguous choice, a caller-proposed scope not covered by the original
instruction, a changed asset/Host/destination/profile/permission boundary, a
policy-changing switch, or destructive cleanup.

A workspace may retain multiple independently approved attachments, but one
task resolves to zero or one selected asset. Conflicts ask; this source
candidate does not silently combine assets or define an explicit composition
contract.

An `ask` response includes a one-task `selection_plan` binding the exact task
bytes, workspace attachment record, and current candidate set. After the user
chooses one candidate, the Host repeats the same task bytes and exact Host root
with the selected attachment ID, the task and plan digests from that response,
and `--selection-approved`. The resolver rechecks every bound fact and returns
`load` only for that attachment; any drift rejects the continuation. This
approval is consumed for this task only, does not change stored scope, and is
not reused for a later task. If the task itself contains the complete canonical
attachment ID at a strict token boundary, that exact naming can serve as the
one-task selection without a prior plan; an asset-ID substring never can. The
task digest, Host root, and approval remain mandatory. A generic
`kdna load <file>` is an explicit-file operation and is not a
workspace-selection continuation: a Host must not use it to bypass the
attachment record or adoption controls.

```bash
node ./src/cli.js resolve \
  --cwd ./my-project --workspace-root ./my-project --task-stdin \
  --select-attachment att_<id-from-ask> \
  --selection-task-digest sha256:<task-digest-from-ask> \
  --selection-plan-digest sha256:<plan-digest-from-ask> \
  --selection-approved
```

The Host writes the same in-memory task bytes to stdin and closes it; the bytes
do not belong in argv, environment variables, or an incidental task file.

The source-candidate resolver is a conservative deterministic interpreter of
user-approved scope hints, not an AI classifier for arbitrary natural
language. Latin and numeric phrases use token boundaries, hyphens and spaces
are normalized as phrase separators, and CJK hints use normalized explicit
phrase matching. Near matches, word-form overlap, empty hints, and
contradictions ask instead of auto-loading. A matched phrase is also treated as
uncertain when it appears in negation, quotation or meta-discussion, a
contrastive multi-clause task, or an overly short or broad hint.
Common English negative contractions, including straight or Unicode
apostrophes, are normalized only far enough to prevent silent loading;
`do not`, `not for`, and `instead of` remain conservative uncertainty signals.
This is a routing safety rule, not a claim of general natural-language
understanding.

An explicit negative match returns `skip/explicitly_outside_scope` without
checking unrelated authorization, snapshot bytes, or a LoadPlan. A clean
no-match under the default `open_world_ask` policy returns
`ask/applicability_unresolved`, because synonyms, paraphrases, and another
language may still express an applicable task. Its receipt-bound one-task
selection is the safe continuation. Only a separately user-approved
`closed_world_skip` policy makes no-match return
`skip/closed_world_no_match`. With multiple attachments, one clear positive
loads only when every other unmatched task-hint policy is closed-world; an
open-world unmatched candidate keeps applicability unresolved.

These cases ask for structured intent; this resolver does not claim to
understand arbitrary natural language. The closed attachment record schema is
still validated first, and every possible load/ask candidate receives full
identity and integrity checks. Authorization is reported per candidate but is
required only after one candidate is selected; an unauthorized candidate
cannot prevent selection of another verified public candidate.

`switch` is a policy change, not an asset-path edit. It requires a preview or
an already explicit user instruction covering the new asset and exact
role/scope. `--retain-scope` means the user explicitly reviewed reuse of the
same hints for the new asset; reuse is never implicit. The preview binds old
and new asset identity, version, digest, role, scope, authorization nature, and
workspace. Rollback restores the complete previous asset and policy metadata.
The earlier unreleased attachment schemas `0.1.0` and `0.2.0` are intentionally
rejected; evaluators re-attach under `0.3.0` rather than silently reinterpret
incomplete history or invent an open/closed-world applicability decision.

```bash
node ./src/cli.js switch att_<id> ./replacement.kdna \
  --cwd ./my-project --retain-scope --preview
node ./src/cli.js switch att_<id> ./replacement.kdna \
  --cwd ./my-project --retain-scope --yes \
  --consent-digest sha256:<digest-from-preview>
```

Read/load adapters that hold a separate process-scoped password source may add
`--defer-password-authorization` to `kdna resolve`. This evaluates only the
approved attachment's public workspace scope and returns
`authorization: "required"` for an otherwise applicable protected asset. It
does not accept, verify, or load a password. The adapter must still pass the
real password through `kdna load --password-stdin`; only successful decryption
may upgrade the delivered result to `authorization: "satisfied"`.

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

Protected assets are an optional authorization gate, not a requirement for
every KDNA. A user-facing Host may obtain authorization from explicit password
input, a system-secure store, or a Host authorization provider and must keep
the secret off argv, environment variables, ordinary files, and ordinary logs.
Packaged account/device credentials require macOS Keychain, Linux Secret
Service, or an encrypted password store. If none is available, the source
candidate returns `BACKEND_UNAVAILABLE`; it never falls back to a plaintext
file. The explicit legacy `file` backend is read/delete-only for migration, the
`env` backend is read-only compatibility input, and `memory` is restricted to
`NODE_ENV=test`.

The source candidate's `--password-stdin` contract is bounded strict UTF-8. It
removes at most one final transport LF or CRLF and preserves every other
character, including leading/trailing spaces and embedded newlines. Empty,
oversized, or invalid input is rejected without echoing secret bytes or
provider diagnostics. The interactive prompt uses the same strict decoder;
its Enter key is the transport terminator and therefore cannot represent an
embedded newline. The protected-workspace source follow-up uses this same
decoder rather than a second password interpretation.

The published `0.35.1` package preserves its historical license surface. The
published `0.36.0` package makes a deliberate safety correction:
`license activate` rejects raw credentials supplied through `--key` or
`--license-key`. Use browser activation, an external grant, or bounded
`--credential-stdin`; never place a license credential in shell arguments.

## Status

The registry `latest` release is `0.36.1`. The workspace attachment commands are
engineering foundation primitives rather than a stable product API. To evaluate
them without confusing an exact candidate with an installed release, obtain an
exact candidate commit from a machine-readable source receipt, detach at that immutable commit, verify the
recorded HEAD, install its locked dependencies,
and invoke the source entry point directly:

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


## Official packages

Official KDNA packages are published under the `@aikdna` npm scope and the
`aikdna` name on PyPI. The unscoped npm package `kdna` is not affiliated with
the KDNA project. Install only from the official coordinates shown in this
README.

## License

Apache-2.0
