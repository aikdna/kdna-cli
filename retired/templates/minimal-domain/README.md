# Minimal KDNA Studio authoring template

This directory is an editable Studio project, not a Runtime asset. Replace the
placeholders in `studio.project.json` and `cards/`, review the evidence in
`tests/`, and explicitly lock the cards you want to compile.

```bash
kdna studio cards validate ./studio.project.json
kdna studio lock verify ./studio.project.json
kdna studio compile ./studio.project.json
kdna validate ./exports
kdna pack ./exports ./dist/example-domain.kdna
```

Studio compilation emits only the current source entries: `mimetype`,
`kdna.json`, `payload.kdnab`, and `checksums.json`. Creator identity and Human
Lock are optional provenance; neither is a format-loading gate.
