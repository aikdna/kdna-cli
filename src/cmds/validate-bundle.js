/**
 * validate-bundle.js — Bundle validation (roadmap-2026.md Stories 3 + 9)
 *
 * Validates a `kdna.bundle.json` manifest (RFC #148 Phase 1):
 *
 *   - Checks `bundle_format === "kdna-bundle-v1"`
 *   - Checks `components[]` is a non-empty array
 *   - For each component: resolves `path`, checks the file exists,
 *     detects it as a KDNA v1/v2 container, and runs the existing
 *     `validate()` pass from @aikdna/kdna-core.
 *   - Runs per-card-type conflict analysis across component pairs
 *     (Story 9, per docs/CONFLICT_RESOLUTION.md).
 *
 * Exit codes:
 *   0 — bundle_valid = true (all components pass, bundle shape valid)
 *   1 — bundle_valid = false (one or more components failed, or
 *       bundle manifest is malformed, or ERROR-severity conflicts found)
 *
 * Output: JSON to stdout, mirroring the shape documented in
 * docs/CONFLICT_RESOLUTION.md §Conflict Report Format.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { analyseConflicts } = require('./conflict-analysis');

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

  const { validate, detectContainerFormat, isV1SourceDir, isV2SourceDir } = core;
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

    const isSourceDir = isV1SourceDir(compAbs) || (isV2SourceDir && isV2SourceDir(compAbs));

    if (!isSourceDir && fmt !== 'v1' && fmt !== 'v2') {
      errors.push({
        conflict_type: 'schema',
        severity: 'ERROR',
        component: compId,
        field: 'path',
        note: `Component "${compId}" at "${comp.path}" is not a valid KDNA v1/v2 container or source directory.`,
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

  // 4. Conflict analysis (Story 9) — per-card-type static analysis across
  //    all component pairs, per docs/CONFLICT_RESOLUTION.md.
  try {
    const { errors: cErr, warnings: cWarn, info: cInfo } =
      analyseConflicts(componentResults, core);
    for (const e of cErr) errors.push(e);
    for (const w of cWarn) warnings.push(w);
    for (const i of cInfo) info.push(i);
  } catch (_) {
    // Conflict analysis is non-blocking — a bug here must not break validate
    info.push({
      conflict_type: 'info',
      severity: 'INFO',
      note: 'Conflict analysis could not complete. See docs/CONFLICT_RESOLUTION.md.',
    });
  }

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
