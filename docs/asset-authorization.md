# KDNA Asset Authorization — CLI User Guide

This document explains how `kdna` CLI handles password-entitled `.kdna`
assets. The current Schema, encryption profiles, conformance fixtures, and
LoadPlan API are authoritative; historical RFC-0009's `access: "protected"`
value is superseded.

## Two flags, two different intents

There are two flags that look similar but mean very different things:

| Flag               | Command          | Meaning                          | Use case                                                                           |
| ------------------ | ---------------- | -------------------------------- | ---------------------------------------------------------------------------------- |
| `--has-password`   | `kdna plan-load` | Diagnostic **presence signal**   | "I have a password available; report that fact without claiming it was verified." |
| `--password-stdin` | `kdna load`      | **Real** password for decryption | Read the password from standard input, then decrypt the protected entry.           |

The plan-load stage decides _whether_ the asset can be loaded. The load
stage actually _does_ the loading (and decryption).

### Why this split?

`plan-load` is intended to be a **dry-run**: tell me what would happen
if I tried to load this asset, without actually loading it. Real-world callers
want to render UI ("This asset is password-protected — please enter your
password") while truthfully distinguishing a presence signal from verified
credentials. Passing `--has-password` therefore remains
`state: needs_password, can_load_now: false` until `load` verifies the real
password.

`load`, on the other hand, **does** the decryption. There is no
scenario where it makes sense to call `load` without actually
decrypting. If you don't have a password, you don't have a key, and
the load should fail.

The corrective Preview candidate makes this distinction fail closed:
`kdna load` rejects `--has-password`, while `plan-load --has-password` never
claims the unverified value is ready. Pipe the real password with
`--password-stdin` to decrypt it.

Passwords in process arguments are rejected. Use stdin or the secure
interactive prompt where supported.

## End-to-end example

```bash
# 1. Inspect what the asset is and what it needs
$ kdna plan-load ./my-protected.kdna
{
  "state": "needs_password",
  "required_action": "enter_password",
  "can_load_now": false,
  ...
}

# 2a. Dry-run: report that a password is available, without claiming verification
$ kdna plan-load ./my-protected.kdna --has-password
{
  "state": "needs_password",
  "required_action": "enter_password",
  "can_load_now": false,
  ...
  "issues": [
    {
      "code": "KDNA_AUTH_PASSWORD_UNVERIFIED",
      "severity": "blocking",
      "message": "A password input is present but has not been verified."
    }
  ]
}

# 2b. ⚠️ Do NOT do this. The CLI rejects --has-password in load:
$ kdna load ./my-protected.kdna --has-password --profile=compact --as=prompt
Error: --has-password is a plan-load diagnostic only; it does not decrypt. Use `kdna plan-load --has-password` for dry-runs. For `kdna load`, pipe the real password with --password-stdin.

# 3. Correct: keep the actual password out of argv
$ printf '%s' "$KDNA_PASSWORD" | kdna load ./my-protected.kdna --password-stdin --profile=compact --as=prompt
KDNA Judgment Asset: my-protected
...

# 4. Wrong password: clear error
$ printf '%s' "$WRONG_PASSWORD" | kdna load ./my-protected.kdna --password-stdin --profile=compact --as=prompt
Error: password verification or decryption failed
```

## Why the CLI rejects `--has-password` in `load`

Earlier implementations accepted `--has-password` in `load` and silently
bypassed real password verification. A caller who possessed a stolen
`.kdna` file could read its plaintext by simply passing
`--has-password` to `load` — they did not need the actual password.

The fix is intentional: `--has-password` is a _plan-load_ concept
("I would have a password if I had to provide one"). The actual
_load_ must always have a real key. If you are calling `load`, you
intend to read the content, and reading requires the key.

## RFC and source pointers

- RFC-0009: `docs/strategy/KDNA_ASSET_AUTHORIZATION_STRATEGY.md` —
  the policy behind the `password` entitlement profile
- LoadPlan: `packages/kdna-core/src/container/index.js` (the password
  authorization branch)
- CLI guard: `src/cli.js` (the `load` command's `--has-password` rejection)
