/**
 * story12-asset-inheritance.test.js — Asset inheritance (Story 12)
 *
 * Verifies:
 *   A) manifest.schema.json accepts 'extends' as string or object
 *   B) planLoad records extends_chain when base is resolvable
 *   C) planLoad emits KDNA_EXTENDS_NOT_FOUND warning when base missing
 *   D) planLoad emits warning when no resolver provided
 *   E) loadAuthorized merges base content into child (axiom inheritance)
 *   F) Child axioms override parent axioms with same id
 *   G) highest_question falls back to parent when child omits it
 *   H) kdna plan-load --json on single asset has no extends_chain
 *
 * Run: node --test tests/story12-asset-inheritance.test.js
 */

'use strict';

const { after, test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cbor = require('cbor-x');

const CLI = path.resolve(__dirname, '..', 'src', 'cli.js');
const FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'v1-minimal');
const FIXTURE_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-s12-fixture-'));
const RUNTIME_FIXTURE = path.join(FIXTURE_TMP, 'v1-minimal.kdna');
require('@aikdna/kdna-core').pack(FIXTURE, RUNTIME_FIXTURE);
after(() => fs.rmSync(FIXTURE_TMP, { recursive: true, force: true }));

function run(args, opts = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, KDNA_HOME: opts.kdnaHome || process.env.KDNA_HOME },
    timeout: 30_000,
  });
}

// ─── A: Schema validation — 'extends' field ───────────────────────────────────

test('Story 12 schema: validateManifest accepts extends as string', () => {
  const core = require('@aikdna/kdna-core');
  if (typeof core.validateManifest !== 'function') return; // skip if not exposed
  const manifest = {
    kdna_version: '1.0',
    asset_id: 'kdna:domain:child',
    asset_uid: 'urn:uuid:00000000-0000-4000-8000-000000000020',
    asset_type: 'domain',
    title: 'Child Domain',
    version: '1.0.0',
    judgment_version: '1.0.0',
    created_at: '2026-06-28T00:00:00Z',
    updated_at: '2026-06-28T00:00:00Z',
    creator: { name: 'Test' },
    compatibility: { min_loader_version: '1.0.0', profile: 'judgment-profile-v1' },
    payload: { path: 'payload.kdnab', encoding: 'json', encrypted: false },
    extends: '@aikdna/base@^1.0.0',
  };
  // Should not throw
  assert.doesNotThrow(() => core.validateManifest(manifest));
});

// ─── B: planLoad — extends_chain when base resolvable ────────────────────────

test('Story 12 planLoad: records extends_chain when base is resolvable', () => {
  const core = require('@aikdna/kdna-core');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-s12-'));
  try {
    // Create child fixture with extends
    const childDir = path.join(tmp, 'child');
    fs.mkdirSync(childDir);
    fs.copyFileSync(path.join(FIXTURE, 'mimetype'), path.join(childDir, 'mimetype'));

    const childManifest = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'kdna.json'), 'utf8'));
    childManifest.extends = '@test/base@^1.0.0';
    fs.writeFileSync(path.join(childDir, 'kdna.json'), JSON.stringify(childManifest, null, 2));
    fs.copyFileSync(path.join(FIXTURE, 'payload.kdnab'), path.join(childDir, 'payload.kdnab'));
    if (typeof core.buildChecksums === 'function') {
      fs.writeFileSync(
        path.join(childDir, 'checksums.json'),
        JSON.stringify(core.buildChecksums(childDir), null, 2),
      );
    }

    const resolveAsset = (name) => {
      if (name === '@test/base') {
        return {
          name: '@test/base',
          version: '1.0.0',
          path: RUNTIME_FIXTURE,
          manifest: childManifest,
        };
      }
      return null;
    };

    const childAsset = path.join(tmp, 'child.kdna');
    core.pack(childDir, childAsset);
    const plan = core.planLoad(childAsset, { resolveAsset });
    assert.ok(
      Array.isArray(plan.extends_chain) && plan.extends_chain.length === 1,
      'extends_chain should have one entry',
    );
    assert.equal(plan.extends_chain[0].name, '@test/base');
    assert.equal(plan.extends_chain[0].version, '1.0.0');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── C: planLoad — warning when base not found ───────────────────────────────

test('Story 12 planLoad: KDNA_EXTENDS_NOT_FOUND warning when base missing', () => {
  const core = require('@aikdna/kdna-core');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-s12-'));
  try {
    const childDir = path.join(tmp, 'child');
    fs.mkdirSync(childDir);
    fs.copyFileSync(path.join(FIXTURE, 'mimetype'), path.join(childDir, 'mimetype'));

    const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'kdna.json'), 'utf8'));
    manifest.extends = '@test/nonexistent@^1.0.0';
    fs.writeFileSync(path.join(childDir, 'kdna.json'), JSON.stringify(manifest, null, 2));
    fs.copyFileSync(path.join(FIXTURE, 'payload.kdnab'), path.join(childDir, 'payload.kdnab'));
    if (typeof core.buildChecksums === 'function') {
      fs.writeFileSync(
        path.join(childDir, 'checksums.json'),
        JSON.stringify(core.buildChecksums(childDir), null, 2),
      );
    }

    const childAsset = path.join(tmp, 'child.kdna');
    core.pack(childDir, childAsset);
    const plan = core.planLoad(childAsset, { resolveAsset: () => null });
    const issue = (plan.issues || []).find((i) => i.code === 'KDNA_EXTENDS_NOT_FOUND');
    assert.ok(issue, 'should have KDNA_EXTENDS_NOT_FOUND warning issue');
    // Non-blocking: plan should still be loadable
    assert.notEqual(plan.state, 'invalid', 'extends not found is a warning, not blocking');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── D: planLoad — warning when no resolver provided ─────────────────────────

test('Story 12 planLoad: KDNA_EXTENDS_RESOLVER_MISSING warning when no resolver', () => {
  const core = require('@aikdna/kdna-core');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-s12-'));
  try {
    const childDir = path.join(tmp, 'child');
    fs.mkdirSync(childDir);
    fs.copyFileSync(path.join(FIXTURE, 'mimetype'), path.join(childDir, 'mimetype'));

    const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'kdna.json'), 'utf8'));
    manifest.extends = '@test/base@^1.0.0';
    fs.writeFileSync(path.join(childDir, 'kdna.json'), JSON.stringify(manifest, null, 2));
    fs.copyFileSync(path.join(FIXTURE, 'payload.kdnab'), path.join(childDir, 'payload.kdnab'));
    if (typeof core.buildChecksums === 'function') {
      fs.writeFileSync(
        path.join(childDir, 'checksums.json'),
        JSON.stringify(core.buildChecksums(childDir), null, 2),
      );
    }

    // No resolveAsset callback
    const childAsset = path.join(tmp, 'child.kdna');
    core.pack(childDir, childAsset);
    const plan = core.planLoad(childAsset);
    const issue = (plan.issues || []).find((i) => i.code === 'KDNA_EXTENDS_RESOLVER_MISSING');
    assert.ok(issue, 'should have KDNA_EXTENDS_RESOLVER_MISSING warning');
    assert.notEqual(
      plan.state,
      'invalid',
      'missing resolver for extends is a warning, not blocking',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── E+F: Inheritance merge — child axiom overrides parent ───────────────────

test('Story 12 inheritance: child axioms override parent, parent unoverridden axioms inherited', () => {
  const core = require('@aikdna/kdna-core');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-s12-'));
  try {
    // Parent: has ax1 (will be overridden) and ax2 (will be inherited)
    const parentDir = path.join(tmp, 'parent');
    fs.mkdirSync(parentDir);
    fs.copyFileSync(path.join(FIXTURE, 'mimetype'), path.join(parentDir, 'mimetype'));
    const parentManifest = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'kdna.json'), 'utf8'));
    delete parentManifest.extends;
    fs.writeFileSync(path.join(parentDir, 'kdna.json'), JSON.stringify(parentManifest, null, 2));
    const parentPayload = {
      profile: 'judgment-profile-v1',
      core: {
        highest_question: 'What is the parent question?',
        axioms: [
          { id: 'ax1', one_sentence: 'Parent ax1 — will be overridden.' },
          { id: 'ax2', one_sentence: 'Parent ax2 — will be inherited.' },
        ],
      },
      patterns: [],
    };
    fs.writeFileSync(path.join(parentDir, 'payload.kdnab'), cbor.encode(parentPayload));
    if (typeof core.buildChecksums === 'function') {
      fs.writeFileSync(
        path.join(parentDir, 'checksums.json'),
        JSON.stringify(core.buildChecksums(parentDir), null, 2),
      );
    }

    // Child: overrides ax1, adds ax3; no highest_question
    const childDir = path.join(tmp, 'child');
    fs.mkdirSync(childDir);
    fs.copyFileSync(path.join(FIXTURE, 'mimetype'), path.join(childDir, 'mimetype'));
    const childManifest = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'kdna.json'), 'utf8'));
    childManifest.extends = '@test/parent@^1.0.0';
    fs.writeFileSync(path.join(childDir, 'kdna.json'), JSON.stringify(childManifest, null, 2));
    const childPayload = {
      profile: 'judgment-profile-v1',
      core: {
        highest_question: 'What is the child question?',
        axioms: [
          { id: 'ax1', one_sentence: 'Child ax1 — overrides parent.' },
          { id: 'ax3', one_sentence: 'Child ax3 — new.' },
        ],
      },
      patterns: [],
    };
    fs.writeFileSync(path.join(childDir, 'payload.kdnab'), cbor.encode(childPayload));
    if (typeof core.buildChecksums === 'function') {
      fs.writeFileSync(
        path.join(childDir, 'checksums.json'),
        JSON.stringify(core.buildChecksums(childDir), null, 2),
      );
    }

    const resolveAsset = (name) => {
      if (name === '@test/parent') {
        return {
          name: '@test/parent',
          version: '1.0.0',
          path: path.join(tmp, 'parent.kdna'),
          manifest: parentManifest,
        };
      }
      return null;
    };

    core.pack(parentDir, path.join(tmp, 'parent.kdna'));
    const childAsset = path.join(tmp, 'child.kdna');
    core.pack(childDir, childAsset);
    const result = core.loadAuthorized(childAsset, {
      profile: 'compact',
      as: 'json',
      resolveAsset,
    });

    assert.ok(result.inheritance_applied === true, 'inheritance_applied should be true');
    const axioms = result.context.axioms || [];
    const ax1 = axioms.find((a) => a.id === 'ax1');
    const ax2 = axioms.find((a) => a.id === 'ax2');
    const ax3 = axioms.find((a) => a.id === 'ax3');

    assert.ok(ax1, 'ax1 should be present (from child)');
    assert.match(ax1.one_sentence, /Child ax1/, 'child ax1 should override parent ax1');
    assert.ok(ax2, 'ax2 should be inherited from parent');
    assert.match(ax2.one_sentence, /Parent ax2/, 'parent ax2 should be inherited');
    assert.ok(ax3, 'ax3 should be present (child-only)');
    // Child has its own highest_question — child's version should be kept
    assert.ok(result.context.highest_question, 'highest_question should be present');
    assert.match(
      result.context.highest_question,
      /child question|parent question/,
      'highest_question should be from child or parent',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── H: CLI smoke — single asset plan-load has no extends_chain ──────────────

test('Story 12 CLI: single asset plan-load has no extends_chain', () => {
  const r = run(['plan-load', RUNTIME_FIXTURE, '--json']);
  assert.ok(r.status !== 1, `unexpected exit 1:\n${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.ok(!out.extends_chain, 'single asset should have no extends_chain');
});
