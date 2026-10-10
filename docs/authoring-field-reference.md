# Authoring field reference (native `0.6` creation input)

This page is for the `kdna create <authored.json>` input. It is bound to the
coordinate this package ships against: container `0.6.0`, `kdna.core/0.8.2`,
`kdna.canonical-ir/0.6.1`, `kdna.read/0.7.0-candidate`, CLI
`0.39.0-rc.native-sections.3`. Declaring a version here does not make an asset
valid, and admission is not read permission.

Working example: `examples/team-update/author.json` (the only input this
repository ships that is known to create successfully).

## 1. Top level

Top-level keys: `manifest`, `payload`, `members`.

All three are required on the creation input; there is no fourth key. The
revision document that `source-open` hands to `source-pack` is a separate
contract, documented in the package README, and is not this input.

The CLI checks this top level before Core sees the document. `manifest` and
`payload` are passed through unchanged; Core validates their contents. `members`
is checked here as well because it carries file bytes.

## 2. `members[]` (attachment descriptors)

`members` is an array with 0 to 128 entries. Each entry has exactly these four
keys: `name`, `type`, `mode`, `bytes_base64`.

- `name` — string, the attachment path inside the container.
- `type` — the string `file`; no other member type is admitted here.
- `mode` — integer from 0 to 65535 (for example 420 for `0644`).
- `bytes_base64` — canonical base64 of the member bytes: correct padding, no
  whitespace or line breaks, no URL-safe alphabet, and it must decode to exactly
  the bytes it encodes.

An empty `members` array is valid and means the asset has no attachments.
Transport limits this CLI enforces before Core runs: input file at most 20 MiB,
one decoded member at most 8 MiB, all decoded members together at most 12 MiB,
at most 128 entries.

## 3. `manifest` required keys (13)

`asset_id`, `asset_uid`, `asset_type`, `title`, `version`, `judgment_version`,
`created_at`, `updated_at`, `compatibility`, `runtime`, `summary`, `languages`,
`history`

Optional keys (8): `creator`, `content_digest`, `authoring`, `access`, `license`,
`description`, `keywords`, `lineage`

`format_version` and `payload` are not part of the creation input; Core adds them
to the produced asset.

## 4. `payload` required keys (22)

`profile`, `profile_version`, `asset`, `actors`, `scope`, `judgments`,
`asset_capability`, `declarations`, `kernel`, `shared_declarations`, `materials`,
`reasons`, `sources`, `source_uses`, `resources`, `relationships`, `dependencies`,
`contracts`, `conditions`, `exceptions`, `misuse`, `examples`

Optional keys (5): `attributions`, `cohesion`, `content_risk`, `extensions`,
`reading_order`

## 5. `payload.judgments[]` required keys (15)

`id`, `focus`, `subject`, `scope`, `form`, `answer_kind`, `core_expression`,
`result_contract`, `method`, `material_refs`, `reason_refs`, `parent_ref`,
`ports`, `inputs`, `content_uses`

Optional keys (9): `answer_other`, `answer_parts`, `boundaries`, `exceptions`,
`extensions`, `formation_rule`, `lifecycle`, `misuse`, `result`

## 6. `judgment.method.components[]`

Required: `id`, `method`, `role`, `material_refs`. Optional: `content_ref`,
`statement`.

`role` is required and takes its value from the contract vocabulary (for example
`识别特征`, `类别定义`, `匹配办法`). Do not drop a required role and do not add an
undefined property; a required component that does not fit the author's material
stays as declared rather than being invented.

## 7. Before you create

1. exactly `manifest`, `payload` and `members` at the top level;
2. `members` is an array (an empty one is fine) and every entry has exactly
   `name`, `type: "file"`, `mode` and canonical `bytes_base64`;
3. all 13 manifest keys present, spelled exactly as above;
4. all 22 payload keys present and 15 required keys in each judgment;
5. every method component has its four required keys, with `role` from the
   vocabulary;
6. timestamps are UTC `YYYY-MM-DDTHH:MM:SS(.sss)Z`;
7. when revising, change the version in all four places: `manifest.version`,
   `manifest.judgment_version`, `payload.asset.asset_version`,
   `payload.asset.judgment_version`;
8. save to a new file name; this CLI never replaces an existing file.

## 8. What a failure looks like today

The middle column reports only what this CLI actually prints. The last column is
guidance, not observed output. Rows marked *observed* were re-run against the
current source; the rest are reported by the external evaluation and were not
reproduced on this machine.

| Input                                              | Reported (observed)                                                                                                                                       | Guidance (not output)                                                                                    |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| misspelled manifest key (for example `summaryy`)   | *observed* `SOURCE_INPUT_INVALID` at stage `input`, no field pointer                                                                                      | check the required key lists above; the pointer is a known gap                                           |
| `members` missing from the top level               | *observed* `SOURCE_INPUT_INVALID` with `field: /`, `reason: key_set`, `missing: ["members"]`                                                               | the creation input always carries all three top-level keys                                               |
| `members` null or not an array                     | *observed* `SOURCE_INPUT_INVALID` with `field: /members`, `reason: null` or `not_array`                                                                    | an empty array means "no attachments"; `null` is not an empty array                                      |
| member entry missing a key or carrying an extra one | *observed* `SOURCE_INPUT_INVALID` with `field: /members/<i>`, `reason: key_set`, `missing`/`unexpected`                                                    | member entries have exactly the four keys in §2                                                          |
| `bytes_base64` that is not canonical base64        | *observed* `SOURCE_INPUT_INVALID` with `field: /members/<i>/bytes_base64`, `reason: not_canonical_base64`                                                  | re-encode the bytes; no whitespace, no padding shortcuts, no URL-safe alphabet                           |
| a fourth top-level key                             | *observed* `SOURCE_INPUT_INVALID` with `field: /`, `reason: key_set`, `unexpected: [...]`                                                                  | Core adds `format_version` and `payload` after creation; do not add them yourself                         |
| invalid `method.components[].role`                 | `READ_CORE_INVALID` with `field: /payload/judgments/0/method/components/0/role`                                                                            | the vocabulary is fixed; a role the author did not give is not invented                                  |
| empty file vs truncated container                  | **indistinguishable**: both `READ_CORE_INVALID`, stage `input`, `diagnostic: null`                                                                         | a truncated file is not reported differently from an empty one                                            |
| container `0.5` (Studio) asset                     | `READ_CORE_INVALID`, `diagnostic: null` — **reported by the external evaluation, not reproduced here** (no `0.5` asset was available on this machine)      | this native entry admits the `0.6` container; Studio-authored assets belong to the separate Studio route   |

The `diagnostic` object appears on the creation-input route; `inspect`, `read`
and Source still report their own codes. The missing field pointer for
Core-level shape errors is a known gap; this page is the reference to check
against until the diagnostic carries one.
