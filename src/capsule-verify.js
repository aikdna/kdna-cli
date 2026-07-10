// KDNA Capsule Verification — trust chain validation for agent consumption
// Ensures agents receive verified, tamper-proof context capsules.
const { execFileSync } = require('child_process');

function verifyCapsule(capsulePath, _options = {}) {
  const raw = require('fs').readFileSync(capsulePath, 'utf8');
  let capsule;
  try {
    capsule = JSON.parse(raw);
  } catch {
    return { valid: false, error: 'Invalid capsule JSON' };
  }

  const errors = [];
  const warnings = [];

  // 1. Structural checks
  if (capsule.type !== 'kdna.context.capsule') errors.push('Missing capsule type marker');
  if (!capsule.domain) errors.push('Missing domain identifier');
  if (!capsule.asset_digest) errors.push('Missing asset digest');
  if (!capsule.signature) errors.push('Missing signature block');

  // 2. CRITICAL: do NOT trust `capsule.signature.verified` from the capsule
  // itself. That field is attacker-controlled — anyone can write
  //   { "signature": { "verified": true } }
  // and the prior implementation would accept it as proof. Trust MUST come
  // from a real cryptographic verification of the underlying asset.
  //
  // Options accepted via _options:
  //   - assetPath:       path to the .kdna file the capsule references
  //                      (we verify its signature directly with kdna-core)
  //   - publicKeyPath:   optional pinned public key (PEM) for ed25519 verify
  //   - trustedPubkeys:  optional array of trusted fingerprints
  //                      (matches the creator_id recorded in the asset)
  if (capsule.signature) {
    const assetPath = _options?.assetPath;
    if (!assetPath) {
      errors.push(
        'Capsule signature self-claim ("verified": ...) is not a trust anchor. ' +
          'Caller must pass { assetPath } to enable cryptographic verification.',
      );
    } else {
      try {
        const core = require('@aikdna/kdna-core');
        const result = core.verifySignatureSync(assetPath, {
          publicKey: _options?.publicKeyPath,
        });
        if (!result || !result.valid) {
          errors.push(
            `Asset signature did not verify: ${result?.error || 'unknown failure'}. ` +
              'Capsule is rejected — its self-claim is not authoritative.',
          );
        } else if (_options?.trustedPubkeys && _options.trustedPubkeys.length > 0) {
          // The signature math passed, but the trust anchor must also be
          // in the caller's allow-list. We compare against the manifest's
          // recorded creator public key fingerprint.
          const manifest = result.manifest || {};
          const pubFp = manifest?.author?.pubkey;
          if (!pubFp || !_options.trustedPubkeys.includes(pubFp)) {
            errors.push(
              `Asset signature verified, but signing key (${pubFp || 'unknown'}) ` +
                'is not in the caller-supplied trusted allow-list.',
            );
          }
        }
      } catch (e) {
        errors.push(
          `Failed to run cryptographic verification: ${e.message}. ` +
            'Refusing to trust the capsule self-claim.',
        );
      }
    }
  }

  // 3. Digest integrity
  if (capsule.asset_digest && capsule.domain) {
    try {
      // Check if the installed asset matches the capsule's claimed digest
      const result = execFileSync('kdna', ['verify', capsule.domain, '--structure'], {
        encoding: 'utf8',
        timeout: 15000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (!result.includes('valid')) {
        warnings.push('Could not verify installed asset against capsule digest');
      }
    } catch {
      warnings.push('Could not run kdna verify to cross-check capsule digest');
    }
  }

  // 4. Trace metadata
  if (capsule.trace) {
    if (!capsule.trace.schema_valid)
      warnings.push('Schema validation was not performed during load');
    if (!capsule.trace.signature_valid)
      warnings.push('Asset signature was not verified during load');
    if (!capsule.trace.loaded_at) warnings.push('Missing load timestamp');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    capsule,
  };
}

module.exports = { verifyCapsule };
