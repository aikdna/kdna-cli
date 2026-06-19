# @aikdna/kdna-cli

[![npm](https://img.shields.io/npm/v/@aikdna/kdna-cli)](https://www.npmjs.com/package/@aikdna/kdna-cli) [![CI](https://github.com/aikdna/kdna-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/aikdna/kdna-cli/actions/workflows/ci.yml) [![License](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)

The official command-line runtime for KDNA Core v1 judgment assets.

KDNA CLI inspects, validates, packs, unpacks, and loads `.kdna` files. It is
the consumer/runtime side of the official KDNA toolchain. Formal authoring is
handled by KDNA Studio CLI and Studio Core.

KDNA Core v1 does not require a public registry, marketplace, quality badge, or
signature system. The current first-run path uses local `.kdna` files.

Authorization and runtime-load decisions are defined in `aikdna/kdna`, not in
this repository. `kdna plan-load` is the CLI diagnostic surface for that
contract and MUST call the LoadPlan API from `@aikdna/kdna-core` instead of
deriving authorization state directly from manifest fields.

## Install

```bash
npm install -g @aikdna/kdna-cli
```

## 5-Minute Path

```bash
kdna demo minimal ./minimal
kdna inspect ./minimal
kdna validate ./minimal
kdna plan-load ./minimal --json
kdna pack ./minimal ./minimal.kdna
kdna validate ./minimal.kdna
kdna load ./minimal.kdna --profile=compact --as=prompt
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

| Command | Purpose |
|---|---|
| `kdna demo minimal <dir>` | Create a minimal v1 source directory |
| `kdna inspect <path>` | Inspect a v1 source dir or `.kdna` container |
| `kdna validate <path>` | Validate format, schema, payload, checksums, and load contract |
| `kdna plan-load <path> --json` | Return the Core LoadPlan before runtime load |
| `kdna pack <source-dir> <output.kdna>` | Pack a v1 source directory |
| `kdna unpack <input.kdna> <output-dir>` | Unpack a v1 container |
| `kdna load <path> --profile=<index|compact|scenario|full> --as=<json|prompt>` | Render judgment context for agents or tools |
| `kdna setup` | Install the `kdna-loader` skill for supported agents |
| `kdna doctor --agents` | Check agent loader installation |

## Producer Path

Use Studio CLI to create formal v1 `.kdna` assets:

```bash
npm install -g @aikdna/kdna-studio-cli
kdna-studio create my_domain --name @yourscope/my_domain
kdna-studio migrate ./my_domain --format v1 --out ./my_domain.kdna
kdna validate ./my_domain.kdna
kdna load ./my_domain.kdna --profile=compact --as=prompt
```

## Legacy Compatibility

Older CLI commands for registry install, compare, trace, licensing, identity, or
pre-v1 dev source workflows may still exist for backward compatibility. They
are not the KDNA Core v1 launch path.

New integrations should use the v1 Core route:

```text
source or Studio project
→ v1 .kdna container
→ kdna validate
→ kdna plan-load
→ kdna load
→ agent/runtime context
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

Current local authorization path:

```bash
kdna validate ./asset.kdna --json
kdna plan-load ./asset.kdna --json
kdna load ./asset.kdna --profile=compact --as=prompt
```

`plan-load` requires a version of `@aikdna/kdna-core` that exports the LoadPlan
v1 API. Until that dependency is released and installed, the command fails with
a version-gate error instead of falling back to duplicated CLI-side parsing.

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
