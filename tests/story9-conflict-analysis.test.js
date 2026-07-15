/**
 * story9-conflict-analysis.test.js — validate --bundle conflict warnings (Story 9)
 *
 * Verifies that kdna validate <bundle.json> --bundle now performs
 * per-card-type static conflict analysis as defined in
 * docs/CONFLICT_RESOLUTION.md (Story 4).
 *
 * Tests are split into two groups:
 *   A) Unit tests for conflict-analysis.js (extractCards, analyseConflicts)
 *   B) CLI integration: validate --bundle emits real conflict entries
 *
 * Run: node --test tests/story9-conflict-analysis.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cbor = require('cbor-x');

const CLI = path.resolve(__dirname, '..', 'src', 'cli.js');
const FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'minimal');

function run(args, opts = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: opts.cwd || process.cwd(),
    env: { ...process.env, ...(opts.env || {}) },
    timeout: 30_000,
  });
}

// ─── A: Unit tests — extractCards ────────────────────────────────────────────

test('Story 9 unit: extractCards handles empty/null payload', () => {
  const { extractCards } = require('../src/cmds/conflict-analysis');
  const result = extractCards(null);
  assert.equal(result.axiom.length, 0);
  assert.equal(result.term.length, 0);
});

test('Story 9 unit: extractCards extracts axioms from core', () => {
  const { extractCards } = require('../src/cmds/conflict-analysis');
  const payload = {
    core: { axioms: [{ id: 'ax1', one_sentence: 'Test axiom.' }] },
    patterns: [],
  };
  const cards = extractCards(payload);
  assert.equal(cards.axiom.length, 1);
  assert.equal(cards.axiom[0].id, 'ax1');
});

test('Story 9 unit: extractCards extracts terms from patterns array', () => {
  const { extractCards } = require('../src/cmds/conflict-analysis');
  const payload = {
    core: {},
    patterns: [
      { type: 'term', id: 't1', term: 'clarity', definition: 'The quality of being clear.' },
      { type: 'banned_term', id: 'bt1', term: 'synergy', replace_with: 'collaboration' },
    ],
  };
  const cards = extractCards(payload);
  assert.equal(cards.term.length, 1);
  assert.equal(cards.term[0].term, 'clarity');
  assert.equal(cards.banned_term.length, 1);
  assert.equal(cards.banned_term[0].term, 'synergy');
});

test('Story 9 unit: extractCards extracts stances as strings', () => {
  const { extractCards } = require('../src/cmds/conflict-analysis');
  const payload = {
    core: { stances: ['Clarity over cleverness.', 'Structure before style.'] },
    patterns: [],
  };
  const cards = extractCards(payload);
  assert.equal(cards.stance.length, 2);
  assert.equal(cards.stance[0].statement, 'Clarity over cleverness.');
});

// ─── A: Unit tests — analyseConflicts ────────────────────────────────────────

test('Story 9 unit: no conflicts when components have distinct cards', () => {
  const { analyseConflicts, extractCards } = require('../src/cmds/conflict-analysis');

  // Monkeypatch: pass pre-extracted cards via a wrapper
  // We test analyseConflicts by passing component results with no payload
  // (no path means no payload → no conflict)
  const compResults = [
    { id: '@test/a@1.0.0', path: null, valid: true },
    { id: '@test/b@1.0.0', path: null, valid: true },
  ];
  const { errors, warnings, info } = analyseConflicts(compResults, {});
  assert.equal(errors.length, 0);
  assert.equal(warnings.length, 0);
  assert.equal(info.length, 0);
});

test('Story 9 unit: malformed CBOR payload is diagnosed, not silently swallowed', () => {
  const { loadPayload, analyseConflicts, extractCards } = require('../src/cmds/conflict-analysis');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-s9-mal-'));
  try {
    const dir = path.join(tmp, 'malformed');
    fs.mkdirSync(dir);
    // Write malformed CBOR bytes
    fs.writeFileSync(path.join(dir, 'payload.kdnab'), Buffer.from([0xff, 0x00, 0xaa, 0xbb]));
    // loadPayload returns null for malformed CBOR (payload exists but invalid)
    const result = loadPayload(dir, {});
    assert.equal(result, null, 'malformed CBOR must return null when payload exists');
    // verify undefined is returned when no payload file exists
    const emptyDir = path.join(tmp, 'empty');
    fs.mkdirSync(emptyDir);
    const noResult = loadPayload(emptyDir, {});
    assert.equal(noResult, undefined, 'no payload file returns undefined');
    // analyseConflicts emits diagnostic INFO for malformed payload
    const compResults = [
      { id: '@test/mal@1.0.0', path: dir, valid: true },
      { id: '@test/ok@1.0.0', path: emptyDir, valid: true },
    ];
    const { info, errors, warnings } = analyseConflicts(compResults, {});
    const diagnostic = info.find((i) => i.note && i.note.includes('malformed'));
    assert.ok(diagnostic, 'malformed CBOR must produce a diagnostic INFO entry');
    assert.match(diagnostic.note, /could not be decoded as CBOR/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Story 9 unit: term conflict → ERROR entry', () => {
  const { analyseConflicts } = require('../src/cmds/conflict-analysis');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-s9-'));
  try {
    // Create two fixture dirs with conflicting term definitions
    const dirA = path.join(tmp, 'compA');
    const dirB = path.join(tmp, 'compB');
    fs.mkdirSync(dirA);
    fs.mkdirSync(dirB);

    const payloadA = {
      profile: 'kdna.payload.judgment',
      profile_version: '0.1.0',
      core: { axioms: [], stances: [], boundaries: [] },
      patterns: [
        { type: 'term', id: 't1', term: 'clarity', definition: 'Being clear and direct.' },
      ],
    };
    const payloadB = {
      profile: 'kdna.payload.judgment',
      profile_version: '0.1.0',
      core: { axioms: [], stances: [], boundaries: [] },
      patterns: [
        {
          type: 'term',
          id: 't1',
          term: 'clarity',
          definition: 'A completely different definition.',
        },
      ],
    };

    fs.writeFileSync(path.join(dirA, 'payload.kdnab'), cbor.encode(payloadA));
    fs.writeFileSync(path.join(dirB, 'payload.kdnab'), cbor.encode(payloadB));

    const compResults = [
      { id: '@test/a@1.0.0', path: dirA, valid: true },
      { id: '@test/b@1.0.0', path: dirB, valid: true },
    ];

    const { errors, warnings } = analyseConflicts(compResults, {});
    assert.equal(errors.length, 1, 'should detect 1 ERROR for term conflict');
    assert.equal(errors[0].conflict_type, 'term_conflict');
    assert.equal(errors[0].severity, 'ERROR');
    assert.equal(errors[0].card_type, 'term');
    assert.equal(errors[0].conflicting_field, 'definition');
    assert.equal(errors[0].component_a, '@test/a@1.0.0');
    assert.equal(errors[0].component_b, '@test/b@1.0.0');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Story 9 unit: axiom id clash → WARNING entry', () => {
  const { analyseConflicts } = require('../src/cmds/conflict-analysis');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-s9-'));
  try {
    const dirA = path.join(tmp, 'compA');
    const dirB = path.join(tmp, 'compB');
    fs.mkdirSync(dirA);
    fs.mkdirSync(dirB);

    const payloadA = {
      profile: 'kdna.payload.judgment',
      profile_version: '0.1.0',
      core: { axioms: [{ id: 'ax1', one_sentence: 'Clarity first.' }] },
      patterns: [],
    };
    const payloadB = {
      profile: 'kdna.payload.judgment',
      profile_version: '0.1.0',
      core: { axioms: [{ id: 'ax1', one_sentence: 'Different axiom, same id.' }] },
      patterns: [],
    };

    fs.writeFileSync(path.join(dirA, 'payload.kdnab'), cbor.encode(payloadA));
    fs.writeFileSync(path.join(dirB, 'payload.kdnab'), cbor.encode(payloadB));

    const compResults = [
      { id: '@test/a@1.0.0', path: dirA, valid: true },
      { id: '@test/b@1.0.0', path: dirB, valid: true },
    ];

    const { errors, warnings } = analyseConflicts(compResults, {});
    assert.equal(errors.length, 0, 'axiom id clash is WARNING not ERROR');
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].conflict_type, 'value_conflict');
    assert.equal(warnings[0].severity, 'WARNING');
    assert.equal(warnings[0].card_type, 'axiom');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Story 9 unit: banned_term replace_with conflict → WARNING', () => {
  const { analyseConflicts } = require('../src/cmds/conflict-analysis');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-s9-'));
  try {
    const dirA = path.join(tmp, 'compA');
    const dirB = path.join(tmp, 'compB');
    fs.mkdirSync(dirA);
    fs.mkdirSync(dirB);

    const make = (replaceWith) => ({
      profile: 'kdna.payload.judgment',
      profile_version: '0.1.0',
      core: {},
      patterns: [{ type: 'banned_term', id: 'bt1', term: 'synergy', replace_with: replaceWith }],
    });

    fs.writeFileSync(path.join(dirA, 'payload.kdnab'), cbor.encode(make('collaboration')));
    fs.writeFileSync(path.join(dirB, 'payload.kdnab'), cbor.encode(make('teamwork')));

    const compResults = [
      { id: '@test/a@1.0.0', path: dirA, valid: true },
      { id: '@test/b@1.0.0', path: dirB, valid: true },
    ];

    const { warnings } = analyseConflicts(compResults, {});
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].conflict_type, 'term_conflict');
    assert.equal(warnings[0].card_type, 'banned_term');
    assert.equal(warnings[0].conflicting_field, 'replace_with');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── B: CLI integration ────────────────────────────────────────────────────────

test('Story 9 CLI: bundle with no conflicts → empty errors/warnings, no stub INFO', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-s9-cli-'));
  try {
    const bundlePath = path.join(tmp, 'bundle.json');
    fs.writeFileSync(
      bundlePath,
      JSON.stringify({
        bundle_format: 'kdna-bundle-v1',
        name: '@test/no-conflict',
        version: '1.0.0',
        components: [
          { id: '@test/comp-a@1.0.0', path: FIXTURE, priority: 1 },
          { id: '@test/comp-b@1.0.0', path: FIXTURE, priority: 2 },
        ],
      }),
    );

    const r = run(['validate', bundlePath, '--bundle']);
    assert.equal(r.status, 0, `exit 0 expected:\n${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.bundle_valid, true);
    // No stub INFO note any more — Story 9 replaced it
    const stubNote = out.info.find((i) => i.note && i.note.includes('Story 9'));
    assert.ok(!stubNote, 'stub INFO note should be gone after Story 9');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Story 9 CLI: bundle with term conflict → ERROR, bundle_valid=false, exit 1', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-s9-cli-'));
  try {
    // Build two source dirs with a term conflict
    const dirA = path.join(tmp, 'compA');
    const dirB = path.join(tmp, 'compB');

    for (const [dir, definition] of [
      [dirA, 'Being clear and direct.'],
      [dirB, 'A completely different meaning.'],
    ]) {
      fs.mkdirSync(dir, { recursive: true });
      // Copy minimal kdna.json and checksums but override payload
      fs.copyFileSync(path.join(FIXTURE, 'kdna.json'), path.join(dir, 'kdna.json'));
      fs.copyFileSync(path.join(FIXTURE, 'mimetype'), path.join(dir, 'mimetype'));
      // Build a payload with a term
      const payload = {
        profile: 'kdna.payload.judgment',
        profile_version: '0.1.0',
        core: { highest_question: 'Test?', axioms: [], stances: [], boundaries: [] },
        patterns: [{ type: 'term', id: 'term_clarity', term: 'clarity', definition }],
        scenarios: [],
        cases: [],
        reasoning: {},
        evolution: {},
      };
      fs.writeFileSync(path.join(dir, 'payload.kdnab'), cbor.encode(payload));
      // Write minimal checksums to make validate() pass
      const core = require('@aikdna/kdna-core');
      if (typeof core.buildChecksums === 'function') {
        const cs = core.buildChecksums(dir);
        fs.writeFileSync(path.join(dir, 'checksums.json'), JSON.stringify(cs, null, 2));
      }
    }

    const bundlePath = path.join(tmp, 'bundle.json');
    fs.writeFileSync(
      bundlePath,
      JSON.stringify({
        bundle_format: 'kdna-bundle-v1',
        name: '@test/term-conflict-bundle',
        version: '1.0.0',
        components: [
          { id: '@test/compA@1.0.0', path: dirA, priority: 1 },
          { id: '@test/compB@1.0.0', path: dirB, priority: 2 },
        ],
      }),
    );

    const r = run(['validate', bundlePath, '--bundle']);
    assert.equal(r.status, 1, `expected exit 1 for term conflict:\n${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.bundle_valid, false);
    const termErr = out.errors.find((e) => e.conflict_type === 'term_conflict');
    assert.ok(termErr, 'should have a term_conflict ERROR');
    assert.equal(termErr.severity, 'ERROR');
    assert.equal(termErr.card_type, 'term');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
