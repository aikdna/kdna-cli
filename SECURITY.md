# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.36.x  | :white_check_mark: |
| < 0.36  | :x:                |

## Reporting a Vulnerability

KDNA CLI is the runtime control plane for domain judgment. Its primary
security surface is container integrity, authorization and decryption,
workspace attachment integrity, and the closed remote projection transport.

If you discover a security vulnerability:

1. **Do not** open a public issue.
2. Report by email to security@aikdna.com or via
   [GitHub Private Vulnerability Reporting](https://github.com/aikdna/kdna-cli/security/advisories/new).
3. Include: affected version, steps to reproduce, potential impact.

We will acknowledge within 5 business days and provide a timeline for a fix.

## Scope

- `kdna attach/switch/rollback/resolve`: immutable snapshots, workspace
  boundary enforcement, approval, integrity, and scope resolution
- `kdna inspect/validate/plan-load/load/pack/unpack`: explicit local container
  integrity, authorization, decryption, and archive handling
- `kdna load --remote-server`: remote projection client behavior and
  avoidance of plaintext payload exposure
- Password-protected `demo` and `load` paths: pass passwords over standard
  input with `--password-stdin`. Passwords in process arguments are rejected.
- Account/device private keys, issuer pins, and grants: encrypted operating
  system or GPG-backed secret backends are required; plaintext backends fail
  closed for this material.

Commands not present in `release-surface/cli-command-allowlist.json` are
outside the distributed CLI contract and fail closed.

## Out of Scope

- Domain content files (KDNA\_\*.json) — these are user-authored judgment assets
- Compromise of the local user account or its unlocked operating-system/GPG
  secret store — CLI runs with the user's privileges

## Supply Chain

KDNA CLI publishes to npm as `@aikdna/kdna-cli`. Builds are reproducible
from source. Dependencies are pinned in `package-lock.json`.
