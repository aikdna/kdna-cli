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

For the single-asset `kdna use` process Host handoff, the request carries the
selected Runtime Capsule as one JSON value. The Golden compact-profile
regression proves this handoff does not trim or reorder Capsule arrays, select a
subset of its context, or reinterpret standard judgment-role fields before
process serialization. The observed Capsule digest in Trace is computed before
handoff and can therefore be matched against the exact Capsule captured by the
process Host. This is delivery evidence only; preservation of request values
does not show that the Host read, followed, or judged faithfully from them.

Trace records prepared projection size as `projection_chars`. After a
correlated Host response, `projection_chars_delivered` records the serialized
projection characters delivered by Runtime. Delivery does not prove that the
Host read or semantically consumed those characters, so `chars_consumed`
remains `0` with `chars_consumed_basis: not_observed` unless a future explicit
consumption receipt is separately defined and labelled. No such receipt is part
of `kdna.agent-host/1`. Trace character counters are non-negative integers;
their basis fields use closed enums so unknown or malformed evidence labels
fail validation.

## Opt in to Plan 1 and Agent Host 2

The default command remains on ConsumptionPlan 0.9, Capsule 1, Agent Host 1,
and Trace 0.9. The strict contract is a separate, explicit path:

```bash
kdna plan-use ./domain.kdna \
  --task "Review this decision" \
  --runtime-contract=1 \
  --as json

kdna use ./domain.kdna \
  --task "Review this decision" \
  --runner cli:default \
  --agent-host node \
  --agent-host-arg ./my-agent-host-2.js \
  --agent-host-capabilities ./my-agent-host-2.registration.json \
  --runtime-contract=1 \
  --as trace
```

`--runtime-contract=1` does not declare Host capabilities. The capability
registration is an independent local input with this exact CLI wrapper:

```json
{
  "type": "kdna.cli.agent-host-registration",
  "version": "1.0",
  "process": {
    "command": "node",
    "args": ["./my-agent-host-2.js"]
  },
  "capabilities": {
    "type": "kdna.agent-host.capabilities",
    "version": "1.0",
    "capability_basis": "registered_descriptor",
    "host_protocols": ["kdna.agent-host/2"],
    "capsule_versions": ["2.0"],
    "capsule_digest_profiles": ["kdna-capsule-jcs-v1"]
  }
}
```

The wrapper binds the descriptor to the exact command and ordered argument
strings selected for this invocation. The CLI snapshots one regular,
non-symlink registration file (maximum 64 KiB), parses it with the Core strict
JSON boundary, and retains only that snapshot. Replacing the file afterward
cannot change the registered value for the running command. The descriptor is
then validated and negotiated by Core; the CLI wrapper defines only process
binding and does not redefine the capability Schema. The registration path,
process command, arguments, and asset resolution path are not copied into the
Plan, Host request, or Trace.

Without a matching registration the process has only
`capability_basis: legacy_assumption`. Core negotiation blocks before Capsule
projection. A registered descriptor that lacks Capsule 2, Host 2, or the
`kdna-capsule-jcs-v1` delivery digest also blocks before projection. Unknown
`--runtime-contract` values fail closed instead of selecting the default path.

The strict executor snapshots one regular packaged `.kdna` file and uses those
same bytes for A/C/E evidence, Plan identity, Capsule 2, delivery digest P, and
the Host request. Installed assets may match A and C against their independent
install receipt; a local file records A as caller-provided `not_compared`.
Source directories, symlinks, Cluster, remote fallback, mock execution, and a
missing process Host are not accepted by this path.

The Host receives the Core-built `kdna.agent-host/2` request unchanged and must
return its own complete Host 2 receipt. The CLI parses raw standard output with
the Core strict JSON parser and never synthesizes a receipt. Duplicate keys,
BOMs, invalid UTF-8, excessive nesting or output, trailing JSON, timeout, and
uncorrelated receipts fail closed. A pre-Host projection or task budget failure
uses Core's evidence-only blocked Trace and does not call the Host.

JudgmentTrace 1 keeps delivery, execution, semantic consumption, model
identity, usage, and conformance separate. A matched receipt establishes the
correlated Host boundary for the exact Capsule delivery digest P. It does not
establish that a model understood the Capsule, that the Capsule affected the
answer, or that the result is faithful or high quality. Unknown model identity,
tokens, and model calls remain `null` with a `not_observed` basis.

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
