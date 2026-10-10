# Authoring field reference (native `0.6` creation input)

This page is for the `kdna create <authored.json>` input. It is bound to the
coordinate this package ships against: container `0.6.0`, `kdna.core/0.8.2`,
`kdna.canonical-ir/0.6.1`, `kdna.read/0.7.0-candidate`, CLI
`0.39.0-rc.native-sections.3`. Declaring a version here does not make an asset
valid, and admission is not read permission.

Working example: `examples/team-update/author.json` (the only input this
repository ships that is known to create successfully).

## 1. Top level

Exactly two keys: `manifest` and `payload`.

## 2. `manifest` required keys (13)

`asset_id`, `asset_uid`, `asset_type`, `title`, `version`, `judgment_version`,
`created_at`, `updated_at`, `compatibility`, `runtime`, `summary`, `languages`,
`history`

Optional keys (8): `creator`, `content_digest`, `authoring`, `access`, `license`,
`description`, `keywords`, `lineage`

`format_version` and `payload` are not part of the creation input; Core adds them
to the produced asset.

## 3. `payload` required keys (22)

`profile`, `profile_version`, `asset`, `actors`, `scope`, `judgments`,
`asset_capability`, `declarations`, `kernel`, `shared_declarations`, `materials`,
`reasons`, `sources`, `source_uses`, `resources`, `relationships`, `dependencies`,
`contracts`, `conditions`, `exceptions`, `misuse`, `examples`

Optional keys (5): `attributions`, `cohesion`, `content_risk`, `extensions`,
`reading_order`

## 4. `payload.judgments[]` required keys (15)

`id`, `focus`, `subject`, `scope`, `form`, `answer_kind`, `core_expression`,
`result_contract`, `method`, `material_refs`, `reason_refs`, `parent_ref`,
`ports`, `inputs`, `content_uses`

Optional keys (9): `answer_other`, `answer_parts`, `boundaries`, `exceptions`,
`extensions`, `formation_rule`, `lifecycle`, `misuse`, `result`

## 5. `judgment.method.components[]`

Required: `id`, `method`, `role`, `material_refs`. Optional: `content_ref`,
`statement`.

`role` is required and takes its value from the contract vocabulary (for example
`识别特征`, `类别定义`, `匹配办法`). Do not drop a required role and do not add an
undefined property; a required component that does not fit the author's material
stays as declared rather than being invented.

## 6. Before you create

1. exactly `manifest` + `payload` at the top level;
2. all 13 manifest keys present, spelled exactly as above;
3. all 22 payload keys present and 15 required keys in each judgment;
4. every method component has its four required keys, with `role` from the
   vocabulary;
5. timestamps are UTC `YYYY-MM-DDTHH:MM:SS(.sss)Z`;
6. when revising, change the version in all four places: `manifest.version`,
   `manifest.judgment_version`, `payload.asset.asset_version`,
   `payload.asset.judgment_version`;
7. save to a new file name; this CLI never replaces an existing file.

## 7. What a failure looks like today

The middle column reports only what this CLI actually prints. The last column is
guidance, not observed output.

| Input                                            | Reported (observed)                                                                                                                                   | Guidance (not output)                                                                                    |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| misspelled manifest key (for example `summaryy`) | `SOURCE_INPUT_INVALID` at stage `input`, no field pointer                                                                                             | check the required key lists above; the pointer is a known gap                                           |
| invalid `method.components[].role`               | `READ_CORE_INVALID` with `field: /payload/judgments/0/method/components/0/role`                                                                       | the vocabulary is fixed; a role the author did not give is not invented                                  |
| empty file vs truncated container                | **indistinguishable**: both `READ_CORE_INVALID`, stage `input`, `diagnostic: null`                                                                    | a truncated file is not reported differently from an empty one                                           |
| container `0.5` (Studio) asset                   | `READ_CORE_INVALID`, `diagnostic: null` — **reported by the external evaluation, not reproduced here** (no `0.5` asset was available on this machine) | this native entry admits the `0.6` container; Studio-authored assets belong to the separate Studio route |

The first three rows were reproduced on this machine; that is stated where it
matters. The missing field pointer for input-shape errors is a known gap; this
page is the reference to check against until the diagnostic carries one.
