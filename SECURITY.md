# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.28.x  | :white_check_mark: |
| 0.27.x  | :white_check_mark: |
| < 0.27  | :x:                |

## Reporting a Vulnerability

KDNA CLI is the runtime control plane for domain judgment. The primary
security surface is signature verification, identity key management,
and registry trust.

If you discover a security vulnerability:

1. **Do not** open a public issue.
2. Report by email to security@aikdna.com or via
   [GitHub Private Vulnerability Reporting](https://github.com/aikdna/kdna-cli/security/advisories/new).
3. Include: affected version, steps to reproduce, potential impact.

We will acknowledge within 5 business days and provide a timeline for a fix.

## Scope

- `kdna verify --trust`: Ed25519 signature verification
- `kdna identity init/export/import`: key generation and backup encryption
- `kdna install`: registry trust chain and SHA-256 verification
- `kdna publish`: signing and key material handling
- `kdna license activate/sync/verify/show`: license-key and entitlement
  handling, including redaction of activation errors and sync traces
- `kdna load --remote-server`: remote projection client behavior and
  avoidance of plaintext payload exposure

## Out of Scope

- Domain content files (KDNA\_\*.json) — these are user-authored judgment assets
- Network-level attacks (man-in-the-middle on registry fetch) — use HTTPS
- Local filesystem access — CLI runs with user privileges

## Supply Chain

KDNA CLI publishes to npm as `@aikdna/kdna-cli`. Builds are reproducible
from source. Dependencies are pinned in `package-lock.json`.
