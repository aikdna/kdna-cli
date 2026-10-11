# Stable CLI change notes

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
