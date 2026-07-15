# Standard KDNA Studio authoring template

This is an editable authoring project, not a Runtime asset. Judgment content
lives in `studio.project.json` and `cards/`; `evals/` preserves the optional
declared evidence cases used during review. The public Runtime artifact is the
packaged `.kdna` file produced from the compiled `exports/` directory.

## Authoring and compilation

```bash
kdna studio cards validate ./studio.project.json
kdna studio lock verify ./studio.project.json
kdna studio compile ./studio.project.json
kdna validate ./exports
mkdir -p dist
kdna pack ./exports ./dist/your-domain.kdna
```

Compilation emits only the current source entries: `mimetype`, `kdna.json`,
`payload.kdnab`, and `checksums.json`. Checksums and CBOR are generated through
the current Core implementation. Do not hand-edit them.

Creator identity and Human Lock are optional provenance. They may document the
authoring process, but neither is a format-validity or loading requirement.

## Evidence questions

- Which real decisions should this judgment improve?
- Which neighboring decisions are explicitly outside its scope?
- Which cases would falsify or weaken an axiom?
- Which failure risks appear when the asset is loaded on the wrong task?

The files under `evals/` are author-declared cases, not proof that semantic
consumption or judgment fidelity occurred at Runtime.
