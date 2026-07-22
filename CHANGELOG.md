# Changelog

## Unreleased

- Apply one fail-closed transport policy to every packaged CLI path that sends
  task, context, license, activation credential, account/device authorization,
  provider token, or judgment material. Remote projection, legacy Activation,
  account/device APIs, and the withdrawn compare source's provider client now
  require an external `https:` origin; plain HTTP is accepted
  only for the exact numeric loopback hosts `127.0.0.1` and `[::1]` (never
  `localhost`, a LAN address, or another hostname). Each client admits only
  its exact contractual origin/path shape and rejects URL credentials,
  unapproved paths, query strings, fragments, parser normalization, and
  non-visible-ASCII input before creating a request. Device verification
  links use the same scheme/host rule while retaining their provider-issued
  path and query contract.

  Projection fetches now refuse every redirect, bound successful JSON bodies,
  and fail closed on malformed responses. Activation/account clients already
  did not follow redirects and now reject every non-2xx response explicitly.
  User-facing failures expose at most a validated stable upstream code and
  HTTP status: full URLs, redirect locations, server messages/bodies, tokens,
  request material, raw network exceptions, and failed-sync local paths are
  removed from the error boundary. Hostile tests prove the redirect target is
  never reached and sensitive response or request material never appears. The
  compare command remains outside the Preview; hardening its packaged source
  does not restore or advertise that command.

- Harden every CLI-owned curl fetch against redirect downgrade, credentialed
  URLs, and error-path information leaks. All download paths — `kdna install`
  asset downloads, the safe-archive fetch used by `diff` / `changelog`, the
  canonical registry fetch, custom scope registry fetches, and the registry
  signature sidecar fetch — now invoke curl with
  `--proto =https --proto-redir =https` so `curl -L` can no longer follow an
  HTTPS→HTTP or HTTPS→FTP redirect. URLs with embedded username/password
  credentials are refused before curl runs, keeping credentials out of
  process argv; registry and signature endpoints go through the same
  `https:`-only guard as asset downloads (previously only the install/archive
  paths were checked). Timeout, retry, digest, and signature verification
  behavior is unchanged.

  Download URLs carrying a query string or fragment are now also refused
  before curl runs: query/fragment components are where leaked tokens live,
  and CLI-managed downloads never need them. Correction of the earlier
  hardening round's error contract: user-facing download errors previously
  echoed the raw curl stderr/message and a merely credential-stripped URL
  (still exposing the full path and query — an audit reproduced a leaked
  `?token=` secret twice in one error). Errors on every download path now
  carry only the asset coordinates or operation name, a stable error
  category (`DOWNLOAD_URL_REFUSED`, `DOWNLOAD_PROTOCOL_BLOCKED`,
  `DOWNLOAD_HTTP_ERROR`, `DOWNLOAD_TIMEOUT`, `DOWNLOAD_FAILED`, …) derived
  from the curl exit code rather than parsed natural-language stderr, and
  optionally the exit code itself. Full URLs, URL path/query/fragment,
  local destination paths, curl stdout/stderr, server response bodies, and
  Node's raw `execFileSync` message (which embeds argv) no longer reach
  users; `redactUrlForError` is removed. Failed downloads now also remove
  the partial temporary file. Hostile tests drive recording curl shims that
  prove refused URLs never reach curl argv, that maximally hostile curl
  stderr (full URL + token + local path + forged server response) never
  reaches CLI output, and that HTTPS→HTTPS redirects still succeed while
  HTTPS→HTTP/HTTPS→FTP stay blocked on all five fetch paths.

- Make `kdna available` (and `kdna match`) discovery-only: the commands now
  enumerate installed candidates and emit manifest metadata plus LoadPlan
  diagnostics (`load_state`, `issues`) without calling `loadAuthorized` or
  projecting any judgment payload. Axiom-level applicability
  (`applies_when` / `does_not_apply_when` / `failure_risks`) is payload
  content and is only available after an explicit `kdna load`; each
  discovery entry carries `loaded: false` and the human output states that
  no content was loaded.
- Stop `kdna install` from moving an existing `active_version`. Installing
  an additional or already-present version now keeps the currently active
  version and prints how to switch explicitly; the active version is only
  set when a package has none yet.
- Restrict every curl download path (`kdna install` registry downloads and
  the safe-archive fetch used by `diff` / `changelog`) to `https:` URLs.
  `file:`, `ftp:`, `javascript:`, plain `http:`, and malformed URLs are
  refused with an explicit error before any fetch; digest verification of
  the downloaded bytes is unchanged.
- Write macOS Keychain secrets through a compile-once Swift helper that
  receives values over stdin instead of the `security -w` argv path, removing
  the brief process-list exposure; route reads and deletes through the same
  helper so keychain ACL prompts cannot block headless runs; when the helper
  cannot be built or does not answer within its timeout the operation is
  refused with a diagnostic instead of falling back to argv. Mock-based tests
  cover the no-argv guarantee, deterministic refusal, and hang timeouts on
  every platform.

## 0.36.0 (2026-07-20)

- Remove Preview asset-signature, detached-signature, and local identity-backup
  command routes instead of carrying three incompatible cryptographic
  contracts or unauthenticated AES-CBC recovery data.
- Accept password and passphrase secrets only through stdin-backed inputs;
  secret values in argv or environment variables fail closed.
- Make `doctor --domains` inspect, verify, and plan every indexed asset through
  Core, and return an unhealthy exit status when an installed asset is invalid
  or cannot be read.
- Withdraw the legacy behavior-comparison command surface from Preview. The
  Runtime path remains `inspect → validate → plan-load → load`; external
  outcome studies are not project release gates.
- Bind the unpublished CLI candidate to KDNA Core source ref `3676ab0`, while
  keeping release readiness blocked until that dependency has a canonical
  registry artifact.
- Print the CLI's natural semantic version without a generation-style prefix.
- Describe current CLI paths as pre-release rather than assigning Beta
  maturity.

This is an unpublished Development Preview candidate. No existing registry
version or package bytes are changed.

## 0.35.1 (2026-07-19)

- Bind every Eval-backed command to the exact official `@aikdna/kdna-eval`
  package identity, version, and command-level root API. Remove environment,
  adjacent-source, and package-subpath fallbacks so a damaged dependency fails
  closed with one stable, non-leaking error instead of silently executing a
  different implementation. Release and smoke gates now verify the exact Eval
  registry artifact and all six command contracts.
- Keep Cluster promotion fail-closed when `--gates` narrows the displayed
  report. Every gate and all underlying evidence remain part of the verdict,
  and unknown gate names are rejected instead of producing an empty passing
  selection.
- Keep CLI observation matrices claim-free because they cannot independently
  prove or bind JudgmentTrace provenance. EvidenceClaim generation remains in
  the official Eval API for callers that have validated the actual trace.
- Reject externally supplied Cluster trace JSON as promotion evidence because
  the CLI cannot independently prove its asset, authorization, result, or cost
  claims. Trust and economics promotion must run through the Eval API inside
  the trusted evidence producer.

## 0.35.0 (2026-07-18)

- Add `--password-stdin` to encrypted demo generation and make stdin the
  documented and tested password path for demo, protect, unlock, and load.
  Legacy `--password <value>` input remains compatible but now emits an
  explicit process-argument and shell-history warning. A public-surface gate
  rejects executable examples that place passwords in argv.

## 0.34.0 (2026-07-16)

- Cut the CLI over to the stable KDNA Runtime contract through the formal Core
  ConsumptionPlan, Runtime Capsule, process Agent Host, and JudgmentTrace APIs.
  Runtime selectors and fallback generations are no longer accepted.
- Depend on the published `@aikdna/kdna-core@0.20.0` registry artifact with
  SLSA provenance; the lock, candidate binding, and evidence bind its exact
  registry integrity and SHA-256. The agent router emits
  `BLOCK_POLICY_FAILED` with caller-owned policy evidence, and install
  `--trusted` requires signature and authoring provenance without reading
  retired Core quality or risk fields.
- Retire the source-tree loader, mock Runner, old verifier, duplicate
  `quality load` route, and assumed Host capabilities. A process Host now needs
  an exact, process-bound capability registration before projection.
- Emit current manifests, payload profiles, digest evidence, watermarks, and
  `kdna.bundle` `0.1.0` authoring records from every shipped producer. Unknown
  manifest fields and obsolete protocol declarations fail closed.
- Make `demo --password`, `protect`, and password recovery bind the encrypted
  payload declaration to Core's current encryption profile coordinate and the
  sole supported `payload.kdnab` entry. Declared encryption and stored payload
  state can no longer drift into a package that Core must reject.
- Use pure SemVer release tags such as `0.34.0` without a `v` prefix. Release
  evidence now requires two byte-identical npm packs and an allowlisted shipped
  surface containing the current Runtime, schemas, validators, fixtures, and
  loader skill while excluding retired, test, private, and build-only files.

## 0.33.0 (2026-07-15)

- Make npm publication exclusive to a canonical, stable GitHub Release tag and
  bind the event tag, Git ref, tag commit, workflow commit, package version,
  clean worktree, exact changelog heading, and audited npm client version before
  publication can proceed. Same-tag publication runs serialize without
  cancellation, and the release workflow pins its GitHub Actions to verified
  commit identifiers.
- Generate clean `npm pack` evidence with independently recomputed integrity,
  shasum, file list, count, and sizes. Registry outages and ambiguous lookup
  failures now block; an existing version is skipped only when its package
  identity and artifact hashes exactly match the candidate. Source commit
  identity remains independently bound to the release tag and workflow commit.
- Make development packing and demo assets emit the then-current Runtime
  entry-set digest profile with its ordered covered entries and
  `entry_set_digest`. The historical `asset_digest` remains only as a deprecated
  alias, and checksum records are constrained to canonical SHA-256 values.
- Verify Capsule entry-set digests from Core layout bytes and route domain
  unpacking through the validated container boundary and formal payload
  projection. Corrupt or incomplete protected runtime entries now fail closed
  instead of relying on best-effort shell extraction.
- Normalize the transaction-owned staged copy to a writable mode (`0600` on
  POSIX) and apply a portable durability barrier. Read-only source assets remain
  unchanged and install correctly on Windows as well as POSIX systems.

- Add a strict `--runtime-contract=1` single-asset opt-in for ConsumptionPlan 1,
  Capsule 2, Agent Host 2, and JudgmentTrace 1 through the exact registry
  release `@aikdna/kdna-core@0.18.0`. The default Plan 0.9 / Capsule 1 / Host 1 /
  Trace 0.9 behavior is unchanged.
- Require an independent, process-bound Host capability registration before
  strict execution. Registration input is a bounded regular-file snapshot,
  parsed through Core's raw JSON boundary and correlated to the exact command
  and ordered arguments. Missing or incompatible capabilities block before
  projection without a downgrade.
- Snapshot one regular packaged asset for A/C/E, Plan, Capsule, P, request, and
  Trace evidence. Host 2 output is bounded and parsed by Core, receipts remain
  Host-native, pre-Host budget failures call no Host, and unknown model/usage
  facts remain `null` / `not_observed`.
- Fail closed on repeated or space-form runtime-contract options and malformed
  strict timeouts. Capsule load and Host-adapter construction failures now end
  in Core-built blocked Trace 1 evidence, and the strict cross-platform CI gate
  covers Node 18 and 22 on Ubuntu and Windows.

- Bind registry-backed `quality diff` and `changelog` inputs to the exact
  registry digest, manifest identity, and version before reading judgment
  content. Single-argument diff now compares the integrity-checked installed
  asset directly with the current registry release.
- Read formal `payload.kdnab` judgment fields as well as historical authoring
  JSON. Structured quality-diff and changelog output now include ontology and
  banned-term additions, removals, and modifications, and share one version
  rule: removals require a major bump while additions or modifications require
  a minor bump.
- Canonicalize bare registry references before binding registry and archive
  identity, so `name@version` and `@aikdna/name@version` compare as the same
  asset while mismatched registry or manifest identities still fail closed.
- Harden network-fetched diff/changelog archive extraction. The command safety
  policy limits each uncompressed entry to 5 MiB and the total uncompressed
  archive content to 12 MiB; these are command download limits, not KDNA format
  limits.

## 0.32.1 (2026-07-14)

- Add exact `@scope/name@version` resolution across installed-name inspect,
  planning, loading, execution, verification, tests, explanations, and removal.
  Unversioned references continue to resolve the active version.
- Evolve the local package index to v3 with immutable `versions` and one
  `active_version`, while preserving active-entry fields for compatibility and
  migrating v2 indexes on the next write.
- List every installed version and mark the active one. Removing the active
  version deterministically selects the highest remaining installed version;
  removing an explicit version leaves other versions intact.
- Fail closed when a local asset does not pass Core validation. Development
  workflows must opt in with `--allow-unverified`, whose JSON receipt includes
  the failed verification state. Blocked assets remain non-executable.
- Pin `ConsumptionPlan.asset_ref.digest` before execution and wire installed-name
  `inspect` plus registry-backed `update` into the top-level CLI.
- Resolve unpinned registry names by full SemVer precedence and only from
  non-yanked exact releases. Invalid or entirely yanked release sets now fail
  closed instead of falling back to registry order.
- Commit package directories and index files atomically, serialize per-tier
  mutations across processes, merge stale index writers, and recover validated
  receipt-backed versions after an interrupted index commit.
- Recheck installed bytes, content digests, and receipts before same-version
  reinstall or update. Corrupted installs fail closed with an explicit
  remove-and-reinstall recovery command.
- Keep registry updates in the tier that supplied the active asset, including
  project-local assets that override a global installation. `update --all`
  continues after individual failures and returns a non-zero summary afterward;
  an older registry release never downgrades a newer local installation.

## 0.32.0 (2026-07-14)

- Require the exact registry release `@aikdna/kdna-core@0.17.0`. The Golden
  regression's pinned Core source ref remains a reproducible test-fixture
  coordinate and is not reported as npm publication provenance.

- Let `kdna use --runner=cli:default` invoke an explicit, provider-neutral
  process Agent host for one packaged asset. The CLI sends a versioned JSON
  request, requires a correlated response, and fails closed on timeout,
  oversized output, process failure, malformed protocol, or an empty judgment.
- Execution-completed traces keep delivery, consumption, execution,
  conformance, and evidence states separate. Model identity, model calls, and
  token usage remain explicitly host-reported.
- Correlated process responses record `projection_chars_delivered` as a Runtime
  delivery observation while leaving `chars_consumed` at zero with a
  `not_observed` basis. Host execution completion is not treated as proof that
  the Capsule was read or semantically consumed.
- Trace count fields require non-negative integers, and delivery/consumption
  basis fields reject unknown or malformed values in both Schema and runtime
  validation.
- Add a synthetic Golden cross-repository regression for the single-asset
  `kdna use` process Host handoff. The compact-profile regression proves exact
  request-value preservation and correlated receipt/Trace evidence without
  making a broader Cluster/profile claim or treating execution completion as
  consumption or conformance.

## 0.31.1 (2026-07-13)

- Add explicit per-domain `routing_signals` for bounded Cluster routing,
  punctuation-safe short tasks, specificity scoring, and manifest priority
  tie-breaking.
- Preflight selected Cluster members through the package store and Core
  LoadPlan before execution. Missing or unauthorized primaries fail closed;
  unavailable optional advisors degrade with an explicit warning and trace.
- Enforce manifest token, character, and asset budgets. A hard
  `budget_exceeded: block` policy now blocks instead of silently truncating.
- Make `conflict_policy: block` produce a non-executed, zero-load blocked trace.
- Verify observed Cluster members against both their internal checksums and the
  artifact digest declared by the Cluster manifest.

## 0.31.0 (2026-07-13)

- Add RFC-0019 browser device activation, signed challenge/proof polling,
  account entitlement sync, status, and removal paths.
- Store device private keys, pinned issuer keys, and grants in the platform
  SecretStore. Public local metadata contains only identifiers, public device
  keys, lease status, and secret references.
- Add encrypted Linux SecretStore support through Secret Service (`secret-tool`)
  and GPG-backed `pass`; account/device authorization fails closed when only a
  plaintext file or environment backend is available.
- Load account assets only after Core verifies the grant signature and every
  account/device/asset binding; plain entitlement status flags do not authorize.
- Add a standard-input-only headless credential path and redact provider
  response bodies. The legacy `--key` flow remains explicit and warns about
  shell-history exposure.
- Require packaged `.kdna` files for runtime validation, LoadPlan generation,
  loading, execution, dependencies, inheritance, and watermark paths while
  preserving source directories as authoring inputs.
- Install the bundled loader for Codex, Claude Code, and OpenCode without
  fetching mutable `main`, preserve customized copies unless `--force` is
  explicit, and make `setup --help` side-effect free.
- Report declared evidence facts from `badge` without content-quality or trust
  verdicts, and scan bundle deprecations inside packaged assets.
- Make release readiness fail for dirty inputs or when the version tag does not
  point to the current commit.
- Remove active user-facing format-generation labels from authoring guidance.

## 0.30.4 (2026-07-13)

- Keep `kdna plan-load` output inside the closed public LoadPlan schema by
  removing the CLI-only `watermark_policy` property. Watermark records remain
  part of observed authorized load output, where they do not break Core/CLI/
  Swift plan parity.

## 0.30.3 (2026-07-13)

- Strengthen the Agent loader's silent-application rule after local Codex,
  Claude Code, and OpenCode field validation.
- Make setup and demo guidance load the Runtime Capsule JSON by default.
- Remove the obsolete product-version keyword from the judgment demo.

## 0.30.2 (2026-07-13)

- Make `kdna available` and `kdna match` tolerate installed assets that no
  longer satisfy the current wire contract; they now report those assets as
  non-loadable instead of crashing while decoding them.
- Route discovery of usable judgment through Core LoadPlan and Runtime Capsule.
- Remove the old product-version label from demo help text.

## 0.30.1 (2026-07-13)

- Make `kdna protect` and `kdna recover` write the cross-language Argon2id
  password profile used by Swift Core.
- Keep existing scrypt assets loadable and unlockable as compatibility inputs.
- Fail clearly when recovery is requested for a scrypt asset, whose envelope
  has no recovery slot.

## 0.30.0 (2026-07-12)

- Require `@aikdna/kdna-core@0.15.12` and `@aikdna/kdna-eval@0.3.1` through
  registry-safe semver dependencies. Published CLI tarballs contain no local
  `file:` dependency.
- Adopt the single strict-CBOR payload contract across pack, validate, inspect,
  conflict/deprecation analysis, encryption, recovery, and demo fixtures.
- Return and verify the predecessor context Capsule artifacts through `kdna load` and
  `kdna capsule-verify`; Agents consume the authorized Capsule rather than raw
  container entries.
- Complete the encrypted lifecycle: pack → protect → validate → plan-load →
  password-gated load → recover. Wrong passwords fail closed; successful loads
  return a Capsule.
- Surface malformed CBOR as non-blocking, stable diagnostics in conflict and
  deprecation analysis instead of silently reporting empty results.
- Add deterministic `kdna plan-use` and observed-execution `kdna use` paths for
  single assets and explicit Cluster manifests. `ConsumptionPlan`,
  `JudgmentTrace`, and evaluation evidence remain separate artifacts.
- Make the built-in CLI Runner resolve installed package names and local source
  paths through the package store, execute Core `planLoad`, and record
  `digest_verified: true` only after an observed checksum-valid load.
- Stop Cluster traces from inferring `assets_loaded` or trust facts from Plan
  selection. Mock execution now reports zero observed loads; CLI execution
  reports the exact assets Core loaded.
- Make `kdna project` accept installed package names as well as packaged file
  paths.
- Add `kdna eval cluster` with fail-closed five-gate Cluster Assay behavior.
  Missing behavioral or trust evidence cannot produce a passing verdict.
- Replace primary CJK n-gram routing with `Intl.Segmenter` word segmentation
  when available, retaining a compatibility fallback.
- Make Cluster migration reports portable sidecars, validate the final stamped
  manifest before writing, and preserve distinct exit codes for complete,
  manual-action, and invalid migrations.
- Require `selection` for applicable Cluster Plans while allowing a blocked
  Plan to contain no selection.
- Update the runtime dependency to `@aikdna/kdna-eval@0.3.1`.

## 0.29.0 (2026-07-10)

feat: add consumption runtime pipeline — task-aware selection, composition, projection, evaluation, and review commands that keep runtime metadata outside the `.kdna` asset format.

- **`kdna route`** — Select a primary framework from a policy or route-card sidecar and produce a trace under `kdna_trace:1.0.0`. Can abstain when a task has no supported match, and de-escalate confidence against consumer-index trust.
- **`kdna compose`** — Build a bounded primary/advisor set with `--source-hardmax` and produce trace, never silently loading every available asset.
- **`kdna project --shape=answer-pattern`** — Render a packaged `.kdna` asset into a task-safe projection via the authorized Core loading path; readable text, not `[object Object]`.
- **`kdna eval-consumption`** — Run replay and multi-gate consumption evaluation across the configured replay modes (repair, holdout, fresh). Keeps routing, composition, projection, cost, quality, and promotion results separate. Verdict is fail-closed.
- **`kdna compose-review-workbook`** — Generate a review workbook from consumption diagnostics.
- **`kdna validate-compose-decisions`** — Validate a decision ledger with 5-mode replay (`repair` / `holdout` / `fresh` / `candidate-sealed` / `new-sealed`). All modes must pass to reach an overall `pass`; any failure fails the verdict. Promotion gate is fail-closed for `sealed-derived` evidence and cannot be auto-promoted.
- **`kdna apply-reviewed-compose-decisions`** — Apply validated decisions to a consumer index. Requires a validation report from `validate-compose-decisions`; `sealed-derived` entries are skipped unconditionally (`--force` cannot override); emitted entries are `enabled: false` (`eval_candidate`).
- **`kdna asset-evidence`** — Generate a public asset evidence manifest for inclusion in downstream release repositories.
- Optional consumption sidecars (route cards, consumer index, trace, evidence manifest) remain versioned separately from the `.kdna` asset format. They are not an endorsement of an asset or a replacement for independent review.
- New runtime dependency: `@aikdna/kdna-eval@^0.2.0` (multiplying replay regression, multi-gate gating, cost tracking).

## 0.28.35 (2026-07-03)

- Replace legacy v0 local install verification with `@aikdna/kdna-core.validate()` (#93)
- Redact license keys from activation server errors and sync trace payloads (#94)
- Wire up `license activate/sync/verify/bind/show` subcommands in CLI dispatcher
- Expand SECURITY.md with license/remote security scope and private reporting link

## 0.28.34 (2026-07-01)

Support plan-load for installed package names (#92).

## 0.28.33 (2026-07-01)

Fix v1 asset install and routing discovery — derive install name from asset_id when legacy kdna.json.name is missing, allow hyphens in registry identifiers, normalize string routing fields for agent discovery (#90, #91).

> **Supersession note (2026-06-27)**: Pre-v0.7 entries below use "v1.0-rc" terminology. As of the v0.7 launch (2026-05-22), the @aikdna/* npm scope and registry v2.0 superseded the v1.0-rc label. The historical "v1.0-rc" references in older entries are kept for accuracy; new development uses the 0.7.x+ numbering.

## v0.28.32 (2026-06-30)

**Refactor**: replace duplicate semver implementation with `@aikdna/kdna-core` re-export.

`src/cmds/semver-util.js` previously maintained a ~100-line parallel implementation
of `parseSemver`/`compareSemver`/`satisfies` identical to the one in kdna-core.
Now that `@aikdna/kdna-core@0.15.10` exports these functions, `semver-util.js`
is a thin re-export wrapper. Removes ~70 lines of duplicated code.

Dependency: `@aikdna/kdna-core` bumped to `^0.15.10`.

**Bug fix: remove fabricated v1 deprecation warning.**

The v1 CLI was emitting a "KDNA v1 format is deprecated and will reach
end-of-life in 9-12 months. Please migrate to KDNA v2." warning on every
`validate`, `plan-load`, `load`, `inspect`, and `unpack` call against any
v1 asset. There is no KDNA v2 product. The v1 format is stable. The warning
was introduced in v0.28.17 (Story 5) without any basis and has been removed.

- **`kdna validate`** — no longer emits spurious v1 deprecation warning
- **`kdna plan-load`** — no longer emits spurious v1 deprecation warning
- **`kdna load`** — no longer emits spurious v1 deprecation warning
- **`kdna inspect`** — no longer emits spurious v1 deprecation warning
- **`kdna unpack`** — no longer emits spurious v1 deprecation warning

## v0.28.29 (2026-06-28)

Story 21 — Watermarking (Section 13.8 encryption/authorization
sprint plan, the last story in the 8-sprint plan). **This
closes Section 13** — the encryption/authorization layer is
now fully delivered.

- **Payload-level watermarking** — `licensed` and `remote`
  assets now carry a watermark that binds the projection to
  the consumer. `public` assets are NOT watermarked.
- **`kdna plan-load`** — output now includes a `watermark_policy`
  field for `access: "licensed"` or `access: "remote"`. The
  policy describes the watermark shape (fields, algorithm) but
  does NOT contain the HMAC key or any precomputed hmac — those
  are generated at `kdna load` time.
- **`kdna load`** — output now includes a `watermark` field on
  the result (JSON output) and a `[WATERMARK ...]` header line
  in `--as=prompt` and `--as=compact` output. The watermark is
  carried in the consumer's context so the model echoes it
  back, enabling post-hoc traceability.
- **Watermark content** — `asset_uid`, `consumer_id` (the
  consumer's identity fingerprint, when `kdna identity init`
  has been run; null otherwise), `timestamp` (ISO), `session_nonce`
  (16 random bytes hex), `algorithm` (`hmac-sha256`), and `hmac`
  (HMAC-SHA256 over the canonical JSON of the other fields).
- **HMAC key is process-local** — generated fresh per CLI
  invocation via `crypto.randomBytes(32)` and never persisted.
  Different CLI invocations produce different HMACs for the same
  consumer/asset. A leaked HMAC cannot be replayed because the
  verifier needs the same key. This is the same trust model as
  Story 19 (per-author key, no central authority) and the
  brief's "不将水印密钥提交到仓库" requirement.
- **Content-neutral** — the watermark never claims "official",
  "trusted", "verified", or "recommended". It is a
  traceability primitive, not a trust claim.
- **Non-blocking** — watermarks are post-hoc traceability,
  not access control. Loading a `licensed` asset without a
  watermark is allowed; the watermark just makes leaks
  traceable.
- **`src/cmds/watermark.js`** — new module with `buildWatermark`,
  `watermarkPolicy`, `verifyWatermark`, `renderWatermarkHeader`,
  `shouldWatermark`, `newHmacKey`, `resolveConsumerId`. Public
  API exportable for embedders (the kdna-studio or kdna-vscode
  could call it directly).
- **16 new tests** in `tests/story21-watermarking.test.js`
  covering: shouldWatermark (mode gating), buildWatermark (field
  shape, public-mode returns null), verifyWatermark (HMAC
  round-trip + tamper detection), renderWatermarkHeader
  (content-neutral one-liner), watermarkPolicy (no secret
  material in policy), plan-load (watermark_policy present for
  licensed/remote, absent for public), load (watermark field
  in JSON, [WATERMARK] header in prompt/compact, no watermark
  for public, consumer_id from kdna identity when set up,
  consumer_id null otherwise).
- Total: **156/156 pass** (up from 140, +16).
- No new npm dependencies. No breaking changes to existing
  CLI output (the watermark is additive on a new field).

## v0.28.28 (2026-06-28)

Story 20 — Revocation state machine (Section 13
encryption/authorization). The author can revoke their own
signature; consumers see the revocation state on verify.

- **`kdna revoke <asset>`** — author revokes their own
  signature. Writes a signed JSON revocation record to
  `signatures/revocation.ed25519.json` (or
  `<asset>.signatures/revocation.ed25519.json` for a
  .kdna container). The record references the specific
  .ed25519.sig file by content hash, so re-signing after
  revocation produces a fresh signature. The record is
  signed with the same Ed25519 key that signed the asset.
  Options: `--reason "..."` for an optional human-readable
  reason, `--revocation <path>` to override the output path,
  `--force` to overwrite an existing revocation.
- **`kdna verify` recognises revocations** — when a valid
  revocation by the same key exists and references the
  current .ed25519.sig, `verify` returns `status: 'revoked'`
  with **exit code 4** (new). The CLI prints the revocation
  reason (if any), the revoked_at timestamp, and the
  revocation file path. Same trust-language discipline as
  Story 19: never says "official", "trusted", "verified", or
  "recommended".
- **`kdna verify` no-key path surfaces revocations** —
  without `--key`, exit code stays at 2 (the
  no-trust-claim signal) but the output now lists the
  revocation record path and reason so the consumer has
  the data to decide.
- **Cross-key attack resistance** — a revocation signed by
  a different key than the original signature does NOT
  apply. Verify checks `record.public_key_hex ===
sigRecord.public_key_hex` and rejects cross-key
  revocations. Tested in `story20-revocation.test.js`
  test 7 (attacker scenario).
- **`kdna revocation status <asset>`** — new subcommand
  that reports the current revocation state for an asset:
  `valid` (signature verifies), `absent` (no revocation
  file), `error` (file present but malformed), or other
  status. `--json` for machine-readable output.
- **Cross-implementation revocation check** — revocation
  uses the same 32-byte raw Ed25519 public key format as
  Story 19 signature records. A future implementation in
  any language can verify a revocation by importing the
  raw 32 bytes, wrapping in SPKI DER, and calling its
  Ed25519 verifier.
- **Reuses Story 19 primitives** — `loadAssetForSigning`,
  `rawPublicKey`, `fingerprint`, `crypto.sign`,
  `crypto.verify`. No new npm dependencies. No modifications
  to the encrypt/decrypt path.
- **Exit code summary** (Story 19 + Story 20):
  - `0` valid (signature verifies, no revocation)
  - `1` invalid (signature wrong OR asset modified)
  - `2` no key (informational; CLI just printed signer
    pubkey + optional revocation note)
  - `3` error (file not found, key unparseable, etc.)
  - `4` revoked (Story 20: signature is valid but author
    revoked it)
- **9 new tests** in `tests/story20-revocation.test.js`
  covering the 7 acceptance criteria (revoke, --reason,
  no-sig, --force, exit 4 on verify, exit 2 on no-key,
  cross-key resistance, status subcommand, status absent).
  Total: **140/140 pass** (up from 131).
- No breaking changes to existing CLI output. The new
  exit code 4 is additive; the revocation record is
  additive; the `revocation status` subcommand is additive.

## v0.28.27 (2026-06-28)

Story 19 — kdna sign / verify + Ed25519 identity keys (Section 13
encryption/authorization, identity layer). **This is the complete
identity layer — no further centralization steps after this.**

- **Identity path migration** — the canonical identity path is now
  `~/.kdna/keys/ed25519.{key,pub}` (mode 0600 on the private key).
  The pre-Story-19 path `~/.kdna/identity/kdna.{key,pub}` still
  works through the legacy `signature.js` helper for backward
  compat (Story 20+ consumers should use the new path).
- **`kdna identity show`** now prints the public key in **three
  encodings**: PEM (file path), hex (32-byte raw), and base64
  (32-byte raw). The raw 32-byte form is what consumers compare
  against a published key.
- **`kdna sign <asset>`** — detached Ed25519 signature over the
  asset digest. The asset digest is `SHA-256(SHA-256(kdna.json) ||
SHA-256(payload.kdnab) || SHA-256(checksums.json))`. The
  signature file is written to `<asset>.ed25519.sig` by default;
  `--sig <path>` overrides. The signature record is JSON
  containing version, algorithm, asset_digest, per-input
  SHA-256 digests, the signer's public key (hex + base64), the
  signer's key fingerprint, the signed_at timestamp, and the
  Ed25519 signature bytes (base64). Detached — the .kdna
  container is not modified in place.
- **`kdna verify <asset>`** — verifies the signature. With
  `--key <pubkey>`, cryptographically verifies against the
  provided public key. Without `--key`, prints the signer's
  public key (hex + base64) plus the message
  `No key provided; cannot determine trust` — trust is the
  consumer's decision, not the CLI's. Exit codes: 0 valid,
  1 invalid (signature is wrong or asset is modified), 2 no key
  provided (informational), 3 error (file not found, key
  unparseable).
- **Trust language discipline** — the CLI never says "official",
  "trusted", "verified", or "recommended" about a signed asset.
  It only says "signature is cryptographically valid against
  key X" — what to do with that fact is the consumer's call.
  This is the same non-collapse shape as RFC-0018 R4.3 (the
  profile non-collapse invariant).
- **No centralization** — each author generates their own key
  pair. KDNA Inc. holds NO private keys. There is no registry
  lookup, no key discovery, no key escrow.
- **No new npm dependencies** — uses Node.js built-in
  `crypto.sign` / `crypto.verify` / `crypto.generateKeyPairSync`
  for Ed25519.
- **10 new tests** in `tests/story19-sign-verify-identity.test.js`
  covering the 7 acceptance criteria (path, mode, format, sign,
  verify, no-key, tamper). Total: **131/131 pass**.
- No breaking changes to existing CLI output (additive commands;
  identity path migration is gated by `KDNA_IDENTITY_DIR` for
  test isolation; legacy `~/.kdna/identity/` still loads).

## v0.28.26 (2026-06-28)

Story 13 — Trust levels + deprecation (RFC #148 v2.x Phase 3, last story
in Phase 3).

- **`trust_level` on bundle components** — each entry in a Bundle
  manifest's `components[]` can now declare `trust_level: "community" |
"verified" | "official"`. `kdna validate --bundle` validates the
  value (anything outside the three-level enum is a hard schema
  ERROR) and threads the value into the per-component result and
  into conflict analysis.
- **`low_trust_warnings` in `validate --bundle` output** — new
  top-level field in the Bundle Validation Report. Lists all
  WARNING-level conflicts where at least one side is
  `trust_level: "community"`, plus the distinct set of community
  component ids that participate. ERROR-level conflicts stay in
  `errors`; trust level never softens a true conflict into a pass.
- **Conflict entries now carry `trust_level_a` / `trust_level_b` /
  `community_warning`** — additive fields. `community_warning` is
  set on WARNING-level entries when any side is `community`. The
  `low_trust_warnings` section is computed from these flags.
- **Semver-aware deprecation warnings** — bundle manifests can now
  declare a `deprecation` block at the top level OR on each
  component, with three accepted field-name aliases:
  - `since` (preferred; bare version like `"0.28.0"` is treated as
    shorthand for `">=0.28.0"`, comparator / range shapes also
    accepted)
  - `deprecated_in` (alias for `since`)
  - `deprecated_at` (shorthand for `">=X"`)
    Optional `remove_in: "X.Y.Z"` escalates the warning wording to
    "REMOVAL" once the running CLI is at or past that version.
    Optional `replacement` and `reason` are surfaced in the message.
- **`kdna load` and `kdna plan-load` print soft deprecation
  warnings to stderr** — when the asset is a Bundle and any of its
  `deprecation` blocks are satisfied by the running CLI version, a
  one-block Notice is printed to stderr (multi-line, exits with a
  trailing newline). Never blocks, never changes exit code. The
  same data is also embedded in the validate-bundle JSON report
  under `deprecation_warnings` (with `current_cli_version`,
  `warnings[]`, and a pre-formatted `stderr_text` field).
- **New helpers** — `src/cmds/semver-util.js` (parseSemver /
  compareSemver / satisfies / isDeprecatedAt) and
  `src/cmds/deprecation.js` (readBundleComponents /
  evaluateDeprecation / scanBundleDeprecations /
  formatDeprecationStderr). No new npm dependencies.
- **28 new tests** in `tests/story13-trust-deprecation.test.js`
  covering semver parsing, deprecation shape handling, trust_level
  validation, low_trust_warnings filtering, and the CLI
  deprecation stderr path. Total: **121/121 pass**.
- No breaking changes to existing load / plan-load / validate
  output (additive fields only).

## v0.28.25 (2026-06-28)

Story 12 — Asset inheritance (RFC #148 v2.x Phase 3).

- **Updated to `@aikdna/kdna-core@0.15.9`** which adds:
  - `extends` field to `manifest.schema.json` (string or `{name, version}` object)
  - `planLoad` resolves base asset, records `extends_chain` in plan output
  - `loadAuthorized` passes `extends_chain` to `loadV1Unsafe` so inheritance
    is applied at load time
  - `loadV1Unsafe` merges base content: child axioms override parent axioms
    with the same `id`; unoverridden parent axioms are inherited; same for
    boundaries; `highest_question` falls back to parent when child omits it
  - `result.extends_chain` + `result.inheritance_applied` in load output
  - All extends failures are non-blocking (WARNING, not ERROR)
- **6 new tests** in `tests/story12-asset-inheritance.test.js`. Total: **93/93 pass**.
- No breaking changes.

Story 11 — RAG namespace isolation (RFC #148 v2.x Phase 3).

- **Updated to `@aikdna/kdna-core@0.15.8`** which adds `rag_namespace` to
  each entry in `resolved_dependencies` and `rag_isolation_policy` to Bundle
  load output (`{ default: "fenced", cross_namespace_blocked: true, namespaces: [...] }`).
- **`--as=prompt` namespace headers**: each component section in multi-asset
  prompt output is now prefixed with `[NAMESPACE: name@version]` (per SPEC §13.8
  source attribution).
- **`kdna load --namespace=<id>`**: new flag that filters the load output to
  the single component whose `rag_namespace` contains `<id>`. Returns only that
  component's content. Emits a warning if the namespace is not found or if the
  asset has no `resolved_dependencies`.
- **5 new tests** in `tests/story11-rag-namespace.test.js`. Total: **87/87 pass**.
- No breaking changes to existing load output (additive fields only).

Story 10 — audit log (RFC #148 v2.x Phase 3).

- **`~/.kdna/audit.jsonl`**: every `kdna load` invocation now appends a
  structured JSON line recording `event_type`, `asset_path`, `asset_id`,
  `version`, `profile`, `as`, `access_mode`, `result` (success/error),
  `error_code`, and `duration_ms`.
- **`kdna load`**: writes audit entry on both success and error paths.
  Audit write failure is non-blocking and never surfaces to the user.
- **`kdna history --audit`**: new flag reads from `audit.jsonl` instead of
  daily trace files. Supports `--json`, `--stats`, `--errors`, `-n <n>`.
- **`kdna history --audit --stats`**: total/success/error counts,
  error rate, by-asset breakdown, by-error-code breakdown.
- **New module**: `src/cmds/audit-log.js` — `appendAuditEntry()`,
  `readAuditLog()`, `auditStats()`.
- **`src/paths.js`**: added `audit` path (`~/.kdna/audit.jsonl`).
- **Help text** updated: `kdna help history` now shows `--audit` variant.
- **7 new tests** in `tests/story10-audit-log.test.js` (3 unit + 4 CLI).
  Total suite: **82/82 pass**.
- **No breaking changes** to existing `kdna history` (without `--audit`)
  or daily trace file behavior.

Story 9 — validate conflict warnings (RFC #148 v2.0).

- **`kdna validate <bundle.json> --bundle`** now runs per-card-type conflict
  static analysis as defined in `docs/CONFLICT_RESOLUTION.md` (Story 4).
  Replaces the Story 3 INFO stub with real analysis.
- **New module**: `src/cmds/conflict-analysis.js` — `analyseConflicts()`,
  `extractCards()`, `loadPayload()`.
- **Covered card types**: term (ERROR on same-term/different-definition),
  axiom id clash (WARNING), banned_term replace_with (WARNING),
  misunderstanding wrong/correct (WARNING), stance same-text (WARNING),
  framework name/steps (WARNING), self_check same-question (WARNING),
  scenario id (INFO), risk mitigation (INFO).
- **Conflict report shape** unchanged from Story 3: `{ conflict_type,
severity, component_a, component_b, card_type, card_id_a, card_id_b,
conflicting_field, resolution, winning_component, note }`.
- **Exit code**: 0 when `bundle_valid=true`; 1 when `errors[]` is non-empty
  (term conflict or component validation failure).
- **10 new tests** in `tests/story9-conflict-analysis.test.js` (6 unit + 2
  CLI integration). `tests/validate-bundle.test.js` stub assertion updated.
  Total suite: **75/75 pass**.
- **No breaking changes** to existing `validate --bundle` output shape.

Story 8 — context budget reporting (RFC #148 v2.0).

- **`context_budget` field in the predecessor bundle profile schema**: Bundle manifests may
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

- **V2 Format Support**: Added support for KDNA v2 containers and the predecessor manifest discriminator with value `"2.0"`, plus the `"bundle"` `asset_type`.
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
  - **`kdna load --password-stdin`** added a non-argv password input path.
    Previously, `load` only accepted the legacy `--password=<value>` form,
    forcing users to expose the password to shell history or provide no input.

## v0.28.8 (2026-06-27)

### Fixed

- **BUG-1 (A1): `plan-load` began accepting the legacy `--password <value>`
  form and threading it to `kdna-core.planLoad`.** Previously, `planLoad` only
  honored the `--has-password` diagnostic flag, so legacy argv-based loading
  could not satisfy the plan-load gate and was rejected with
  `state: needs_password`. The resulting plan reports
  `input_fingerprint.has_password_input: true`, `state: ready`, and
  `can_load_now: true`. The encryption envelope itself was already in place
  (kdna-studio 0.8.0 → B2 scrypt); this fix closed the consumer-side loop.

### Fixed

- **BUG-2/3 (B1): `kdna protect` migrates to `kdna-password-protected-v1-scrypt` and produces valid checksums.** The previous implementation used the legacy `kdna-password-protected-v1` (Argon2id) profile, encrypted `KDNA_Core.json` only (leaving the judgment payload readable), and rebuilt the asset without regenerating `checksums.json`. Result: `kdna validate` reported `manifest_digest mismatch` / `asset_digest mismatch`, and `kdna protect unlock` crashed with `JavaScript does not support arrays, maps, or strings with length over 4294967295` because `reader.loadProfileSync` (the old path) assumed the payload was CBOR-encoded while kdna-studio produces JSON. New behavior: `kdna protect` encrypts `payload.kdnab` under the scrypt profile (matching kdna-studio), calls `buildChecksumsV1` before `pack` to write a fresh `checksums.json`, and `kdna protect unlock` routes through `core.loadAuthorized` (the same path `kdna load` uses) to avoid the cbor-x 32-bit length path. Legacy Argon2id assets are still loadable but emit a deprecation warning. `kdna recover` also re-encrypts under the scrypt profile.

### Fixed

- **BUG-4/5/6 (D1/D2): CLI routing consistency.** `kdna version` is now a
  first-class command (previously returned `Unknown command: version`);
  `kdna help <subcmd> [...]` re-routes to `<subcmd> --help`; and the protect and
  unlock commands accept `--help` / `-h`. Their help text was aligned on the
  canonical flag set, including `--out`, password input, `--entries <list>`,
  and `--profile <name>`.

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
- `kdna inspect` output is always JSON and includes the predecessor format discriminator, `asset_id`, `asset_uid`, `payload_encrypted`, `profile`, and `load_contract_default_profile` fields.

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
