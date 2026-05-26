# @aikdna/kdna-cli

> **KDNA Ecosystem:** [`kdna`](https://github.com/aikdna/kdna) — the protocol. [KDNAChat](https://github.com/AhaSparkCoach/kdnachat) — the consumption client. [KDNaStudio](https://github.com/AhaSparkCoach/kdnastudio) — the authoring tool. [KDNAWork](https://github.com/AhaSparkCoach/kdnawork) — the workbench. **You are here → kdna-cli** — the toolchain. [Registry](https://github.com/aikdna/kdna-registry) — the catalog.

**Role**: kdna-cli is the **runtime control plane** — the official reference implementation for domain validation, loading, packaging, comparison, and agent-facing runtime workflows. It bridges Studio output to Chat/Work consumption.

**KDNA CLI is the official open-source reference implementation for KDNA validation, loading, packaging, comparison, registry access, and agent-facing runtime workflows.**

It is the runtime control plane for loading, validating, composing, testing, and governing domain judgment for AI agents.

KDNA CLI 是 KDNA 验证、加载、打包、比较、注册表访问和 Agent 运行时工作流的官方开源参考实现，也是 AI Agent 加载、验证、组合、测试和治理领域判断的运行控制平面。

The CLI is how a KDNA cognitive kernel becomes usable by agents. It installs KDNA domains, verifies their structure and trust metadata, loads them into agent-readable form, compares judgment paths with and without KDNA, and records traces for audit.

KDNA CLI 让一个认知内核真正被 Agent 使用。它负责安装 KDNA、验证结构与信任信息、把 KDNA 转换成 Agent 可加载的形式、对比加载前后的判断路径，并记录可审计的使用痕迹。

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

## Commands by Role

### Domain Authoring

| Command | Status | Description |
|---------|--------|-------------|
| `kdna init <name>` | Beta | Scaffold a new domain from template |
| `kdna validate <path>` | Stable | Validate domain structure |
| `kdna validate --schema <path>` | Stable | Schema-only validation |
| `kdna pack <path>` | Beta | Pack into .kdna container |
| `kdna pack <path> --encrypt --license <file>` | Beta | Pack encrypted .kdnae container |
| `kdna unpack <file>` | Beta | Unpack .kdna or .kdnae container |
| `kdna inspect <path>` | Beta | Inspect domain or .kdna file |
| `kdna publish <path>` | Experimental | Pack + sign + publish to registry |
| `kdna publish --check <path>` | Experimental | Quality gate check only |
| `kdna version bump <level> [path]` | Beta | Bump domain version |

### Agent Runtime

| Command | Status | Description |
|---------|--------|-------------|
| `kdna available [--json]` | Beta | List installed domains with v2.1 fields |
| `kdna match "<task>" [--json]` | Beta | Signal matching — find relevant domains |
| `kdna load <name> [--as=prompt\|json\|raw]` | Beta | Emit domain in agent-ready format |
| `kdna postvalidate <name> --output <file>` | Beta | Post-generation judgment check |

### Testing & Verification

| Command | Status | Description |
|---------|--------|-------------|
| `kdna verify <name>` | Beta | 3-layer: structure + trust + judgment |
| `kdna compare <name> --input "..."` | Beta | With/without KDNA reasoning diff |
| `kdna compare <name> --input "..." --report-md` | Beta | Markdown report with scoring |
| `kdna compare <name> --input "..." --report-json` | Beta | JSON report with scoring |
| `kdna diff <name>@<v1> <name>@<v2>` | Beta | Judgment-level diff between versions |

### Diagnostics & Trace

| Command | Status | Description |
|---------|--------|-------------|
| `kdna doctor` | Beta | System health check |
| `kdna doctor --agents` | Beta | Agent integration check (Codex/Claude/OpenCode/Cursor/Gemini) |
| `kdna doctor --json` | Beta | Machine-readable health report |
| `kdna trace` | Experimental | View recent load/postvalidate traces |
| `kdna trace --json` | Experimental | Machine-readable trace output |
| `kdna trace --export <file>` | Experimental | Export traces for audit |
| `kdna trace --since 7d\|30d\|90d` | Experimental | Filter by time range |
| `kdna history` | Experimental | Recent domain usage (last 20) |
| `kdna history --stats` | Experimental | Aggregate by domain and agent |
| `kdna history --domain <name>` | Experimental | Filter by domain |

### License & Authorization

| Command | Status | Description |
|---------|--------|-------------|
| `kdna license generate <domain> --to <email>` | Experimental | Generate signed license |
| `kdna license install <license.json>` | Experimental | Register license for auto-decrypt |
| `kdna license verify <license.json>` | Experimental | Verify license signature and validity |
| `kdna license bind <license.json>` | Experimental | Bind license to this machine |
| `kdna license show <license.json>` | Experimental | Display license details |

### Cluster Composition

| Command | Status | Description |
|---------|--------|-------------|
| `kdna cluster lint <path>` | Planned | Validate cluster manifest |

### Registry & Distribution

| Command | Status | Description |
|---------|--------|-------------|
| `kdna install <name>` | Beta | Install domain from registry |
| `kdna install ./file.kdna` | Beta | Install from local .kdna file |
| `kdna install ./file.kdnae` | Beta | Install from encrypted .kdnae (auto-decrypt with license) |
| `kdna remove <name>` | Beta | Uninstall a domain |
| `kdna update <name>` | Beta | Update installed domain |
| `kdna info <name>` | Beta | Show domain metadata and trust status |
| `kdna list [--available]` | Beta | List installed or available domains |
| `kdna search <keyword>` | Beta | Search registry |
| `kdna registry refresh` | Beta | Refresh registry cache |

### Identity & Signing

| Command | Status | Description |
|---------|--------|-------------|
| `kdna identity init` | Experimental | Generate Ed25519 signing key |
| `kdna identity show` | Experimental | Display public key and buyer ID |
| `kdna identity export [--out]` | Experimental | Backup private key (encrypted) |
| `kdna identity import <file>` | Experimental | Restore identity from backup |

### Setup

| Command | Status | Description |
|---------|--------|-------------|
| `kdna setup` | Beta | One-command setup: CLI + skill + data root |

---

## SPEC Compatibility

KDNA CLI follows the canonical KDNA domain structure defined in [`aikdna/kdna`](https://github.com/aikdna/kdna).

A valid KDNA domain is a lowercase `snake_case` folder. A complete domain may include up to six files:

- `KDNA_Core.json`
- `KDNA_Patterns.json`
- `KDNA_Scenarios.json`
- `KDNA_Cases.json`
- `KDNA_Reasoning.json`
- `KDNA_Evolution.json`

The minimum valid domain requires:

- `KDNA_Core.json`
- `KDNA_Patterns.json`

Each file must include `meta.version`, `meta.domain`, `meta.created`, `meta.purpose`, and `meta.load_condition`.

---

## Default Registry

By default, KDNA CLI uses the official KDNA registry. Users may override it with `KDNA_REGISTRY_URL`.

```bash
# Use the official registry (default)
kdna install @aikdna/writing

# Use a custom registry
export KDNA_REGISTRY_URL="https://my-registry.example.com/domains.json"
kdna install @myorg/internal
```

---

## Open Source and Commercial Boundary

KDNA keeps the protocol, schemas, validator, core CLI, benchmark tools, and reference examples open source.

Commercial or hosted layers may include:

- Managed registry services
- Quality badge review workflows
- Hosted runtime guard
- Enterprise private registry
- Team collaboration in KDNA Studio
- Licensed/private judgment asset distribution

KDNA supports both open judgment assets and licensed/private judgment assets. Open domains remain the default path for community adoption, while encrypted containers and licenses support professional and enterprise distribution.

KDNA 同时支持开放判断资产和授权/私有判断资产。开放 domain 是社区采用的默认路径；加密容器和 license 用于专业资产与企业分发。

---

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `KDNA_AGENT` | Override agent name in trace logs (e.g. `claude_code`, `codex`, `opencode`) |
| `KDNA_REGISTRY_URL` | Override canonical registry URL |
| `KDNA_IDENTITY_DIR` | Override identity key directory |

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
kdna doctor --agents --json
kdna trace --json
kdna history --json
kdna license verify --json <file>
```

## Product Matrix

| Layer | Product | Responsibility |
|-------|---------|---------------|
| Protocol | KDNA SPEC | Define judgment asset format |
| Core Library | @aikdna/kdna-core | load / validate / compose / render |
| Runtime | @aikdna/kdna-cli | Agent runtime + compile + verify + test + publish + license |
| Authoring | KDNA Studio | Human-led judgment production |
| Consumption | KDNAChat | Load, use, compare |
| Governance | KDNA Governance Console | Approve, release, audit |
| Distribution | Registry | Discover, install, license, distribute |

## Development

```bash
git clone https://github.com/aikdna/kdna-cli.git
cd kdna-cli
npm install
npm test
```

## Related

- [@aikdna/kdna-core](https://github.com/aikdna/kdna/tree/main/packages/kdna-core) — Pure logic library
- [KDNA Registry](https://github.com/aikdna/kdna-registry) — Domain catalog
- [KDNA SPEC](https://github.com/aikdna/kdna) — Protocol specification
- [aikdna.com](https://aikdna.com) — Website

## License

Apache-2.0
