# @aikdna/kdna-cli

[![npm](https://img.shields.io/npm/v/@aikdna/kdna-cli)](https://www.npmjs.com/package/@aikdna/kdna-cli) [![CI](https://github.com/aikdna/kdna-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/aikdna/kdna-cli/actions/workflows/ci.yml) [![License](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)

The official command-line runtime for KDNA judgment assets.

KDNA makes judgment portable across models and runtimes. This repository
implements the inspect, validate, authorization, loading, projection, and
runtime-control part of the open protocol.

KDNA CLI inspects, validates, packs, unpacks, loads, signs, and manages `.kdna` files. It is
the consumer/runtime side of the official KDNA toolchain. Formal authoring is
handled by KDNA Studio CLI and Studio Core.

For task-aware selection, composition, projection, and evaluation, see the
[Consumption Runtime guide](./docs/consumption-runtime.md).

## Install

```bash
npm install -g @aikdna/kdna-cli
```

## Quick start — load a real judgment asset

```bash
# Generate a canonical reference asset locally
kdna demo judgment ./demo-judgment
kdna pack ./demo-judgment ./demo-judgment.kdna

# Validate, plan, load
kdna validate ./demo-judgment.kdna
kdna plan-load ./demo-judgment.kdna
kdna load ./demo-judgment.kdna --profile=compact --as=json
```

Successful validation returns:

```json
{
  "format_valid": true,
  "schema_valid": true,
  "payload_valid": true,
  "checksums_valid": true,
  "load_contract_valid": true,
  "overall_valid": true,
  "problems": []
}
```

## Core Commands

| Command                                                                           | Purpose                                                        |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `kdna demo minimal <dir>`                                                         | Create a minimal local demo folder                             |
| `kdna inspect <path>`                                                             | Inspect a source directory or `.kdna` container                |
| `kdna validate <path>`                                                            | Validate format, schema, payload, checksums, and load contract |
| `kdna plan-load <path> --json`                                                    | Return the Core LoadPlan before runtime load                   |
| `kdna pack <input-dir> <output.kdna>`                                             | Pack a local working folder into a `.kdna` file                |
| `kdna unpack <input.kdna> <output-dir>`                                           | Unpack a KDNA Asset Container                                  |
| `kdna load <path> --profile=<index\|compact\|scenario\|full> --as=<json\|prompt>` | Return a Runtime Capsule or its prompt projection              |

## Consumption Runtime

The optional consumption commands help an application select and inspect
judgment context for a task. They keep runtime metadata outside the `.kdna`
file format and produce traces that can be reviewed or replayed.

```bash
# Select a primary framework from a policy, then inspect the trace.
kdna route <asset-path> --task=review --policy=policy.json --as=trace

# Compose a primary with bounded advisors.
kdna compose <asset-path> --primary=example-primary --advisors=example-advisor --as=trace

# Render a packaged asset into a readable judgment projection.
kdna project <asset-path>.kdna --shape=answer-pattern --as=prompt

# The same projection can address an installed package name.
kdna project @aikdna/dev-deploy-readiness --task="Should this deploy?" --shape=answer-pattern --as=prompt

# Plan without execution, then execute through a registered Runner.
kdna plan-use @aikdna/dev-deploy-readiness --task="Should this deploy?" --as=json
kdna use @aikdna/dev-deploy-readiness --task="Should this deploy?" --runner=cli:default --as=trace

# Cluster is an explicit advanced path.
kdna cluster validate ./kdna.cluster.json
kdna cluster plan-use ./kdna.cluster.json --task="Deploy a public API change" --as=json
kdna use ./kdna.cluster.json --task="Deploy a public API change" --runner=cli:default --as=trace
kdna eval cluster ./kdna.cluster.json --fixtures=./fixtures --as=json

# Evaluate a policy with public-safe fixtures and an explicit budget profile.
kdna eval-consumption <asset-path> --fixtures=./fixtures --budget=interactive --as=markdown
```

| Command                                 | Purpose                                                               |
| --------------------------------------- | --------------------------------------------------------------------- |
| `kdna route`                            | Select a primary framework or report no match.                        |
| `kdna compose`                          | Build a bounded primary/advisor set and trace it.                     |
| `kdna project`                          | Render a packaged asset as a task-safe projection.                    |
| `kdna plan-use`                         | Produce a deterministic pre-execution ConsumptionPlan.                |
| `kdna use`                              | Execute through a registered Runner and emit an observed Trace.       |
| `kdna cluster`                          | Validate, plan, inspect, or migrate an explicit Cluster manifest.     |
| `kdna eval asset`                       | Run the single-asset Assay without inflating evidence classification. |
| `kdna eval cluster`                     | Run the fail-closed five-gate Cluster Assay.                          |
| `kdna eval-consumption`                 | Run replay and multi-gate consumption evaluation.                     |
| `kdna compose-review-workbook`          | Create a review workbook from diagnostics.                            |
| `kdna validate-compose-decisions`       | Validate a decision ledger with replay evidence.                      |
| `kdna apply-reviewed-compose-decisions` | Create disabled candidate sidecar entries from validated decisions.   |
| `kdna asset-evidence`                   | Generate a public asset evidence manifest.                            |

Generated sidecars are disabled by default. They are not an endorsement of an
asset or a replacement for independent review.

The built-in `mock` Runner never claims an asset was loaded. The built-in
`cli` Runner validates and loads assets through KDNA Core but does not invoke a
language model; Agent/model execution is supplied by a registered Agent, app,
or API Runner.

## Asset Management

| Command                        | Purpose                                            |
| ------------------------------ | -------------------------------------------------- |
| `kdna install <file.kdna>`     | Install to local asset store (`~/.kdna/packages/`) |
| `kdna list`                    | List installed assets                              |
| `kdna remove <name>[@version]` | Remove an installed asset                          |

## Identity, Signing & Revocation

| Command                                 | Purpose                              |
| --------------------------------------- | ------------------------------------ |
| `kdna identity init [--name <n>]`       | Create Ed25519 signing key           |
| `kdna identity show`                    | Show public key (PEM / hex / base64) |
| `kdna sign <file.kdna>`                 | Sign an asset with your identity key |
| `kdna verify <file.kdna> [--key <pub>]` | Verify a signature                   |
| `kdna revoke <sig.kdsig> [--reason]`    | Issue a signed revocation record     |
| `kdna revocation-status <sig.kdsig>`    | Check revocation status              |

## Agent Loader Commands

The `kdna-loader` skill provides automatic discovery of local `.kdna` assets
for supported agents (OpenCode, Codex, Claude Code, Cursor). Install manually:

| Agent       | Skill path                              |
| ----------- | --------------------------------------- |
| OpenCode    | `~/.agents/skills/kdna-loader/SKILL.md` |
| Codex       | `~/.codex/skills/kdna-loader/SKILL.md`  |
| Claude Code | `~/.claude/skills/kdna-loader/SKILL.md` |
| Cursor      | `~/.cursor/skills/kdna-loader/SKILL.md` |

See [kdna-skills](https://github.com/aikdna/kdna-skills) for the loader source and installer script.

`kdna doctor [--agents] [--domains]` is the recommended first step after
install; `kdna setup` is the first-time setup wizard.

## Producer Path

Use Studio CLI to create formal `.kdna` assets:

```bash
npm install -g @aikdna/kdna-studio-cli
kdna-studio create my_domain --name @yourscope/my_domain
kdna-studio card add my_domain axiom \
  --field one_sentence="Prefer specific evidence over broad claims" \
  --field full_statement="When reviewing content, prefer specific evidence over broad claims because unsupported generalizations make the judgment impossible to verify or improve." \
  --field why="Broad claims hide the actual reason for a judgment, so reviewers cannot tell whether the conclusion is evidence based, reusable, or merely plausible sounding." \
  --field applies_when='["reviewing content"]' \
  --field does_not_apply_when='["pure formatting"]' \
  --field failure_risk="generic advice"
kdna-studio card approve my_domain --all --by expert --statement "I confirm this judgment."
kdna-studio export my_domain --out ./my_domain.kdna
kdna validate ./my_domain.kdna --runtime
kdna plan-load ./my_domain.kdna --json
kdna load ./my_domain.kdna --profile=compact --as=json
```

## Compatibility Notes

Some older commands may still appear for existing users and migration tests.
They are maintained as compatibility surfaces, not as the recommended public
beta path.

New integrations should use the single current KDNA route:

```text
source or Studio project
→ .kdna asset
→ kdna validate
→ kdna plan-load
→ kdna load
→ Runtime Capsule
```

## Runtime Authorization Contract

The source of truth is `aikdna/kdna`:

- `specs/kdna-authorization-contract.md`
- `schema/load-plan.schema.json`
- `conformance/authorization/cases.json`
- `conformance/authorization/goldens/*.loadplan.json`

This CLI is a diagnostic control plane. It may display, validate, and transport
LoadPlan results, but it must not define access modes, entitlement profiles,
issue codes, crypto profiles, or fail-closed policy independently.

The local packaged `.kdna` beta path is intentionally simple: validate the
file, inspect the LoadPlan, and load only when the plan says it is loadable.
Additional publisher or hosting layers are handled outside this first-run path.

Current local authorization path:

```bash
kdna validate ./asset.kdna --json
kdna plan-load ./asset.kdna --json
kdna plan-load ./asset.kdna --json --has-password
kdna load ./asset.kdna --profile=compact --as=json
```

> ⚠️ `--has-password` is a **plan-load** diagnostic only. It tells the
> planner "I would have a password if I had to provide one" so it can
> skip the `needs_password` gate. It does **not** decrypt. To actually
> load a protected asset, use `kdna load --password=<value>`. See
> [`docs/asset-authorization.md`](docs/asset-authorization.md) for the
> full distinction and end-to-end examples.

For an RFC-0019 account/device asset, an `active` status flag is not enough.
The preferred flow is:

```bash
kdna plan-load ./asset.kdna
# needs_account / sign_in_or_activate

kdna license activate @publisher/asset \
  --server https://publisher.example \
  --asset ./asset.kdna

kdna plan-load ./asset.kdna
# ready

kdna load ./asset.kdna --profile=compact --as=json
# kdna.context.capsule
```

The browser step authorizes the current device. Device private keys, pinned
issuer keys, and the signed grant are stored in the platform SecretStore; local
JSON contains only public status metadata and secret references. Headless
clients can use `--credential-stdin`. Activation credentials are never accepted
as ordinary command-line arguments. Account/device loading does not fall back
to the password profile.

Sensitive account/device state requires an encrypted SecretStore backend:
macOS Keychain, Linux Secret Service (`secret-tool`), or a GPG-backed standard
password store (`pass`). If none is available, account/device activation fails
closed instead of writing device keys or grants to plaintext files. Set
`KDNA_SECRET_STORE_BACKEND` only to select one of these trusted local backends;
the file and environment backends are not accepted for account/device grants.

`plan-load` delegates to `@aikdna/kdna-core`. The CLI never redefines access,
authorization, or decryption policy, and `load --as=json` returns the Core
Runtime Capsule rather than raw asset internals.

## Development

```bash
git clone https://github.com/aikdna/kdna-cli.git
cd kdna-cli
npm install
npm test
```

## Related

- [KDNA Core](https://github.com/aikdna/kdna/tree/main/packages/kdna-core)
- [KDNA Studio CLI](https://github.com/aikdna/kdna-studio-cli)
- [KDNA Skills](https://github.com/aikdna/kdna-skills)
- [aikdna.com](https://aikdna.com)

## License

Apache-2.0
