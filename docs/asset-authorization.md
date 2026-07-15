# KDNA Asset Authorization — CLI User Guide

This document explains how `kdna` CLI handles protected (password-locked)
`.kdna` assets. It is the user-facing companion to the technical RFC
0009 (Password-Protected KDNA Assets) and the current LoadPlan API
reference.

## Two flags, two different intents

There are two flags that look similar but mean very different things:

| Flag                 | Command          | Meaning                          | Use case                                                                           |
| -------------------- | ---------------- | -------------------------------- | ---------------------------------------------------------------------------------- |
| `--has-password`     | `kdna plan-load` | Diagnostic **presence signal**   | "I have a password somewhere; skip the `needs_password` gate so I can plan ahead." |
| `--password=<value>` | `kdna load`      | **Real** password for decryption | Actually decrypt the protected entry and read its content.                         |

The plan-load stage decides _whether_ the asset can be loaded. The load
stage actually _does_ the loading (and decryption).

### Why this split?

`plan-load` is intended to be a **dry-run**: tell me what would happen
if I tried to load this asset, without actually loading it. Real-world
callers want to render UI ("This asset is password-protected — please
enter your password") or to skip UI for automation ("yes I know the
password, just plan ahead"). For those callers, passing
`--has-password=true` lets them get `state: ready, can_load_now: true`
without supplying the password yet.

`load`, on the other hand, **does** the decryption. There is no
scenario where it makes sense to call `load` without actually
decrypting. If you don't have a password, you don't have a key, and
the load should fail.

As of v0.28, `kdna load` **rejects** `--has-password` with a clear
error. Use `--password=<value>` to actually decrypt.

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

# 2a. Dry-run: I know I have a password, plan as if it were supplied
$ kdna plan-load ./my-protected.kdna --has-password
{
  "state": "ready",
  "required_action": "load",
  "can_load_now": true,
  ...
  "issues": [
    {
      "code": "KDNA_AUTH_PASSWORD_DIAGNOSTIC",
      "severity": "info",
      "message": "hasPassword is a diagnostic credential-presence signal only; it does not verify the password."
    }
  ]
}

# 2b. ⚠️ Do NOT do this. The CLI rejects --has-password in load:
$ kdna load ./my-protected.kdna --has-password --profile=compact --as=prompt
Error: --has-password is a plan-load diagnostic only; it does not decrypt. Use `kdna plan-load --has-password` for dry-runs. For `kdna load`, supply the real password via --password=<value>.

# 3. Correct: supply the actual password
$ kdna load ./my-protected.kdna --password="correct horse battery staple" --profile=compact --as=prompt
KDNA Judgment Asset: my-protected
...

# 4. Wrong password: clear error
$ kdna load ./my-protected.kdna --password="wrong" --profile=compact --as=prompt
Error: LoadPlan denied loading: state=needs_password required_action=enter_password
```

## Why the CLI rejects `--has-password` in `load`

Before v0.28, `kdna load` accepted `--has-password` and silently
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
- CLI guard: `kdna-cli/src/cli.js:286-292` (the `load` command's
  `--has-password` rejection)
