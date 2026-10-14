# Authoring field reference (native `0.6` creation input)

This page is for the `kdna create <authored.json>` input. It is bound to the
coordinate this package ships against: container `0.6.0`, `kdna.core/0.8.2`,
`kdna.canonical-ir/0.6.1`, `kdna.read/0.7.0-candidate`, CLI
`0.40.0`. Declaring a version here does not make an asset
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

`asset_capability` is not free text: it must equal the closed mapping of the
judgment `form` values — every judgment `conclusion` → `asserted_answers`,
every judgment `rule` → `result_forming_rules`, both forms present → `mixed`.
A contradicting value is refused with `READ_CORE_INVALID` at
`/payload/asset_capability` (observed).

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

Optional keys (7): `answer_other`, `answer_parts`, `boundaries`, `exceptions`,
`extensions`, `lifecycle`, `misuse`

Conditional keys (2): `result` and `formation_rule` follow `form` —
`form: "conclusion"` requires `result` and refuses `formation_rule`;
`form: "rule"` requires `formation_rule` and refuses `result`. `answer_kind:
"other"` requires `answer_other` carrying all three keys (`name`, `definition`,
`exclusion_reason`); `answer_kind: "composite"` requires `answer_parts`.

An undecided question inside the author's domain stays a judgment with
`answer_kind: "other"` and an `answer_other` definition saying the author has
not decided. Moving it to `out_of_domain`/`none` or dropping it is not
equivalent to keeping it, and nothing downstream can tell the difference —
see §6 for the matching rule about a method the author never stated.

## 6. `judgment.method.components[]`

Required: `id`, `method`, `role`, `material_refs`. Optional: `content_ref`,
`statement`.

Every component's `method.term` equals the judgment's `method.method.term`,
and `components` is never empty. `role` is required and takes its value from
the fixed per-term vocabulary below; a duplicate role, a role from another
term's set, or a missing required role is refused with `READ_CORE_INVALID`
pointing at `…/method/components` (the pointer names the array, not the
offending role). Do not add an undefined property; a required component that
does not fit the author's material stays as declared rather than being
invented.

The required and optional role sets per method term, generated from the
contract this CLI binds (`composite` instead carries `plan` and `units`):

<!-- method-role-table:start -->
| method term | required roles | optional roles |
| --- | --- | --- |
| `analogy` | 参照对象、对应关系、借用办法 | 关键差异、不可迁移之处 |
| `calculation` | 输入与含义、计算关系 | 计算假设、取值边界、误差说明 |
| `causal_analysis` | 待解释现象、原因关系 | 候选原因、区分依据、反向情况 |
| `criteria_comparison` | 判断标准、对照办法、归结办法 | 底线要求、例外情况 |
| `elimination` | 候选范围、排除条件、保留办法 | 特殊情况处理 |
| `evidence_analysis` | 所用材料、材料与判断的联系 | 反向材料、材料取舍 |
| `experience` | 经验要点 | 参考经历、适用情形、例外情况 |
| `feedback` | 调整目标、反馈信号、调整办法 | 停止条件、冲突处理 |
| `feeling` | 个人感受 | 体验说明、偏好变化 |
| `inference` | 判断前提、推导关系 | 关键假设、例外情况 |
| `interpretation` | 解读对象、解释关系 | 相关语境、理解线索、替代解读 |
| `observation` | 观察依据 | 判定口径、观察限制 |
| `other` | 方法说明、判断依据、作用关系 | 补充说明、适用限制 |
| `recognition` | 识别特征、类别定义、匹配办法 | 易混淆情况 |
| `simulation` | 起点条件、变化假设、演变关系 | 情景分叉、转折信号 |
| `tradeoff` | 候选方案、比较因素、取舍原则 | 不可兼得之处、优先变化 |
<!-- method-role-table:end -->

When the author has not stated a method at all, do not pick a term for them:
use `method.term: "other"` with the required `other` definition
(`name` / `definition` / `exclusion_reason`) stating the absence, and keep the
three `other` roles (方法说明、判断依据、作用关系) as explicit not-stated
components. A term chosen by the encoder passes admission silently and reads
back exactly like a stated method, so this substitution is the one error no
downstream check can detect.

## 7. Before you create

1. exactly `manifest`, `payload` and `members` at the top level;
2. `members` is an array (an empty one is fine) and every entry has exactly
   `name`, `type: "file"`, `mode` and canonical `bytes_base64`;
3. all 13 manifest keys present, spelled exactly as above;
4. all 22 payload keys present and 15 required keys in each judgment;
5. every method component has its four required keys, with `role` from the
   per-term table in §6, every required role present exactly once, and the
   component's `method.term` equal to the judgment's; each judgment's `form`
   conditions from §5 hold (`result` for `conclusion`, `formation_rule` for
   `rule`);
6. timestamps are UTC `YYYY-MM-DDTHH:MM:SS(.sss)Z`;
7. when revising, change the version in all four places: `manifest.version`,
   `manifest.judgment_version`, `payload.asset.asset_version`,
   `payload.asset.judgment_version`;
8. save to a new file name; this CLI never replaces an existing file.

## 8. What a failure looks like today

The middle column reports only what this CLI actually prints. The last column is
guidance, not observed output. Rows marked *observed* were re-run against the
current source; the container rows were observed on **all three native read
entries** (this CLI, the browser section-bytes entry and the `sections-node`
path entry), which report the same code, stage and diagnostic for the same file.
The rest are reported by the external evaluation and were not reproduced on this
machine.

| Input                                              | Reported (observed)                                                                                                                                       | Guidance (not output)                                                                                    |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| misspelled manifest key (for example `summaryy`)   | *observed* `SOURCE_INPUT_INVALID` at stage `input`, no field pointer                                                                                      | check the required key lists above; the pointer is a known gap                                           |
| `members` missing from the top level               | *observed* `SOURCE_INPUT_INVALID` with `field: /`, `reason: key_set`, `missing: ["members"]`                                                               | the creation input always carries all three top-level keys                                               |
| `members` null or not an array                     | *observed* `SOURCE_INPUT_INVALID` with `field: /members`, `reason: null` or `not_array`                                                                    | an empty array means "no attachments"; `null` is not an empty array                                      |
| member entry missing a key or carrying an extra one | *observed* `SOURCE_INPUT_INVALID` with `field: /members/<i>`, `reason: key_set`, `missing`/`unexpected`                                                    | member entries have exactly the four keys in §2                                                          |
| `bytes_base64` that is not canonical base64        | *observed* `SOURCE_INPUT_INVALID` with `field: /members/<i>/bytes_base64`, `reason: not_canonical_base64`                                                  | re-encode the bytes; no whitespace, no padding shortcuts, no URL-safe alphabet                           |
| a fourth top-level key                             | *observed* `SOURCE_INPUT_INVALID` with `field: /`, `reason: key_set`, `unexpected: [...]`                                                                  | Core adds `format_version` and `payload` after creation; do not add them yourself                         |
| role outside the term's set, duplicate role, or a missing required role | *observed* `READ_CORE_INVALID` with `field: /payload/judgments/0/method/components` (the array, not the offending role; no reason sentence)                | check the per-term role table in §6; empty `components` is also refused here                             |
| `method` key absent from a judgment                | *observed* `READ_CORE_INVALID` with `field: /payload/judgments/0/method`                                                                                   | when the author has stated no method, use the `other` encoding in §6 rather than choosing a term         |
| judgment `exceptions.value[]` entry is only an id  | *observed* `READ_CORE_INVALID` with `field: /payload/judgments/0/exceptions/value/0/statement`                                                             | `exceptions.value[]` carries complete exception objects (`statement`, `boundary_ref`, `applies_to`, `when`, `effect`), not references                                   |
| material missing `source_refs`                     | *observed* `READ_CORE_INVALID` with `field: /payload/materials/0/source_refs`                                                                              | every material declares `source_refs`; an empty array is allowed but the key is required                 |
| empty file (no container structure)                | *observed* `READ_INPUT_INVALID`, stage `input`, `diagnostic: null`                                                                                        | the input is not a container at all                                                                      |
| truncated or damaged container                     | *observed* `READ_CORE_INVALID`, stage `input`, `diagnostic: null`                                                                                          | the container is recognisable but incomplete; structural damage is not reported as a missing container   |
| container of another family (for example Studio `0.5`) | *observed* `READ_UNSUPPORTED_VERSION`, stage `metadata`, `field: /payload.kdnab`                                                                        | this native entry admits the `0.6` container; use the route that belongs to that family                  |
| `form: "conclusion"` judgment without `result`     | *observed* `READ_CORE_INVALID` with `field: /payload/judgments/0/result`                                                                                  | `conclusion` requires `result`; `rule` requires `formation_rule` and refuses `result` (§5)               |
| `answer_other` carrying plain text instead of the definition object | *observed* `READ_CORE_INVALID` with `field: /payload/judgments/5/answer_other`                                                            | `answer_other` needs all three keys `name`, `definition`, `exclusion_reason` (§5)                        |
| `asset_capability` contradicting the judgment forms | *observed* `READ_CORE_INVALID` with `field: /payload/asset_capability`                                                                                    | use the closed mapping in §4; the judgment-level `form` stays authoritative                              |

The `diagnostic` object appears on the creation-input route; `inspect`, `read`
and Source still report their own codes. The missing field pointer for
Core-level shape errors is a known gap; this page is the reference to check
against until the diagnostic carries one.

## 9. `relationships[]`, `shared_declarations[]` and boundary entry shapes

The shapes below are generated from the exact Core this CLI binds; the entries
themselves are optional and stay empty when the author's material produces no
such content.

A `relationships[]` entry carries exactly `id`, `kind`, `direction`,
`participants` (exactly two `{judgment_ref, role}`), `operator`, `effect` and
`statement`. `kind`, `operator`, `effect` and each `participants[].role` are
plain `{term}` references; the four normative tuples are:

<!-- entry-shapes:start -->
| relation kind | direction    | participant roles            | operator           | effect                   |
| ------------- | ------------ | ---------------------------- | ------------------ | ------------------------ |
| `support`     | `directed`   | `supporter` → `claim`        | `supports`         | `offers_support`         |
| `complement`  | `directed`   | `supplement` → `base`        | `complements`      | `adds_perspective`       |
| `qualify`     | `directed`   | `qualifier` → `qualified`    | `qualifies`        | `limits_interpretation`  |
| `conflict`    | `undirected` | `side_a` ↔ `side_b`          | `conflicts_with`   | `preserves_disagreement` |

- `boundary_effect`: `exclude`, `limit`, `out_of_domain`
- shared text declaration `kind`: `worldview`, `value_order`
- declaration unprovided `state`: `unknown`, `none`, `not_applicable`
<!-- entry-shapes:end -->

A `shared_declarations[]` entry is one of two shapes, both carrying `id`,
`subject` (`{actor_ids, statement}`), `applies_to` and `kind`:

- `kind: "worldview"` or `"value_order"` — `value` is a non-empty list of texts
  (`value_order` is ordered; write the ranking in the author's stated order);
- `kind: "role"` — `value` carries at least one of `acts_as`,
  `does_not_act_as`, `responsibility` as `{state, value}` declarations.

`applies_to` is `{"kind": "asset"}` for the whole work, or
`{"kind": "judgments", "judgment_refs": [...]}` for named judgments.

A boundary declaration (`declarations.boundaries`, and a judgment's own
`boundaries`) is one of:

- `{"state": "provided", "value": [Boundary, ...]}`, each `Boundary` carrying
  exactly `id`, `effect`, `statement`, `declared_by`, `applies_to`,
  `exception_refs` (an empty array when the author names no exceptions);
- `{"state": "unknown" | "none" | "not_applicable", "value": null}` — the
  unprovided states stay distinct; `unknown` is not `none`.
