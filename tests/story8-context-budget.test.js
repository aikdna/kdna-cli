/**
 * story8-context-budget.test.js — Context budget reporting (Story 8)
 *
 * Verifies that kdna plan-load <bundle> attaches a context_budget_report
 * when the Bundle manifest declares context_budget.max_tokens.
 *
 * Four cases:
 *   1. No context_budget declared → no report in output (backward compat)
 *   2. Budget declared, components fit → over_budget=false, budget_action='none'
 *   3. Budget declared, components exceed, strategy='warn' → over_budget=true,
 *      budget_action='warn_only', exit 0
 *   4. Budget declared, components exceed, strategy='error' → over_budget=true,
 *      budget_action='block_load', exit 1 (plan state=invalid)
 *
 * Run: node --test tests/story8-context-budget.test.js
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

function run(args, opts = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: opts.cwd || process.cwd(),
    env: { ...process.env, ...(opts.env || {}) },
    timeout: 30_000,
  });
}

/**
 * Build a minimal bundle source dir with a kdna.json that includes
 * optional context_budget and resolved_dependencies via a mock resolver.
 *
 * Because plan-load needs resolved_dependencies to trigger budget reporting,
 * we build a bundle manifest that declares dependencies in its kdna.json and
 * relies on the CLI's resolveAsset callback (from two-tier store) for
 * resolution.  Since we don't have real installed packages in the test
 * environment, we test the computeContextBudget function directly via the
 * unit path, and test the CLI integration with a fixture that has no
 * dependencies (checking that context_budget_report is absent when no
 * resolved_dependencies exist), and with the unit module directly.
 */
function writeBundleFixture(dir, opts = {}) {
  const sourceDir = path.join(dir, 'source');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'mimetype'), 'application/vnd.kdna.asset');

  const manifest = {
    format_version: '0.1.0',
    asset_id: 'kdna:bundle:ctx-budget-test',
    asset_uid: 'urn:uuid:00000000-0000-4000-8000-000000000099',
    asset_type: 'bundle',
    title: 'Context Budget Test Bundle',
    version: '1.0.0',
    judgment_version: '1.0.0',
    created_at: '2026-06-28T00:00:00Z',
    updated_at: '2026-06-28T00:00:00Z',
    creator: { name: 'Test' },
    compatibility: {
      min_loader_version: '0.20.0',
      profile: 'kdna.payload.bundle',
      profile_version: '0.1.0',
    },
    payload: { path: 'payload.kdnab', encoding: 'cbor', encrypted: false },
    summary: 'Test',
    description: 'Context budget test bundle.',
    languages: ['en'],
    default_language: 'en',
    license: 'Apache-2.0',
    status: 'stable',
  };

  if (opts.contextBudget) {
    manifest.context_budget = opts.contextBudget;
  }

  fs.writeFileSync(path.join(sourceDir, 'kdna.json'), JSON.stringify(manifest, null, 2));

  const payload = {
    profile: 'kdna.payload.bundle',
    profile_version: '0.1.0',
    components: [{ id: 'comp-a', path: './comp-a.kdna', priority: 1 }],
  };
  fs.writeFileSync(path.join(sourceDir, 'payload.kdnab'), cbor.encode(payload));

  const core = require('@aikdna/kdna-core');
  fs.writeFileSync(
    path.join(sourceDir, 'checksums.json'),
    JSON.stringify(core.buildChecksums(sourceDir), null, 2),
  );
  const assetPath = path.join(dir, 'bundle.kdna');
  core.pack(sourceDir, assetPath);
  return assetPath;
}

// ─── Unit tests for computeContextBudget ────────────────────────────────────

test('Story 8 unit: no resolved deps → empty components, zero total', () => {
  const { computeContextBudget } = require('../src/cmds/context-budget');
  const report = computeContextBudget({ max_tokens: 5000 }, []);
  assert.equal(report.total_estimated_tokens, 0);
  assert.equal(report.over_budget, false);
  assert.equal(report.budget_action, 'none');
  assert.equal(report.components.length, 0);
  assert.equal(report.declared_max_tokens, 5000);
  assert.equal(report.strategy, 'warn');
});

test('Story 8 unit: two components fit within budget → over_budget=false', () => {
  const { computeContextBudget } = require('../src/cmds/context-budget');
  const deps = [
    { name: '@scope/a', version: '1.0.0', path: '/mock/a.kdna' },
    { name: '@scope/b', version: '2.0.0', path: '/mock/b.kdna' },
  ];
  const report = computeContextBudget(
    { max_tokens: 3000, per_component_estimate_tokens: 800 },
    deps,
  );
  assert.equal(report.total_estimated_tokens, 1600); // 2 × 800
  assert.equal(report.over_budget, false);
  assert.equal(report.budget_action, 'none');
  assert.equal(report.components[0].estimated_tokens, 800);
  assert.equal(report.components[0].estimation_basis, 'bundle_declared_per_component');
  assert.equal(report.components[0].load_order, 1);
  assert.equal(report.components[1].load_order, 2);
});

test('Story 8 unit: two components exceed budget, strategy=warn', () => {
  const { computeContextBudget } = require('../src/cmds/context-budget');
  const deps = [
    { name: '@scope/a', version: '1.0.0' },
    { name: '@scope/b', version: '2.0.0' },
    { name: '@scope/c', version: '3.0.0' },
  ];
  const report = computeContextBudget({ max_tokens: 2000, strategy: 'warn' }, deps);
  // default 1000 × 3 = 3000 > 2000
  assert.equal(report.total_estimated_tokens, 3000);
  assert.equal(report.over_budget, true);
  assert.equal(report.budget_action, 'warn_only');
  assert.equal(report.strategy, 'warn');
});

test('Story 8 unit: components exceed budget, strategy=truncate_lowest_priority', () => {
  const { computeContextBudget } = require('../src/cmds/context-budget');
  const deps = [
    { name: '@scope/a', version: '1.0.0' },
    { name: '@scope/b', version: '2.0.0' },
  ];
  const report = computeContextBudget(
    { max_tokens: 1500, strategy: 'truncate_lowest_priority', per_component_estimate_tokens: 1000 },
    deps,
  );
  assert.equal(report.over_budget, true);
  assert.equal(report.budget_action, 'truncate_lowest_priority_components');
});

test('Story 8 unit: components exceed budget, strategy=error', () => {
  const { computeContextBudget } = require('../src/cmds/context-budget');
  const deps = [{ name: '@scope/a', version: '1.0.0' }];
  const report = computeContextBudget({ max_tokens: 500, strategy: 'error' }, deps);
  // default 1000 > 500
  assert.equal(report.over_budget, true);
  assert.equal(report.budget_action, 'block_load');
});

test('Story 8 unit: default estimation_basis when per_component not declared', () => {
  const {
    computeContextBudget,
    DEFAULT_TOKENS_PER_COMPONENT,
  } = require('../src/cmds/context-budget');
  const deps = [{ name: '@scope/x', version: '1.0.0' }];
  const report = computeContextBudget({ max_tokens: 9999 }, deps);
  assert.equal(report.components[0].estimation_basis, 'default_compact_profile');
  assert.equal(report.components[0].estimated_tokens, DEFAULT_TOKENS_PER_COMPONENT);
});

// ─── CLI integration: no context_budget → no report ─────────────────────────

test('Story 8 CLI: bundle without context_budget → no context_budget_report in plan', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-s8-'));
  try {
    const assetPath = writeBundleFixture(tmp); // no contextBudget
    const r = run(['plan-load', assetPath]);
    // plan-load may exit 0 or 3 depending on asset state — both are valid here
    assert.ok(r.status !== 1, `unexpected plan-load error:\n${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.ok(
      !Object.prototype.hasOwnProperty.call(out, 'context_budget_report'),
      'context_budget_report should be absent when no budget is declared',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Story 8 CLI: bundle with context_budget but no resolved deps → no report', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-s8-'));
  try {
    const assetPath = writeBundleFixture(tmp, {
      contextBudget: { max_tokens: 5000, strategy: 'warn' },
    });
    const r = run(['plan-load', assetPath]);
    assert.ok(r.status !== 1, `unexpected plan-load error:\n${r.stderr}`);
    const out = JSON.parse(r.stdout);
    // No resolved_dependencies (no real deps in manifest), so no budget report
    assert.ok(
      !Object.prototype.hasOwnProperty.call(out, 'context_budget_report'),
      'context_budget_report should be absent when resolved_dependencies is empty',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
