# KDNA CLI `0.43.4`

Official command-line interface (`@aikdna/kdna-cli@0.43.4`) for authoring, password-protecting, validating, reading, and comparing `.kdna` judgment works.

Public, local, and password-protected `.kdna` workflows in `@aikdna/kdna-cli@0.43.4` run offline on **Node.js `>=22`** and **permanently require no online account**.

- **Website & KDNA Reader:** [aikdna.com](https://aikdna.com) · [Read KDNA Whitepaper v1.0.1 in Browser](https://aikdna.com/reader/?sample=kdna-whitepaper)
- **Specifications & Release Matrix:** [`aikdna/kdna`](https://github.com/aikdna/kdna) ([`release-coordinates.json`](https://github.com/aikdna/kdna/blob/main/docs/release-coordinates.json))
- **Agent Skills & MCP:** [`aikdna/kdna-skills`](https://github.com/aikdna/kdna-skills) (`kdna-creator` & `kdna-loader`)
- **Public Reference Works:** [`aikdna/kdna-assets`](https://github.com/aikdna/kdna-assets)

---

## Quick Start

Four everyday workflows with a `.kdna` judgment work—every command below runs directly:

```sh
# 1. Create: generate a ready-to-compile starter draft (omit --example for a TODO template)
kdna init --example --mode interview --output draft.json
kdna validate-input draft.json --format human
kdna create --draft draft.json --output my-judgments.kdna --allow-create

# 2. Read only what the task needs: browse the catalog first, then read selected judgments with full context
kdna read my-judgments.kdna --mode catalog --allow-read --format human
kdna read my-judgments.kdna --mode exact_selection --judgment-id decision:first-dilemma --allow-read --compact

# 3. Protect with a local password (offline AEAD encryption; no account, no network)
printf '%s' 'a long passphrase' > password.txt
kdna protect my-judgments.kdna --output locked.kdna --password-file password.txt
kdna read locked.kdna --mode exact_selection --judgment-id decision:first-dilemma --allow-read --password-file password.txt --format human

# 4. Compare two versions in plain text
kdna init --example --mode works --output revised-draft.json
kdna create --draft revised-draft.json --output revised.kdna --allow-create
kdna diff my-judgments.kdna revised.kdna --format human
```

Prefer conversational co-creation with an AI agent instead of editing JSON directly? Install [`aikdna/kdna-skills`](https://github.com/aikdna/kdna-skills) (`kdna-creator` for guided interviews, distillation from existing works, or research; `kdna-loader` for task-scoped selective reading). To explore a complete 45-judgment reference work, open *KDNA Whitepaper* (`v1.0.1`, native `zh-CN` & `en`, by Zhang Ling / 张零, `CC BY 4.0`) in [KDNA Reader](https://aikdna.com/reader/?sample=kdna-whitepaper) or [`aikdna/kdna-assets`](https://github.com/aikdna/kdna-assets).

---

## Operations & Explicit Permissions

Passwords are read only from `--password-file` or an inherited descriptor (`--password-fd`, `>=3`)—never from command-line arguments. Reading and writing require explicit flags so agent hosts never access or overwrite files silently:

| Operation | Command | Explicit Permission |
| --- | --- | --- |
| Scaffold, compile, and check authoring input | `init`, `compile`, `validate-input` | None (reads/prints input or writes a new JSON draft) |
| Pack a native `0.6.0` `.kdna` work | `create` | `--allow-create` (atomic no-replace save) |
| Encrypt payload locally with a password | `protect` | `--password-file` or `--password-fd` |
| Inspect metadata and validate integrity | `inspect`, `validate` | Explicit file path (plus password source if protected) |
| Read catalog, selected judgments, or expansions | `read` | `--allow-read` (plus password source if protected) |
| Compare two `.kdna` versions | `diff` | Explicit file paths (plus password source if protected) |
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

# Local password protection & inspection
kdna protect asset.kdna --output protected.kdna --password-file ./password.txt
kdna inspect asset.kdna
kdna inspect protected.kdna --password-fd 3 3< ./password.txt
kdna validate asset.kdna

# Scoped reading & multi-judgment selection
kdna read asset.kdna --mode catalog --budget 1000000 --allow-read
kdna read asset.kdna --mode exact_selection --judgment-id j:one --judgment-id j:two --allow-read --compact
kdna read asset.kdna --mode exact_selection --judgment-id j:one,j:two --allow-read --format human
kdna read asset.kdna --session --allow-read

# Version comparison, source revision & 0.5 -> 0.6 migration
kdna diff old.kdna new.kdna --format human
kdna source-open asset.kdna --expected-a 'sha256:<64-lowercase-hex-digits>' --allow-source
kdna source-pack asset.kdna --edits edits.json --expected-a 'sha256:<64-lowercase-hex-digits>' --output revised.kdna --allow-source
kdna convert asset.kdna --expected-a 'sha256:<64-lowercase-hex-digits>' --output converted.kdna --allow-source
```

### Key Behavioral Notes

- **Authoring drafts (`init`, `validate-input`, `compile`):** `init` generates a `kdna.draft/1` document across four modes (`minimal`, `interview`, `works`, `research`) in English (`--lang en`, default) or Chinese (`--lang zh`). Pass `--example` for an immediately compilable starter, or omit it for `TODO:` prompts checked before `create --draft`. See [`docs/authoring-field-reference.md`](./docs/authoring-field-reference.md).
- **Selective reading (`read`):** `catalog` lists judgment IDs without bodies; `exact_selection` returns the chosen judgments together with their mandatory supporting and qualifying context (`--judgment-id` may repeat or take a comma-separated list; `--compact` trims wrapper envelopes while keeping every safety boundary, reason, example, and relation intact; `--budget` defaults to `1000000` bytes on `catalog` / `exact_selection` and `4000000` bytes on `whole_asset`). `--format human` renders `inspect`, `validate`, `read`, and `diff` in clean plain text. See [`docs/consumption-runtime.md`](./docs/consumption-runtime.md).
- **Local password protection (`protect`):** Encrypts `payload.kdnab` with an offline authenticated-encryption envelope (`PBKDF2` + `AES-256-GCM`), stripping one trailing newline from the supplied password file/descriptor and zeroing secret buffers on exit. Wrong passwords fail with `PROTECTION_AUTHENTICATION_FAILED`; missing passwords fail with `KDNA_PASSWORD_REQUIRED`.
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

`@aikdna/kdna-cli@0.43.4` binds to exact companion packages (`@aikdna/kdna-core@0.37.9` and `@aikdna/kdna-read@0.13.3`, container `0.6.0`, recorded in [`public-contract-binding.json`](./public-contract-binding.json)). See [`docs/native-delivery.md`](./docs/native-delivery.md) and [`examples/team-update/README.md`](./examples/team-update/README.md) for offline host setup:

```sh
npm ci --prefix release-surface/native-offline-host --offline --ignore-scripts --omit=optional --no-audit --no-fund
export NODE_PATH="$PWD/release-surface/native-offline-host/node_modules"
npm run build
npm test
```

**Boundaries:** Technical validation confirms container structure and digests, never whether a judgment is true or suitable for your task. Reading content (`--allow-read`) delivers structured judgment text and never grants filesystem mutation, network, payment, or external execution permissions (see [`docs/asset-authorization.md`](./docs/asset-authorization.md)).

## Licenses

Code is licensed under [Apache-2.0](./LICENSE); documentation and bundled examples are licensed under [CC BY 4.0](./LICENSE-DOCS) as stated in [`NOTICE`](./NOTICE).
