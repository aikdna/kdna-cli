# @aikdna/kdna-cli

[![npm](https://img.shields.io/npm/v/@aikdna/kdna-cli)](https://www.npmjs.com/package/@aikdna/kdna-cli) [![CI](https://github.com/aikdna/kdna-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/aikdna/kdna-cli/actions/workflows/ci.yml) [![License](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)

> **KDNA Core v1 is the official KDNA judgment-asset format and runtime loading contract.** `.kdna` assets are created, inspected, packed, unpacked, and validated through the **official KDNA toolchain**.

**Role**: kdna-cli is the **official KDNA runtime CLI** — the official command-line entry point of the KDNA toolchain for inspecting, validating, packing, unpacking, and loading `.kdna` assets.

**KDNA CLI is the official CLI entry of the KDNA toolchain — the official command-line surface for `.kdna` asset operations.**

Third-party products integrate KDNA through the official SDK, CLI, Loader, or API.

KDNA CLI 是 KDNA 官方工具链的 CLI 入口,是 `.kdna` 资产操作的官方命令行界面。第三方产品通过官方 SDK、CLI、Loader 或 API 接入 KDNA。

The CLI is how a `.kdna` judgment asset becomes usable by agents. It inspects, validates, packs, unpacks, and loads KDNA assets, and records traces for audit.

KDNA CLI 让一个领域判断资产真正被 Agent 使用。它负责安装 KDNA、验证结构与信任信息、把 KDNA 转换成 Agent 可加载的形式、对比加载前后的判断路径，并记录可审计的使用痕迹。

A `.kdna` asset is not created by writing JSON files. It is compiled by a
Studio-compatible authoring pipeline that performs human confirmation,
validation, canonicalization, identity generation, digest computation, signing,
optional encryption, and provenance recording. kdna-cli verifies and publishes
existing assets; it does not author trusted KDNA.

Part of the [KDNA](https://github.com/aikdna/kdna) ecosystem.

## Install

```bash
npm install -g @aikdna/kdna-cli
kdna setup
```

## Quick Start (5 minutes)

```bash
npm install -g @aikdna/kdna-cli
kdna setup
kdna install @aikdna/writing
kdna verify @aikdna/writing --judgment
kdna compare @aikdna/writing --input "help me improve this post"
kdna doctor --agents
```

## The 6 Commands You Actually Need

| Command                               | What it does                                       |
| ------------------------------------- | -------------------------------------------------- |
| `kdna setup`                          | Initialize ~/.kdna, install the agent skill loader |
| `kdna install <domain>`               | Install a domain from the registry                 |
| `kdna list`                           | Show installed domains with quality info           |
| `kdna verify <domain>`                | 3-layer check: structure + trust + judgment        |
| `kdna compare <domain> --input "..."` | Compare with/without KDNA judgment                 |
| `kdna doctor --agents`                | Check agent integration health                     |

## All Commands by Role

### Dev Source Utilities

| Command                            | Status       | Description                                                                 |
| ---------------------------------- | ------------ | --------------------------------------------------------------------------- |
| `kdna init <name>`                 | Deprecated   | Alias for `kdna dev scaffold`; creates a non-canonical dev source workspace |
| `kdna dev scaffold <name>`         | Beta         | Scaffold a non-canonical dev source workspace                               |
| `kdna dev validate <path>`         | Stable       | Validate a non-canonical dev source directory                               |
| `kdna dev pack <path>`             | Beta         | Build a dev-only non-trusted `.kdna` bundle                                 |
| `kdna dev unpack <file>`           | Beta         | Unpack .kdna into a dev source directory                                    |
| `kdna dev inspect <path>`          | Beta         | Inspect a non-canonical dev source directory                                |
| `kdna dev card <path>`             | Beta         | Display KDNA Card from a dev source directory                               |
| `kdna inspect <file.kdna>`         | Beta         | Inspect a .kdna asset                                                       |
| `kdna publish <file.kdna>`         | Experimental | Publish an existing Studio-compiled `.kdna` asset                           |
| `kdna publish --check <path>`      | Experimental | Dev source readiness check only; does not publish                           |
| `kdna version bump <level> [path]` | Beta         | Bump domain version                                                         |

### Agent Runtime

| Command                                                | Status | Description                             |
| ------------------------------------------------------ | ------ | --------------------------------------- |
| `kdna available [--json]`                              | Beta   | List installed domains with v2.1 fields |
| `kdna match "<task>" [--json]`                         | Beta   | Signal matching — find relevant domains |
| `kdna load <name\|file.kdna> [--as=prompt\|json\|raw]` | Beta   | Emit asset in agent-ready format        |
| `kdna postvalidate <name> --output <file>`             | Beta   | Post-generation judgment check          |

### Testing & Verification

| Command                                                      | Status | Description                           |
| ------------------------------------------------------------ | ------ | ------------------------------------- |
| `kdna verify <name\|file.kdna>`                              | Beta   | 3-layer: structure + trust + judgment |
| `kdna compare <name\|file.kdna> --input "..."`               | Beta   | With/without KDNA reasoning diff      |
| `kdna compare <name\|file.kdna> --input "..." --report-md`   | Beta   | Markdown report with scoring          |
| `kdna compare <name\|file.kdna> --input "..." --report-json` | Beta   | JSON report with scoring              |
| `kdna diff <name>@<v1> <name>@<v2>`                          | Beta   | Judgment-level diff between versions  |

### Diagnostics & Trace

| Command                           | Status       | Description                                                   |
| --------------------------------- | ------------ | ------------------------------------------------------------- |
| `kdna doctor`                     | Beta         | System health check                                           |
| `kdna doctor --agents`            | Beta         | Agent integration check (Codex/Claude/OpenCode/Cursor/Gemini) |
| `kdna doctor --json`              | Beta         | Machine-readable health report                                |
| `kdna trace`                      | Experimental | View recent load/postvalidate traces                          |
| `kdna trace --json`               | Experimental | Machine-readable trace output                                 |
| `kdna trace --export <file>`      | Experimental | Export traces for audit                                       |
| `kdna trace --since 7d\|30d\|90d` | Experimental | Filter by time range                                          |
| `kdna history`                    | Experimental | Recent domain usage (last 20)                                 |
| `kdna history --stats`            | Experimental | Aggregate by domain and agent                                 |
| `kdna history --domain <name>`    | Experimental | Filter by domain                                              |

### License & Authorization

Licensed asset loading (`kdna install`, `kdna load`, `kdna verify`) requires a
valid local activation. Full RFC-0008 conformance across JS Core, Swift Core,
and CLI is tracked via cross-language test vectors in the
[kdna](https://github.com/aikdna/kdna) conformance suite.

| Command                                                     | Status       | Description                                                    |
| ----------------------------------------------------------- | ------------ | -------------------------------------------------------------- |
| `kdna license generate <domain> --to <email>`               | Experimental | Generate signed license                                        |
| `kdna license install <license.json>`                       | Experimental | Register license for auto-decrypt                              |
| `kdna license activate <domain> --key <key> --server <url>` | Experimental | Activate a license from entitlement source                     |
| `kdna license sync [domain] [--server <url>]`               | Experimental | Refresh entitlement and revocation status                      |
| `kdna license verify <license.json>`                        | Experimental | Verify license signature and validity                          |
| `kdna license bind <license.json>`                          | Experimental | Bind license to this machine                                   |
| `kdna license show <license.json>`                          | Experimental | Display license details                                        |
| `kdna license status [domain] [--json]`                     | Experimental | Show installed license activation status without exposing keys |

### Cluster Composition

| Command                    | Status  | Description               |
| -------------------------- | ------- | ------------------------- |
| `kdna cluster lint <path>` | Planned | Validate cluster manifest |

### Registry & Distribution

| Command                   | Status | Description                           |
| ------------------------- | ------ | ------------------------------------- |
| `kdna install <name>`     | Beta   | Install domain from registry          |
| `kdna install file.kdna`  | Beta   | Install from local .kdna asset        |
| `kdna remove <name>`      | Beta   | Uninstall a domain                    |
| `kdna update <name>`      | Beta   | Update installed domain               |
| `kdna info <name>`        | Beta   | Show domain metadata and trust status |
| `kdna list [--available]` | Beta   | List installed or available domains   |
| `kdna search <keyword>`   | Beta   | Search registry                       |
| `kdna registry refresh`   | Beta   | Refresh registry cache                |

### Identity & Signing

| Command                        | Status       | Description                     |
| ------------------------------ | ------------ | ------------------------------- |
| `kdna identity init`           | Experimental | Generate Ed25519 signing key    |
| `kdna identity show`           | Experimental | Display public key and buyer ID |
| `kdna identity export [--out]` | Experimental | Backup private key (encrypted)  |
| `kdna identity import <file>`  | Experimental | Restore identity from backup    |

### Setup

| Command      | Status | Description                                |
| ------------ | ------ | ------------------------------------------ |
| `kdna setup` | Beta   | One-command setup: CLI + skill + data root |

---

## SPEC Compatibility

KDNA CLI follows the canonical KDNA Container format defined in [`aikdna/kdna`](https://github.com/aikdna/kdna).

A valid KDNA asset is a `.kdna` container with:
- `kdna.json` — public manifest and metadata (no judgment content)
- `payload.kdnab` — CBOR-encoded judgment payload
- `signature.kdsig` — Ed25519 signature

The authoring source tree uses standard JSON files (KDNA_Core.json, KDNA_Patterns.json, etc.) for human editing and Git review. These files belong to the source tree only and MUST NOT appear as top-level entries in a distribution `.kdna` asset.

To create a trusted `.kdna`, use `kdna-studio migrate <source-dir> --out <file.kdna>` or a Studio-compatible compiler that records authoring provenance, Human Lock evidence, compiler metadata, and asset digest.

---

## Legacy Registry (deprecated)

KDNA Core v1 is the **official KDNA judgment-asset format**. KDNA Core v1 does not define a registry, marketplace, or quality-badge system. Assets are loaded by path or by the official CLI, not by registry name.

The legacy `kdna install <name>` command and the `KDNA_REGISTRY_URL` env var are preserved for backward compatibility with the legacy `kdna-registry` repository (marked as a legacy experiment). New KDNA Core v1 integrations should use the official CLI route:

```bash
kdna inspect <path>
kdna validate <path>
kdna pack <source-dir> <output.kdna>
kdna unpack <input.kdna> <output-dir>
```

---

## Official toolchain components

KDNA Core v1 is the **official KDNA judgment-asset format**. `.kdna` assets are created, inspected, protected, loaded, and consumed through the official KDNA toolchain. Third-party products integrate KDNA through the official SDK, CLI, Loader, or API.

| Layer | Component | Responsibility |
| ------ | -------------------------- | --------------- |
| Format | KDNA Core | Official KDNA judgment-asset format and runtime loading contract |
| Core Library | @aikdna/kdna-core | Official loader SDK |
| Runtime | @aikdna/kdna-cli | Official CLI: inspect, validate, pack, unpack, load |
| Authoring | KDNA Studio Core | Official authoring kernel |

## Development

```bash
git clone https://github.com/aikdna/kdna-cli.git
cd kdna-cli
npm install
npm test
```

## Related

- [@aikdna/kdna-core](https://github.com/aikdna/kdna/tree/main/packages/kdna-core) — Official loader SDK
- [KDNA SPEC](https://github.com/aikdna/kdna) — Official KDNA Core format
- [aikdna.com](https://aikdna.com) — Website

## License

Apache-2.0
