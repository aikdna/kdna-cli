# @aikdna/kdna-cli

**KDNA CLI is the runtime control plane for loading, validating, composing, testing, and governing domain judgment for AI agents.**

KDNA CLI 是 AI Agent 加载、验证、组合、测试和治理领域判断的运行控制平面。

Part of the [KDNA](https://github.com/aikdna/KDNA) ecosystem.

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

| Command | Description |
|---------|-------------|
| `kdna init <name>` | Scaffold a new domain from template |
| `kdna validate <path>` | Validate domain structure |
| `kdna validate --schema <path>` | Schema-only validation |
| `kdna pack <path>` | Pack into .kdna container |
| `kdna pack <path> --encrypt --license <file>` | Pack encrypted .kdnae container |
| `kdna unpack <file>` | Unpack .kdna or .kdnae container |
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
| `kdna postvalidate <name> --output <file>` | Post-generation judgment check |

### Testing & Verification

| Command | Description |
|---------|-------------|
| `kdna verify <name>` | 3-layer: structure + trust + judgment |
| `kdna compare <name> --input "..."` | With/without KDNA reasoning diff |
| `kdna compare <name> --input "..." --report-md` | Markdown report with scoring |
| `kdna compare <name> --input "..." --report-json` | JSON report with scoring |
| `kdna diff <name>@<v1> <name>@<v2>` | Judgment-level diff between versions |

### Diagnostics & Trace

| Command | Description |
|---------|-------------|
| `kdna doctor` | System health check |
| `kdna doctor --agents` | Agent integration check (Codex/Claude/OpenCode/Cursor/Gemini) |
| `kdna doctor --json` | Machine-readable health report |
| `kdna trace` | View recent load/postvalidate traces |
| `kdna trace --json` | Machine-readable trace output |
| `kdna trace --export <file>` | Export traces for audit |
| `kdna trace --since 7d\|30d\|90d` | Filter by time range |
| `kdna history` | Recent domain usage (last 20) |
| `kdna history --stats` | Aggregate by domain and agent |
| `kdna history --domain <name>` | Filter by domain |

### License & Authorization

| Command | Description |
|---------|-------------|
| `kdna license generate <domain> --to <email>` | Generate signed license |
| `kdna license install <license.json>` | Register license for auto-decrypt |
| `kdna license verify <license.json>` | Verify license signature and validity |
| `kdna license bind <license.json>` | Bind license to this machine |
| `kdna license show <license.json>` | Display license details |

### Cluster Composition

| Command | Description |
|---------|-------------|
| `kdna cluster lint <path>` | Validate cluster manifest |

### Registry & Distribution

| Command | Description |
|---------|-------------|
| `kdna install <name>` | Install domain from registry |
| `kdna install ./file.kdna` | Install from local .kdna file |
| `kdna install ./file.kdnae` | Install from encrypted .kdnae (auto-decrypt with license) |
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

### Environment Variables

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
| Distribution | Registry | Discover, install, trade |

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
- [KDNA SPEC](https://github.com/aikdna/KDNA) — Protocol specification
- [aikdna.com](https://aikdna.com) — Website

## License

Apache-2.0
