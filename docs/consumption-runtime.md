# Consumption Runtime Guide

The CLI has one single-asset Runtime path:

```text
packaged bytes → ConsumptionPlan → Runtime Capsule → process Host → receipt → JudgmentTrace
```

It accepts a regular packaged `.kdna` file or an exact installed asset. Source
directories, symlinks, Cluster manifests, alternate runners, missing process
Hosts, and unsupported capability pairs fail closed.

## Plan without executing

```bash
kdna plan-use ./domain.kdna --task "Review this decision" --as=json
```

The plan binds the immutable packaged bytes, canonical asset identity, task,
projection request, budget, accepted Host protocol, and integrity digest. No
model or process Host is invoked.

## Register and invoke a process Host

Capability registration is an independent local input bound to the exact
executable and ordered argument strings selected for the invocation:

```json
{
  "type": "kdna.cli.agent-host-registration",
  "protocol_version": "0.1.0",
  "process": {
    "command": "node",
    "args": ["./my-agent-host.js"]
  },
  "capabilities": {
    "type": "kdna.agent-host-capabilities",
    "protocol_version": "0.1.0",
    "capability_basis": "registered_descriptor",
    "host_protocols": ["kdna.agent-host"],
    "capsule_versions": ["0.1.0"],
    "capsule_digest_profiles": ["kdna.canonicalization.runtime-capsule-jcs"],
    "capsule_digest_profile_versions": ["0.1.0"]
  }
}
```

Run the Host:

```bash
kdna use ./domain.kdna \
  --task "Review this decision" \
  --runner cli:default \
  --agent-host node \
  --agent-host-arg ./my-agent-host.js \
  --agent-host-capabilities ./my-agent-host.registration.json \
  --as=trace
```

The command is spawned directly without a shell. It receives one
`kdna.agent-host` request on standard input. The request includes the current
protocol version, correlated request identity, Runtime contract coordinates,
task, budget, canonical asset identity, authority, and the Core-built Runtime
Capsule.

The Host must return one correlated response containing a complete
`kdna.agent-host.runtime-receipt`. Core validates the receipt, including the
Host-recomputed Capsule delivery digest, identity correlation, provider
execution state, semantic-consumption evidence, model-identity basis, and
usage basis. The CLI never synthesizes a successful Host receipt.

The registration file is snapshotted as one regular non-symlink file and
parsed through Core's strict JSON boundary. Its path, process command,
arguments, and local asset path are not copied into the Plan, Host request, or
Trace.

## Evidence limits

A matched receipt establishes the correlated Host boundary for the exact
Capsule delivery digest. It does not establish that a model understood the
Capsule, that the Capsule affected the answer, or that the result is faithful
or high quality. JudgmentTrace therefore keeps delivery, execution, semantic
consumption, model identity, usage, and conformance separate. Unknown model
identity, token usage, and model calls remain `null` with a `not_observed`
basis.

Duplicate JSON keys, BOMs, invalid UTF-8, excessive nesting or output,
trailing JSON, timeout, process failure, an uncorrelated receipt, identity
tampering, and digest mismatch fail closed. Budget limits are enforced before
Host execution; a blocked pre-Host Trace contains no fabricated receipt.

`--runtime-contract` is an optional assertion of this current contract, not a
generation selector. A selector value or repeated occurrence is rejected.
`--timeout=<ms>` accepts one positive integer.

## Cluster boundary

Cluster remains a separately staged Runtime engineering surface. `kdna use`
does not enable Cluster execution or reuse the single-asset process Host flags
for Cluster. Cluster validation and planning commands do not constitute a
published staged Primary-first Runtime.
