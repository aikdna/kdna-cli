# KDNA CLI Operation Permissions & Offline Password Protection (`0.46.0`)

`@aikdna/kdna-cli@0.46.0` uses explicit per-invocation local operation flags and offline AEAD password protection (`scrypt-sha256` + `AES-256-KW` + `AES-256-GCM`, container `0.6.0`). All operations run locally and permanently require no online account.

## 1. Per-Invocation Operation Flags

| Command | Required Flag / Input | Scope & Guarantee |
| --- | --- | --- |
| `inspect`, `validate` | Explicit file path (`--metadata` for pre-unlock outer manifest) | Technical admission, digest verification, and metadata without disclosing judgment bodies. |
| `read`, `review` | `--allow-read` | Admits the named `.kdna` file and discloses the requested catalog, exact selection, or single-page author review sheet. |
| `create` | `--allow-create` | Encodes a validated draft (`--draft`) or full authored JSON into a new `.kdna` file; never overwrites an existing file or symlink. |
| `source-open`, `source-pack` | `--allow-source` + `--expected-a <sha256:...>` | Verifies the exact original container SHA-256 (`--expected-a`), extracts `{manifest, payload}` edits, or packs a revised `.kdna` to a new path (auto-preserving `representation_metadata` if omitted). |
| `protect`, `unprotect` | `--password-env <var>`, `--password-prompt` (TTY), `--password-file <path>`, or `--password-fd <fd>` | Encrypts a plaintext `0.6.0` `.kdna` into an offline password-protected envelope or restores plaintext bytes to a new file. |

Operation flags apply only to the current CLI invocation; they never grant human confirmation, editorial adoption, or external action authority.

## 2. Revising Checksum-Sealed vs. Cryptographically Signed Containers

- **Unsigned containers with `checksums.json`:** Official distribution `.kdna` files embed an unsigned `checksums.json` entry manifest. After verifying `--expected-a` against the original bytes, `kdna source-pack` (`>=0.45.1`) automatically refreshes `checksums.json` over the revised container entries and re-admits the output before saving.
- **Cryptographically signed containers:** If an asset carries a cryptographic signature entry (e.g., `*.kdsig` / `signature.json` or a manifest signature declaration), `source-pack` fails closed (`KDNA_SOURCE_SIGNED_CHECKSUMS_REFUSED`) rather than stripping or forging a signature. Revise from the unencrypted `.authored.json` source and re-sign through your signing authority.

```sh
# Revise an official unsigned .kdna asset directly
ORIG_A="sha256:$(shasum -a 256 work-1.0.0.kdna | awk '{print $1}')"
kdna source-open work-1.0.0.kdna --expected-a "$ORIG_A" --allow-source --output edits.json
# Update manifest.version / payload.asset.asset_version (e.g. 1.0.0 -> 1.0.1) and judgment fields in edits.json
kdna validate-input edits.json --format human
kdna source-pack work-1.0.0.kdna --edits edits.json --expected-a "$ORIG_A" --output work-1.0.1.kdna --allow-source
kdna validate work-1.0.1.kdna --system --format human
kdna diff work-1.0.0.kdna work-1.0.1.kdna --format human
```

## 3. Offline Password Protection (`protect` / `unprotect`)

Passwords in command-line arguments (`argv`) are strictly rejected so secrets never leak via process tables or shell history. Outer `kdna.json` manifest fields (`title`, `summary`, `creator`, `keywords`, `version`) remain unencrypted so readers can identify the file (`kdna inspect --metadata`), while `payload.kdnab` is AEAD-encrypted. For interactive terminal use, pass `--password-prompt` (confirmed twice on `protect`, fails closed on non-TTY); for cross-platform scripts and non-interactive Agent shells, pass `--password-env <VAR>` (or `--password-file` / `--password-fd >= 3`), and use `--left-password-*` / `--right-password-*` on `kdna diff` when comparing rotated passphrases:

```sh
# Interactive TTY prompt (hidden input, confirmed twice on protect)
kdna protect my-work.kdna --output my-work.protected.kdna --password-prompt
kdna inspect my-work.protected.kdna --metadata --format human

# Cross-platform environment variable (works on macOS, Linux, Windows, and Agent subshells)
export KDNA_PASS='...'
kdna read my-work.protected.kdna --mode catalog --allow-read --password-env KDNA_PASS --format human
kdna unprotect my-work.protected.kdna --output my-work.restored.kdna --password-env KDNA_PASS
unset KDNA_PASS
```

See [SECURITY.md](../SECURITY.md), [public-contract-binding.json](../public-contract-binding.json), and [docs/authoring-field-reference.md](./authoring-field-reference.md).
