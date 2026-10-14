# Stable CLI change notes

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
