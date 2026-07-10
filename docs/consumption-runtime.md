# Consumption Runtime Guide

The KDNA CLI can help an integration select, compose, project, and evaluate
judgment assets. These commands complement `validate`, `plan-load`, and
`load`; they do not alter the `.kdna` protocol.

## Start with a packaged asset

```bash
kdna validate ./domain.kdna
kdna plan-load ./domain.kdna --json
kdna project ./domain.kdna --shape=answer-pattern --as=prompt
```

`project` uses the authorized Core loading path for packaged assets. A source
directory can still be inspected, but it is not presented as a loaded runtime
projection.

## Route and compose

Use a policy or route-card sidecar to select a primary framework. A route can
also abstain when a task has no supported match.

```bash
kdna route ./domain.kdna --task=review --policy=policy.json --as=trace
kdna compose ./domain.kdna --primary=review-framework --source-hardmax=3 --as=trace
```

Composition requires a primary. It never silently loads every asset as a
fallback. Trace output records the primary, accepted advisors, rejections,
budget profile, and provenance.

## Evaluate and review

Use public-safe fixtures to compare a policy across the configured replay
modes. The report keeps routing, composition, projection, cost, quality, and
promotion results separate.

```bash
kdna eval-consumption ./domain.kdna --fixtures=./fixtures --as=markdown
kdna compose-review-workbook diagnostics.json --out=workbook.md
kdna validate-compose-decisions decisions.jsonl --fixtures=./fixtures --out=validation.json
kdna apply-reviewed-compose-decisions decisions.jsonl --validation=validation.json --out=consumer-index.json
```

Applied entries are emitted as disabled candidates. Enable a sidecar only
through the policy and review process appropriate for your application.

## Keep responsibilities separate

- `kdna validate` verifies file structure and loadability.
- `kdna plan-load` reports authorization and readiness.
- Consumption commands evaluate task fit and runtime policy.
- Sidecars describe runtime decisions; they do not modify an asset or certify
  its content.
