# Changelog

## v0.15.0 (2026-05-23)

**License + Install Integration: auto-decrypt .kdnae on install**

- `kdna install ./file.kdnae`: automatic decryption via license lookup in `~/.kdna/licenses/`
- `kdna license install <file>`: register a license for automatic domain decryption
- Fixed `license verify --json` flag parsing
- Fixed `license bind` to re-sign after machine binding
- Fixed `license generate` to output JSON to stdout (info to stderr)
- Added `--save <path>` flag to `license generate`
- Modified `parseSource` to recognize `.kdnae` extension for local install
- Added `extractAndDecrypt` function (extract ZIP + AES-256-GCM decrypt KDNA files)
- Added `findLicenseForDomain` for automatic license discovery

## v0.14.0 (2026-05-23)

**Encrypted Container (.kdnae) + License Management**

- `.kdnae` container format: AES-256-GCM encryption of KDNA JSON files (kdna.json stays plaintext)
- `kdna pack --encrypt --license <file>`: create encrypted containers
- `kdna unpack <file.kdnae> --license <file>`: decrypt and extract
- `kdna license generate <domain> --to <email>`: generate Ed25519-signed licenses
- `kdna license verify <license.json>`: verify signature, expiry, machine binding
- `kdna license bind <license.json>`: bind license to machine fingerprint + re-sign
- `kdna license show <license.json>`: display license details
- PBKDF2 key derivation: license_id + machine fingerprint (600k iterations) → AES-256
- Machine fingerprint: sha256(hostname + uid + platform + arch + hardware UUID)

## v0.13.0 (2026-05-23)

**Compare Report: structured scoring output**

- `kdna compare --report-md`: Markdown report with Judgment Diff table and D1-D7 scoring
- `kdna compare --report-json`: JSON report with parsed axes, scores, and metadata
- `--output <file>` flag for saving reports
- Trace recording integrated for compare runs

## v0.12.0 (2026-05-23)

**Doctor + Trace + History: diagnostics and observability**

- `kdna doctor --agents`: detect agent installations and verify kdna-loader skill status per agent (Codex, Claude Code, OpenCode, Cursor, Gemini)
- `kdna doctor --domains`: domain-only health check
- `kdna doctor --json`: machine-readable health report
- `kdna trace`: JSON Lines logging to `~/.kdna/traces/YYYY-MM-DD.jsonl`
- `kdna trace --json / --export / --clear / --since`: trace inspection and export
- `kdna history`: recent domain usage viewer (last 20 by default)
- `kdna history --stats`: aggregate by domain and agent
- `kdna history --domain <name> / --agent <name>`: filtering
- Automatic trace recording on `kdna load`, `kdna postvalidate`, and `kdna compare`

## v0.11.0 (2026-05-22)

- Agent-facing commands: `available`, `match`, `load`, `select`, `postvalidate`
- Load profiles: `--profile=index|compact|scenario|full`
- v2.1 governance fields: `applies_when`, `does_not_apply_when`, `failure_risk`

## v0.10.0 (2026-05-21)

- `kdna setup`: one-command agent skill installation
- `kdna verify`: 3-layer verification (structure + trust + judgment)
- `kdna info`: rich domain metadata display

## v0.9.0 (2026-05-20)

- `kdna install`, `kdna remove`, `kdna update`: registry-based domain management
- `.kdna` ZIP container format
- `kdna pack`, `kdna unpack`
- `kdna publish`, `kdna identity`
- Breaking: removed legacy `project`, `eval`, `export`, `demo`, `preview` commands
