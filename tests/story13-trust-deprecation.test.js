/**
 * story13-trust-deprecation.test.js — Trust levels + deprecation (Story 13)
 *
 * Verifies the three Story 13 deliverables in OPEN/kdna-cli:
 *
 *   1) trust_level on each bundle component descriptor
 *      (community | verified | official) — accepted in kdna validate --bundle,
 *      surfaced in the component result, and propagated into conflict-analysis.
 *
 *   2) kdna validate --bundle surfaces low_trust_warnings: a top-level
 *      summary of WARNING-level conflicts where at least one side is
 *      trust_level: "community". ERROR-level conflicts are unchanged
 *      (they remain errors regardless of trust).
 *
 *   3) Semver-aware deprecation warnings: bundle manifests (top-level
 *      and per-component) can declare a `deprecation` block with
 *      `since` / `deprecated_in` / `deprecated_at` version fields.
 *      kdna load and kdna plan-load print soft warnings to stderr
 *      when the running CLI version satisfies the condition.
 *      Wording escalates to "REMOVAL" past `remove_in`.
 *
 * Test groups:
 *   A) semver-util unit tests (parseSemver, compareSemver, satisfies)
 *   B) deprecation.js unit tests (evaluateDeprecation, scanBundleDeprecations)
 *   C) conflict-analysis.js: conflict entries carry trust_level_a/_b
 *   D) validate-bundle.js: trust_level validation + low_trust_warnings
 *   E) CLI: load + plan-load print deprecation to stderr
 *   F) validate --bundle: stderr_text populated when deprecation matches
 *
 * Run: node --test tests/story13-trust-deprecation.test.js
 */

'use strict';

const { after, test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const CLI = path.resolve(__dirname, '..', 'src', 'cli.js');
const FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'minimal');
const CORE = require('@aikdna/kdna-core');
const cbor = require('cbor-x');
const { currentJudgmentPayload } = require('./helpers/current-asset');
const FIXTURE_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-s13-fixture-'));
const RUNTIME_FIXTURE = path.join(FIXTURE_TMP, 'minimal.kdna');
CORE.pack(FIXTURE, RUNTIME_FIXTURE);
after(() => fs.rmSync(FIXTURE_TMP, { recursive: true, force: true }));

function run(args, opts = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: opts.cwd || process.cwd(),
    env: { ...process.env, ...(opts.env || {}) },
    timeout: 30_000,
  });
}

/** Write a current-format fixture source dir (with payload.kdnab + checksums). */
function writeFixtureDir(tmp, name, payload) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(FIXTURE, 'kdna.json'), path.join(dir, 'kdna.json'));
  fs.copyFileSync(path.join(FIXTURE, 'mimetype'), path.join(dir, 'mimetype'));
  fs.writeFileSync(path.join(dir, 'payload.kdnab'), cbor.encode(payload));
  if (typeof CORE.buildChecksums === 'function') {
    fs.writeFileSync(
      path.join(dir, 'checksums.json'),
      JSON.stringify(CORE.buildChecksums(dir), null, 2),
    );
  }
  return dir;
}

function writeBundleFile(tmp, components, extra = {}, filename = 'bundle.json') {
  const p = path.join(tmp, filename);
  fs.writeFileSync(
    p,
    JSON.stringify(
      {
        bundle_format: 'kdna.bundle',
        bundle_version: '0.1.0',
        name: '@test/s13-bundle',
        version: '1.0.0',
        components,
        ...extra,
      },
      null,
      2,
    ),
  );
  return p;
}

const termPayload = (term, definition) =>
  currentJudgmentPayload({
    core: {
      highest_question: 'Q?',
      axioms: [
        {
          id: `ax_scope_${Buffer.from(definition).toString('hex').slice(0, 24)}`,
          one_sentence: 'Keep the test scope explicit.',
        },
      ],
      stances: [],
      boundaries: [],
    },
    patterns: [{ type: 'term', id: `t_${term}`, term, definition }],
    scenarios: [],
    cases: [],
    reasoning: {},
    evolution: {},
  });

const axiomPayload = (id, text) =>
  currentJudgmentPayload({
    core: {
      highest_question: 'Q?',
      axioms: [{ id, one_sentence: text }],
      stances: [],
      boundaries: [],
    },
    patterns: [],
    scenarios: [],
    cases: [],
    reasoning: {},
    evolution: {},
  });

// ─── A: semver-util unit ──────────────────────────────────────────────────────

test('Story 13 semver: parseSemver accepts plain semver', () => {
  const { parseSemver } = require('../src/cmds/semver-util');
  assert.deepEqual(parseSemver('1.2.3'), { major: 1, minor: 2, patch: 3 });
  assert.deepEqual(parseSemver('v0.28.25'), { major: 0, minor: 28, patch: 25 });
  assert.deepEqual(parseSemver('0.0.0'), { major: 0, minor: 0, patch: 0 });
});

test('Story 13 semver: parseSemver strips pre-release / build', () => {
  const { parseSemver } = require('../src/cmds/semver-util');
  assert.deepEqual(parseSemver('1.2.3-alpha.1'), { major: 1, minor: 2, patch: 3 });
  assert.deepEqual(parseSemver('1.2.3+build.5'), { major: 1, minor: 2, patch: 3 });
  assert.equal(parseSemver('not-a-version'), null);
  assert.equal(parseSemver(null), null);
});

test('Story 13 semver: compareSemver orders correctly', () => {
  const { compareSemver } = require('../src/cmds/semver-util');
  assert.ok(compareSemver('0.28.25', '0.28.24') > 0);
  assert.ok(compareSemver('0.28.0', '0.28.10') < 0);
  assert.equal(compareSemver('1.0.0', '1.0.0'), 0);
  assert.ok(compareSemver('0.28.0', '0.27.99') > 0);
});

test('Story 13 semver: satisfies handles caret/tilde/comparators/ranges', () => {
  const { satisfies } = require('../src/cmds/semver-util');
  assert.equal(satisfies('0.28.25', '^0.28.0'), true, '^0.28.0 should match 0.28.25');
  assert.equal(satisfies('0.28.25', '~0.28.0'), true, '~0.28.0 should match 0.28.25');
  assert.equal(satisfies('0.28.25', '~0.27.0'), false, '~0.27.0 should NOT match 0.28.25');
  assert.equal(satisfies('0.28.25', '>=0.28.0'), true);
  assert.equal(satisfies('0.28.25', '>=0.29.0'), false);
  assert.equal(satisfies('0.28.25', '0.28.25'), true, 'exact match');
  assert.equal(satisfies('0.28.25', '0.28.0'), false, 'different version is not exact');
  assert.equal(satisfies('0.28.25', '>=0.27.0 <0.29.0'), true, 'AND of comparators');
  assert.equal(satisfies('0.28.25', '>=0.29.0 <0.30.0'), false, 'AND — out of range');
  assert.equal(satisfies('0.28.25', '*'), true, '* matches everything');
  assert.equal(satisfies('0.28.25', ''), true, 'empty matches everything');
  // kdna-core semantics: null range = "no constraint" = any version satisfies.
  // (The old standalone implementation returned false for null.)
  // Deprecation logic uses isDeprecatedAt(), which guards null separately.
  assert.equal(satisfies('0.28.25', null), true, 'null range → unconstrained → true');
  assert.equal(satisfies('0.28.25', 'garbage'), false, 'unknown range shape');
});

// ─── B: deprecation.js unit ───────────────────────────────────────────────────

test('Story 13 deprecation: evaluateDeprecation returns null for missing block', () => {
  const { evaluateDeprecation } = require('../src/cmds/deprecation');
  assert.equal(evaluateDeprecation(null, 'comp-1', 'component', '0.28.0'), null);
  assert.equal(evaluateDeprecation(undefined, 'comp-1', 'component', '0.28.0'), null);
  assert.equal(evaluateDeprecation({}, 'comp-1', 'component', '0.28.0'), null);
});

test('Story 13 deprecation: evaluateDeprecation matches `since` against version', () => {
  const { evaluateDeprecation } = require('../src/cmds/deprecation');
  const dep = { since: '>=0.28.0', reason: 'Renamed' };
  const w = evaluateDeprecation(dep, 'comp-1', 'component', '0.28.25');
  assert.ok(w, 'should produce a warning at CLI 0.28.25 when since is >=0.28.0');
  assert.equal(w.kind, 'deprecation');
  assert.equal(w.component_id, 'comp-1');
  assert.equal(w.component_label, 'component');
  assert.equal(w.since, '>=0.28.0');
  assert.equal(w.reason, 'Renamed');
  assert.match(w.message, /comp-1/);
  assert.match(w.message, /Renamed/);
});

test('Story 13 deprecation: deprecated_in is an alias for since', () => {
  const { evaluateDeprecation } = require('../src/cmds/deprecation');
  const dep = { deprecated_in: '^0.28.0' };
  const w = evaluateDeprecation(dep, 'comp-1', 'component', '0.28.25');
  assert.ok(w, 'deprecated_in should produce a warning when CLI version satisfies range');
  assert.equal(w.since, '^0.28.0');
});

test('Story 13 deprecation: deprecated_at is shorthand for `since: >=X`', () => {
  const { evaluateDeprecation } = require('../src/cmds/deprecation');
  const dep = { deprecated_at: '0.28.0' };
  assert.ok(
    evaluateDeprecation(dep, 'comp-1', 'component', '0.28.0'),
    'deprecated_at=0.28.0 should match CLI 0.28.0',
  );
  assert.ok(
    evaluateDeprecation(dep, 'comp-1', 'component', '0.29.0'),
    'deprecated_at=0.28.0 should match CLI 0.29.0 (shorthand for >=0.28.0)',
  );
  assert.equal(
    evaluateDeprecation(dep, 'comp-1', 'component', '0.27.0'),
    null,
    'deprecated_at=0.28.0 should NOT match CLI 0.27.0',
  );
});

test('Story 13 deprecation: kind escalates to "removal" past remove_in', () => {
  const { evaluateDeprecation } = require('../src/cmds/deprecation');
  const dep = { since: '0.28.0', remove_in: '0.30.0' };
  const early = evaluateDeprecation(dep, 'comp-1', 'component', '0.28.5');
  assert.equal(early.kind, 'deprecation');
  const late = evaluateDeprecation(dep, 'comp-1', 'component', '0.30.0');
  assert.equal(late.kind, 'removal');
  assert.equal(late.past_removal, true);
  assert.match(late.message, /REMOVAL/);
});

test('Story 13 deprecation: returns null when CLI version does not satisfy', () => {
  const { evaluateDeprecation } = require('../src/cmds/deprecation');
  const dep = { since: '>=0.30.0' };
  assert.equal(evaluateDeprecation(dep, 'comp-1', 'component', '0.28.25'), null);
});

test('Story 13 deprecation: scanBundleDeprecations reads top-level + per-component', () => {
  const { scanBundleDeprecations } = require('../src/cmds/deprecation');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-s13-dep-'));
  try {
    // Build a current bundle source dir.
    fs.copyFileSync(path.join(FIXTURE, 'mimetype'), path.join(tmp, 'mimetype'));
    fs.copyFileSync(path.join(FIXTURE, 'kdna.json'), path.join(tmp, 'kdna.json'));
    const m = JSON.parse(fs.readFileSync(path.join(tmp, 'kdna.json'), 'utf8'));
    m.asset_type = 'bundle';
    m.compatibility.profile = 'kdna.payload.bundle';
    m.deprecation = { since: '>=0.28.0', reason: 'bundle-wide deprecation' };
    fs.writeFileSync(path.join(tmp, 'kdna.json'), JSON.stringify(m, null, 2));
    fs.writeFileSync(
      path.join(tmp, 'payload.kdnab'),
      cbor.encode({
        profile: 'kdna.payload.bundle',
        profile_version: '0.1.0',
        components: [
          {
            id: '@old/comp-a@1.0.0',
            path: './a.kdna',
            deprecation: { since: '>=0.28.0' },
          },
          {
            id: '@fresh/comp-b@1.0.0',
            path: './b.kdna',
            // no deprecation → ignored
          },
        ],
      }),
    );
    if (typeof CORE.buildChecksums === 'function') {
      fs.writeFileSync(
        path.join(tmp, 'checksums.json'),
        JSON.stringify(CORE.buildChecksums(tmp), null, 2),
      );
    }

    const warnings = scanBundleDeprecations(tmp, '0.28.25');
    assert.equal(warnings.length, 2, 'one bundle-level + one component-level');
    const ids = warnings.map((w) => w.component_id).sort();
    assert.ok(ids.includes('@old/comp-a@1.0.0'), 'per-component deprecation should appear');
    const bundleId = m.name || m.asset_id || '(unnamed bundle)';
    assert.ok(
      ids.includes(bundleId),
      'top-level bundle deprecation should appear under the bundle name',
    );
    const labels = warnings.map((w) => w.component_label).sort();
    assert.deepEqual(labels, ['bundle', 'component']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Story 13 deprecation: scanBundleDeprecations returns [] for non-bundle', () => {
  const { scanBundleDeprecations } = require('../src/cmds/deprecation');
  // FIXTURE is a judgment source dir, not a bundle.
  const warnings = scanBundleDeprecations(FIXTURE, '0.28.25');
  assert.deepEqual(warnings, []);
});

test('Story 13 deprecation: malformed CBOR produces a stable diagnostic', () => {
  const {
    readBundleComponents,
    scanBundleDeprecations,
    formatDeprecationStderr,
  } = require('../src/cmds/deprecation');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-s13-malformed-'));
  try {
    fs.copyFileSync(path.join(FIXTURE, 'kdna.json'), path.join(tmp, 'kdna.json'));
    const manifest = JSON.parse(fs.readFileSync(path.join(tmp, 'kdna.json'), 'utf8'));
    manifest.asset_type = 'bundle';
    manifest.compatibility.profile = 'kdna.payload.bundle';
    fs.writeFileSync(path.join(tmp, 'kdna.json'), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(tmp, 'payload.kdnab'), Buffer.from([0xff, 0x00, 0xaa, 0xbb]));

    const readResult = readBundleComponents(tmp);
    assert.equal(readResult.kind, 'diagnostic');
    assert.equal(readResult.diagnostic.code, 'KDNA_PAYLOAD_CBOR_DECODE_FAILED');

    const signals = scanBundleDeprecations(tmp, '0.30.0');
    assert.equal(signals.length, 1);
    assert.equal(signals[0].kind, 'diagnostic');
    assert.equal(signals[0].severity, 'info');
    assert.equal(signals[0].code, 'KDNA_PAYLOAD_CBOR_DECODE_FAILED');
    assert.match(signals[0].message, /could not be decoded as CBOR/);
    assert.match(formatDeprecationStderr(signals), /bundle metadata diagnostics/i);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Story 13 deprecation: formatDeprecationStderr produces multi-line text', () => {
  const { evaluateDeprecation, formatDeprecationStderr } = require('../src/cmds/deprecation');
  const dep = { since: '>=0.28.0', replacement: '@new/comp@1.0.0', reason: 'moved' };
  const w = evaluateDeprecation(dep, '@old/comp@1.0.0', 'component', '0.28.25');
  const text = formatDeprecationStderr([w]);
  assert.match(text, /bundle deprecation signals/i);
  assert.match(text, /@old\/comp@1\.0\.0/);
  assert.match(text, /@new\/comp@1\.0\.0/);
  assert.equal(formatDeprecationStderr([]), '');
});

// ─── C: conflict-analysis trust_level annotation ──────────────────────────────

test('Story 13 conflict: each entry carries trust_level_a / trust_level_b', () => {
  const { analyseConflicts } = require('../src/cmds/conflict-analysis');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-s13-c-'));
  try {
    const dirA = writeFixtureDir(tmp, 'a', termPayload('clarity', 'A definition.'));
    const dirB = writeFixtureDir(tmp, 'b', termPayload('clarity', 'A different definition.'));
    const compResults = [
      { id: 'a@1.0.0', path: dirA, valid: true, trust_level: 'community' },
      { id: 'b@1.0.0', path: dirB, valid: true, trust_level: 'official' },
    ];
    const { errors } = analyseConflicts(compResults, {});
    assert.equal(errors.length, 1);
    assert.equal(errors[0].severity, 'ERROR');
    assert.equal(errors[0].trust_level_a, 'community');
    assert.equal(errors[0].trust_level_b, 'official');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Story 13 conflict: WARNING entry has community_warning=true when one side is community', () => {
  const { analyseConflicts } = require('../src/cmds/conflict-analysis');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-s13-c-'));
  try {
    const dirA = writeFixtureDir(tmp, 'a', axiomPayload('ax1', 'A sentence.'));
    const dirB = writeFixtureDir(tmp, 'b', axiomPayload('ax1', 'Different sentence, same id.'));
    const compResults = [
      { id: 'a@1.0.0', path: dirA, valid: true, trust_level: 'community' },
      { id: 'b@1.0.0', path: dirB, valid: true, trust_level: 'verified' },
    ];
    const { warnings } = analyseConflicts(compResults, {});
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].severity, 'WARNING');
    assert.equal(warnings[0].community_warning, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Story 13 conflict: WARNING entry has community_warning=false when no side is community', () => {
  const { analyseConflicts } = require('../src/cmds/conflict-analysis');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-s13-c-'));
  try {
    const dirA = writeFixtureDir(tmp, 'a', axiomPayload('ax1', 'A sentence.'));
    const dirB = writeFixtureDir(tmp, 'b', axiomPayload('ax1', 'Different sentence, same id.'));
    const compResults = [
      { id: 'a@1.0.0', path: dirA, valid: true, trust_level: 'verified' },
      { id: 'b@1.0.0', path: dirB, valid: true, trust_level: 'official' },
    ];
    const { warnings } = analyseConflicts(compResults, {});
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].community_warning, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── D: validate-bundle trust_level validation + low_trust_warnings ───────────

test('Story 13 validate --bundle: trust_level is accepted on component descriptor', () => {
  const { validateBundle } = require('../src/cmds/validate-bundle');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-s13-v-'));
  try {
    // Two components with distinct axiom ids → no conflict → no WARNING
    const dirA = writeFixtureDir(tmp, 'a', axiomPayload('ax_a', 'A sentence.'));
    const dirB = writeFixtureDir(tmp, 'b', axiomPayload('ax_b', 'B sentence.'));
    const bundlePath = writeBundleFile(tmp, [
      { id: '@test/a@1.0.0', path: dirA, priority: 1, trust_level: 'community' },
      { id: '@test/b@1.0.0', path: dirB, priority: 2, trust_level: 'official' },
    ]);
    const r = validateBundle(bundlePath);
    assert.equal(r.bundle_valid, true);
    const a = r.components.find((c) => c.id === '@test/a@1.0.0');
    const b = r.components.find((c) => c.id === '@test/b@1.0.0');
    assert.equal(a.trust_level, 'community');
    assert.equal(b.trust_level, 'official');
    assert.equal(r.low_trust_warnings.count, 0, 'no warnings = empty low_trust_warnings');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Story 13 validate --bundle: invalid trust_level value is an ERROR', () => {
  const { validateBundle } = require('../src/cmds/validate-bundle');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-s13-v-'));
  try {
    const bundlePath = writeBundleFile(tmp, [
      { id: '@test/bad@1.0.0', path: FIXTURE, trust_level: 'random' },
    ]);
    const r = validateBundle(bundlePath);
    assert.equal(r.bundle_valid, false);
    const trustErr = r.errors.find((e) => e.field === 'trust_level');
    assert.ok(trustErr, 'invalid trust_level should produce a trust_level field error');
    assert.match(trustErr.note, /random/);
    assert.match(trustErr.note, /community, verified, official/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Story 13 validate --bundle: low_trust_warnings surfaces WARNING with community', () => {
  const { validateBundle } = require('../src/cmds/validate-bundle');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-s13-v-'));
  try {
    // Two fixtures with same axiom id, different one_sentence → WARNING
    const dirA = writeFixtureDir(tmp, 'a', axiomPayload('ax1', 'Community axiom.'));
    const dirB = writeFixtureDir(tmp, 'b', axiomPayload('ax1', 'Official axiom, different.'));
    const bundlePath = writeBundleFile(tmp, [
      { id: '@community/a@1.0.0', path: dirA, priority: 1, trust_level: 'community' },
      { id: '@official/b@1.0.0', path: dirB, priority: 2, trust_level: 'official' },
    ]);
    const r = validateBundle(bundlePath);
    // Bundle is still valid (WARNING, not ERROR)
    assert.equal(r.bundle_valid, true);
    // The WARNING is in `warnings`
    assert.ok(r.warnings.length >= 1, 'should have at least one WARNING');
    // low_trust_warnings surfaces it
    assert.equal(r.low_trust_warnings.count, 1);
    assert.equal(r.low_trust_warnings.conflicts[0].community_warning, true);
    assert.ok(r.low_trust_warnings.affected_components.includes('@community/a@1.0.0'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Story 13 validate --bundle: ERROR-level conflict is NOT in low_trust_warnings (errors are errors)', () => {
  const { validateBundle } = require('../src/cmds/validate-bundle');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-s13-v-'));
  try {
    // Two components with conflicting term definitions → ERROR
    const dirA = writeFixtureDir(tmp, 'a', termPayload('clarity', 'Community definition.'));
    const dirB = writeFixtureDir(tmp, 'b', termPayload('clarity', 'Official definition.'));
    const bundlePath = writeBundleFile(tmp, [
      { id: '@community/a@1.0.0', path: dirA, priority: 1, trust_level: 'community' },
      { id: '@official/b@1.0.0', path: dirB, priority: 2, trust_level: 'official' },
    ]);
    const r = validateBundle(bundlePath);
    assert.equal(r.bundle_valid, false);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].severity, 'ERROR');
    // low_trust_warnings only filters WARNINGs, not ERRORs
    assert.equal(r.low_trust_warnings.count, 0);
    // But the ERROR entry should still carry trust_level annotation
    assert.equal(r.errors[0].trust_level_a, 'community');
    assert.equal(r.errors[0].trust_level_b, 'official');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Story 13 validate --bundle: deprecation_warnings is empty when nothing matches', () => {
  const { validateBundle } = require('../src/cmds/validate-bundle');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-s13-v-'));
  try {
    const bundlePath = writeBundleFile(tmp, [{ id: '@test/a@1.0.0', path: FIXTURE, priority: 1 }]);
    const r = validateBundle(bundlePath, { currentVersion: '0.28.25' });
    assert.ok(r.deprecation_warnings);
    assert.equal(r.deprecation_warnings.count, 0);
    assert.equal(r.deprecation_warnings.current_cli_version, '0.28.25');
    assert.equal(r.deprecation_warnings.stderr_text, '');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Story 13 validate --bundle: deprecation.since matches → deprecation_warnings populated', () => {
  const { validateBundle } = require('../src/cmds/validate-bundle');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-s13-v-'));
  try {
    const bundlePath = writeBundleFile(
      tmp,
      [{ id: '@test/old@1.0.0', path: FIXTURE, priority: 1, deprecation: { since: '>=0.28.0' } }],
      { deprecation: { since: '>=0.28.0', reason: 'bundle-wide' } },
    );
    const r = validateBundle(bundlePath, { currentVersion: '0.28.25' });
    assert.equal(r.deprecation_warnings.count, 2, 'one bundle-level + one component-level');
    assert.ok(r.deprecation_warnings.stderr_text.length > 0);
    assert.match(r.deprecation_warnings.stderr_text, /bundle deprecation signals/i);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── E: CLI load + plan-load print deprecation to stderr ──────────────────────

test('Story 13 CLI plan-load: deprecated bundle prints Notice to stderr', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-s13-cli-'));
  try {
    // Build a current bundle source dir.
    fs.copyFileSync(path.join(FIXTURE, 'mimetype'), path.join(tmp, 'mimetype'));
    fs.copyFileSync(path.join(FIXTURE, 'kdna.json'), path.join(tmp, 'kdna.json'));
    const m = JSON.parse(fs.readFileSync(path.join(tmp, 'kdna.json'), 'utf8'));
    m.asset_type = 'bundle';
    m.compatibility.profile = 'kdna.payload.bundle';
    fs.writeFileSync(path.join(tmp, 'kdna.json'), JSON.stringify(m, null, 2));
    fs.writeFileSync(
      path.join(tmp, 'payload.kdnab'),
      cbor.encode({
        profile: 'kdna.payload.bundle',
        profile_version: '0.1.0',
        components: [
          {
            id: '@old/comp@1.0.0',
            path: './x.kdna',
            deprecation: { since: '>=0.28.0', reason: 'moved' },
          },
        ],
      }),
    );
    if (typeof CORE.buildChecksums === 'function') {
      fs.writeFileSync(
        path.join(tmp, 'checksums.json'),
        JSON.stringify(CORE.buildChecksums(tmp), null, 2),
      );
    }

    const packed = `${tmp}.kdna`;
    CORE.pack(tmp, packed);
    const r = run(['plan-load', packed, '--json']);
    // The plan-load exit code may be 0 or non-zero depending on whether
    // it's a valid bundle + the resolved_dependencies is empty (no
    // resolveAsset callback). The important thing is the stderr.
    assert.match(r.stderr, /bundle deprecation signals/i);
    assert.match(r.stderr, /@old\/comp@1\.0\.0/);
    assert.match(r.stderr, /moved/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(`${tmp}.kdna`, { force: true });
  }
});

test('Story 13 CLI plan-load: non-deprecated bundle does NOT print deprecation', () => {
  // FIXTURE is a judgment dir (not a bundle) — scanBundleDeprecations
  // returns [], so no stderr notice.
  const r = run(['plan-load', RUNTIME_FIXTURE, '--json']);
  assert.doesNotMatch(r.stderr, /bundle deprecation signals/i);
});

test('Story 13 CLI load: deprecated bundle prints Notice to stderr', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-s13-cli-'));
  try {
    fs.copyFileSync(path.join(FIXTURE, 'mimetype'), path.join(tmp, 'mimetype'));
    fs.copyFileSync(path.join(FIXTURE, 'kdna.json'), path.join(tmp, 'kdna.json'));
    const m = JSON.parse(fs.readFileSync(path.join(tmp, 'kdna.json'), 'utf8'));
    m.asset_type = 'bundle';
    m.compatibility.profile = 'kdna.payload.bundle';
    fs.writeFileSync(path.join(tmp, 'kdna.json'), JSON.stringify(m, null, 2));
    fs.writeFileSync(
      path.join(tmp, 'payload.kdnab'),
      cbor.encode({
        profile: 'kdna.payload.bundle',
        profile_version: '0.1.0',
        components: [
          { id: '@old/comp@1.0.0', path: './x.kdna', deprecation: { since: '>=0.28.0' } },
        ],
      }),
    );
    if (typeof CORE.buildChecksums === 'function') {
      fs.writeFileSync(
        path.join(tmp, 'checksums.json'),
        JSON.stringify(CORE.buildChecksums(tmp), null, 2),
      );
    }

    const packed = `${tmp}.kdna`;
    CORE.pack(tmp, packed);
    const r = run(['load', packed, '--as=json']);
    // load may fail because the bundle has no resolveAsset callback for
    // '@old/comp@1.0.0', but the stderr notice should still appear.
    assert.match(r.stderr, /bundle deprecation signals/i);
    assert.match(r.stderr, /@old\/comp@1\.0\.0/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(`${tmp}.kdna`, { force: true });
  }
});

test('Story 13 CLI load: fresh bundle has no stderr deprecation', () => {
  const r = run(['load', RUNTIME_FIXTURE, '--as=json']);
  assert.equal(r.status, 0, `expected exit 0:\n${r.stderr}`);
  assert.doesNotMatch(r.stderr, /bundle deprecation signals/i);
});

// ─── F: validate --bundle stderr text ─────────────────────────────────────────

test('Story 13 CLI validate --bundle: deprecation matches → stderr text', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-s13-cli-'));
  try {
    const bundlePath = writeBundleFile(
      tmp,
      [{ id: '@old/comp@1.0.0', path: FIXTURE, priority: 1, deprecation: { since: '>=0.28.0' } }],
      { name: '@test/deprecated-bundle' },
    );
    const r = run(['validate', bundlePath, '--bundle']);
    assert.equal(r.status, 0, `expected exit 0:\n${r.stderr}`);
    assert.match(r.stderr, /bundle deprecation signals/i);
    // JSON should also carry the deprecation_warnings block.
    // The CLI version is whatever's in package.json; we just check
    // that the field is populated and that count is 1.
    const out = JSON.parse(r.stdout);
    assert.equal(out.deprecation_warnings.count, 1);
    assert.ok(out.deprecation_warnings.current_cli_version, 'should report CLI version');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Story 13 CLI validate --bundle: deprecation does NOT match → no stderr', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-s13-cli-'));
  try {
    const bundlePath = writeBundleFile(tmp, [
      { id: '@old/comp@1.0.0', path: FIXTURE, priority: 1, deprecation: { since: '>=99.0.0' } },
    ]);
    const r = run(['validate', bundlePath, '--bundle']);
    assert.equal(r.status, 0, `expected exit 0:\n${r.stderr}`);
    assert.doesNotMatch(r.stderr, /bundle deprecation signals/i);
    const out = JSON.parse(r.stdout);
    assert.equal(out.deprecation_warnings.count, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
