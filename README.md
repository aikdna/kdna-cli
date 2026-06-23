# @aikdna/kdna-cli

[![npm](https://img.shields.io/npm/v/@aikdna/kdna-cli)](https://www.npmjs.com/package/@aikdna/kdna-cli) [![CI](https://github.com/aikdna/kdna-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/aikdna/kdna-cli/actions/workflows/ci.yml) [![License](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)

The official command-line runtime for Core GA judgment assets.

KDNA CLI inspects, validates, packs, unpacks, and loads `.kdna` files. It is
the consumer/runtime side of the official KDNA toolchain. Formal authoring is
handled by KDNA Studio CLI and Studio Core.

Start with one local `.kdna` file: validate it, plan loading, and render
agent-ready judgment context from your terminal.

## Install

```bash
npm install -g @aikdna/kdna-cli
```

## 5-Minute Path

```bash
kdna demo minimal ./minimal
kdna pack ./minimal ./minimal.kdna
kdna validate ./minimal.kdna
kdna plan-load ./minimal.kdna
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

| Command                                                    | Purpose                                                        |
| ---------------------------------------------------------- | -------------------------------------------------------------- |
| `kdna demo minimal <dir>`                                  | Create a minimal local demo folder                             |
| `kdna inspect <path>`                                      | Inspect a source directory or `.kdna` container                   |
| `kdna validate <path>`                                     | Validate format, schema, payload, checksums, and load contract |
| `kdna plan-load <path> --json`                             | Return the Core LoadPlan before runtime load                   |
| `kdna plan-load <path> --json --has-password`              | Diagnose password-authorized load state                        |
| `kdna plan-load <path> --json --entitlement-status active` | Diagnose receipt/entitlement load state                        |
| `kdna pack <input-dir> <output.kdna>`                      | Pack a local working folder into a `.kdna` file                |
| `kdna unpack <input.kdna> <output-dir>`                    | Unpack a KDNA Asset Container                                          |
| `kdna load <path> --profile=<index\|compact\|scenario\|full> --as=<json\|prompt>` | Render judgment context for agents or tools |

## Agent Loader Commands

The `kdna-loader` skill provides automatic discovery of local `.kdna` assets
for supported agents (OpenCode, Codex, Claude Code, Cursor). Install manually:

| Agent | Skill path |
| --- | --- |
| OpenCode | `~/.agents/skills/kdna-loader/SKILL.md` |
| Codex | `~/.codex/skills/kdna-loader/SKILL.md` |
| Claude Code | `~/.claude/skills/kdna-loader/SKILL.md` |
| Cursor | `~/.cursor/skills/kdna-loader/SKILL.md` |

See [kdna-skills](https://github.com/aikdna/kdna-skills) for the loader source and installer script.

`kdna setup` and `kdna doctor` were removed in Core CLI 0.27.0. Use the manual install path above.

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
kdna-studio export my_domain --format v1 --out ./my_domain.kdna
kdna validate ./my_domain.kdna --runtime
kdna plan-load ./my_domain.kdna --json
kdna load ./my_domain.kdna --profile=compact --as=prompt
```

## Compatibility Notes

Some older commands may still appear for existing users and migration tests.
They are maintained as compatibility surfaces, not as the recommended public
beta path.

New integrations should use the Core GA route:

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

The local packaged `.kdna` beta path is intentionally simple: validate the
file, inspect the LoadPlan, and load only when the plan says it is loadable.
Additional publisher or hosting layers are handled outside this first-run path.

Current local authorization path:

```bash
kdna validate ./asset.kdna --json
kdna plan-load ./asset.kdna --json
kdna plan-load ./asset.kdna --json --has-password
kdna plan-load ./asset.kdna --json --entitlement-status active
kdna load ./asset.kdna --profile=compact --as=prompt
```

`plan-load` requires a version of `@aikdna/kdna-core` that exports the LoadPlan
Core GA API. Until that dependency is released and installed, the command fails with
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
