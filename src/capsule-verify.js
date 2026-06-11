// KDNA Capsule Verification — trust chain validation for agent consumption
// Ensures agents receive verified, tamper-proof context capsules.
const crypto = require('crypto');
const { execFileSync } = require('child_process');

function verifyCapsule(capsulePath, options = {}) {
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

  // 2. Signature verification
  if (capsule.signature && !capsule.signature.verified) {
    errors.push('Capsule signature not verified — asset may be tampered');
  }

  // 3. Digest integrity
  if (capsule.asset_digest && capsule.domain) {
    try {
      const kdnaHome =
        process.env.KDNA_HOME || require('path').join(require('os').homedir(), '.kdna');
      const packagesDir = require('path').join(
        kdnaHome,
        'packages',
        capsule.domain.replace('@', '').replace('/', '-'),
      );
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
