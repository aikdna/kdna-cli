# An author's weekly team-update preferences

[author.json](./author.json) contains three self-declared preferences of an
example author: update order, links to evidence, and optional supporting
rationale. It is teaching content, not a record of a real team, a universal
communication rule, an authority grant or human acceptance evidence.

The author chooses completed changes, blockers and the next action as the
initial order. An optional dependency connects the order judgment to the
rationale judgment, allowing the reader to request a genuine expansion handle.
The example then changes the author's preference to putting a blocker first
when it needs a teammate's decision. This is a scripted demonstration of an
authored revision; it is not a report of real user feedback.

Prepare the [exact offline archive host](../../docs/native-delivery.md), then
run the [public API recipe](../native-workflow.cjs) from that host directory:

```sh
node node_modules/@aikdna/kdna-cli/examples/native-workflow.cjs node_modules/@aikdna/kdna-cli/examples/team-update/author.json ./team-update-output
```

Use a new output directory. The recipe:

1. Passes the complete authored Manifest, Payload and empty member array to
   `create` with explicit creation permission, then checks the saved digest.
2. Uses `inspect` to obtain the newly admitted asset's tuple and identity, and
   obtains a metadata-only catalog with explicit Read permission.
3. Selects `update:order` in one retained Read session. It takes the actual
   `dependency:update-rationale` handle returned by that response and sends it
   unchanged for expansion in the same session.
4. Opens Source with explicit permission and the exact original SHA256. It
   clones the complete returned `edits` pair, revises the preference and both
   asset/judgment version coordinates, and adds a declared revision history.
5. Packs to a new file using the original asset and expected digest, verifies
   that the original remains unchanged, and reads the revised preference in a
   new session. It never transfers the old handle to the revised asset.

The output directory keeps the original and revised `.kdna` files, complete
operation responses, the full Source edits, and a small summary. Read content
shows what was disclosed; local response storage does not prove that a person
or another Agent used it. Creation, Read and Source permissions are local to
these calls and authorize no network, payment or other action.

This is a teaching recipe. Technical execution, content usefulness, genuine
Agent task adoption and human acceptance remain separate checks. It creates an
unsigned public asset; protected Source uses a separate Host route. Revision
does not strip or recreate checksums or signatures.
