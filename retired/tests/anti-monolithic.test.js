/**
 * Tests for the Anti-Monolithic Domain lint (RFC-0013 §4, SPEC §1.6).
 *
 * Run: node --test tests/anti-monolithic.test.js
 *
 * Strategy: write 4 fixtures (small, large + manifest + rationale, large
 * no manifest, large short rationale), then assert default (warning) and
 * strict (error) behavior for each.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  runAntiMonolithicCheck,
  AXIOM_THRESHOLD,
  FRAMEWORK_THRESHOLD,
  RATIONALE_MIN_LENGTH,
} = require('../src/cmds/anti-monolithic');

function makeCore({ axiomCount, frameworkCount }) {
  const axioms = [];
  for (let i = 0; i < axiomCount; i++) {
    axioms.push({
      id: `ax_${i + 1}`,
      one_sentence: `Axiom ${i + 1}.`,
      full_statement: `Full statement for axiom ${i + 1}.`,
      why: 'reason',
      applies_when: ['any'],
      does_not_apply_when: ['none'],
      failure_risk: 'low',
      confidence: 'high',
      evidence_type: 'practice_patterns',
    });
  }
  const frameworks = [];
  for (let i = 0; i < frameworkCount; i++) {
    frameworks.push({
      id: `fw_${i + 1}`,
      name: `Framework ${i + 1}`,
      purpose: 'test',
      steps: ['step 1'],
      when_to_apply: 'always',
    });
  }
  return {
    meta: { name: 'test', version: '0.1.0' },
    axioms,
    ontology: [],
    frameworks,
    core_structure: [],
    stances: [],
  };
}

function makeManifest({ withRationale, rationaleText }) {
  const m = {
    domain_id: '@test/test',
    modules: [
      {
        module_id: 'm1',
        module_type: 'internal_module',
        independent_asset: false,
        maps_to: 'KDNA_Core.json.frameworks[fw_1]',
        loadable_via: 'full',
      },
    ],
  };
  if (withRationale) {
    m.decomposition_rationale = rationaleText;
  }
  return m;
}

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-am-test-'));
}

test('small domain below thresholds: no warnings, no errors', () => {
  const dir = mkTmpDir();
  try {
    fs.writeFileSync(
      path.join(dir, 'KDNA_Core.json'),
      JSON.stringify(makeCore({ axiomCount: 4, frameworkCount: 2 })),
    );
    const result = runAntiMonolithicCheck(dir);
    assert.equal(result.triggered, false);
    assert.equal(result.warnings.length, 0);
    assert.equal(result.errors.length, 0);
    assert.equal(result.summary.axiom_count, 4);
    assert.equal(result.summary.framework_count, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('large domain without module_manifest: default warning, strict error', () => {
  const dir = mkTmpDir();
  try {
    fs.writeFileSync(
      path.join(dir, 'KDNA_Core.json'),
      JSON.stringify(makeCore({ axiomCount: 8, frameworkCount: 4 })),
    );
    const warn = runAntiMonolithicCheck(dir);
    assert.equal(warn.triggered, true);
    assert.equal(warn.errors.length, 0);
    assert.ok(warn.warnings.length >= 1);
    assert.match(warn.warnings[0], /Anti-Monolithic Domain Principle/);

    const strict = runAntiMonolithicCheck(dir, { strict: true });
    assert.equal(strict.triggered, true);
    assert.equal(strict.warnings.length, 0);
    assert.ok(strict.errors.length >= 1);
    assert.match(strict.errors[0], /Anti-Monolithic Domain Principle/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('large domain with module_manifest + substantive rationale: soft warning only', () => {
  const dir = mkTmpDir();
  try {
    fs.writeFileSync(
      path.join(dir, 'KDNA_Core.json'),
      JSON.stringify(makeCore({ axiomCount: 9, frameworkCount: 5 })),
    );
    const rationale =
      'This domain intentionally keeps its three sub-tools as internal modules ' +
      'because they are not independently loadable and share a single highest question. ' +
      'Test sign-off: maintainer @test.';
    fs.writeFileSync(
      path.join(dir, 'module_manifest.json'),
      JSON.stringify(makeManifest({ withRationale: true, rationaleText: rationale })),
    );
    const result = runAntiMonolithicCheck(dir);
    assert.equal(result.summary.has_module_manifest, true);
    assert.equal(result.summary.has_decomposition_rationale, true);
    assert.equal(result.triggered, false); // Soft warning path, not the "triggered" path
    assert.ok(result.warnings.length >= 1);
    assert.match(result.warnings[0], /Maintainer sign-off recorded/);

    // Strict should not error: rationale is substantive.
    const strict = runAntiMonolithicCheck(dir, { strict: true });
    assert.equal(strict.errors.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('large domain with module_manifest but short placeholder rationale: triggered (warn / error)', () => {
  const dir = mkTmpDir();
  try {
    fs.writeFileSync(
      path.join(dir, 'KDNA_Core.json'),
      JSON.stringify(makeCore({ axiomCount: 7, frameworkCount: 3 })),
    );
    fs.writeFileSync(
      path.join(dir, 'module_manifest.json'),
      JSON.stringify(makeManifest({ withRationale: true, rationaleText: 'todo' })),
    );
    const result = runAntiMonolithicCheck(dir);
    assert.equal(result.triggered, true);
    // Should have BOTH: a placeholder-too-short warning AND a missing-rationale warning/error.
    assert.ok(result.warnings.some((w) => /only \d+ chars/.test(w)));
    assert.ok(result.warnings.some((w) => /Anti-Monolithic Domain Principle/.test(w)));

    const strict = runAntiMonolithicCheck(dir, { strict: true });
    assert.ok(strict.errors.length >= 1);
    assert.match(strict.errors[0], /Anti-Monolithic Domain Principle/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('missing KDNA_Core.json: error', () => {
  const dir = mkTmpDir();
  try {
    const result = runAntiMonolithicCheck(dir);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /Cannot read KDNA_Core.json/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('thresholds: SPEC says 2-6 axioms; lint fires strictly above 6', () => {
  assert.equal(AXIOM_THRESHOLD, 6);
  assert.equal(FRAMEWORK_THRESHOLD, 3);
  assert.equal(RATIONALE_MIN_LENGTH, 30);
});
