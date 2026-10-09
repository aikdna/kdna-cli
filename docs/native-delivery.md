# Exact native CLI delivery

The unpublished CLI candidate `0.39.0-rc.native-sections.3` uses Core
`0.37.1-rc.browser.1` and Read `0.11.2-rc.browser.1`. The CLI package includes its support
guides and the synthetic author example. Its exact archive and the complete
offline host are delivered separately; no registry release or download service
is announced here.

Obtain an authorized delivery containing `archives.json`, `package.json`,
`package-lock.json` `LICENSE`, `LICENSE-DOCS`, `NOTICE`, and a `vendor/` directory with twelve exact `.tgz` files.
Before installing, verify each archive's length, SHA256 and npm integrity against
the delivered receipt. Verify the host manifest and lock hashes recorded in that receipt before installation. The host and lock must select those same twelve archives,
including this CLI candidate, with relative `file:vendor/` locations. Same-version
checkouts and older archive receipts cannot substitute for those bytes.

Use Node `22.22.3` for the reproducible environment. From the delivery directory:

```sh
npm ci --offline --ignore-scripts --omit=optional --no-audit --no-fund
node node_modules/@aikdna/kdna-cli/src/cli.js --help
node node_modules/@aikdna/kdna-cli/examples/native-workflow.cjs node_modules/@aikdna/kdna-cli/examples/team-update/author.json ./team-update-output
```

The recipe resolves the public CLI export from the current host directory. It
requires a new output directory and keeps both original and revised files.
See the [author example](../examples/team-update/README.md) for the disclosed
content, same-session expansion and full Source revision behavior. A successful
scripted run does not prove that a person or another Agent used the content.

The CLI's exact companion binding records Core archive SHA256
`81639dd57dc3a56a2d9171ce3a6ce956847f4877461b8722897e4f598aa8a8ca`
and Read archive SHA256
`c5c2d6b65c44dd30aeddd49d6f2a4c915e9fd4d8f2a28297d6d677564e261cb7`.
The candidate's own archive identity must come from its delivered receipt.
Earlier archive lists and host templates describe their own byte identities;
they do not identify this combination. Preserve a complete older set for rollback
rather than mixing archives or reusing sessions and handles across hosts.

`cbor-extract` is optional in `cbor-x` and is excluded with `--omit=optional`.
No compiled acceleration is delivered by this host, and install scripts remain
disabled. Core's reference API and live checkout are separate surfaces from the
native archive combination. There is no retired loader fallback.

## License delivery

Keep LICENSE and NOTICE files from the KDNA packages and preserve
third-party license files. KDNA code is Apache-2.0; documentation and examples
are CC BY 4.0 as stated in NOTICE. Keep the supplied LICENSE-DOCS text with
the complete delivery. The delivery receipt records declared licenses and
their archive members. Most dependencies declare MIT; `fast-uri` declares
BSD-3-Clause and `pako` declares `(MIT AND Zlib)`. These coordinates do not replace
the license terms.

Technical installation, file saving and asset admission do not establish author
confirmation, task adoption, action permission or publication approval.

## Rebuild a complete source delivery

From the source repository with Node22 and npm on PATH, run `node scripts/create-native-delivery.cjs /absolute/path/to/new-delivery`. The destination must not exist. The generator verifies all eleven companion inputs and their license members, checks the real npm pack report against the allowlist, matches every CLI archive member and mode to its source file, and emits the twelve archives, SHA/SRI and source-member receipt, root license texts and an offline consumer lock with manifest/lock hashes. Install and run the recipe above from that new directory. The root hybrid lock (future exact Core/Read registry coordinates plus vendored third-party archives) and this complete offline consumer are separate acquisition routes to the same declared package versions; neither falls back to a global CLI.
