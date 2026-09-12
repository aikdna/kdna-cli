/**
 * Anti-Monolithic Domain lint for KDNA dev source workspaces.
 *
 * Implements the Anti-Monolithic Domain Principle (RFC-0013 §4).
 * The principle is codified in SPEC §1.6; this file is the runtime
 * check that enforces it.
 *
 * Default mode: WARN (does not block CI).
 * Strict mode: ERROR (blocks CI / official preflight).
 *
 * Trigger conditions (all three must hold):
 *   1. KDNA_Core.json.axioms.length > 6
 *   2. KDNA_Core.json.frameworks.length >= 3
 *   3. The source workspace either:
 *        (a) has no module_manifest.json, OR
 *        (b) has module_manifest.json but no domain-level
 *            decomposition_rationale field.
 *
 * If a trigger fires, the lint produces:
 *   - WARNING: domain appears monolithic; recommend split or
 *     add module_manifest.json + decomposition_rationale.
 *   - ERROR (--strict only): same content, with the strict banner.
 *
 * Optional auxiliary checks (always WARN, never ERROR):
 *   - module_manifest.json exists and references modules
 *     but has no sub_domain (or all modules are internal_module)
 *     and the domain has multiple distinct judgment questions.
 *   - module_manifest.json exists with decomposition_rationale
 *     but the rationale text is shorter than 30 characters
 *     (likely placeholder).
 *
 * Boundary rules per RFC-0013 §3.3:
 *   - internal_module: in-domain, not independently loadable
 *   - sub_domain:      independently loadable as its own .kdna
 *   - reference:       pure data, not judgment
 */

const fs = require('fs');
const path = require('path');

const AXIOM_THRESHOLD = 6; // SPEC §5.2 says "between 2 and 6 axioms"
const FRAMEWORK_THRESHOLD = 3; // RFC-0013 §4 companion rule
const RATIONALE_MIN_LENGTH = 30;

function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return { __readError: e.message, __path: filePath };
  }
}

/**
 * Run the Anti-Monolithic check on a dev source directory.
 * Returns { triggered, warnings, errors, summary }.
 */
function runAntiMonolithicCheck(dir, opts = {}) {
  const strict = !!opts.strict;
  const abs = path.resolve(dir);
  const result = {
    path: abs,
    triggered: false,
    warnings: [],
    errors: [],
    summary: {
      axiom_count: 0,
      framework_count: 0,
      has_module_manifest: false,
      has_decomposition_rationale: false,
    },
  };

  const corePath = path.join(abs, 'KDNA_Core.json');
  const core = readJsonSafe(corePath);
  if (!core || core.__readError) {
    result.errors.push(
      `Cannot read KDNA_Core.json at ${corePath}: ${(core && core.__readError) || 'file not found'}`,
    );
    return result;
  }

  const axioms = Array.isArray(core.axioms) ? core.axioms : [];
  const frameworks = Array.isArray(core.frameworks) ? core.frameworks : [];
  result.summary.axiom_count = axioms.length;
  result.summary.framework_count = frameworks.length;

  const axiomOver = axioms.length > AXIOM_THRESHOLD;
  const frameworkOver = frameworks.length >= FRAMEWORK_THRESHOLD;
  if (!axiomOver || !frameworkOver) {
    return result; // Below threshold: domain is not monolithic by the rule.
  }

  // Both thresholds exceeded: now check module_manifest.json.
  const manifestPath = path.join(abs, 'module_manifest.json');
  const manifest = readJsonSafe(manifestPath);
  const manifestExists = manifest !== null && !manifest.__readError;
  result.summary.has_module_manifest = manifestExists;

  let hasRationale = false;
  if (manifestExists) {
    const rationale = (manifest && manifest.decomposition_rationale) || '';
    hasRationale = typeof rationale === 'string' && rationale.trim().length >= RATIONALE_MIN_LENGTH;
    result.summary.has_decomposition_rationale = hasRationale;

    if (
      rationale &&
      rationale.trim().length > 0 &&
      rationale.trim().length < RATIONALE_MIN_LENGTH
    ) {
      result.warnings.push(
        `module_manifest.json: decomposition_rationale is only ${rationale.trim().length} chars; ` +
          `minimum is ${RATIONALE_MIN_LENGTH} chars to count as a real sign-off.`,
      );
    }
  }

  if (!manifestExists) {
    result.triggered = true;
    const msg =
      `Anti-Monolithic Domain Principle: KDNA_Core.json has ` +
      `${axioms.length} axioms (>${AXIOM_THRESHOLD}) and ${frameworks.length} frameworks (>=${FRAMEWORK_THRESHOLD}). ` +
      `No module_manifest.json found. Either split into sub-domains and compose via cluster, ` +
      `or create a module_manifest.json with a decomposition_rationale (>=${RATIONALE_MIN_LENGTH} chars) ` +
      `and a maintainer sign-off. See SPEC §1.6 and RFC-0013 §4.`;
    if (strict) {
      result.errors.push(msg);
    } else {
      result.warnings.push(msg);
    }
  } else if (!hasRationale) {
    result.triggered = true;
    const msg =
      `Anti-Monolithic Domain Principle: KDNA_Core.json has ` +
      `${axioms.length} axioms (>${AXIOM_THRESHOLD}) and ${frameworks.length} frameworks (>=${FRAMEWORK_THRESHOLD}). ` +
      `module_manifest.json exists but decomposition_rationale is missing or too short. ` +
      `Add a substantive rationale (>=${RATIONALE_MIN_LENGTH} chars) to record the maintainer sign-off. ` +
      `See SPEC §1.6 and RFC-0013 §4.`;
    if (strict) {
      result.errors.push(msg);
    } else {
      result.warnings.push(msg);
    }
  } else {
    // Thresholds exceeded but maintainer sign-off is present:
    // emit a soft warning so the maintainer rationale is visible in
    // CI logs even though the rule is satisfied.
    result.warnings.push(
      `Anti-Monolithic Domain Principle: KDNA_Core.json has ${axioms.length} axioms and ` +
        `${frameworks.length} frameworks. Maintainer sign-off recorded in module_manifest.json ` +
        `(decomposition_rationale). Review periodically that the rationale still holds.`,
    );
  }

  return result;
}

/**
 * Print the check result to stdout. Returns the recommended process
 * exit code: 0 if no errors (warnings OK), 1 if errors.
 */
function printAndExit(result, opts = {}) {
  const jsonMode = !!opts.json;
  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    return result.errors.length ? 1 : 0;
  }
  if (result.errors.length) {
    console.error('Errors:');
    result.errors.forEach((e) => console.error(`  - ${e}`));
  }
  if (result.warnings.length) {
    console.log('Warnings:');
    result.warnings.forEach((w) => console.log(`  - ${w}`));
  }
  if (!result.errors.length && !result.warnings.length) {
    console.log(
      `✓ Anti-Monolithic check passed: ${result.path} ` +
        `(${result.summary.axiom_count} axioms, ${result.summary.framework_count} frameworks)`,
    );
  } else if (!result.errors.length) {
    console.log(
      `✓ Anti-Monolithic check: ${result.warnings.length} warning(s), 0 error(s) ` +
        `(passing; --strict to upgrade warnings to errors)`,
    );
  }
  return result.errors.length ? 1 : 0;
}

module.exports = {
  runAntiMonolithicCheck,
  printAndExit,
  AXIOM_THRESHOLD,
  FRAMEWORK_THRESHOLD,
  RATIONALE_MIN_LENGTH,
};
