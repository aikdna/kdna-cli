/**
 * watermark.js — payload-level watermarking (Story 21)
 *
 * Design contract (from `roadmap-2026.md` §5.1 Story 21 + §13.7):
 *
 *   1. Watermarks are per-mode: `access: "licensed"` and
 *      `access: "remote"` get a watermark. `access: "public"`
 *      does NOT.
 *   2. The watermark binds the projection to the consumer:
 *      asset_uid + consumer_id (when known) + session_timestamp
 *      + session_nonce, all hashed via HMAC-SHA256 with a
 *      process-local key.
 *   3. The watermark is content-neutral. It is a post-hoc
 *      traceability primitive, NOT a trust claim and NOT an
 *      access control. Loading a `licensed` asset without
 *      a watermark is allowed; the watermark just makes
 *      leaks traceable.
 *   4. The watermark appears in JSON, prompt, and compact
 *      output profiles — i.e. the consumer carrying the
 *      watermark in their context, where the LLM can echo
 *      it back.
 *
 * The HMAC key is generated fresh per CLI invocation
 * (`newHmacKey()`) and never persisted. This means:
 *   - Different CLI invocations produce different HMACs for
 *     the same consumer/asset (the session_nonce already
 *     randomises this, but the key is also fresh as a
 *     belt-and-braces measure).
 *   - A leaked HMAC cannot be replayed: a verifier needs
 *     the same key, which is process-local.
 *
 * Per the brief: "不将水印密钥提交到仓库" — the HMAC key
 * is generated at runtime and never read from or written to
 * any file. There is no configuration value for it. This is
 * intentional: a static key would be a credential, and any
 * leaked credential is a permanent leak.
 */

'use strict';

const crypto = require('node:crypto');

const WATERMARK_VERSION = '1';
const WATERMARKED_ACCESS_MODES = new Set(['licensed', 'remote']);

/**
 * Should this access mode receive a watermark?
 *
 * `public` does not. `licensed` and `remote` do.
 */
function shouldWatermark(access) {
  return WATERMARKED_ACCESS_MODES.has(access);
}

/**
 * Generate a process-local HMAC key. Random 32 bytes; thrown
 * away when the process exits.
 */
function newHmacKey() {
  return crypto.randomBytes(32);
}

/**
 * Resolve the consumer's identity. Tries the kdna identity key
 * at KDNA_IDENTITY_DIR (preferred, env-controlled) or the
 * default ~/.kdna/keys/. Returns the SHA-256 prefix of the
 * public key as the consumer_id.
 *
 * Per the design contract: consumer_id is OPTIONAL. The
 * watermark works without it; it's just a more useful watermark
 * with it. The HMAC binds the consumer_id to the rest of the
 * watermark so a downstream consumer can't strip it.
 */
function resolveConsumerId(opts) {
  if (opts && typeof opts.consumerId === 'string' && opts.consumerId.length > 0) {
    return opts.consumerId;
  }

  // Build a list of candidate paths in priority order:
  //   1. opts.identityDir (explicit)
  //   2. process.env.KDNA_IDENTITY_DIR (env-controlled; matches
  //      what the rest of the CLI uses)
  //   3. ~/.kdna/keys (default)
  const candidates = [];
  if (opts && opts.identityDir) candidates.push(opts.identityDir);
  if (process.env.KDNA_IDENTITY_DIR) candidates.push(process.env.KDNA_IDENTITY_DIR);
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    const os = require('node:os');
    const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
    candidates.push(path.join(home, '.kdna', 'keys'));
  } catch (_) {
    // ignore
  }

  for (const dir of candidates) {
    try {
      const fs = require('node:fs');
      const path = require('node:path');
      const pubPath = path.join(dir, 'ed25519.pub');
      if (fs.existsSync(pubPath)) {
        const pub = fs.readFileSync(pubPath, 'utf8');
        return crypto.createHash('sha256').update(pub).digest('hex').substring(0, 16);
      }
    } catch (_) {
      // continue
    }
  }
  return null;
}

/**
 * Build a watermark for an asset.
 *
 * @param {object} opts
 * @param {string} opts.assetUid — the asset's URN (from kdna.json)
 * @param {string} opts.access — the asset's access mode
 * @param {string|null} [opts.consumerId] — optional consumer identifier
 * @param {Buffer} [opts.hmacKey] — process-local key (random if omitted)
 * @param {string} [opts.timestamp] — ISO timestamp (now if omitted)
 * @returns {object|null} the watermark record, or null if access mode is unwatermarked
 */
function buildWatermark(opts) {
  if (!opts || typeof opts !== 'object') {
    throw new Error('buildWatermark: opts is required');
  }
  const access = opts.access;
  if (!shouldWatermark(access)) return null;
  if (!opts.assetUid) {
    throw new Error('buildWatermark: opts.assetUid is required');
  }

  const hmacKey = opts.hmacKey || newHmacKey();
  const timestamp = opts.timestamp || new Date().toISOString();
  const sessionNonce = crypto.randomBytes(16).toString('hex');
  const consumerId = resolveConsumerId(opts);

  const body = {
    version: WATERMARK_VERSION,
    asset_uid: opts.assetUid,
    consumer_id: consumerId,
    timestamp,
    session_nonce: sessionNonce,
    algorithm: 'hmac-sha256',
  };

  // Compute the HMAC over the canonical JSON body (everything
  // except the hmac field itself). The consumer can verify
  // the HMAC by recomputing it from these fields.
  const canonical = stableStringify(body);
  const hmac = crypto
    .createHmac('sha256', hmacKey)
    .update(canonical)
    .digest('hex');

  return {
    ...body,
    hmac,
  };
}

/**
 * Build a watermark policy summary — what `kdna plan-load`
 * returns. The full watermark is built at `kdna load` time
 * (because the plan is built without decryption context);
 * the plan only carries the policy metadata.
 */
function watermarkPolicy(opts) {
  if (!shouldWatermark(opts.access)) return null;
  return {
    version: WATERMARK_VERSION,
    access_mode: opts.access,
    asset_uid: opts.assetUid,
    algorithm: 'hmac-sha256',
    fields: ['asset_uid', 'consumer_id', 'timestamp', 'session_nonce', 'hmac'],
    note: 'watermark is generated at load time and is content-neutral',
  };
}

/**
 * Verify a watermark. Returns { ok, reason }.
 *
 * The HMAC key is required. If the verifier doesn't have the
 * key, the watermark cannot be verified. This is intentional:
 * a leaked HMAC is useless because every CLI invocation
 * generates a new key.
 */
function verifyWatermark(watermark, opts = {}) {
  if (!watermark || typeof watermark !== 'object') {
    return { ok: false, reason: 'not a watermark object' };
  }
  if (watermark.version !== WATERMARK_VERSION) {
    return { ok: false, reason: `unsupported watermark version: ${watermark.version}` };
  }
  if (watermark.algorithm !== 'hmac-sha256') {
    return { ok: false, reason: `unsupported algorithm: ${watermark.algorithm}` };
  }
  if (!opts.hmacKey) {
    return { ok: false, reason: 'hmac key required for verification' };
  }
  const { hmac, ...body } = watermark;
  const canonical = stableStringify(body);
  const expected = crypto
    .createHmac('sha256', opts.hmacKey)
    .update(canonical)
    .digest('hex');
  if (expected !== hmac) {
    return { ok: false, reason: 'hmac mismatch' };
  }
  return { ok: true, reason: null };
}

/**
 * Render a watermark as a one-line text header for inclusion
 * in `--as=prompt` and `--as=compact` output. The consumer is
 * expected to include this line in the prompt they send to
 * the LLM; if the LLM's response is leaked, the watermark
 * is in the response too.
 *
 * The rendered line is one short line, lower-case, no
 * content-trust vocabulary, machine-parseable. Example:
 *
 *   [WATERMARK v1 hmac-sha256 2026-06-28T17:30:00Z <first-12-chars-of-hmac>]
 */
function renderWatermarkHeader(watermark) {
  if (!watermark) return '';
  const hmacShort = (watermark.hmac || '').substring(0, 12);
  const cid = watermark.consumer_id || 'anonymous';
  return (
    `[WATERMARK v=${watermark.version} alg=${watermark.algorithm || 'hmac-sha256'} ` +
    `ts=${watermark.timestamp} nonce=${(watermark.session_nonce || '').substring(0, 12)} ` +
    `cid=${cid} hmac=${hmacShort}]`
  );
}

/**
 * Stable canonical JSON for HMAC computation. Same shape as
 * the kdna-cli's STABLE_STRINGIFY used in Story 19/20 — kept
 * independent here because the servers don't share code with
 * the CLI, and the canonical form is the simplest possible
 * deterministic serialization.
 */
function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

module.exports = {
  WATERMARK_VERSION,
  WATERMARKED_ACCESS_MODES,
  shouldWatermark,
  newHmacKey,
  resolveConsumerId,
  buildWatermark,
  watermarkPolicy,
  verifyWatermark,
  renderWatermarkHeader,
  stableStringify,
};
