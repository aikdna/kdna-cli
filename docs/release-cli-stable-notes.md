# Stable CLI change notes

## CLI 0.43.2

This source binds the published Core `0.37.9` and Read `0.13.3` archives and
moves every byte-pinned coordinate — the six route-contract digests, the
accepted companion pair, the dependency and delivery archive receipts, the
offline host lock, the root lock and the stable profile — to those exact
registry tarballs. It includes the read-help clarification of the budget object,
the body/full/raw views and the three read modes, and the one-shot read stderr
guidance for budget rejections. No runtime behavior or protocol semantics
change. Both Core `0.37.9` and Read `0.13.3` carry registry `gitHead` and
provenance attestations. Earlier published coordinates remain in place,
including CLI `0.43.1`.

## CLI 0.43.1

This source binds the published Core `0.37.8` and Read `0.13.2` archives and
moves every byte-pinned coordinate — the six route-contract digests, the
accepted companion pair, the dependency and delivery archive receipts, the
offline host lock, the root lock and the stable profile — to those exact
registry tarballs. It does not change runtime behavior or protocol semantics.
Read `0.13.2` has no registry `gitHead` or provenance attestation; the release
binds its exact archive SHA256/SRI/SHA1 only and does not claim provenance for
it. Core `0.37.8` retains its registry `gitHead` and provenance. Earlier
published coordinates remain in place.

## CLI 0.43.0

This source binds the published Core `0.37.7` and Read `0.13.1` and adds the
explicit `kdna convert` command: it reads exactly the current `0.5` public
source generation and writes an admitted `0.6` container with a confirmed
`representation_origin`, saves a new file under the existing no-replace
policy, refuses historical tuples, protected sources and extension members by
name before any conversion, and never converts implicitly on the read or
source routes. Every byte-pinned coordinate — the six route-contract digests,
the accepted companion pair, the dependency and delivery archive receipts and
the offline host lock — moves back to the exact published archives in this
release batch, and the publish-coordinate gate reports zero findings again.
Earlier published coordinates remain in place.

## CLI 0.42.0

This source candidate adds the explicit `--view raw` adapter carrier. Raw
prints the library envelope exactly as the library returns it — reduction
machinery and issued handles included — for adapters that apply the installed
Read projection themselves; it is not a model view, and an explicit
`--view-accept` beside it is refused rather than ignored. The default body,
`--view full`, and every model-view contract value, including the 0.41.0
paired projection, are unchanged, so existing consumers keep their exact
surfaces.

## CLI 0.41.0

This source candidate binds the exact released Core 0.37.6 and Read 0.13.0
archives and carries the paired model-view 0.2.0 projection. The delivered read
request answers with the author body while the non-selected closure members
arrive behind their own expansion handles; `--view full` prints the complete
surface without the reduction machinery, and `--view-accept` pins the
model-view contract the caller accepts, defaulting to the contract this CLI is
built against. A session may expand a returned handle either by echoing it or
by naming the compact `handle_id` a reduced entry carries; the CLI resolves it
within the same session with explicit refusals and still passes the complete
read admission. The 0.40.1 method-role guidance sibling is unchanged.

No content, field or route is removed. Publication targets `latest` only, keeps
every other dist-tag and the prior version in place, retains exact companion
archive identities, and re-verifies the published bytes through a fresh
registry consumer.

## CLI 0.40.1

This source candidate binds the exact released Core 0.37.4 and Read 0.12.1
archives and adds one authoring aid: when `create` is refused by Core with a
method or method-component diagnostic, the output carries a `guidance` sibling
that quotes the per-term role vocabulary from the installed Core's read-only
method-role table, names which required roles the authored input does not
contain, and points at the documented encoding for a method the author never
stated. The guidance presents authored input and the public vocabulary only; it
decides nothing, and the Core diagnostic object, its fields and the complete
core result remain exactly as the installed Core produced them. An installation
without the read-only table keeps byte-identical previous output.

No content, field or route is removed. Publication targets `latest` only, keeps
every other dist-tag and the prior version in place, retains exact companion
archive identities, and re-verifies the published bytes through a fresh registry
consumer.

## CLI 0.40.0

This source candidate binds Core 0.37.3 and Read 0.12.0 to the exact approved
archives, and moves with the Read distribution coordinate that adds the model
view projection.

The default surface of `kdna read` is the author body plus one fingerprint
whenever the installed Read package provides that projection; the CLI probes for
the capability rather than assuming it, an explicit `--view body` against an
installation without it is refused instead of quietly answered with the full
surface, and `--view full` prints exactly what this CLI printed before the flag
existed. No content, field or route is removed, and the native section contracts
are unchanged.

The source release gate retains exact commit and tree identity, two matching
packs, companion archive identities, an approved artifact and notes digest, and
a real published stable GitHub release event. Publication targets `latest` only;
other npm dist-tags must remain unchanged, and a registry version with
conflicting bytes is refused. Public installation and registry byte identity are
checked again after publication.

File generation, local Read permission and producer evidence do not establish
human confirmation, task adoption or action authorization. Studio protected
assets use their separately documented protection route.

## CLI 0.39.0

This source candidate binds Core 0.37.2 and Read 0.11.3 to the exact approved
archives. It creates native section assets from explicit authored input, saves
to an exclusive destination, and exposes local inspection and Read with
explicit permission. An installed example performs a reasoned revision while
preserving the original file, then verifies the revised asset through Read.

The source release gate retains exact commit and tree identity, two matching
packs, companion archive identities, an approved artifact and notes digest,
and a real published stable GitHub release event. Publication targets latest
only; other npm dist-tags must remain unchanged. A registry version with
conflicting bytes is refused. Public installation and registry byte identity
are checked again after publication.

File generation, local Read permission and producer evidence do not establish
human confirmation, task adoption or action authorization. Studio protected
assets use their separately documented protection route.
