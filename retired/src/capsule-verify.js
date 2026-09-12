// KDNA Capsule Verification — structure and digest validation for consumption.

const fs = require('fs');

function computeEntrySetDigestFromFile(assetPath) {
  const core = require('@aikdna/kdna-core');
  return core.computeDigestEvidence(assetPath).runtime_entry_set.value;
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
  if (!capsule.type || capsule.type !== 'kdna.runtime-capsule')
    errors.push('Missing or invalid capsule type marker');
  if (capsule.contract_version !== '0.1.0') errors.push('Missing or invalid contract version');
  if (!capsule.asset?.asset_id) errors.push('Missing asset identifier');
  if (!capsule.digests?.asset?.value) errors.push('Missing packaged asset digest');
  if (!capsule.digests?.content?.value) errors.push('Missing content digest');
  if (!capsule.digests?.runtime_entry_set?.value) errors.push('Missing Runtime entry-set digest');
  if (!capsule.signature) errors.push('Missing signature block');

  // 2. Current Preview has no asset-signature contract.
  if (capsule.signature && capsule.signature.state !== 'absent') {
    errors.push('Unsupported asset-signature state in Runtime Capsule');
  }

  // 3. A/C/E digest verification (when assetPath is provided)
  const assetPath = options.assetPath;
  if (assetPath && fs.existsSync(assetPath)) {
    try {
      const core = require('@aikdna/kdna-core');
      const actual = core.computeDigestEvidence(assetPath);
      for (const [field, label] of [
        ['asset', 'Packaged asset'],
        ['content', 'Content'],
        ['runtime_entry_set', 'Runtime entry-set'],
      ]) {
        const claimed = capsule.digests?.[field]?.value;
        if (claimed && actual[field].value !== claimed) {
          errors.push(
            `${label} digest mismatch: capsule claims ${claimed}, actual digest is ${actual[field].value}`,
          );
        }
      }
    } catch (e) {
      errors.push(`Unable to verify packaged asset digest evidence: ${e.message}`);
    }
  } else if (assetPath) {
    warnings.push(`Asset path not found: ${assetPath}. Cannot verify digest.`);
  }

  if (options.publicKey) {
    errors.push('Asset signatures are outside the current Preview contract');
  }

  // 5. Trace metadata
  if (capsule.trace) {
    if (capsule.trace.schema_valid === undefined)
      warnings.push('Schema validation status not reported');
    else if (!capsule.trace.schema_valid)
      warnings.push('Schema validation was not performed during load');

    if (capsule.trace.signature_state !== 'absent') {
      errors.push('Runtime Capsule trace contains an unsupported asset-signature state');
    }

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
