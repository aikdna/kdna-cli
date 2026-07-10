/**
 * validate-bundle.js — Bundle validation (roadmap-2026.md Stories 3 + 9 + 13)
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
 *   - Story 13: validates per-component `trust_level` and `deprecation`
 *     fields, surfaces `low_trust_warnings` (WARNING-level conflicts
 *     involving `community`-trust components), and surfaces bundle-level
 *     deprecation signals when the current CLI version satisfies the
 *     deprecation condition.
 *
 * Exit codes:
 *   0 — bundle_valid = true (all components pass, bundle shape valid)
 *   1 — bundle_valid = false (one or more components failed, or
 *       bundle manifest is malformed, or ERROR-severity conflicts found)
 *
 * Output: JSON to stdout, mirroring the shape documented in
 * docs/CONFLICT_RESOLUTION.md §Conflict Report Format. Story 13 adds
 * `low_trust_warnings` and `deprecation_warnings` top-level sections.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { analyseConflicts } = require('./conflict-analysis');
const { evaluateDeprecation, formatDeprecationStderr } = require('./deprecation');

const BUNDLE_FORMAT = 'kdna-bundle-v1';
const VALID_TRUST_LEVELS = new Set(['community', 'verified', 'official']);

/**
 * Validate a bundle manifest at `manifestPath`.
 *
 * @param {string} manifestPath  Absolute or relative path to the manifest JSON.
 * @param {object} [opts]
 * @param {boolean} [opts.verbose]  Include full per-component validation detail.
 * @param {string} [opts.currentVersion]  the running CLI version. Story 13
 *   uses this to evaluate the `deprecation` blocks in the manifest. When
 *   omitted, `deprecation_warnings` is emitted as an empty section.
 * @returns {BundleValidationResult}
 */
function validateBundle(manifestPath, opts = {}) {
  const abs = path.resolve(manifestPath);
  // Story 13: default the currentVersion to the CLI's own package.json
  // version. Callers can override (e.g. tests) but the CLI case always
  // gets a value here.
  const currentVersion = opts.currentVersion || require('../../package.json').version;

  if (!fs.existsSync(abs)) {
    return {
      bundle_valid: false,
      fatal: `File not found: ${manifestPath}`,
      bundle_format: null,
      name: null,
      version: null,
      components: [],
      conflicts: { error_count: 1, warning_count: 0, info_count: 0 },
      errors: [
        { conflict_type: 'schema', severity: 'ERROR', note: `File not found: ${manifestPath}` },
      ],
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
      note:
        `Expected "${BUNDLE_FORMAT}", got "${manifest.bundle_format || '(missing)'}". ` +
        'A valid kdna.bundle.json must have bundle_format: "kdna-bundle-v1".',
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

    // Story 13 — trust_level validation. Optional field; when present
    // it must be one of {community, verified, official}. Anything else
    // is a hard schema error (rejected at validate time, not silently
    // ignored), because a typo here would mask the trust signal.
    if (comp.trust_level !== undefined && comp.trust_level !== null) {
      if (typeof comp.trust_level !== 'string' || !VALID_TRUST_LEVELS.has(comp.trust_level)) {
        errors.push({
          conflict_type: 'schema',
          severity: 'ERROR',
          component: compId,
          field: 'trust_level',
          note:
            `Component "${compId}" declares trust_level="${comp.trust_level}". ` +
            `Valid values: ${Array.from(VALID_TRUST_LEVELS).join(', ')}.`,
        });
      }
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
      // Story 13 — surface trust_level so conflict-analysis can tag
      // entries with the trust_level of each side.
      trust_level: VALID_TRUST_LEVELS.has(comp.trust_level) ? comp.trust_level : null,
      // Story 13 — surface the raw deprecation block (validation does
      // not require it to be well-formed here; the deprecation check
      // happens in the deprecation.js module against the current CLI
      // version). Stored as-is for the report to surface to the user.
      deprecation: comp.deprecation || null,
    };
    if (opts.verbose) {
      entry._validation = compResult;
    }
    componentResults.push(entry);
  }

  // 4. Conflict analysis (Story 9) — per-card-type static analysis across
  //    all component pairs, per docs/CONFLICT_RESOLUTION.md.
  try {
    const { errors: cErr, warnings: cWarn, info: cInfo } = analyseConflicts(componentResults, core);
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

  return buildResult(manifest, componentResults, errors, warnings, info, { currentVersion });
}

/**
 * @param {object} manifest
 * @param {Array}  components
 * @param {Array}  errors
 * @param {Array}  warnings
 * @param {Array}  info
 * @param {object} [opts]
 * @param {string} [opts.currentVersion]  the running CLI version (Story 13).
 *   When provided, the result also includes `deprecation_warnings` (entries
 *   that the current CLI version satisfies) and `low_trust_warnings`
 *   (WARNING-level conflicts involving community-trust components).
 * @returns {BundleValidationResult}
 */
function buildResult(manifest, components, errors, warnings, info, opts = {}) {
  const result = {
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

  // Story 13 — low_trust_warnings: filter WARNING-level entries where
  // at least one side has trust_level === "community". The conflict
  // entries are still in `warnings`; this section is a convenience
  // summary that downstream consumers (and the CLI's stderr line)
  // can surface without re-walking `warnings`.
  const lowTrustWarnings = warnings.filter((w) => w.community_warning === true);
  result.low_trust_warnings = {
    count: lowTrustWarnings.length,
    conflicts: lowTrustWarnings,
    // Distinct set of community-trust component ids that participate
    // in at least one community_warning. Lets the user ask "which of
    // my community components are causing trouble?" without scanning
    // the full conflict list.
    affected_components: Array.from(
      new Set(
        lowTrustWarnings.flatMap((w) =>
          [w.component_a, w.component_b].filter(
            (id) => w.trust_level_a === 'community' || w.trust_level_b === 'community',
          ),
        ),
      ),
    ),
  };

  // Story 13 — deprecation_warnings: scan the manifest (top-level
  // deprecation block + each component's deprecation block) against
  // the current CLI version. The CLI version is passed via opts; when
  // not provided (older callers, internal tests), this section is
  // still emitted but empty.
  if (opts.currentVersion) {
    const depWarnings = [];
    const topLevel = evaluateDeprecation(
      manifest.deprecation,
      manifest.name || manifest.asset_id || '(unnamed bundle)',
      'bundle',
      opts.currentVersion,
    );
    if (topLevel) depWarnings.push(topLevel);
    for (const comp of components) {
      if (!comp || !comp.deprecation) continue;
      const w = evaluateDeprecation(
        comp.deprecation,
        comp.id || comp.path || '(unnamed component)',
        'component',
        opts.currentVersion,
      );
      if (w) depWarnings.push(w);
    }
    result.deprecation_warnings = {
      count: depWarnings.length,
      current_cli_version: opts.currentVersion,
      warnings: depWarnings,
      // Pre-formatted one-liner for stderr-style consumers. Empty
      // string when there are no warnings so callers can append
      // unconditionally.
      stderr_text: formatDeprecationStderr(depWarnings),
    };
  } else {
    result.deprecation_warnings = {
      count: 0,
      current_cli_version: null,
      warnings: [],
      stderr_text: '',
    };
  }

  return result;
}

module.exports = { validateBundle, BUNDLE_FORMAT };
