# @aikdna/kdna-cli

**KDNA CLI is the runtime control plane for loading, validating, composing, testing, and governing domain judgment for AI agents.**

KDNA CLI 是 AI Agent 加载、验证、组合、测试和治理领域判断的运行控制平面。

CLI 不是 Studio，不是 Chat，不是 Governance Console。它是这些产品共同依赖的底层协议接口。

Part of the [KDNA](https://github.com/aikdna/KDNA) ecosystem.

## Install

```bash
npm install -g @aikdna/kdna-cli
```

## Quick Start

```bash
kdna install @aikdna/writing    # Install a domain
kdna verify @aikdna/writing     # 3-layer verification
kdna available                  # List installed domains
kdna match "improve this post"  # Find relevant domains
kdna load @aikdna/writing       # Load for agent consumption
```

## Commands by Role

### Domain Authoring

| Command | Description |
|---------|-------------|
| `kdna init <name>` | Scaffold a new domain from template |
| `kdna validate <path>` | Validate domain structure |
| `kdna validate --schema <path>` | Schema-only validation |
| `kdna pack <path>` | Pack into .kdna container |
| `kdna unpack <file>` | Unpack .kdna container |
| `kdna inspect <path>` | Inspect domain or .kdna file |
| `kdna publish <path>` | Pack + sign + publish to registry |
| `kdna publish --check <path>` | Quality gate check only |
| `kdna version bump <level> [path]` | Bump domain version |

### Agent Runtime

| Command | Description |
|---------|-------------|
| `kdna available [--json]` | List installed domains with v2.1 fields |
| `kdna match "<task>" [--json]` | Signal matching — find relevant domains |
| `kdna load <name> [--as=prompt\|json\|raw]` | Emit domain in agent-ready format |

### Testing & Verification

| Command | Description |
|---------|-------------|
| `kdna verify <name>` | 3-layer verification: structure + trust + judgment |
| `kdna compare <name> --input "..."` | With/without KDNA reasoning diff |
| `kdna diff <name>@<v1> <name>@<v2>` | Judgment-level diff between versions |
| `kdna doctor` | Check runtime environment health |

### Cluster Composition

| Command | Description |
|---------|-------------|
| `kdna cluster lint <path>` | Validate cluster manifest |

### Registry & Distribution

| Command | Description |
|---------|-------------|
| `kdna install <name>` | Install domain from registry |
| `kdna remove <name>` | Uninstall a domain |
| `kdna update <name>` | Update installed domain |
| `kdna info <name>` | Show domain metadata and trust status |
| `kdna list [--available]` | List installed or available domains |
| `kdna search <keyword>` | Search registry |
| `kdna registry refresh` | Refresh registry cache |

### Identity & Signing

| Command | Description |
|---------|-------------|
| `kdna identity init` | Generate Ed25519 signing key |
| `kdna identity show` | Display public key and buyer ID |
| `kdna identity export [--out]` | Backup private key (encrypted) |
| `kdna identity import <file>` | Restore identity from backup |

### Setup

| Command | Description |
|---------|-------------|
| `kdna setup` | One-command setup: CLI + skill + data root |

## Exit Codes

| Code | Name | Meaning |
|------|------|---------|
| 0 | `OK` | Success |
| 1 | `VALIDATION_FAILED` | Structure or schema validation failed |
| 2 | `INPUT_ERROR` | Invalid input, missing argument, not found |
| 3 | `TRUST_FAILED` | Signature or trust verification failed |
| 4 | `JUDGMENT_QUALITY_FAILED` | Judgment governance fields missing or insufficient |
| 5 | `REGISTRY_ERROR` | Registry lookup or network error |
| 6 | `PROVIDER_ERROR` | LLM provider (API key, rate limit) error |
| 7 | `POLICY_VIOLATION` | Publishing or governance policy violation |
| 8 | `HUMAN_LOCK_REQUIRED` | Human lock required but not present |

## JSON Output

Machine-consumable commands support `--json` for structured output:

```bash
kdna verify @aikdna/writing --json
kdna available --json
kdna match "help me write" --json
kdna search writing --json
kdna info @aikdna/writing --json
kdna doctor --json
```

## Product Matrix

| Layer | Product | Responsibility |
|-------|---------|---------------|
| Protocol | KDNA SPEC | Define judgment asset format |
| Core Library | @aikdna/kdna-core | load / validate / compose / render |
| Runtime | @aikdna/kdna-cli | Agent runtime + compile + verify + test + publish |
| Authoring | KDNA Studio | Human-led judgment production |
| Consumption | KDNAChat | Load, use, compare |
| Governance | KDNA Governance Console | Approve, release, audit |
| Distribution | Registry | Discover, install, trade |

CLI 不应该成为一个"命令行 Studio"，而是所有 KDNA 产品共同依赖的协议控制平面。

## Development

```bash
git clone https://github.com/aikdna/kdna-cli.git
cd kdna-cli
npm install
npm test
```

## Related

- [@aikdna/kdna-core](https://github.com/aikdna/KDNA/tree/main/packages/kdna-core) — Pure logic library
- [KDNA Registry](https://github.com/aikdna/kdna-registry) — Domain catalog
- [aikdna.com](https://aikdna.com) — Website

## License

Apache-2.0
