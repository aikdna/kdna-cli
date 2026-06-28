/**
 * validate-bundle.js — Bundle validation stub (roadmap-2026.md Story 3)
 *
 * Validates a `kdna.bundle.json` manifest (RFC #148 Phase 1):
 *
 *   - Checks `bundle_format === "kdna-bundle-v1"`
 *   - Checks `components[]` is a non-empty array
 *   - For each component: resolves `path`, checks the file exists,
 *     detects it as a KDNA v1 container, and runs the existing
 *     `validate()` pass from @aikdna/kdna-core.
 *
 * Conflict analysis (per-card-type union/priority rules defined in
 * docs/CONFLICT_RESOLUTION.md) is NOT implemented in this stub.
 * Story 9 adds that analysis on top of this foundation.
 *
 * Exit codes:
 *   0 — bundle_valid = true (all components pass, bundle shape valid)
 *   1 — bundle_valid = false (one or more components failed, or
 *       bundle manifest is malformed)
 *
 * Output: JSON to stdout, mirroring the shape documented in
 * docs/CONFLICT_RESOLUTION.md §Conflict Report Format.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const BUNDLE_FORMAT = 'kdna-bundle-v1';

/**
 * Validate a bundle manifest at `manifestPath`.
 *
 * @param {string} manifestPath  Absolute or relative path to the manifest JSON.
 * @param {object} [opts]
 * @param {boolean} [opts.verbose]  Include full per-component validation detail.
 * @returns {BundleValidationResult}
 */
function validateBundle(manifestPath, opts = {}) {
  const abs = path.resolve(manifestPath);

  if (!fs.existsSync(abs)) {
    return {
      bundle_valid: false,
      fatal: `File not found: ${manifestPath}`,
      bundle_format: null,
      name: null,
      version: null,
      components: [],
      conflicts: { error_count: 1, warning_count: 0, info_count: 0 },
      errors: [{ conflict_type: 'schema', severity: 'ERROR', note: `File not found: ${manifestPath}` }],
      warnings: [],
      info: [],
    };
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (e) {
    return {
      bundle_valid: false,
      fatal: `Invalid JSON in bundle manifest: ${e.message}`,
      bundle_format: null,
      name: null,
      version: null,
      components: [],
      conflicts: { error_count: 1, warning_count: 0, info_count: 0 },
      errors: [{ conflict_type: 'schema', severity: 'ERROR', note: `Invalid JSON: ${e.message}` }],
      warnings: [],
      info: [],
    };
  }

  const errors = [];
  const warnings = [];
  const info = [];

  // 1. bundle_format check
  if (manifest.bundle_format !== BUNDLE_FORMAT) {
    errors.push({
      conflict_type: 'schema',
      severity: 'ERROR',
      field: 'bundle_format',
      note: `Expected "${BUNDLE_FORMAT}", got "${manifest.bundle_format || '(missing)'}". `
        + 'A valid kdna.bundle.json must have bundle_format: "kdna-bundle-v1".',
    });
  }

  // 2. components array check
  if (!Array.isArray(manifest.components) || manifest.components.length === 0) {
    errors.push({
      conflict_type: 'schema',
      severity: 'ERROR',
      field: 'components',
      note: '"components" must be a non-empty array of component descriptors.',
    });
    return buildResult(manifest, [], errors, warnings, info);
  }

  // 3. Per-component validation
  let core;
  try {
    core = require('@aikdna/kdna-core');
  } catch (e) {
    errors.push({
      conflict_type: 'schema',
      severity: 'ERROR',
      note: 'Cannot load @aikdna/kdna-core: ' + e.message,
    });
    return buildResult(manifest, [], errors, warnings, info);
  }

  const { validate, detectContainerFormat, isV1SourceDir } = core;
  const baseDir = path.dirname(abs);
  const componentResults = [];

  for (let i = 0; i < manifest.components.length; i++) {
    const comp = manifest.components[i];
    const compId = comp.id || `(components[${i}])`;

    if (!comp.id) {
      errors.push({
        conflict_type: 'schema',
        severity: 'ERROR',
        component: compId,
        field: 'id',
        note: `components[${i}] is missing the required "id" field.`,
      });
    }

    if (!comp.path) {
      errors.push({
        conflict_type: 'schema',
        severity: 'ERROR',
        component: compId,
        field: 'path',
        note: `Component "${compId}" (components[${i}]) is missing the required "path" field.`,
      });
      componentResults.push({
        id: compId,
        path: null,
        priority: null,
        valid: false,
        issues: ['missing "path" field'],
      });
      continue;
    }

    const compAbs = path.resolve(baseDir, comp.path);

    if (!fs.existsSync(compAbs)) {
      errors.push({
        conflict_type: 'schema',
        severity: 'ERROR',
        component: compId,
        field: 'path',
        note: `Component "${compId}" path not found: ${comp.path}`,
      });
      componentResults.push({
        id: compId,
        path: comp.path,
        priority: typeof comp.priority === 'number' ? comp.priority : null,
        valid: false,
        issues: [`file not found: ${comp.path}`],
      });
      continue;
    }

    // Detect container format
    let fmt;
    try {
      fmt = detectContainerFormat(compAbs);
    } catch (e) {
      fmt = null;
    }

    const isSourceDir = isV1SourceDir(compAbs);

    if (!isSourceDir && fmt !== 'v1') {
      errors.push({
        conflict_type: 'schema',
        severity: 'ERROR',
        component: compId,
        field: 'path',
        note: `Component "${compId}" at "${comp.path}" is not a valid KDNA v1 container or source directory.`,
      });
      componentResults.push({
        id: compId,
        path: comp.path,
        priority: typeof comp.priority === 'number' ? comp.priority : null,
        valid: false,
        issues: ['not a KDNA v1 container'],
      });
      continue;
    }

    // Run the existing v1 validator
    let compResult;
    try {
      compResult = validate(compAbs);
    } catch (e) {
      errors.push({
        conflict_type: 'schema',
        severity: 'ERROR',
        component: compId,
        note: `validate() threw for component "${compId}": ${e.message}`,
      });
      componentResults.push({
        id: compId,
        path: comp.path,
        priority: typeof comp.priority === 'number' ? comp.priority : null,
        valid: false,
        issues: [`validator error: ${e.message}`],
      });
      continue;
    }

    const compValid = compResult.overall_valid === true;

    if (!compValid) {
      errors.push({
        conflict_type: 'schema',
        severity: 'ERROR',
        component: compId,
        note: `Component "${compId}" failed KDNA v1 validation. See component result for details.`,
      });
    }

    const entry = {
      id: compId,
      path: comp.path,
      priority: typeof comp.priority === 'number' ? comp.priority : null,
      valid: compValid,
      issues: compResult.issues || [],
    };
    if (opts.verbose) {
      entry._validation = compResult;
    }
    componentResults.push(entry);
  }

  // 4. Conflict analysis stub — Story 9 fills this in.
  //    Emit a single INFO note so callers can tell the stub is running.
  info.push({
    conflict_type: 'info',
    severity: 'INFO',
    note: 'Conflict analysis pending (Story 9). See docs/CONFLICT_RESOLUTION.md for the design contract.',
  });

  return buildResult(manifest, componentResults, errors, warnings, info);
}

/**
 * @param {object} manifest
 * @param {Array}  components
 * @param {Array}  errors
 * @param {Array}  warnings
 * @param {Array}  info
 * @returns {BundleValidationResult}
 */
function buildResult(manifest, components, errors, warnings, info) {
  return {
    bundle_format: manifest.bundle_format || null,
    name: manifest.name || null,
    version: manifest.version || null,
    bundle_valid: errors.length === 0,
    components,
    conflicts: {
      error_count: errors.length,
      warning_count: warnings.length,
      info_count: info.length,
    },
    errors,
    warnings,
    info,
  };
}

module.exports = { validateBundle, BUNDLE_FORMAT };
