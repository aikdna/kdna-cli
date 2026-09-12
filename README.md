# KDNA CLI 0.38.0-rc.component-semantics.1

The CLI delegates container admission and disclosure to the pinned public Core and Read packages. It does not parse assets independently.

## Commands

```sh
kdna inspect asset.kdna
kdna validate asset.kdna
kdna read asset.kdna --mode catalog --budget 1000000 --allow-read
kdna read asset.kdna --mode exact_selection --asset-id asset:example --asset-version 1.0.0 --judgment-id j:example --budget 1000000 --allow-read
kdna read asset.kdna --session --allow-read
```

`inspect` emits technical metadata and digests without disclosure content. `validate` emits admission status and public diagnostics. Read defaults to denial; `--allow-read` grants this local process permission to read the selected file. It does not authorize actions. Modes are `catalog`, `whole_asset`, `exact_selection` and session-only `expand`.

Session mode consumes one public ReadRequest JSON object per line and emits one public result per line. Send an `exact_selection` request, then return an issued `expansion_handles` object unchanged in an `expand` request. Keep the same process running. The first Host-observed admitted snapshot is retained for the session. JSON input lines must be valid UTF-8 and at most 1 MiB.

Exit codes: 0 for accepted/ready operations, 1 for rejection or a non-ready Read result, 2 for invalid CLI arguments or unavailable commands. `plan` and `load` return explicit unavailable results. Retired authoring, packing, conversion and execution commands are not supported.

## JavaScript API

```js
const { run } = require('@aikdna/kdna-cli');
const exitCode = await run(['validate', '/absolute/path/asset.kdna'], process.stdout);
```

`run(argv, stdout = process.stdout, stdin = process.stdin)` is the sole JavaScript export. It resolves to the exit code; it rejects if output fails or closes before completion. Node Writable output is acknowledged only after its write callback completes. Writes are sequential, including under backpressure. For an in-memory synchronous sink, provide `write(text)` returning true after storing the text; a write-only sink returning false is unavailable. The caller owns the output stream and may end it after `run` settles. Session input must be an async iterable of string or byte chunks; ending input closes the session. Read output failure closes iteration and prevents a successful delivery acknowledgement. This package declares no TypeScript SDK. Output failure also terminates a session waiting for its next input item, and a later line or EOF cannot turn that failure into success. The first output failure is preserved through run completion. The CLI destroys Node Readable input on output failure and requests the iterator's return method where available. A custom async iterator must cooperate to release its own pending work: the CLI cannot force arbitrary next/return promises to settle. Such late rejections are observed, while run rejects without waiting indefinitely for uncooperative cleanup. Already completed output lines remain completed; a local write callback does not prove remote consumption. After run settles, the caller owns later output errors and stream closure. One run-level failure boundary remains active through normal input cleanup, including a return promise that began while output was healthy. A later output failure ends that run without waiting for the external return promise; its late result or rejection remains observed and cannot resume input or output. Healthy delayed cleanup still waits for its actual completion. The CLI requests iterator return at most once and awaits diagnostic output before initiating malformed-input cleanup.

## Local validation and packaging

Use the exact supplied Core/Read archives and locked dependency artifacts in an isolated prefix. The RC's lockfile records their integrity but does not assert they are published. Do not substitute registry packages based on matching version strings.

```sh
npm ci --offline --ignore-scripts --omit=optional --no-audit --no-fund
npm run build
npm test
npm pack --ignore-scripts
```

Use Node 22 or later. Create a private working prefix with HOME, TMPDIR, XDG_CACHE_HOME and npm cache/config paths under it. Copy the source and the eleven exact companion archives listed in `release-surface/dependency-archives.json` into its `vendor/` directory after verifying their SHA256 and SRI. The source lock uses those relative `file:vendor/` archives, including all nine non-optional transitive dependencies. They are supplied with the local candidate and are not assertions of registry availability. The commands above install from that offline graph. Optional native acceleration is excluded. The package is private and its publish hook fails closed. Its seven package members are explicitly allowlisted; tests, retired code and local caches are not installed.

## Contract and authority

This is an unpublished local release candidate. Package versions do not prove registry availability or independent acceptance. `public-contract-binding.json` records the exact contract tuple and source digests. The implementations bind to Core 0.24.0-rc.component-semantics.2 archive SHA256 `a9cb3f08735b00657e4848766f0ac517abdcb256121a841f01e662525a0858ea` and Read 0.3.0-rc.component-semantics.2 archive SHA256 `43d0f12a1a63a88d26570bfff821919a5cd478fdbd0568bd9c819bc56078b0f0`.

The semantic source SHA256 is `862cea95bdb3a634356ad729b95e0882cb0b75fdb80f103a11f4037783899110` and generated contract SHA256 is `ec8a2616a768f5523e8852487e757f6f9560d1933ea3a9ee90ead69fe1120f4d`. Their public tuple is Core `kdna.core/0.3.0`, IR `kdna.canonical-ir/0.2.0` and Read `kdna.read/0.2.0`. The finite component contract digest is `sha256:3087cd19542e72322aec19b3015c916d2cfb074fa42e3fd76b3756bb4f097de3`.

`inspect` and `validate` preserve Core's public phase states and diagnostic codes. A structurally valid asset whose component interpretation is blocked exits with code 1 and reports `core: valid`, `interpretation: blocked`; it does not disclose interpreted content. Supported taxonomy, candidate-set and discriminator-set bodies, as well as absent versus explicitly empty method declarations, are available through authorized public Read projections. Core admission still precedes interpretation and local read permission. Static adoption declarations do not establish live Creation authority or a human confirmation.

Core admission establishes technical validity. It does not establish authorship, content quality, Creation acceptance, reading permission, or action authorization. Read disclosure requires a trusted embedding provider with explicit scope, identity, time and policy observations. A caller-supplied serialized snapshot or handle does not establish authority. Expansion handles are usable only with the original process-local snapshot and issuing Host provider; reopen creates a different snapshot.

Encrypted, signed and checksum-bearing containers remain capability-unavailable where the accepted Core rejects them. Plan admission and execution are unavailable. There is no legacy loader, raw-payload fallback, asset migration or action executor. Historical files under `retired/` are excluded from builds and distribution; old documentation outside this README is historical, not a supported API contract.
