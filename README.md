# KDNA CLI `0.46.0`

Official command-line interface (`@aikdna/kdna-cli@0.46.0`) for authoring, password-protecting/unprotecting, validating, reading, and comparing `.kdna` judgment works.

Public, local, and password-protected `.kdna` workflows in `@aikdna/kdna-cli@0.46.0` run offline on **Node.js `>=22`** and **permanently require no online account**.

- **Website & KDNA Reader (macOS):** [aikdna.com](https://aikdna.com) · [Download KDNA Reader & KDNA Whitepaper v1.0.2](https://aikdna.com/en/downloads)
- **Official Exemplars & Benchmarks (Account-Free):** [Case Studies & `.kdna` Downloads](https://aikdna.com/en/explore/systems) ([Human-Sounding Writing `v1.0.1`](https://aikdna.com/en/explore/human-writing) · [Code Review `v1.0.2`](https://aikdna.com/en/explore/code-review))
- **Specifications & Release Matrix:** [`aikdna/kdna`](https://github.com/aikdna/kdna) ([`release-coordinates.json`](https://github.com/aikdna/kdna/blob/main/docs/release-coordinates.json))
- **Agent Skills & MCP:** [`aikdna/kdna-skills`](https://github.com/aikdna/kdna-skills) (`kdna-creator` & `kdna-loader`)
- **Public Reference Works:** [`aikdna/kdna-assets`](https://github.com/aikdna/kdna-assets)

---

## Quick Start

Install globally or run on demand with `npx` (**Node.js `>=22`** required; no account needed):

```sh
# Option A — Install globally so the `kdna` command is on PATH
npm install -g @aikdna/kdna-cli@0.46.0

# Option B — Run any command below without installing globally by prefixing `npx -y @aikdna/kdna-cli@0.46.0`
npx -y @aikdna/kdna-cli@0.46.0 --help
```

Five everyday workflows with a `.kdna` judgment work—every command below runs directly:

```sh
# 1. Create: generate a ready-to-compile starter draft (omit --example for a TODO template)
kdna init --example --mode interview --output draft.json
kdna validate-input draft.json --format human
kdna create --draft draft.json --output my-judgments.kdna --allow-create

# 2. Read only what the task needs: browse the catalog first, then read selected judgments with full context
kdna read my-judgments.kdna --mode catalog --allow-read --format human
kdna read my-judgments.kdna --mode exact_selection --judgment-id decision:first-dilemma --allow-read --compact

# 3. Export a one-page author review sheet for human sign-off
kdna review my-judgments.kdna --allow-read --output my-judgments-review.md

# 4. Protect with a local password (offline AEAD encryption; interactive TTY prompt or env var, no plaintext file on disk)
kdna protect my-judgments.kdna --output locked.kdna --password-prompt
kdna inspect locked.kdna --metadata --format human
KDNA_PASS='a long passphrase' kdna read locked.kdna --mode exact_selection --judgment-id decision:first-dilemma --allow-read --password-env KDNA_PASS --format human

# 5. Compare two versions in plain text
kdna init --example --mode works --output revised-draft.json
kdna create --draft revised-draft.json --output revised.kdna --allow-create
kdna diff my-judgments.kdna revised.kdna --format human
```

Prefer conversational co-creation with an AI agent instead of editing JSON directly? Install [`aikdna/kdna-skills`](https://github.com/aikdna/kdna-skills) (`kdna-creator` for guided interviews, distillation from existing works, or research; `kdna-loader` for task-scoped selective reading). To explore a complete 45-judgment reference work, open *KDNA Whitepaper* (`v1.0.2`, native `zh-CN` & `en`, by Zhang Ling / 张零, `CC BY 4.0`) in [KDNA Reader for macOS](https://aikdna.com/en/downloads) or inspect it directly from [`aikdna/kdna-assets`](https://github.com/aikdna/kdna-assets).

---

## Operations & Explicit Permissions

Passwords are read only from `--password-env <var>`, `--password-prompt` (hidden TTY), `--password-file`, or an inherited descriptor (`--password-fd`, `>=3`)—never from command-line arguments. Reading and writing require explicit flags so agent hosts never access or overwrite files silently:

| Operation | Command | Explicit Permission |
| --- | --- | --- |
| Scaffold, compile, and check authoring input | `init`, `compile`, `validate-input` | None (reads/prints input or writes a new JSON draft) |
| Pack a native `0.6.0` `.kdna` work | `create` | `--allow-create` (atomic no-replace save) |
| Encrypt or decrypt payload locally with a password | `protect`, `unprotect` | `--password-env`, `--password-prompt`, `--password-file`, or `--password-fd` |
| Inspect metadata and validate integrity | `inspect` (`--metadata`), `validate` | Explicit file path (plus password source to unlock payload) |
| Read catalog, selected judgments, or expansions | `read` | `--allow-read` (plus password source if protected) |
| Render a one-page author review sheet | `review` | `--allow-read` (plus password source if protected) |
| Compare two `.kdna` versions | `diff` | Explicit file paths (shared `--password-*` or `--left-password-*` / `--right-password-*`) |
| Export or repack full authored source | `source-open`, `source-pack` | `--allow-source` and exact `--expected-a` SHA-256 |
| Migrate an explicit `0.5.0` public source to `0.6.0` | `convert` | `--allow-source` and exact `--expected-a` SHA-256 |

---

## Command Reference

```sh
# Authoring & compilation
kdna init --output draft.json
kdna init --mode interview --output interview-draft.json
kdna validate-input draft.json --format human
kdna create --draft draft.json --output asset.kdna --allow-create
kdna compile draft.json --output authored.json
kdna create authored.json --output asset.kdna --allow-create

# Local password protection, pre-unlock manifest summary & decryption
kdna protect asset.kdna --output protected.kdna --password-prompt
kdna inspect protected.kdna --metadata --format human
kdna inspect protected.kdna --password-env KDNA_PASS
kdna unprotect protected.kdna --output restored.kdna --password-env KDNA_PASS
kdna validate asset.kdna

# Scoped reading, one-page review & multi-judgment selection
kdna read asset.kdna --mode catalog --budget 1000000 --allow-read
kdna read asset.kdna --mode exact_selection --judgment-id j:one --judgment-id j:two --allow-read --compact
kdna read asset.kdna --mode exact_selection --judgment-id j:one,j:two --allow-read --format human
kdna read asset.kdna --session --allow-read
kdna review asset.kdna --allow-read --format markdown --output review.md

# Version comparison (including rotated passphrases), source revision & 0.5 -> 0.6 migration
kdna diff old.kdna new.kdna --format human
kdna diff old.locked.kdna new.locked.kdna --left-password-env KDNA_OLD --right-password-env KDNA_NEW --format human
kdna source-open asset.kdna --expected-a 'sha256:<64-lowercase-hex-digits>' --output edits.json --allow-source
kdna source-pack asset.kdna --edits edits.json --expected-a 'sha256:<64-lowercase-hex-digits>' --output revised.kdna --allow-source
kdna convert asset.kdna --expected-a 'sha256:<64-lowercase-hex-digits>' --output converted.kdna --allow-source
```

### Key Behavioral Notes

- **Authoring drafts (`init`, `validate-input`, `compile`):** `init` generates a `kdna.draft/1` document across four cross-domain modes (`minimal`, `interview`, `works`, `research`) in English (`--lang en`, default) or Chinese (`--lang zh`) using canonical ASCII method-role keys (legacy Chinese role keys remain accepted in drafts and on admission). `kdna.draft/1` supports minimal drafts unchanged as well as optional `creator`, `worldview`, `value_order`, `sources` / `source_refs`, `sections` (`extension:reading-sections`), `relationships`, `exceptions` (`waive` or `replace_boundary`), `misuse`, `form: "rule"` (`formation_rule`), and open/undecided questions (`answer_kind: "other"` + `answer_other`). Omitting `method` on a draft judgment records that absence explicitly via `method.term: "other"`. Pass `--example` for an immediately compilable starter, or omit it for `TODO:` prompts checked before `compile` and `create --draft`. `validate-input` checks drafts, full authored JSON, and `source-open` `.edits` documents. See [`docs/authoring-field-reference.md`](./docs/authoring-field-reference.md).
- **Selective reading (`read` & `review`):** `catalog` lists judgment IDs without bodies; `exact_selection` returns the chosen judgments together with their mandatory supporting and qualifying context (`--judgment-id` may repeat or take a comma-separated list; `--compact` trims wrapper envelopes while keeping every safety boundary, conditional exception, reason, example, and relation intact; `--budget` defaults to `1000000` bytes on `catalog` / `exact_selection` and `4000000` bytes on `whole_asset`). `kdna review <asset.kdna> --allow-read [--format markdown|human|json] [--output <review.md>]` renders a complete one-page author review sheet (asset scope, shared declarations, every judgment, rule conditions, open-question markers, boundaries, conditional exceptions with trigger `when` and `replace_limit`/`waive`, misuse warnings, and related judgments) for human sign-off. `--format human` renders `inspect`, `validate`, `read`, `review`, `protect`, `unprotect`, and `diff` in clean plain text (using English method-role labels on English works and localized Chinese labels on Chinese works). See [`docs/consumption-runtime.md`](./docs/consumption-runtime.md).
- **Local password protection (`protect`, `unprotect`):** `protect` encrypts `payload.kdnab` with a Container `0.6.0` offline AEAD envelope (`scrypt-sha256` / `argon2id` + `AES-256-KW` + `AES-256-GCM` per `kdna.envelope.aead`), noting explicitly that outer `kdna.json` manifest fields (`title`, `summary`, `creator`, `keywords`, `version`) remain unencrypted for file identification (`kdna inspect --metadata` reads only that outer manifest). Passphrases are read once per side from `--password-env <var>` (cross-platform), `--password-prompt` (hidden TTY with confirmation on `protect`; fails closed on non-TTY), `--password-file <path>`, or `--password-fd <fd>`, stripping one trailing newline and zeroing secret buffers on exit; `kdna diff` also supports `--left-password-*` and `--right-password-*` for rotated passphrases. `unprotect` decrypts a password-protected `0.6.0` container back into an unprotected `0.6.0` section container atomically. Wrong passwords fail with `PROTECTION_AUTHENTICATION_FAILED`; missing passwords fail with `KDNA_PASSWORD_REQUIRED`. Keep your unencrypted authoring draft or public `.kdna` (or run `kdna unprotect`) for future revisions.
- **Safe saving & exit codes:** File saves never overwrite existing paths or symlinks—always choose a new filename for a revision. Exit codes: `0` on success/ready, `1` on validation/auth/save rejection, and `2` on invalid CLI arguments or retired commands.

---

## Programmatic JavaScript API

```js
const { run } = require('@aikdna/kdna-cli');

const exitCode = await run(['validate', '/absolute/path/asset.kdna'], process.stdout);
```

`run(argv, stdout = process.stdout, stdin = process.stdin)` is the package's sole programmatic export:
- Resolves to the numeric CLI exit code (`0`, `1`, or `2`) after sequential writes complete, honoring Node.js `Writable` backpressure.
- Accepts any async iterable of UTF-8 lines/chunks on `stdin` for `--session` JSONL mode, closing cleanly on EOF or output error without leaving background handles open.

---

## Offline Verification & Contract Boundaries

`@aikdna/kdna-cli@0.46.0` binds to exact companion packages (`@aikdna/kdna-core@0.37.11` and `@aikdna/kdna-read@0.13.5`, container `0.6.0`, recorded in [`public-contract-binding.json`](./public-contract-binding.json)). See [`docs/native-delivery.md`](./docs/native-delivery.md) and [`examples/team-update/README.md`](./examples/team-update/README.md) for offline host setup:

```sh
npm ci --prefix release-surface/native-offline-host --offline --ignore-scripts --omit=optional --no-audit --no-fund
export NODE_PATH="$PWD/release-surface/native-offline-host/node_modules"
npm run build
npm test
```

**Boundaries:** Technical validation confirms container structure and digests, never whether a judgment is true or suitable for your task. Reading content (`--allow-read`) delivers structured judgment text and never grants filesystem mutation, network, payment, or external execution permissions (see [`docs/asset-authorization.md`](./docs/asset-authorization.md)).

## Licenses

Code is licensed under [Apache-2.0](./LICENSE); documentation and bundled examples are licensed under [CC BY 4.0](./LICENSE-DOCS) as stated in [`NOTICE`](./NOTICE).
