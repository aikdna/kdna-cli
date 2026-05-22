# @aikdna/kdna-cli

KDNA CLI — create, validate, install, and manage domain cognition packages for AI agents.

Part of the [KDNA](https://github.com/aikdna/KDNA) ecosystem.

## Install

```bash
npm install -g @aikdna/kdna-cli
```

## Quick Start

```bash
# Validate a domain
kdna validate ./my-domain

# Verify a domain (structure + trust + judgment)
kdna verify @aikdna/writing

# Install a domain
kdna install @aikdna/writing

# Create a new domain
kdna init my-domain

# Search the registry
kdna search writing

# Compare with/without KDNA
kdna compare @aikdna/writing --input "..."
```

## Commands

| Command | Description |
|---------|-------------|
| `kdna validate <dir>` | Validate domain structure |
| `kdna verify <name>` | Full 3-layer verification (structure/trust/judgment) |
| `kdna install <name>` | Install a domain from the registry |
| `kdna remove <name>` | Remove an installed domain |
| `kdna info <name>` | Show domain information |
| `kdna inspect <dir\|file>` | Inspect a domain or .kdna file |
| `kdna list` | List installed domains |
| `kdna search <keyword>` | Search the registry |
| `kdna init <name>` | Create a new domain from template |
| `kdna pack <dir>` | Pack a domain into .kdna file |
| `kdna unpack <file>` | Unpack a .kdna file |
| `kdna publish <dir>` | Publish a domain to the registry |
| `kdna compare <name>` | Compare AI output with/without KDNA |
| `kdna diff <name@v1> <name@v2>` | Diff two domain versions |
| `kdna project init` | Initialize .kdna/config.json for a project |
| `kdna identity init` | Create a signing identity |

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
