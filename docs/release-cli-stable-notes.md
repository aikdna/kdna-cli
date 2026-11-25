# Stable CLI change notes

## CLI 0.46.0

This source keeps the exact published Core `0.37.11` and Read `0.13.5` companion pair and delivers human/review rendering fixes, backward-compatible `kdna.draft/1` structural authoring extensions, and cross-platform encrypted `.kdna` usability: `kdna read --format human` and `kdna review` now resolve and render Core `0.6.0` conditional exceptions (`when` condition statements plus `waive` and `replace_limit` replacement boundaries at both asset and judgment levels) alongside explicit open/undecided (`answer_kind: "other"` / `answer_other`) and rule (`form: "rule"` / `formation_rule` + linked conditions) markers; `kdna.draft/1` keeps minimal drafts unchanged while adding optional `creator` (always emitting both `manifest.creator` and `payload.attributions` for KDNA Reader display), `worldview`, `value_order`, `sources` / `source_refs`, `sections` (`extension:reading-sections`), `relationships` (compiled to Core's four normative tuples), asset- and judgment-level `exceptions` (with Reader-compatible judgment `owner_ref`) and `misuse`, `form: "rule"` with dynamic `asset_capability`, `answer_kind: "other"` + `answer_other`, cross-domain `init --example` diversity, K22-respecting advisories (`vague_or_short_focus`, `unbounded_absolutism`, `isolated_multi_judgment`, `research_provenance_mismatch`), and typo hints; encrypted workflows gain cross-platform `--password-env <var>`, hidden TTY `--password-prompt` (confirmed twice on `protect`, fail-closed on non-TTY), an explicit `plaintext_metadata_notice` on `protect`, pre-unlock `kdna inspect --metadata`, and rotated-passphrase `kdna diff --left-password-* / --right-password-*`; and `kdna source-pack` safely preserves `manifest.representation_metadata` from the verified original container when omitted in edits. Earlier published coordinates remain in place, including CLI `0.45.2`.

## CLI 0.45.2

This source keeps the exact published Core `0.37.11` and Read `0.13.5` companion pair and reconciles `kdna source-pack` receipt evidence after unsigned `checksums.json` regeneration: `evidence.output.A` (along with `C`, `E`, `source_A`, and `member_actions`) now reflects the post-checksum container written to disk so multi-hop `source-open` / `source-pack` revisions chain seamlessly using `evidence.output.A`. Earlier published coordinates remain in place, including CLI `0.45.1`.

## CLI 0.45.1

This source keeps the exact published Core `0.37.11` and Read `0.13.5` companion pair and updates `kdna source-pack` and packaged authorization documentation: after verifying `--expected-a` against the original container bytes, `source-pack` automatically regenerates unsigned `checksums.json` entry manifests via Core's native checksum producer and re-admits the resulting container before saving (while continuing to fail closed with `KDNA_SOURCE_SIGNED_CHECKSUMS_REFUSED` if any cryptographic signature entry or manifest signature declaration is present); and `docs/asset-authorization.md` now documents the current `0.45.1` operation flags and offline `protect`/`unprotect` routes cleanly. Earlier published coordinates remain in place, including CLI `0.45.0`.

## CLI 0.45.0

This source keeps the exact published Core `0.37.11` and Read `0.13.5` companion
pair and delivers one-page author review sheets (`kdna review`), clean
author-facing stance diffs (`kdna diff --format human` and `--verbose`) with
downstream relationship impact analysis and zero tail-edit truncation, and
Windows atomic file-save compatibility on non-hardlink filesystems: `kdna review
<asset.kdna> --allow-read` renders a top Quick Sign-off Summary table followed
by complete judgment claims, premises, method components, reasons, boundaries,
conditional exceptions, foreseeable misuse, examples, relationships, sources,
and revision history in localized Chinese or English (with automatic `.json`
output format inference when `--output <file.json>` is passed); `kdna diff
--format human` folds mechanical internal component/reference IDs by default
(restored in full by `--verbose`), removes the 300-character string truncation
ceiling so tail modifications on long judgment paragraphs are always displayed
in full context, and surfaces downstream judgments affected via `support`,
`qualify`, and `conflict` edges; and `saveNewAsset` falls back cleanly to
exclusive atomic `wx` creation on Windows filesystems that do not support hard
links (`EPERM`, `ENOTSUP`, `ENOSYS`, `EXDEV`, `EINVAL`, `EACCES`). Earlier
published coordinates remain in place, including CLI `0.44.0`.

## CLI 0.44.0

This source binds the exact Core `0.37.11` and Read `0.13.5` companion pair and
delivers canonical ASCII `method_roles` with full legacy Chinese role backward
compatibility, sub-second CLI startup and read/inspect latency via lazy route
validator loading, explicit `method: "other"` draft omission semantics
(`KT-028`), offline `kdna unprotect` decryption, and direct `source-open`
`.edits` consumption/export ergonomics: `kdna init` and `kdna compile` emit
language-neutral ASCII `method.components[].role` identifiers while accepting
both ASCII and legacy Chinese roles in drafts and existing `0.6.0` `.kdna`
containers; `kdna read --format human` renders localized Chinese role labels on
Chinese works and English role labels on English works regardless of wire role
encoding; omitting `method` in `kdna.draft/1` compiles to `method.term: "other"`
with an explicit unstated-method definition rather than assuming `feeling`;
`kdna unprotect` atomically decrypts a password-protected `0.6.0` container back
to an unprotected `0.6.0` section container; `kdna source-open --output
<edits.json>` exports `{manifest, payload}` directly and `kdna source-pack` /
`validate-input` also accept full `source-open` JSON envelopes cleanly; and
`README.md` / `SECURITY.md` document the true Container `0.6.0` AEAD protection
stack (`scrypt-sha256` / `argon2id` + `AES-256-KW` + `AES-256-GCM`). Earlier
published coordinates remain in place, including CLI `0.43.5`.

## CLI 0.43.5

This source keeps the exact published Core `0.37.9` and Read `0.13.3` pair and
delivers English human-format role rendering, subcommand help ergonomics,
placeholder checks on `compile`, and `source-pack` revision diagnostics:
`kdna read --format human` renders English method-component role labels
(`[subject_interpreted]`, `[options]`, `[priority_rule]`, etc.) when the asset
or judgment language is English while retaining Chinese labels on Chinese works
and leaving wire JSON tokens unchanged; `kdna <subcommand> --help` / `-h` and
`kdna -v` exit `0` with accurate flag synopses (`--allow-read` mandatory and
`--mode` / `--budget` defaults explicit); `kdna compile` rejects unreplaced
`TODO:` scaffold placeholders consistently with `kdna create --draft`;
`kdna validate-input` validates `source-open` `.edits` documents cleanly; and
`kdna source-pack` emits an explicit `.edits` hint when passed a raw
`source_opened` envelope, reports 4-version alignment diagnostics when
`manifest` and `payload.asset` version pairs diverge, and syncs
`result.value.value` when `core_expression.statement` is revised on a
`conclusion` judgment whose two fields matched in the base asset. `README.md`,
`SECURITY.md`, and `docs/authoring-field-reference.md` are updated accordingly.
Public, local, and password-protected `0.6.0` workflows remain permanently
offline and account-free. Earlier published coordinates remain in place,
including CLI `0.43.4`.

## CLI 0.43.4

This source keeps the exact published Core `0.37.9` and Read `0.13.3` pair and
delivers safety-closure preservation, bilingual authoring ergonomics, and
human-readable diagnostics across the CLI: `kdna read --compact` preserves all
asset-wide boundaries, anti-misuse declarations, shared declarations,
inter-judgment relationships, reasons, materials, examples, sources, and
mandatory-closure related judgments while continuing to strip repeated IR node
wrappers and catalog bloat; `kdna read --format human` renders full reasoning
components, reasons, boundaries, examples, and relationships with CJK-aware
wrapping, and routes `read` and `diff` rejections through human text when
`--format human` is requested; `kdna diff` deduplicates judgment-owned IR mirror
nodes so single statement edits are reported once; `kdna init` adds English
draft role aliases (`--lang en` default, `--lang zh` for canonical Chinese role
keys) and `--example` ready-to-compile starter drafts; and `kdna read --mode
whole_asset` defaults `--budget` to `4000000` bytes while `catalog` and
`exact_selection` retain `1000000` bytes. Public, local, and password-protected
`0.6.0` workflows remain permanently offline and account-free. Earlier published
coordinates remain in place, including CLI `0.43.3`.

## CLI 0.43.3

This source keeps the exact published Core `0.37.9` and Read `0.13.3` pair and
adds authoring, local password protection, revision comparison, and human-first
terminal ergonomics: `kdna init [--mode minimal|interview|works|research]`
scaffolds ready-to-edit `kdna.draft/1` templates across minimal, interview,
works-distillation, and research-choice authoring flows; `kdna validate-input
[--format json|human]` validates both `kdna.draft/1` and full `0.6.0` authored
inputs (pinpointing duplicate or invalid `method.components` roles and emitting
non-blocking structural craft advisories); `kdna compile` and `kdna create
--draft` expand `kdna.draft/1` into full native `0.6.0` input before Core
admission; `kdna protect` produces offline password-protected `0.6.0` containers
using `--password-file` or `--password-fd`; `kdna inspect`, `validate`, `read`,
and `diff` accept `--password-file` or `--password-fd` on protected assets;
`kdna validate --system` adds warnings-only system-integrity checks; `kdna diff`
compares two `.kdna` revisions at judgment granularity; and `kdna read --compact`
plus `--format human` provide lean agent and human projections while default
JSON output remains deterministic. Earlier published coordinates remain in
place, including CLI `0.43.2`.

## CLI 0.43.2

This source binds the published Core `0.37.9` and Read `0.13.3` archives and
moves every byte-pinned coordinate — the six route-contract digests, the
accepted companion pair, the dependency and delivery archive receipts, the
offline host lock, the root lock and the stable profile — to those exact
registry tarballs. It includes the read-help clarification of the budget object,
the body/full/raw views and the three read modes, and the one-shot read stderr
guidance for budget rejections. No runtime behavior or protocol semantics
change. Both Core `0.37.9` and Read `0.13.3` carry registry `gitHead` and
provenance attestations. Earlier published coordinates remain in place,
including CLI `0.43.1`.

## CLI 0.43.1

This source binds the published Core `0.37.8` and Read `0.13.2` archives and
moves every byte-pinned coordinate — the six route-contract digests, the
accepted companion pair, the dependency and delivery archive receipts, the
offline host lock, the root lock and the stable profile — to those exact
registry tarballs. It does not change runtime behavior or protocol semantics.
Read `0.13.2` has no registry `gitHead` or provenance attestation; the release
binds its exact archive SHA256/SRI/SHA1 only and does not claim provenance for
it. Core `0.37.8` retains its registry `gitHead` and provenance. Earlier
published coordinates remain in place.

## CLI 0.43.0

This source binds the published Core `0.37.7` and Read `0.13.1` and adds the
explicit `kdna convert` command: it reads exactly the current `0.5` public
source generation and writes an admitted `0.6` container with a confirmed
`representation_origin`, saves a new file under the existing no-replace
policy, refuses historical tuples, protected sources and extension members by
name before any conversion, and never converts implicitly on the read or
source routes. Every byte-pinned coordinate — the six route-contract digests,
the accepted companion pair, the dependency and delivery archive receipts and
the offline host lock — moves back to the exact published archives in this
release batch, and the publish-coordinate gate reports zero findings again.
Earlier published coordinates remain in place.

## CLI 0.42.0

This source candidate adds the explicit `--view raw` adapter carrier. Raw
prints the library envelope exactly as the library returns it — reduction
machinery and issued handles included — for adapters that apply the installed
Read projection themselves; it is not a model view, and an explicit
`--view-accept` beside it is refused rather than ignored. The default body,
`--view full`, and every model-view contract value, including the 0.41.0
paired projection, are unchanged, so existing consumers keep their exact
surfaces.

## CLI 0.41.0

This source candidate binds the exact released Core 0.37.6 and Read 0.13.0
archives and carries the paired model-view 0.2.0 projection. The delivered read
request answers with the author body while the non-selected closure members
arrive behind their own expansion handles; `--view full` prints the complete
surface without the reduction machinery, and `--view-accept` pins the
model-view contract the caller accepts, defaulting to the contract this CLI is
built against. A session may expand a returned handle either by echoing it or
by naming the compact `handle_id` a reduced entry carries; the CLI resolves it
within the same session with explicit refusals and still passes the complete
read admission. The 0.40.1 method-role guidance sibling is unchanged.

No content, field or route is removed. Publication targets `latest` only, keeps
every other dist-tag and the prior version in place, retains exact companion
archive identities, and re-verifies the published bytes through a fresh
registry consumer.

## CLI 0.40.1

This source candidate binds the exact released Core 0.37.4 and Read 0.12.1
archives and adds one authoring aid: when `create` is refused by Core with a
method or method-component diagnostic, the output carries a `guidance` sibling
that quotes the per-term role vocabulary from the installed Core's read-only
method-role table, names which required roles the authored input does not
contain, and points at the documented encoding for a method the author never
stated. The guidance presents authored input and the public vocabulary only; it
decides nothing, and the Core diagnostic object, its fields and the complete
core result remain exactly as the installed Core produced them. An installation
without the read-only table keeps byte-identical previous output.

No content, field or route is removed. Publication targets `latest` only, keeps
every other dist-tag and the prior version in place, retains exact companion
archive identities, and re-verifies the published bytes through a fresh registry
consumer.

## CLI 0.40.0

This source candidate binds Core 0.37.3 and Read 0.12.0 to the exact approved
archives, and moves with the Read distribution coordinate that adds the model
view projection.

The default surface of `kdna read` is the author body plus one fingerprint
whenever the installed Read package provides that projection; the CLI probes for
the capability rather than assuming it, an explicit `--view body` against an
installation without it is refused instead of quietly answered with the full
surface, and `--view full` prints exactly what this CLI printed before the flag
existed. No content, field or route is removed, and the native section contracts
are unchanged.

The source release gate retains exact commit and tree identity, two matching
packs, companion archive identities, an approved artifact and notes digest, and
a real published stable GitHub release event. Publication targets `latest` only;
other npm dist-tags must remain unchanged, and a registry version with
conflicting bytes is refused. Public installation and registry byte identity are
checked again after publication.

File generation, local Read permission and producer evidence do not establish
human confirmation, task adoption or action authorization. Studio protected
assets use their separately documented protection route.

## CLI 0.39.0

This source candidate binds Core 0.37.2 and Read 0.11.3 to the exact approved
archives. It creates native section assets from explicit authored input, saves
to an exclusive destination, and exposes local inspection and Read with
explicit permission. An installed example performs a reasoned revision while
preserving the original file, then verifies the revised asset through Read.

The source release gate retains exact commit and tree identity, two matching
packs, companion archive identities, an approved artifact and notes digest,
and a real published stable GitHub release event. Publication targets latest
only; other npm dist-tags must remain unchanged. A registry version with
conflicting bytes is refused. Public installation and registry byte identity
are checked again after publication.

File generation, local Read permission and producer evidence do not establish
human confirmation, task adoption or action authorization. Studio protected
assets use their separately documented protection route.
