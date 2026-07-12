/**
 * deprecation.js — Bundle component deprecation scan (Story 13)
 *
 * Scans a bundle manifest (the `kdna.bundle.json` file with
 * `bundle_format: "kdna-bundle-v1"`) for components that declare a
 * `deprecation` block, and returns a list of soft deprecation warnings
 * for components whose deprecation condition is satisfied by the
 * current CLI version.
 *
 * Component deprecation shape (additive, optional):
 *
 *   {
 *     "id": "@aikdna/old-component@1.0.0",
 *     "path": "./old.kdna",
 *     "priority": 1,
 *     "deprecation": {
 *       "since":      ">=0.28.0",     // OR
 *       "deprecated_in": ">=0.28.0",  // alias for "since"
 *       "deprecated_at": "0.28.0",    // shorthand for "since: 0.28.0"
 *       "remove_in":   "0.30.0",      // optional, escalates wording
 *       "replacement": "@aikdna/new-component",
 *       "reason":      "Renamed for clarity"
 *     }
 *   }
 *
 * The CLI emits one stderr line per affected component. The
 * wording switches when the CLI is at or past `remove_in`.
 *
 * Top-level bundle deprecation (whole bundle is deprecated):
 *
 *   {
 *     "bundle_format": "kdna-bundle-v1",
 *     "name": "@aikdna/old-bundle",
 *     "deprecation": {
 *       "since": ">=0.28.0",
 *       "reason": "Migrate to @aikdna/new-bundle"
 *     }
 *   }
 *
 * This is the same shape, just at the manifest level. The CLI surfaces
 * it as a separate "bundle-level" line.
 *
 * Design contract: deprecation is a soft signal, never blocking.
 * It does NOT affect exit code. It does NOT prevent load/plan-load.
 * It is purely informational, like the v1 format deprecation warning
 * in Story 5 (`kdna load` on a v1 asset prints a one-liner to stderr).
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cbor = require('cbor-x');
const { isDeprecatedAt } = require('./semver-util');

/**
 * Read the bundle manifest if `abs` points at a `bundle-profile-v1` asset.
 * Returns `{ kind: 'bundle', manifest, components }`, a discriminated
 * `{ kind: 'diagnostic', diagnostic }` result when the bundle payload exists
 * but cannot be decoded, or `null` when the path is not a bundle.
 *
 * `manifest` is the top-level kdna.json; `components` is the parsed
 * `components[]` array from `payload.kdnab` (or the legacy `components`
 * field on the manifest itself, if present).
 */
function readBundleComponents(abs) {
  const kdnaJsonPath = path.join(abs, 'kdna.json');
  if (!fs.existsSync(kdnaJsonPath)) return null;

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(kdnaJsonPath, 'utf8'));
  } catch {
    return null;
  }

  if (!manifest.compatibility || manifest.compatibility.profile !== 'bundle-profile-v1') {
    return null;
  }

  const payloadPath = path.join(abs, 'payload.kdnab');
  if (!fs.existsSync(payloadPath)) return null;

  try {
    const payloadBuf = fs.readFileSync(payloadPath);
    const payload = cbor.decode(payloadBuf);
    if (Array.isArray(payload.components)) {
      return { kind: 'bundle', manifest, components: payload.components };
    }
  } catch {
    const componentId = manifest.name || manifest.asset_id || '(unnamed bundle)';
    return {
      kind: 'diagnostic',
      diagnostic: {
        kind: 'diagnostic',
        severity: 'info',
        code: 'KDNA_PAYLOAD_CBOR_DECODE_FAILED',
        component_id: componentId,
        component_label: 'bundle',
        message:
          `[KDNA_PAYLOAD_CBOR_DECODE_FAILED] bundle "${componentId}" has a ` +
          'payload.kdnab that could not be decoded as CBOR; deprecation scanning was skipped.',
      },
    };
  }

  return null;
}

/**
 * Evaluate one deprecation block against the current CLI version.
 * Returns a warning object if the version satisfies the deprecation
 * condition, or null if not.
 *
 * @param {object|null} deprecation  the deprecation block (or null)
 * @param {string} componentId       for the warning message
 * @param {string} componentLabel    "component" or "bundle"
 * @param {string} currentVersion    the running CLI version
 */
function evaluateDeprecation(deprecation, componentId, componentLabel, currentVersion) {
  if (!deprecation || typeof deprecation !== 'object') return null;

  // Resolve the "since" condition from one of three accepted field names.
  //   "since"          — preferred; can be a version literal, comparator,
  //                      or range (e.g. "0.28.0", ">=0.28.0", "^0.28.0")
  //   "deprecated_in"  — alias (matches the wording in the Story 13 brief)
  //   "deprecated_at"  — shorthand: version ≥ this is deprecated
  let since = null;
  if (typeof deprecation.since === 'string' && deprecation.since.trim() !== '') {
    const raw = deprecation.since.trim();
    // Bare version literal "0.28.0" with no comparator or range operator
    // is treated as a "from this version onwards" boundary — that is what
    // "deprecated since 0.28.0" means in the deprecation context. If the
    // user wants exact-match semantics they can write "=0.28.0" (we do
    // not implement that shape today; ranges start with ^, ~, >, >=, <, <=).
    if (/^[0-9]/.test(raw)) {
      since = '>=' + raw;
    } else {
      since = raw;
    }
  } else if (
    typeof deprecation.deprecated_in === 'string' &&
    deprecation.deprecated_in.trim() !== ''
  ) {
    since = deprecation.deprecated_in;
  } else if (
    typeof deprecation.deprecated_at === 'string' &&
    deprecation.deprecated_at.trim() !== ''
  ) {
    // Treat deprecated_at as shorthand: "deprecated from this version onwards".
    since = '>=' + deprecation.deprecated_at.trim();
  }

  if (!since) return null; // no usable condition

  if (!isDeprecatedAt(currentVersion, since)) return null;

  // Build the warning object. The wording escalates when the CLI is at
  // or past `remove_in` (which is treated as a >= check, like deprecated_at).
  const removeIn = typeof deprecation.remove_in === 'string' ? deprecation.remove_in.trim() : null;
  const pastRemoval = removeIn && isDeprecatedAt(currentVersion, '>=' + removeIn);

  const reason = typeof deprecation.reason === 'string' ? deprecation.reason : null;
  const replacement = typeof deprecation.replacement === 'string' ? deprecation.replacement : null;

  const lines = [];
  const tag = pastRemoval ? 'REMOVAL' : 'DEPRECATION';
  lines.push(
    `[${tag}] ${componentLabel} "${componentId}" is deprecated (CLI ${currentVersion} ${pastRemoval ? '≥' : '≥'} since ${since}).`,
  );
  if (removeIn) {
    lines.push(
      `  scheduled for removal in ${removeIn}${pastRemoval ? ' — this CLI version is past removal' : ''}.`,
    );
  }
  if (replacement) {
    lines.push(`  replacement: ${replacement}`);
  }
  if (reason) {
    lines.push(`  reason: ${reason}`);
  }

  return {
    kind: pastRemoval ? 'removal' : 'deprecation',
    severity: pastRemoval ? 'warning' : 'info',
    component_id: componentId,
    component_label: componentLabel,
    deprecation: deprecation,
    current_version: currentVersion,
    since,
    remove_in: removeIn,
    past_removal: pastRemoval,
    replacement,
    reason,
    message: lines.join('\n'),
  };
}

/**
 * Scan an asset (path) for deprecation warnings and read diagnostics. Returns
 * an array of signal objects (possibly empty). Deprecation warnings have at
 * minimum:
 *
 *   {
 *     kind: 'deprecation' | 'removal',
 *     severity: 'info' | 'warning',
 *     component_id, component_label,
 *     message, current_version, since, remove_in, past_removal,
 *     replacement, reason,
 *     deprecation  // raw block, for consumers that want the full shape
 *   }
 *
 * A malformed CBOR bundle payload returns a non-blocking diagnostic signal
 * with code `KDNA_PAYLOAD_CBOR_DECODE_FAILED`. Returns [] if the asset is not
 * a bundle or has no deprecated components. Never throws.
 */
function scanBundleDeprecations(abs, currentVersion) {
  if (!abs || !currentVersion) return [];
  const bundle = readBundleComponents(abs);
  if (!bundle) return [];
  if (bundle.kind === 'diagnostic') return [bundle.diagnostic];

  const warnings = [];

  // 1. Top-level bundle deprecation
  const topLevel = evaluateDeprecation(
    bundle.manifest.deprecation,
    bundle.manifest.name || bundle.manifest.asset_id || '(unnamed bundle)',
    'bundle',
    currentVersion,
  );
  if (topLevel) warnings.push(topLevel);

  // 2. Per-component deprecation
  for (const comp of bundle.components) {
    if (!comp || typeof comp !== 'object') continue;
    const compId = comp.id || comp.path || '(unnamed component)';
    const w = evaluateDeprecation(comp.deprecation, compId, 'component', currentVersion);
    if (w) warnings.push(w);
  }

  return warnings;
}

/**
 * Format an array of deprecation warnings into multi-line stderr text.
 * Returns '' when there are no warnings.
 */
function formatDeprecationStderr(warnings) {
  if (!warnings || warnings.length === 0) return '';
  const hasDeprecation = warnings.some(
    (warning) => warning.kind === 'deprecation' || warning.kind === 'removal',
  );
  const lines = [
    hasDeprecation
      ? 'Notice: bundle deprecation signals detected.'
      : 'Notice: bundle metadata diagnostics detected.',
  ];
  for (const w of warnings) {
    lines.push(w.message);
  }
  return lines.join('\n') + '\n';
}

module.exports = {
  readBundleComponents,
  evaluateDeprecation,
  scanBundleDeprecations,
  formatDeprecationStderr,
};
