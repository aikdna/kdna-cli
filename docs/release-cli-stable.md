# Exact stable CLI publication

The stable channel declares `@aikdna/kdna-cli@0.43.1`, Git tag `0.43.1`,
repository `aikdna/kdna-cli` and npm dist-tag `latest`. The channel binds exact
Core `0.37.8` and Read `0.13.2` companion archives. The committed stable profile
selects their exact SHA256 identities. Version strings alone cannot substitute
for those bytes. The committed binding's `route_contracts` digests name the
exact contract bytes of the bound Core and move with it in the same commit as
any companion re-pin; `tests/route-contracts-binding.test.js` recomputes every
digest from the installed Core so a forgotten re-pin fails closed instead of
shipping stale values.

The common release engine preserves the preview channel's original policy and
implements an independent stable event and approval policy. The stable workflow
uses `scripts/stable-release-authority.cjs`; it requires a published, nondraft,
non-prerelease GitHub release naming the exact clean source commit and tag.
The final release body must contain the exact source change notes followed by
one `kdna-stable-release` JSON approval block. The approval binds the source
commit/tree, DCO baseline, stable version, artifact and notes SHA256, and the
exact companion archive SHA256/SRI/SHA1 identities. Core `0.37.8` also carries
a registry `gitHead`; Read `0.13.2` has no registry `gitHead` or provenance
attestation, so its approval entry records `gitHead: null` and makes no such
claim.

Local candidate preparation exports the exact Git source twice, creates two
matching packs with the authenticated npm client and retains the first artifact.
`candidate-smoke` installs a private twelve-archive graph in an empty cache and
runs create, inspect, Read, expansion, full Source revision and reopening. These
local checks do not satisfy the real published-release event gate.

The workflow verifies the publicly released Core and Read companions before
publication. Duplicate version handling compares exact registry metadata and
archive identity; missing bytes or a conflict fail closed. Publication rebinds
the retained artifact immediately before the audited publisher receives it.
Only `latest` may move to `0.43.1`; all other dist-tags must retain the complete
pre-publication map. Final verification downloads the published bytes again and
creates a fresh public-registry consumer. A local candidate or successful upload
without this acquisition check is not a completed release.

The existing preview tag and prior version retain their own source and byte
identity. There is no conversion from the old RC archive to a stable artifact.
