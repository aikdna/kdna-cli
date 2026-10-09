# Publish the exact native CLI preview

The standalone authority in `scripts/preview-release-authority.cjs` supports only
`@aikdna/kdna-cli@0.39.0-rc.native-sections.3`, scoped Git tag
`preview/cli/0.39.0-rc.native-sections.3`, repository `aikdna/kdna-cli` and npm
`native-preview`. It never publishes `latest`. The stable historical verification
jobs remain separate.

The release tools are vendored public source, with immutable upstream commit,
SHA-256 values and adaptations in `scripts/release-tools/ORIGIN.json`. They load
no neighboring checkout or private path. The vendored library exposes only
Git/tar/JSON/npm primitives. Its upstream stable release entry point and stable
authority exports are disabled. The CLI authority owns its entire release
policy. Update this source only by reviewing an exact public upstream commit,
recording origin hashes and adaptations, and running its hostile-case tests.

The npm client is the authenticated npm 11.17.0 tarball, isolated from inherited
npm configuration and the global cache. Source tests use the declared
`release-surface/native-offline-host` graph; the root publication manifest keeps
exact public Core/Read registry coordinates. These are different dependency
acquisition paths. The root source lock is not used as proof of a clean public
consumer.

Before requesting publication, commit a clean DCO-signed source on the canonical
main ancestry. The fixed baseline is
`2adb6d403802e2ba6b9923258959c2179e05e32c`. Every introduced commit must have its
matching author sign-off. Select new absolute output paths outside the checkout:

```sh
node scripts/preview-release-authority.cjs provision-npm --artifact "$OUTPUT/npm-11.17.0.tgz"
export KDNA_TRUSTED_NPM_TARBALL="$OUTPUT/npm-11.17.0.tgz"
node scripts/preview-release-authority.cjs candidate --unit cli \
  --evidence "$OUTPUT/cli-candidate.json" \
  --artifact "$OUTPUT/aikdna-kdna-cli-0.39.0-rc.native-sections.3.tgz"
node scripts/preview-release-authority.cjs candidate-smoke --unit cli \
  --evidence "$OUTPUT/cli-candidate.json" \
  --artifact "$OUTPUT/aikdna-kdna-cli-0.39.0-rc.native-sections.3.tgz"
```

The candidate exports the exact committed Git blobs twice, packs each export,
compares archive bytes and every member's mode/content against the source, and
retains the SHA-256/SHA-512/member manifest. The exact 17 package files are fixed
in the authority and must match both the committed allowlist and package
manifest. Candidate smoke creates a new private consumer and an empty npm
cache, verifies eleven source-bound companion archives and the exact required
source-host lock, adds the retained CLI entry and installs all twelve archives
with offline `npm ci`, compares every installed package member, then executes the
packaged create/inspect/read/expand/source-edit/repack example. Candidate
commands grant no publication authority and never synthesize a GitHub event.

The Owner must review the complete final release text, target account/repository,
public visibility, exact source commit/tree and retained artifact digest, and
explicitly authorize publication. The release body is exactly the `## CLI ...`
section in `docs/release-cli-preview-notes.md`, followed by one final fenced
`kdna-preview-release` block. The following describes its fields; placeholders
are not a valid approval:

```json
{
  "schema": "kdna.preview-release-approval/1",
  "unit": "cli",
  "repository": "aikdna/kdna-cli",
  "source_commit": "FULL_CLI_COMMIT",
  "source_tree": "FULL_CLI_TREE",
  "base_commit": "2adb6d403802e2ba6b9923258959c2179e05e32c",
  "version": "0.39.0-rc.native-sections.3",
  "dist_tag": "native-preview",
  "artifact_sha256": "RETAINED_CLI_SHA256",
  "notes_sha256": "EXACT_NOTES_SHA256",
  "companions": [
    {"name":"@aikdna/kdna-core","version":"0.37.1-rc.browser.1","sha256":"12a2d5f234ed3404aee1b394442251ad875c1531c01cd6a4f3c0366d55e5d773","integrity":"PUBLIC_CORE_SRI","shasum":"PUBLIC_CORE_SHA1","gitHead":"PUBLIC_CORE_COMMIT"},
    {"name":"@aikdna/kdna-read","version":"0.11.2-rc.browser.1","sha256":"c5c2d6b65c44dd30aeddd49d6f2a4c915e9fd4d8f2a28297d6d677564e261cb7","integrity":"PUBLIC_READ_SRI","shasum":"PUBLIC_READ_SHA1","gitHead":"PUBLIC_READ_COMMIT"}
  ]
}
```

A machine block records reviewed coordinates; its mere existence does not prove
human approval. Only the real GitHub `release: published` event for a nondraft
prerelease runs the publishing workflow. Set the GitHub release target to the
full approved source commit, rather than a branch name. Event SHA, scoped tag,
Git commit/tree, clean worktree/index, main ancestry, source notes and approved
artifact SHA are checked again throughout. The preparation phase repeats both
source packs; it rejects a changed artifact instead of substituting a new pack.

Core and Read must already be public at their approved exact bytes. The prewrite
consumer acquires their metadata and tarballs from the official registry,
compares SHA-256/SHA-512/SHA-1/source coordinates and executes the installed
route. An existing CLI version is skipped only if its registry bytes/source
identity match and `native-preview` already selects that exact version. Different
bytes, ambiguous absence, authentication errors or missing tags fail closed.
An identical-version skip also acquires and executes the public CLI package
before accepting the skip.
The official `dist-tags` are read before and after publication; `latest` must
remain unchanged. No command repairs tags.

Publication passes only the retained, rebound archive to the isolated audited
npm publisher with `native-preview`, public access and provenance. Afterwards a
fresh cache installs the exact public CLI/Core/Read versions, compares complete
installed file sets and executes the example again. Evidence distinguishes local
candidate, real published event and observed registry consumer; successful local
tests are not a publication claim.

If the preview is defective, stop downstream adoption. Any removal or movement
of `native-preview` to a previously verified version requires separate Owner
approval of that exact public action. Preserve the version, source and evidence;
this authority does not unpublish, rewrite tags or change stable `latest`.
