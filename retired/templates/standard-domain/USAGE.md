# Using the standard authoring template

1. Copy this directory and replace every placeholder in
   `studio.project.json`, `cards/`, and `evals/`.
2. Keep cards unlocked while editing. Lock only cards intentionally selected
   for the next compiled candidate.
3. Run Studio card validation and lock verification.
4. Compile to `exports/`; Core generates the current manifest, CBOR payload,
   and checksums.
5. Validate and pack the compiled source, then test the packaged bytes through
   `kdna plan-use` and a registered process Host.

```bash
kdna studio cards validate ./studio.project.json
kdna studio lock verify ./studio.project.json
kdna studio compile ./studio.project.json
kdna validate ./exports
kdna pack ./exports ./dist/your-domain.kdna
kdna plan-use ./dist/your-domain.kdna --task="Describe a real decision" --as=json
```

The template keeps authoring data and declared eval evidence outside the
Runtime container. Runtime receives only the compiled, byte-authenticated
asset projection.
