# Native CLI Read guide

This guide's current entry is the unpublished
`0.39.0-rc.native-sections.3` CLI and its exact native Core/Read archives.
Use the [binding](../public-contract-binding.json) and
[installation instructions](../README.md#local-validation-and-packaging)
together; a matching version string alone is insufficient.

```sh
kdna read ./asset.kdna --mode catalog --budget 1000000 --allow-read
kdna read ./asset.kdna --mode exact_selection --asset-id asset:example \
  --asset-version 1.0.0 --judgment-id j:example --budget 1000000 --allow-read
```

Catalog is metadata. A selected body is disclosure, not a decision to act.
Core technical admission, explicit read permission, delivery, task adoption and
action authorization remain separate. There is no model or action execution.

For dependency expansion, use `read --session --allow-read`. Send one current
ReadRequest JSON object per line, using the exact tuple from the binding.
An `exact_selection` request uses `judgment_ids: ["j:example"]`. Read the
response, then send its returned `expansion_handles` object unchanged in an
`expand` request in the same session. Do not reopen the file, reconstruct a
handle or treat it as persistent permission. Each request has a byte budget
and a fresh, single-use preparation.

See the [complete authored example](../examples/team-update/README.md) for
creation, selection, a real returned handle, full Source revision and a new
file. The example source is provided for separate execution verification;
source preparation alone does not establish a successful run or useful task.

`plan`, `load`, `plan-use` and `use` do not provide a current native Runtime
path. Plan/load and unavailable commands return exit 2. The historical contract
below does not enable these commands in the native candidate.

<details>
<summary>Preserved historical consumption contract</summary>

The following original guide is retained as historical material. Its command
names, Host protocol and limits belong to that older surface; they are not
instructions for the native candidate. For the separately published loading
line, use its exact version's documentation.

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

</details>
