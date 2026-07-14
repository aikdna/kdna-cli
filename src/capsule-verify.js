// KDNA Capsule Verification — trust chain validation for agent consumption
// Ensures agents receive verified, tamper-proof context capsules.

const fs = require('fs');
const crypto = require('crypto');

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function computeEntrySetDigestFromFile(assetPath) {
  const core = require('@aikdna/kdna-core');
  const layout = core.readLayout(assetPath);
  const manifestEntry = layout?.map?.['kdna.json'];
  const payloadEntry = layout?.map?.['payload.kdnab'];
  if (!Buffer.isBuffer(manifestEntry) || !Buffer.isBuffer(payloadEntry)) {
    throw new Error('KDNA container is missing protected runtime entries');
  }
  const manifestDigest = sha256(manifestEntry);
  const payloadDigest = sha256(payloadEntry);
  const combined = `kdna.json:${manifestDigest}\npayload.kdnab:${payloadDigest}`;
  return `sha256:${sha256(Buffer.from(combined, 'utf8'))}`;
}

function verifyCapsule(capsulePath, options = {}) {
  const raw = fs.readFileSync(capsulePath, 'utf8');
  let capsule;
  try {
    capsule = JSON.parse(raw);
  } catch {
    return { valid: false, errors: ['Invalid capsule JSON'], warnings: [] };
  }

  const errors = [];
  const warnings = [];

  // 1. Structural checks
  if (!capsule.type || capsule.type !== 'kdna.context.capsule')
    errors.push('Missing or invalid capsule type marker');
  if (!capsule.domain) errors.push('Missing domain identifier');
  if (!capsule.asset_digest) errors.push('Missing asset digest');
  if (!capsule.signature) errors.push('Missing signature block');

  // 2. Honest signature state check (not self-claimed "verified")
  if (capsule.signature) {
    const sigState = capsule.signature.state || 'absent';
    if (sigState === 'absent') {
      warnings.push('Capsule is unsigned — signature state is absent');
    } else if (sigState === 'not_checked') {
      warnings.push('Capsule has a declared issuer but signature was not verified during load');
    } else if (sigState === 'verified') {
      warnings.push('Capsule claims verified signature — external verification available');
    }
  }

  // 3. Asset digest verification (when assetPath is provided)
  const assetPath = options.assetPath;
  if (assetPath && fs.existsSync(assetPath)) {
    try {
      const actualEntrySetDigest = computeEntrySetDigestFromFile(assetPath);
      if (capsule.asset_digest && actualEntrySetDigest !== capsule.asset_digest) {
        errors.push(
          `Entry-set digest mismatch: capsule claims ${capsule.asset_digest}, ` +
            `actual protected runtime entry digest is ${actualEntrySetDigest}`,
        );
      }
    } catch (e) {
      errors.push(`Unable to verify protected runtime entries: ${e.message}`);
    }
  } else if (assetPath) {
    warnings.push(`Asset path not found: ${assetPath}. Cannot verify digest.`);
  }

  // 4. Cryptographic signature verification (when assetPath and key provided)
  if (assetPath && fs.existsSync(assetPath) && options.publicKey) {
    try {
      const core = require('@aikdna/kdna-core');
      const result = core.verifySignatureSync(assetPath, {
        publicKey: options.publicKey,
      });
      if (!result || result.signature_valid !== true) {
        errors.push(
          `Asset signature verification failed: ${result?.errors?.join('; ') || 'unknown failure'}`,
        );
      } else {
        warnings.push('Asset signature cryptographically verified');
      }
    } catch (e) {
      errors.push(`Failed to run cryptographic verification: ${e.message}`);
    }
  }

  // 5. Trace metadata
  if (capsule.trace) {
    if (capsule.trace.schema_valid === undefined)
      warnings.push('Schema validation status not reported');
    else if (!capsule.trace.schema_valid)
      warnings.push('Schema validation was not performed during load');

    if (!capsule.trace.signature_state) warnings.push('Signature state not reported');
    else if (capsule.trace.signature_state === 'not_checked')
      warnings.push('Asset signature was not verified during load');

    if (!capsule.trace.loaded_at) warnings.push('Missing load timestamp');
  }

  // 6. Context integrity — ensure context is present for non-index profiles
  if (
    capsule.profile !== 'index' &&
    (!capsule.context || Object.keys(capsule.context).length === 0)
  ) {
    warnings.push('Empty context for non-index profile');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

module.exports = { verifyCapsule, computeEntrySetDigestFromFile };
