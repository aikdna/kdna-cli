# standard-domain template

This is an expanded authoring project-view template for a new KDNA domain.
Copy this folder, fill in the bracketed placeholders, then export a packaged
`.kdna` file before distribution or runtime use.

## What this template includes

```
standard-domain/
├── README.md                   # Four Questions + Failure Risks + Files
├── kdna.json                   # Authoring manifest with judgment_version
├── KDNA_Core.json              # Axioms with applies_when / does_not_apply_when / failure_risk
├── KDNA_Patterns.json          # Misunderstandings with same governance fields
└── evals/
    ├── 3_core_cases.json       # Domain MUST handle correctly
    ├── 3_boundary_cases.json   # Edge of scope
    ├── 3_failure_cases.json    # Known failure modes (cite failure_risk)
    ├── 1_excluded_case.json    # Wrong domain entirely
    └── scoring.json            # D1-D8 dimensions
```

## How to use

```bash
# 1. Copy to your new domain folder
cp -r templates/standard-domain ./my_domain
cd my_domain

# 2. Optionally generate a scope identity (once per scope)
kdna identity init

# 3. Edit kdna.json:
#    - name: "@yourscope/your_domain_id"
#    - judgment_version: "YYYY.MM"
#    - description, core_insight, keywords, author

# 4. Edit KDNA_Core.json and KDNA_Patterns.json:
#    - Replace placeholder axioms with your own
#    - Every axiom MUST have applies_when, does_not_apply_when, failure_risk
#    - Every misunderstanding MUST have applies_when, failure_risk

# 5. Fill out evals/ — 10 real cases

# 6. Optionally review and customize the declared cases in evals/

# 7. Export and verify the packaged asset
mkdir -p dist
kdna-studio create ../your-domain-studio --from-folder . --name @yourscope/your-domain
kdna-studio export ../your-domain-studio --out ./dist/your-domain.kdna
kdna validate ./dist/your-domain.kdna

kdna plan-load ./dist/your-domain.kdna
kdna load ./dist/your-domain.kdna --profile=compact --as=prompt
```

## Standard vs minimal-domain

`minimal-domain/` is the **bare-minimum** template — no optional governance fields or evals. Use it only for fast experimentation or learning.

`standard-domain/` is the richer authoring template for domains that need evidence, limitations, and repeatable validation. Public distribution uses a local `.kdna` export plus `kdna validate` / `kdna plan-load` / `kdna load` evidence.
