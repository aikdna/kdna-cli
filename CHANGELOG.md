# Changelog

## v0.19.2 (2026-05-29)

**Publish output option compatibility**

- Added `--out` and `-o` aliases for `kdna publish` output directory selection.
- Added `--out` support for `kdna dev pack`.
- Added coverage that `kdna dev pack --out <dir>` emits an inspectable v1.0 `.kdna` container.

## v0.19.1 (2026-05-29)

**Registry yank visibility**

- Hide yanked registry entries from default `kdna list --available` output.
- Hide yanked registry entries from default `kdna search` results.
- Keep install fail-closed behavior for yanked assets with the registry-provided reason.

## v0.18.0 (2026-05-27)

**Asset-first install/runtime + licensed `.kdna` lifecycle**

- `.kdna` is now the canonical installed, verified, and loaded asset.
- Installs store immutable assets under `~/.kdna/packages/` with `index.json` and `receipt.json`; runtime commands no longer persist extracted domain directories.
- Added direct `.kdna` runtime reads through `@aikdna/kdna-core@0.5.0`.
- Added licensed `.kdna` encrypted-entry loading through `kdna-licensed-entry-v1`.
- Added `kdna license activate` and `kdna license sync` for entitlement lifecycle, revocation, and offline grace checks.
- Removed the old user-facing encrypted-extension install path. Licensed assets use the `.kdna` extension and activation metadata under `~/.kdna/licenses/`.

## v0.17.0 (2026-05-26)

**kdna-core 0.4.0 upgrade + manifest conformance**

- Upgraded `@aikdna/kdna-core` dependency from `^0.3.0` → `^0.4.0` (publish kdna-core 0.4.0 first)
- Manifest validation: canonical manifest schema v1.0-rc conformance
- All 43 tests pass, 0 lint errors

## v0.16.0 (2026-05-23)

**Stabilization: tests, trace attribution, documentation**

- Added 25 smoke tests for v0.12+ commands (doctor, trace, history, license, compare report)
- Added trace agent attribution via `KDNA_AGENT` environment variable (replaces hardcoded `agent: 'cli'`)
- Updated README with full v0.12–v0.16 command coverage and environment variables
- Fixed `license verify --json` flag parsing (was treating `--json` as license path)
- Fixed `license bind` to re-sign after machine binding
- Fixed `license verify` and `license bind` argument parsing for flags
- Split integration tests from default test suite: `npm test` runs offline-only, `npm run test:integration` for registry-dependent tests
- Added CHANGELOG.md with release notes from v0.9 through v0.15

## v0.15.0 (2026-05-23)

**Superseded encrypted-extension experiment**

- Earlier experimental encrypted-extension install support has been superseded by v0.18.0 licensed `.kdna` encrypted entries.
- `kdna license install <file>`: register a license for automatic domain decryption
- Fixed `license verify --json` flag parsing
- Fixed `license bind` to re-sign after machine binding
- Fixed `license generate` to output JSON to stdout (info to stderr)
- Added `--save <path>` flag to `license generate`
- Modified `parseSource` during the experiment to recognize the encrypted extension for local install
- Added legacy extract-and-decrypt helper during the prototype; this disk-extraction path was superseded by v0.18.0 in-memory encrypted-entry loading
- Added `findLicenseForDomain` for automatic license discovery

## v0.14.0 (2026-05-23)

**Superseded encrypted-extension prototype + License Management**

- Prototype encrypted container format: AES-256-GCM encryption of KDNA JSON files (kdna.json stays plaintext)
- Prototype dev pack encryption flag for encrypted containers
- Prototype unpack support for encrypted files with a license file
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
- `kdna dev pack`, `kdna dev unpack`
- `kdna publish`, `kdna identity`
- Breaking: removed legacy `project`, `eval`, `export`, `demo`, `preview` commands
