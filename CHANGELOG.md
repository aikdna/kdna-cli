# Changelog

> **Supersession note (2026-06-27)**: Pre-v0.7 entries below use "v1.0-rc" terminology. As of the v0.7 launch (2026-05-22), the @aikdna/* npm scope and registry v2.0 superseded the v1.0-rc label. The historical "v1.0-rc" references in older entries are kept for accuracy; new development uses the 0.7.x+ numbering.

## v0.28.21 (2026-06-28)

Story 8 — context budget reporting (RFC #148 v2.0).

- **`context_budget` field in `bundle-profile-v1` schema**: Bundle manifests may
  now declare `context_budget.max_tokens`, `context_budget.strategy`
  (`warn`|`truncate_lowest_priority`|`error`), and
  `context_budget.per_component_estimate_tokens`.
- **`kdna plan-load <bundle> --json`** now attaches a `context_budget_report`
  object when the Bundle manifest declares `context_budget.max_tokens` and
  the plan has resolved dependencies. The report includes:
  `declared_max_tokens`, `strategy`, `total_estimated_tokens`, `over_budget`,
  `budget_action`, per-component breakdown, and an `estimation_note`.
- **Strategy enforcement**: when `strategy: "error"` and over budget, the plan
  state is set to `invalid` with issue code `KDNA_CONTEXT_BUDGET_EXCEEDED`,
  blocking the load. When `strategy: "warn"`, a warning is emitted to stderr
  and loading proceeds. When under budget, `budget_action: "none"`.
- **New module**: `src/cmds/context-budget.js` — `computeContextBudget()`.
- **8 new tests** in `tests/story8-context-budget.test.js` (5 unit + 2 CLI
  integration). Total suite: 65/65 pass.
- **No breaking changes** to existing `plan-load` output when no
  `context_budget` is declared (backward compatible).


Registration of bundle validation tests in the default test harness.

- **Test suite expansion**: Added `tests/validate-bundle.test.js` to `test:v1` script, ensuring all 57 tests run automatically under `npm test`.

## v0.28.19 (2026-06-28)

Story 6 — dependencies runtime. Integrates two-tier package store resolution and topological loading for multi-domain composition.

- **Dependencies Resolution Callback**: Passed a robust `resolveAssetCallback` from CLI to Core during validation, planning, and authorization loops.
- **Topological Plan surfacing**: Surfaced resolved transitive dependencies list in the planning output of `kdna plan-load`.
- **47 integration/smoke tests**: Fully verified all features, including circular reference detection and semver range mismatch assertions.


## v0.28.18 (2026-06-28)

KDNA v2 Bundle payload type and V1 deprecation start — RFC #148 Story 5.

- **V2 Format Support**: Added support for KDNA v2 containers and manifest specifications (`kdna_version` `"2.0"` and `"bundle"` `asset_type`).
- **V1 Deprecation Window**: Commenced 9-12 month deprecation window for KDNA v1 format, emitting soft deprecation warnings on standard error during validation, loading, inspection, and unpacking.
- **Bundle component resolution**: Updated bundle validator to accept components package/container in both KDNA v1 and v2 formats.


## v0.28.16 (2026-06-28)

`validate <bundle.json> --bundle` stub — RFC #148 Story 3.

- **New command**: `kdna validate <bundle.json> --bundle` validates a
  `kdna.bundle.json` manifest. Checks `bundle_format`,
  `components[]` shape, resolves each component path, and runs the
  existing v1 `validate()` pass on each component.
- **Exit codes**: 0 = all components valid; 1 = invalid component or
  malformed manifest.
- **Output**: JSON following the shape defined in
  `docs/CONFLICT_RESOLUTION.md §Conflict Report Format` (the doc
  shipped in v0 of kdna — PR #149).
- **Conflict analysis stub**: returns `conflicts: { error_count: 0,
  warning_count: 0, info_count: 1 }` with a single INFO entry
  noting that Story 9 will fill in per-card-type conflict analysis.
- **`--verbose` flag**: includes the full per-component `_validation`
  object in the component entries.
- **Help text**: `kdna help validate` now lists the `--bundle` form.
- **10 new tests** in `tests/validate-bundle.test.js` covering valid
  bundles, missing fields, non-existent component paths, invalid JSON
  manifests, and the stub INFO note.
- **No breaking changes** to existing `kdna validate <file.kdna>` or
  `kdna validate <path> --runtime` paths.



Phase 11 audit follow-up. Closes 3 issues filed against the
kdna-cli repo (#66, #67) plus a documentation note for #68 (which
was already fixed in the prior 0.8.3 release on the studio-cli
side).

- **#66** `cli.js` top-level help text for `kdna load` now
  advertises `--as=json|prompt|raw` (the parser accepted `raw`
  all along; the help string was inconsistent with the
  `_common.js` reference). Same fix applied to the `error()`
  message at the load command itself.
- **#67** `publish.js#manifestForSigning` option renamed from
  `includeContentDigest` (inverse semantics) to `stripDigestFields`
  (matches kdna-core's `manifestForSignature`). The old name is
  accepted as a deprecated alias for callers that depended on
  the inverse behaviour.

## v0.28.11 (2026-06-28)

Phase 10 audit follow-up. Closes 5 issues filed against the
kdna-studio-cli repo (#61, #62, #63, #64, #65) plus the cross-repo
#52 (P0 — hardcoded `password: undefined` in `agent.js` cmdLoad
that made kdna-loader unable to decrypt any password-protected
asset).

- **#52 `cmdLoad` now resolves the password for `loadAuthorized`.**
  Sources (in priority order): `--password <value>`, the
  `KDNA_PASSWORD` env var, and `--password-stdin` (with the same
  TTY-hang guard as the rest of the CLI). The previous
  `password: undefined` hard-code meant every password-protected
  asset the agent tried to load was rejected downstream with a
  confusing "decrypt failed" error. **P0 security/UX.**
- **#61 `cli.js` top-level help text references `payload.kdnab`,
  not `KDNA_Core.json`.** Matches the matching studio-cli fix
  (#44) and RFC-0009.
- **#62 `cli.js` help for `protect recover` now advertises
  `--code-stdin` only** (the parser only ever accepted
  `--code-stdin`; the help text claimed `--code <rc>` worked too).
- **#63 `cluster.js` stdin read now TTY-guards up front.** Prior
  version read from fd 0 in both piped and interactive modes; the
  piped path had a `!isTTY` check but the interactive prompt
  path silently hung if stdin was already closed. The fix rejects
  with a clear error before any read.
- **#64 `agent.js:854` (`agent evaluate` stdin read) now
  TTY-guards.** Same pattern as #63.
- **#65 `cmdRecover` now uses Core's canonical `pack` and
  emits `checksums.json`.** Prior version used a custom `buildZip`
  helper and wrote no checksums file, so every recovered asset
  failed `kdna validate` immediately after recovery.

## v0.28.10 (2026-06-28)

This release closes 4 issues filed against the v0.28.x line on
2026-06-28 (the capsule-verify security advisory plus three
audit follow-ups). Bumps `@aikdna/kdna-core` from `^0.15.0` to
`^0.15.4`; that release ships the `manifestForSignature` alignment
that the `publish.js` signing path depends on.

### Security
- **capsule-verify.js no longer trusts `capsule.signature.verified`.**
  The prior implementation read the boolean self-claim from the
  capsule itself, which an attacker could trivially forge by writing
  `{"signature": {"verified": true}}`. The fix replaces the trust-
  on-first-use check with a mandatory call to
  `@aikdna/kdna-core#verifySignatureSync(assetPath)`, plus an
  optional allow-list of trusted pubkey fingerprints the caller can
  pass via `{trustedPubkeys: [...]}`. Capsules without a verifiable
  asset path are now rejected with an explicit error. **This is the
  private advisory previously held for the security@aikdna.com
  disclosure.**

### Fixed
- **`protect.js` help text + `recover` fallback** — help strings
  and the recover fallback now reference `payload.kdnab` (the
  canonical encryption target) instead of the obsolete
  `KDNA_Core.json`. Matches the corresponding studio-cli fix and
  RFC-0009.
- **`protect.js` TTY-hang guards** — `--password-stdin` (in both
  `protect` and `unlock`) and `--code-stdin` (in `recover`) now
  refuse up front when stdin is a TTY instead of waiting forever
  for input the user never sends. Matches the studio-cli fix.
- **`publish.js#manifestForSigning` aligns with kdna-core** — now
  strips `authoring.content_digest` recursively. Without this,
  a publish that ran through the kdna-core verifier would report a
  signature mismatch on manifests that contained an authoring
  block.
- **`publish.js#listPublishEntries` matches the canonical
  exclusion set** — now skips `build-receipt.json` and the
  `reports/` directory (previously included in the signed payload
  even though `kdna-core#buildContentDigest` excludes them, which
  caused a verifier-mismatch on every published asset that had
  reports). Mirrors `docs/CANONICALIZATION.md`.
- **`cli.js#cmdLoad` `--password-stdin` TTY guard** — refuses on
  TTY instead of hanging.

## v0.28.9 (2026-06-27)

### Fixed
- **Fresh-environ audit follow-ups** — small consumer-side fixes for issues surfaced by a clean-`npm install -g` audit on 2026-06-27:
  - **fixtures in tarball**: `package.json` `files` array now includes `fixtures/`. The `kdna demo minimal` and `kdna demo judgment` commands now work for fresh `npm install -g @aikdna/kdna-cli` users (the README "5 minutes" path).
  - **`kdna protect unlock --out <file>`**: previously the flag was silently ignored; the unlocked payload was printed to stdout. The command now writes a decrypted, re-packed `.kdna` to the given path. Without `--out` it still prints to stdout (backward compatible).
  - **`kdna load --password-stdin`**: previously `load` only accepted `--password=<value>`, forcing users to either type the password inline (shell history) or pipe nothing. The command now matches `protect` and `plan-load` and accepts `--password-stdin` to read from stdin.

## v0.28.8 (2026-06-27)

### Fixed
- **BUG-1 (A1): `kdna plan-load --password <value>` now threads the password to `kdna-core.planLoad`.** Previously, `planLoad` only honored the `--has-password` diagnostic flag, so a `kdna load --password <pw>` invocation could not satisfy the plan-load gate and was rejected with `state: needs_password`. `plan-load` now accepts `--password <value>` directly; the resulting plan reports `input_fingerprint.has_password_input: true`, `state: ready`, `can_load_now: true`. This makes the `load --password` round-trip fully end-to-end on the runtime side. The encryption envelope itself was already in place (kdna-studio 0.8.0 → B2 scrypt); this fix closes the consumer-side loop.

### Fixed
- **BUG-2/3 (B1): `kdna protect` migrates to `kdna-password-protected-v1-scrypt` and produces valid checksums.** The previous implementation used the legacy `kdna-password-protected-v1` (Argon2id) profile, encrypted `KDNA_Core.json` only (leaving the judgment payload readable), and rebuilt the asset without regenerating `checksums.json`. Result: `kdna validate` reported `manifest_digest mismatch` / `asset_digest mismatch`, and `kdna protect unlock` crashed with `JavaScript does not support arrays, maps, or strings with length over 4294967295` because `reader.loadProfileSync` (the old path) assumed the payload was CBOR-encoded while kdna-studio produces JSON. New behavior: `kdna protect` encrypts `payload.kdnab` under the scrypt profile (matching kdna-studio), calls `buildChecksumsV1` before `pack` to write a fresh `checksums.json`, and `kdna protect unlock` routes through `core.loadAuthorized` (the same path `kdna load` uses) to avoid the cbor-x 32-bit length path. Legacy Argon2id assets are still loadable but emit a deprecation warning. `kdna recover` also re-encrypts under the scrypt profile.

### Fixed
- **BUG-4/5/6 (D1/D2): CLI routing consistency.** `kdna version` is now a first-class command (previously returned `Unknown command: version`); `kdna help <subcmd> [...]` re-routes to `<subcmd> --help` so each subcommand prints its own Usage; `kdna protect` and `kdna protect unlock` accept `--help` / `-h`. Help text in `src/cli.js` and Usage in `src/cmds/protect.js` are aligned on the canonical flag set: `--out`, `--password <pw> | --password-stdin`, `--entries <list>`, `--profile <name>`.

### Fixed
- **D4: `@aikdna/kdna-core` dep floor raised to `^0.15.0`.** `kdna doctor` was reading the resolved version from `node_modules/@aikdna/kdna-core/package.json`, which had been pinned at 0.14.0; doctor is correct, the dep floor was stale. Bumping the floor and re-running `npm install` makes doctor report `v0.15.0` (the actual published version).

### Changed
- **C3 (SPEC alignment): `signature.kdsig` marked OPTIONAL until 2027-Q1.** SPEC.md §3.2, `specs/container.md` §3.1, and `specs/RFC-0013` previously listed `signature.kdsig` as REQUIRED for distribution assets, but the README and implementation flagged it as "not yet implemented". The normative deadline for REQUIRED is **2027-Q1** (end of March 2027). All currently distributed `.kdna` assets remain conformant without `signature.kdsig`; assets distributed on or after 2027-Q1 MUST include it. See `OPEN/kdna/SPEC.md` §3.2 and `OPEN/kdna/specs/container.md` §3.1.

## v0.28.7 (2026-06-26)

### Added
- **B7: SecretStore abstraction (src/secret-store.js).** Cross-platform secret storage with three backends: 'keychain' (macOS, via `security` CLI), 'file' (default on Linux/Windows, `~/.kdna/secrets/<name>` with 0600 mode), and 'env' (read-only, for CI). Selected via `KDNA_SECRET_STORE_BACKEND` env var. Interface: `get / set / delete / list` (Promise-based). 6 unit tests cover file-backend round-trip, env-backend read-only, backend selection, and Windows-safe name encoding.

## v0.28.6 (2026-06-26)

### Added
- **test(smoke): CLI smoke test covering all 32 case-routed commands.** `tests/cli-smoke.test.js` spawns each top-level command and asserts (a) the CLI does not respond with "Unknown command", (b) the CLI does not crash with a hard signal or stack trace, (c) `--help` exits 0 and shows the Core v1 section. This catches the class of bugs where a new `case` is added/removed from `src/cli.js` and a command silently becomes unreachable. The 32-command list is hard-coded; if you add a new `case 'foo': { ... }` block, add `'foo'` to the array.

## v0.28.5 (2026-06-26)

### Fixed
- **Security: redact internal repo names from v0.28.1 CHANGELOG entry.** The v0.28.1 entry explicitly listed 7 private repo names in plain text. This entry has been reworded to refer to "the configured forbidden-pattern set" without naming the specific repos. Users who already installed v0.28.1 / v0.28.2 / v0.28.3 / v0.28.4 are still affected (the published tarball is immutable); upgrade to v0.28.5 to read the redacted CHANGELOG.

## v0.28.4 (2026-06-26)

### Fixed
- **C4 (complete): All 12 previously unconnected cmds now reachable from the CLI.** `kdna badge`, `kdna domain`, `kdna governance`, `kdna legacy`, `kdna quality`, `kdna registry`, `kdna setup`, `kdna studio` are now connected via the dispatcher in `src/cli.js`. Each module had full implementation but no `case` entry. `showHelp()` updated to list all 19 case-routed commands across 4 sections.

## v0.28.3 (2026-06-26)

### Fixed
- **C4 (partial): Connect 4 of 12 unconnected cmds to dispatcher.** `kdna changelog`, `kdna explain`, `kdna protocol`, and `kdna test` are now reachable from the CLI. Each was fully implemented in `src/cmds/<name>.js` but unreachable because `src/cli.js` had no `case` entry. 8 cmds (badge/domain/governance/legacy/quality/registry/setup/studio) remain as B14 long-term roadmap.

## v0.28.2 (2026-06-26)

### Fixed
- **C5: Wire `kdna publish` case to dispatcher.** The 767-line `src/publish.js` module was unreachable from the CLI. The `kdna publish --check <path>` quality gate and the `kdna publish <path>` registry upload are now reachable.
- **C1: Registry default URL no longer points to private 404 repo.** `CANONICAL_REGISTRY_URL` is now empty by default. Production users with a real registry must set `KDNA_REGISTRY_URL` explicitly. Verification fails fast with a clear error message.
- **C6: Remove 11 unused `eslint-disable no-fallthrough` directives.** After C5 was wired, several case blocks gained explicit `break` statements; the eslint-disable comments above them became redundant. ESLint `--fix` removed them automatically.

## v0.28.1 (2026-06-26)

### Fixed (PR #48)
- **Fix (P0): protect.js writer/reader alignment.** `kdna protect` now writes canonical
  `access: "licensed"` (per ADR-001) and the comparator paths in `cmdProtect` / `cmdUnlock`
  / `cmdRecover` check against `"licensed"` instead of the legacy alias `"protected"`.
  Previously, a manifest with canonical `access: "licensed"` would fail `kdna protect`
  with a misleading "expected 'protected'" error.
- **Fix (P0): domain.js canonical access vocabulary.** Replaced 4 `access: ... || 'open'`
  fallbacks (lines 643, 675, 771, 832) with `'public'`, aligning with the canonical
  `public | licensed | remote` vocabulary per ADR-001.
- **Fix: protect.js recover path mimetype.** The `recover` path now writes v1
  mimetype `application/vnd.kdna.asset` (was: v2 `application/vnd.aikdna.kdna+zip`),
  matching the canonical container format.

### Fixed (PR #49)
- **Fix: public-surface guardrail config real SHA-256 hashes.** Replaced 5 placeholder
  hashes in `scripts/public-surface.config.json` with 7 real SHA-256 hashes (for
  the configured forbidden-pattern set — see the config file for exact hash values).
  Previously, the guardrail silently passed for any input because no forbidden pattern
  hash matched.

### Fixed (PR #51)
- **Docs: rewrite the legacy registry references as out-of-scope historical context.**
  `src/registry.js` and `src/install.js` SCHEMA.md references marked as historical;
  added comment that the registry URL is configurable via `KDNA_REGISTRY_URL`.

### Maintenance
- **Removed duplicate v0.28.0 entry** at top of changelog.

## v0.28.0 (2026-06-23)
- Feat: kdna lint — Anti-Monolithic Domain check (RFC-0013 §4), supports --strict and --json.
- Feat: kdna workpack — Work Pack operations (init, validate, inspect, explain, plan, run, report).

## v0.27.6 (2026-06-22)
- Fix (P0): kdna load now forwards --has-password and --entitlement-status to planLoad

## v0.27.5 (2026-06-22)
- Fix: descriptive file errors for validate/inspect/load/unpack (missing file, non-v1 container)
- Fix: kdna pack requires --force to overwrite existing output file

## v0.27.4 (2026-06-21)

### Fixed
- Template documentation now references the packaged `.kdna` path instead of raw source directories.
- README first-run narrative tightened so new users land directly on the `kdna demo` → `kdna inspect` → `kdna load` path.
- Test fixture `checksums.json` updated for deterministic pack output.

### Changed
- CLI first-run surface cleaned: help text, demo output, and error messages use consistent v1 terminology.
- ajv + ajv-formats auto-installed via kdna-core dependency; improved ajv-missing error message.

---

## v0.27.3 (2026-06-21)

### Added
- `kdna demo judgment` now creates a real content-review judgment demo with full KDNA payload.

### Fixed
- `kdna load` LoadPlan enforcement: the `loadAuthorized` shim now correctly delegates to `planLoad` before calling `loadV1`, preventing load of assets that fail checksum or schema validation.
- Domain command and install wording updated to remove residual "trusted"/"registry-trusted" language in output strings.

### Changed
- Setup module and verify module wording aligned with the content-neutral v1 contract — no more "trusted" or "recommended" in CLI output.
- Legacy v0.7 and v0.12 test assertions updated to match current wording.

---

## v0.27.2 (2026-06-21)

### Added
- `kdna validate --entitlement-status <status>` flag: accepts `active`, `expired`, `revoked`, or `offline_grace` and passes it through to the LoadPlan, enabling runtime authorization diagnostics before load.

### Fixed
- `kdna validate --runtime` now correctly delegates to `core.planLoad` and reports `can_load_now` as the exit signal (exit code 0 = ready, 1 = invalid, 3 = not authorized).
- `kdna plan-load` exit codes now match the LoadPlan contract: 0 for `can_load_now`, 1 for invalid state, 3 for blocked/needs-auth.

### Changed
- `kdna load` rejects v2 containers immediately with a clear "Re-export with kdna-studio-cli@0.6.0" message, rather than falling through to an opaque error.
- Scenario profile no longer silently falls back to compact/index when scenario content is unavailable; now reports explicit error.
- `--has-password` flag is accepted by `validate --runtime` and `plan-load` as a diagnostic credential-presence signal (does not verify the password itself).

---

## v0.27.0 (2026-06-20)

### Breaking
- **Hard cutover to Core v1.** The CLI now speaks only the v1 `.kdna` container format. All legacy v2 ZIP containers, registry commands (`install`, `remove`, `update`, `publish`, `identity`), and v0.x compatibility paths are removed from the default help surface. Legacy commands remain accessible but surface a deprecation warning redirecting to `kdna-studio-cli` for authoring and the v1 path for runtime.
- `kdna load` now enforces LoadPlan authorization. Assets that fail structural validation, checksums verification, or access control checks are blocked at load time with an explicit error code.
- `kdna validate` output schema changed: the JSON report now includes `overall_valid`, per-gate booleans (`format_valid`, `schema_valid`, `payload_valid`, `checksums_valid`, `load_contract_valid`), and a `problems` array.

### Added
- **`kdna plan-load <file.kdna>`** — returns a structured LoadPlan before runtime load. Reports asset metadata, access model, entitlement requirements, validation gate results, and a `can_load_now` / `required_action` decision. Designed for product consumers (Chat, IDEs, agents) to render authorization UI from.
- **Load profile support:** `kdna load --profile=index|compact|scenario|full` and `--as=json|prompt`. The `prompt` output mode renders a flat text prompt suitable for pasting into an agent context window.
- **Entitlement status passthrough:** `kdna load` and `kdna plan-load` accept `--entitlement-status active|expired|revoked|offline_grace` to simulate or assert the entitlement state without mutating the local license store.
- **`kdna demo minimal`** — creates a minimal v1 fixture directory with valid `mimetype`, `kdna.json`, and `payload.kdnab` for first-run testing. Accepts `--force` to overwrite.
- **Checksums verification in validate:** when `checksums.json` is present, `kdna validate` computes actual SHA-256 digests for `kdna.json` and `payload.kdnab` and compares them against the declared values. Mismatch causes `checksums_valid: false`.
- **Container security hardening:** ZIP entry names are normalized (NFC Unicode, no backslash separators, no path traversal), duplicate entries are rejected, and per-entry size / compression-ratio limits are enforced.
- **Exit code 4** reserved for encrypted-payload errors (`requires_decryption`).

### Changed
- Help text restructured into a single flat listing of Core v1 commands: `inspect`, `validate`, `plan-load`, `load`, `pack`, `unpack`, `demo`.
- `kdna pack` and `kdna unpack` described as "creator/debug views" rather than a second public asset model.
- Pack output is deterministic: fixed DOS epoch timestamps, alphabetical entry order, mimetype always first (STORED, method 0). Same source → identical SHA-256 output.
- `kdna inspect` output is always JSON and includes `kdna_version`, `asset_id`, `asset_uid`, `payload_encrypted`, `profile`, and `load_contract_default_profile` fields.

### Removed
- Legacy v2 container loading path. v2 containers (`application/vnd.aikdna.kdna+zip`) are rejected with a clear message directing users to re-export with `kdna-studio-cli@0.6.0`.
- Registry-centric help surface (`available`, `match`, `select`, `install`, `remove`, `update`, `publish`, `identity`, `setup` hidden behind `kdna help --legacy`).
- `kdna postvalidate` command superseded by `kdna validate --runtime`.
- Hardcoded "trusted" / "recommended" / "high_quality" / "officially_approved" language banned from all CLI output paths.

### Fixed
- Container format detection is strict: must have mimetype as the first ZIP entry, STORED (method 0), with the exact v1 media type string. No fallthrough to v2 or generic ZIP parsing.
- `kdna validate` no longer silently passes invalid containers that happen to have a `kdna.json` file — format gate checks all three required entries explicitly.

---

## v0.26.9 (2026-06-21)

### Fixed
- Depend on `@aikdna/kdna-core@^0.12.2` so compact prompt loading preserves axiom `applies_when`, `does_not_apply_when`, and `failure_risk` fields from Studio-exported `.kdna` files.

## v0.26.8 (2026-06-20)

### Changed
- Reworded dev-pack and install output so local `.kdna` validity is not described as "trusted" or "registry-trusted".
- Signature/provenance checks described as verification evidence rather than content endorsement.

## v0.26.6 (2026-06-20)

### Changed
- Center Core v1 help on local `.kdna` files.
- Describe pack/unpack as creator/debug views instead of a second public asset model.

## v0.26.5 (2026-06-20)

### Changed
- Move current help text to the local `.kdna` inspect/validate/plan-load/load path.
- Reword `kdna init`, legacy publish checks, and removed Studio CLI guidance so they no longer present Human Lock, registry publishing, or "trusted" status as Core v1 format requirements.
- Keep registry, install, publish, identity, and protected flows behind legacy / compatibility language.

## v0.26.4 (2026-06-20)

### Changed
- Clarify npm/package description around the current local `.kdna` runtime path.
- Replace dev-pack "non-trusted" help wording with "diagnostic" wording.
- Reword legacy publish provenance messages to avoid treating trust as a format layer.

## v0.19.2 (2026-05-29)

### Added
- `--out` and `-o` aliases for `kdna publish` output directory selection.
- `--out` support for `kdna dev pack`.
- Coverage that `kdna dev pack --out <dir>` emits an inspectable v1.0 `.kdna` container.

## v0.19.1 (2026-05-29)

### Changed
- Hide yanked registry entries from default `kdna list --available` output.
- Hide yanked registry entries from default `kdna search` results.
- Keep install fail-closed behavior for yanked assets with the registry-provided reason.

## v0.18.0 (2026-05-27)

### Added
- `.kdna` is now the canonical installed, verified, and loaded asset.
- Installs store immutable assets under `~/.kdna/packages/` with `index.json` and `receipt.json`.
- Direct `.kdna` runtime reads through `@aikdna/kdna-core@0.5.0`.
- Licensed `.kdna` encrypted-entry loading through `kdna-licensed-entry-v1`.
- `kdna license activate` and `kdna license sync` for entitlement lifecycle, revocation, and offline grace checks.

### Removed
- Old user-facing encrypted-extension install path. Licensed assets use the `.kdna` extension and activation metadata under `~/.kdna/licenses/`.

## v0.17.0 (2026-05-26)

### Changed
- Upgraded `@aikdna/kdna-core` dependency from `^0.3.0` → `^0.4.0`.
- Manifest validation: canonical manifest schema v1.0-rc conformance.

## v0.16.0 (2026-05-23)

### Added
- 25 smoke tests for v0.12+ commands (doctor, trace, history, license, compare report).
- Trace agent attribution via `KDNA_AGENT` environment variable.
- README with full v0.12–v0.16 command coverage and environment variables.

### Fixed
- `license verify --json` flag parsing (was treating `--json` as license path).
- `license bind` re-sign after machine binding.
- `license verify` and `license bind` argument parsing for flags.
- Split integration tests from default test suite: `npm test` runs offline-only, `npm run test:integration` for registry-dependent tests.

## v0.15.0 (2026-05-23)

### Added
- `kdna license install <file>`: register a license for automatic domain decryption.
- `--save <path>` flag to `license generate`.
- `findLicenseForDomain` for automatic license discovery.

### Fixed
- `license verify --json` flag parsing.
- `license bind` to re-sign after machine binding.
- `license generate` to output JSON to stdout (info to stderr).

## v0.14.0 (2026-05-23)

### Added
- Prototype encrypted container format: AES-256-GCM encryption of KDNA JSON files.
- `kdna license generate <domain> --to <email>`: generate Ed25519-signed licenses.
- `kdna license verify <license.json>`: verify signature, expiry, machine binding.
- `kdna license bind <license.json>`: bind license to machine fingerprint + re-sign.
- `kdna license show <license.json>`: display license details.
- PBKDF2 key derivation: license_id + machine fingerprint (600k iterations) → AES-256.
- Machine fingerprint: sha256(hostname + uid + platform + arch + hardware UUID).

## v0.13.0 (2026-05-23)

### Added
- `kdna compare --report-md`: Markdown report with Judgment Diff table and D1-D7 scoring.
- `kdna compare --report-json`: JSON report with parsed axes, scores, and metadata.
- `--output <file>` flag for saving reports.
- Trace recording integrated for compare runs.

## v0.12.0 (2026-05-23)

### Added
- `kdna doctor --agents`: detect agent installations and verify kdna-loader skill status per agent.
- `kdna doctor --domains`: domain-only health check.
- `kdna doctor --json`: machine-readable health report.
- `kdna trace`: JSON Lines logging to `~/.kdna/traces/YYYY-MM-DD.jsonl`.
- `kdna trace --json / --export / --clear / --since`: trace inspection and export.
- `kdna history`: recent domain usage viewer (last 20 by default).
- `kdna history --stats`: aggregate by domain and agent.
- `kdna history --domain <name> / --agent <name>`: filtering.
- Automatic trace recording on `kdna load`, `kdna postvalidate`, and `kdna compare`.

## v0.11.0 (2026-05-22)

### Added
- Agent-facing commands: `available`, `match`, `load`, `select`, `postvalidate`.
- Load profiles: `--profile=index|compact|scenario|full`.
- v2.1 governance fields: `applies_when`, `does_not_apply_when`, `failure_risk`.

## v0.10.0 (2026-05-21)

### Added
- `kdna setup`: one-command agent skill installation.
- `kdna verify`: 3-layer verification (structure + trust + judgment).
- `kdna info`: rich domain metadata display.

## v0.9.0 (2026-05-20)

### Added
- `kdna install`, `kdna remove`, `kdna update`: registry-based domain management.
- `.kdna` ZIP container format.
- `kdna dev pack`, `kdna dev unpack`.
- `kdna publish`, `kdna identity`.

### Breaking
- Removed legacy `project`, `eval`, `export`, `demo`, `preview` commands.
