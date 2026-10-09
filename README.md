# KDNA CLI 0.39.0-rc.native-sections.3

This unpublished candidate delegates native container production, admission and disclosure to the exact companion Core and Read archives. It does not interpret assets independently.

| Operation | Current candidate command | Explicit permission |
| --- | --- | --- |
| Produce a new native asset | `create` | `--allow-create` |
| Technical admission and metadata | `inspect`, `validate` | Explicit file argument |
| Catalog, selected content and retained expansion | `read` | `--allow-read` |
| Open full authored values or save a revision | `source-open`, `source-pack` | `--allow-source` and exact `--expected-a` |

Plan admission, load/execution and retired commands remain unavailable (exit 2).
The [Read guide](./docs/consumption-runtime.md) and
[authorization guide](./docs/asset-authorization.md) distinguish this native
candidate from their preserved historical loading contracts.

The package includes the [normal author example](./examples/team-update/README.md),
the Read and authorization guides, and SECURITY. The example covers creation,
retained Read, Source revision and a new-file Read. Follow the
[delivery guide](./docs/native-delivery.md) to install an exact offline host and
run the recipe from its installed package location. The example is synthetic
teaching content; it does not establish Agent task adoption or human acceptance.

## Commands

```sh
kdna create authored.json --output asset.kdna --allow-create
kdna inspect asset.kdna
kdna validate asset.kdna
kdna read asset.kdna --mode catalog --budget 1000000 --allow-read
kdna read asset.kdna --mode exact_selection --asset-id asset:example --asset-version 1.0.0 --judgment-id j:example --budget 1000000 --allow-read
kdna read asset.kdna --session --allow-read
kdna source-open asset.kdna --expected-a 'sha256:<64-lowercase-hex-digits>' --allow-source
kdna source-pack asset.kdna --edits edits.json --expected-a 'sha256:<64-lowercase-hex-digits>' --output revised.kdna --allow-source
```

`create` accepts an Agent-authored UTF-8 JSON document with exactly `manifest`, `payload` and `members`. Each member has exactly `name`, `type: "file"`, `mode` and canonical `bytes_base64`. Generated container fields (`format_version`, `payload`, `representation_metadata`) do not belong in the authored Manifest. Core validates the complete Manifest, Payload, attachment names, references and native output. No authored fields are silently removed. An empty `members` array is valid for an asset without attachments. This is a public unsigned production route; it does not create encrypted containers, checksums or signatures.

The transport rejects duplicate decoded JSON keys, invalid UTF-8, lone surrogate escapes and non-finite numbers. It accepts regular files up to 20 MiB and nesting up to 128, with decoded attachments limited to 8 MiB each and 12 MiB total. Core independently applies its semantic and final container limits. Attachment base64 is a transport representation, not a Payload string or file path.

`--allow-create` permits this invocation to encode and save the supplied input. Saving uses a complete, synced temporary file in the destination directory and an atomic no-replace link. Existing files and symlinks are never replaced; use a new filename for a revision. Exit 0 reports `saved`, exact byte length and SHA256, producer evidence, and separate unevaluated authority states. It does not establish author confirmation, Creation completion or task adoption. A retained temporary file after successful publication is reported explicitly. This mechanism does not promise directory durability across power loss. Observed output failure prevents a new save or commit from starting; an already in-flight filesystem link can finish, and a saved file may remain when its output acknowledgement fails.

`inspect` and `validate` authorize technical Whole admission of the explicitly named native file. Inspect reports metadata, scalar IR digest and full verification evidence; it does not emit judgment bodies. Read requires `--allow-read`; otherwise it returns `KDNA_READ_PERMISSION_REQUIRED` before opening the file or consuming session input. This permission allows admission and requested projections, and does not authorize actions. Files are captured through one nonblocking, no-follow descriptor, must be regular files, and are limited to 25 MiB, including actual reads if the file grows. FIFOs, directories and symlinks are rejected. The captured bytes enter the official native byte admission API; its zero asset filesystem-read count excludes the CLI's file capture and does not attest to later pathname contents. The first admitted Whole snapshot is retained, so the response budget bounds disclosure rather than file capture or admission memory. Ready and metadata-only catalog results exit 0. Observed output failure prevents subsequent reads or admission from starting; already pending filesystem work is not forcibly canceled.

Session mode consumes one current native retained Read request per line. Selection uses `judgment_ids: ["j:example"]`. Keep the same process and Host provider running, and send a returned `expansion_handles` object unchanged for `expand`. Each request receives a fresh, single-use preparation. Handles from a reopened file or another process do not gain authority. JSON lines must be valid UTF-8, have no duplicate keys, and be at most 1 MiB. The contract tuple is recorded in `public-contract-binding.json`.

`source-open` and `source-pack` require `--allow-source` before edit or asset files are opened. Supply the exact asset SHA256 as `--expected-a`; it is passed unchanged to the official Source API. A wrong or stale digest is rejected after Source authorization and native admission, before authoring content is returned. The CLI captures the original asset using the same bounded regular-file ingress as Read. Protected representations use a separate Host route and are not opened or revised through these commands.

`source-open` returns an observation and an `edits` object containing the complete authored Manifest and Payload. Save only that `edits` object as the JSON input for `source-pack`, with exactly two non-null object fields, `manifest` and `payload`. These are full replacement values, not a merge patch. The observation is metadata, not an editing token. Resource bytes and derived logical-payload bytes are omitted from this JSON projection; pack requires the original asset and retains its original members through native Source. Core rebuilds the native tables, validates references and readmits the output. Original signature and checksum members are retained and reverified; this route does not strip them or re-sign an edited asset.

Edit JSON has the same strict UTF-8, duplicate-key, surrogate, finite-number and nesting checks as authored input, with a 20 MiB regular-file transport limit. Core applies its own semantic and container limits. No nested authored fields are removed. When changing the asset version, update both `manifest.version` and `payload.asset.asset_version`; unchanged content still receives new native IDs under the new asset identity. Save to a new `.kdna` filename and consume the new file to obtain fresh process-local handles. Saving and output-failure behavior follow the no-replace policy above; already pending Source work can complete after output fails, without starting a new save once failure is observed.

Exit codes: 0 for source-opened/saved/accepted/ready/catalog operations, 1 for rejection, failed save or non-ready Read, and 2 for invalid CLI arguments or unavailable commands. Plan admission and execution remain unavailable. Retired packing, conversion and execution commands are not supported.

## JavaScript API

```js
const { run } = require('@aikdna/kdna-cli');
const exitCode = await run(['validate', '/absolute/path/asset.kdna'], process.stdout);
```

`run(argv, stdout = process.stdout, stdin = process.stdin)` is the sole JavaScript export. It resolves to the exit code; it rejects if output fails or closes before completion. Node Writable output is acknowledged only after its write callback completes. Writes are sequential, including under backpressure. For an in-memory synchronous sink, provide `write(text)` returning true after storing the text; a write-only sink returning false is unavailable. The caller owns the output stream and may end it after `run` settles. Session input must be an async iterable of string or byte chunks; ending input closes the session. Read output failure closes iteration and prevents a successful delivery acknowledgement. This package declares no TypeScript SDK. Output failure also terminates a session waiting for its next input item, and a later line or EOF cannot turn that failure into success. The first output failure is preserved through run completion. The CLI destroys Node Readable input on output failure and requests the iterator's return method where available. A custom async iterator must cooperate to release its own pending work: the CLI cannot force arbitrary next/return promises to settle. Such late rejections are observed, while run rejects without waiting indefinitely for uncooperative cleanup. Already completed output lines remain completed; a local write callback does not prove remote consumption. After run settles, the caller owns later output errors and stream closure. One run-level failure boundary remains active through normal input cleanup, including a return promise that began while output was healthy. A later output failure ends that run without waiting for the external return promise; its late result or rejection remains observed and cannot resume input or output. Healthy delayed cleanup still waits for its actual completion. The CLI requests iterator return at most once and awaits diagnostic output before initiating malformed-input cleanup.

## Local validation and packaging

Use Node 22 or later with the exact companion archives in `vendor/`; do not substitute packages based on matching version strings. `release-surface/dependency-archives.json` lists eleven active SHA256/SRI-bound archive inputs. Earlier archives remain as historical inputs and are not selected by the current development lock. The root lock declares the exact registry candidate. Before those versions are published, use the committed development host lock with the verified companion archives. Optional native acceleration is excluded.

```sh
npm ci --prefix release-surface/native-offline-host --offline --ignore-scripts --omit=optional --no-audit --no-fund
export NODE_PATH="$PWD/release-surface/native-offline-host/node_modules"
npm run build
npm run test:transport
npm test
npm pack --ignore-scripts
```

The native CLI source and dependency graph are candidates. Source feedback revision, the full native CLI product chain and the final combined archive/clean installation must be verified before distribution acceptance; prior tests of the retired tuple are not evidence for this combination. The source publish hook fails closed; publication must use a reviewed retained artifact through the release authority. Seventeen package members are allowlisted, including support guides and the authored example. Tests, retired code, dependency archives, host locks and local caches are excluded from the CLI tarball. The distributor supplies the exact archive receipt and offline host separately.

## Contract and authority

Core `0.37.1-rc.browser.1` archive SHA256 `12a2d5f234ed3404aee1b394442251ad875c1531c01cd6a4f3c0366d55e5d773` and Read `0.11.2-rc.browser.1` archive SHA256 `c5c2d6b65c44dd30aeddd49d6f2a4c915e9fd4d8f2a28297d6d677564e261cb7` supply the required native public export targets. The current tuple is container `0.6.0`, Core `kdna.core/0.8.2`, IR `kdna.canonical-ir/0.6.1` and Read `kdna.read/0.7.0-candidate`; route-definition content identities are recorded in the binding file. A source checkout with the same versions is not automatically byte-equivalent to these archives.

Technical validity, producer observation, filesystem saving, author confirmation, reading permission, task adoption and action authorization remain separate. No CLI operation creates human confirmation or grants network, payment, execution or other Host permissions. There is no legacy loader fallback, automatic asset migration or action executor. Historical material under `retired/` is excluded from builds and distribution.

## Licenses

Preserve the KDNA LICENSE and NOTICE files and all dependency license files. Code is Apache-2.0; documentation and examples are CC BY 4.0 as stated in NOTICE. Keep the supplied LICENSE-DOCS text with the complete delivery. The package metadata license describes code and does not replace these separate terms.
