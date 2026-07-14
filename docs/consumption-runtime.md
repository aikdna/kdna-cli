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

## Attach a process Agent host

The command-line path can invoke any Agent adapter that implements the
provider-neutral process contract for one packaged asset:

```bash
kdna use ./domain.kdna \
  --task "Review this decision" \
  --runner cli:default \
  --agent-host node \
  --agent-host-arg ./my-agent-host.js \
  --as trace
```

The command is spawned directly with `shell: false`; each
`--agent-host-arg` is one exact argument. The host is selected only by this
explicit command-line option—never by an asset manifest—and runs with the CLI
process environment. Attach only an executable you trust. Staged Cluster
execution is not enabled by this option.

The host reads one JSON document from standard input:

```json
{
  "protocol": "kdna.agent-host/1",
  "request_id": "host_...",
  "phase": "single_judgment",
  "task": {},
  "authority": { "asset_id": "...", "role": "primary", "final_decision": true },
  "asset": { "asset_id": "...", "role": "primary" },
  "capsule": { "type": "kdna.context.capsule" }
}
```

It writes exactly one correlated JSON response to standard output:

```json
{
  "protocol": "kdna.agent-host/1",
  "request_id": "host_...",
  "outcome": {
    "judgment": {
      "answer": "...",
      "reasoning": ["..."],
      "confidence": "high"
    },
    "model": "host-selected-model",
    "usage": { "tokens_used": 123, "model_calls": 1 }
  }
}
```

The CLI observes the correlated process response and records request/response
digests as a host receipt. A correlated result proves that host execution
finished; it does not independently prove semantic Capsule consumption,
judgment fidelity, or conformance. Trace therefore keeps `delivery_status`,
`consumption_status`, `execution_status`, `conformance_status`, and
`evidence_status` separate. Model identity, token usage, and model-call counts
remain host-reported and are labelled that way. Host diagnostics from standard
error are drained but are not copied into results. Timeout, excessive output,
process failure, malformed or uncorrelated JSON, malformed usage, and an empty
judgment all fail closed. Without `--agent-host`, the CLI stays `partial` with
execution not started.

Trace records prepared projection size as `projection_chars`. After a
correlated Host response, `projection_chars_delivered` records the serialized
projection characters delivered by Runtime. Delivery does not prove that the
Host read or semantically consumed those characters, so `chars_consumed`
remains `0` with `chars_consumed_basis: not_observed` unless a future explicit
consumption receipt is separately defined and labelled. No such receipt is part
of `kdna.agent-host/1`. Trace character counters are non-negative integers;
their basis fields use closed enums so unknown or malformed evidence labels
fail validation.

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
