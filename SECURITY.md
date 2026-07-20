# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.28.x  | :white_check_mark: |
| 0.27.x  | :white_check_mark: |
| < 0.27  | :x:                |

## Reporting a Vulnerability

KDNA CLI is the runtime control plane for domain judgment. Its primary
security surface is container integrity, authorization and decryption,
identity key management, and registry trust.

If you discover a security vulnerability:

1. **Do not** open a public issue.
2. Report by email to security@aikdna.com or via
   [GitHub Private Vulnerability Reporting](https://github.com/aikdna/kdna-cli/security/advisories/new).
3. Include: affected version, steps to reproduce, potential impact.

We will acknowledge within 5 business days and provide a timeline for a fix.

## Scope

- `kdna identity init/show`: identity key generation and public-key inspection
- `kdna install`: registry trust chain and SHA-256 verification
- `kdna publish`: immutable artifact and digest handling
- `kdna license activate/sync/verify/show`: license-key and entitlement
  handling, including redaction of activation errors and sync traces;
  account/device private keys, issuer pins, and grants must remain in an
  encrypted SecretStore backend (macOS Keychain, Linux Secret Service, or a
  GPG-backed standard password store); plaintext file and environment backends
  fail closed for this material
- `kdna load --remote-server`: remote projection client behavior and
  avoidance of plaintext payload exposure
- Password-protected `demo`, `protect`, `unlock`, and `load` paths: pass
  passwords over standard input with `--password-stdin` (or use the secure
  interactive prompt where supported). Passwords in process arguments are
  rejected.

Asset signatures and private-key backup/import are outside the current Preview
contract. Registry signatures, signed licenses and grants, and Human Lock
provenance remain separate supported security contracts.

## Out of Scope

- Domain content files (KDNA\_\*.json) — these are user-authored judgment assets
- Network-level attacks (man-in-the-middle on registry fetch) — use HTTPS
- Compromise of the local user account or its unlocked operating-system/GPG
  secret store — CLI runs with the user's privileges

## Supply Chain

KDNA CLI publishes to npm as `@aikdna/kdna-cli`. Builds are reproducible
from source. Dependencies are pinned in `package-lock.json`.
