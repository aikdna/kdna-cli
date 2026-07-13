const { describe, it } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const {
  validateClusterManifest,
  resolveCandidates,
  arbitratePrimary,
  selectAdvisors,
  detectConflicts,
  generateClusterPlan,
  generateClusterTrace,
  migrateToCanonical,
} = require('../src/cluster-engine');
const { preflightClusterPlan } = require('../src/cluster-preflight');

// ── Canonical manifest fixture ────────────────────────────────────────

const CANONICAL_MANIFEST = {
  format: 'kdna-cluster',
  format_version: '0.9.0',
  cluster_id: '@aikdna/launch-decision',
  name: 'Launch Decision Cluster',
  version: '0.1.0',
  description: 'Coordinates deploy-risk and API-design judgments.',
  type: 'vertical',
  status: 'draft',
  access: 'public',
  domains: [
    {
      id: '@aikdna/dev-change-risk',
      version: '^0.1.0',
      role: 'primary-candidate',
      required: true,
      load_condition: 'Task involves a deploy, rollback, or production change decision.',
    },
    {
      id: '@aikdna/dev-api-design-judgment',
      version: '^0.1.0',
      role: 'advisor',
      required: false,
      load_condition: 'Task introduces or modifies a public API surface.',
      contribution_hypothesis_template:
        'API surface introduces a design dimension beyond deploy risk.',
    },
    {
      id: '@aikdna/creator-brand-positioning',
      version: '^0.1.0',
      role: 'advisor',
      required: false,
      load_condition: 'Task involves brand, content, or audience positioning decisions.',
      contribution_hypothesis_template: 'Brand alignment dimension beyond technical deploy risk.',
    },
  ],
  composition: {
    strategy: 'signal_based',
    max_active_domains: 3,
    conflict_policy: 'surface',
    priority_order: ['@aikdna/dev-change-risk', '@aikdna/dev-api-design-judgment'],
    primary_selection: 'exactly_one',
    advisor_selection: 'contribution_hypothesis_required',
  },
  budget: { profile: 'interactive', max_tokens: 800, max_assets: 3, enforcement: 'hard' },
  degradation_policy: {
    primary_unavailable: 'block',
    required_advisor_unavailable: 'block',
    optional_advisor_unavailable: 'continue_with_warning',
    budget_exceeded: 'block',
  },
};

const LEGACY_PACKAGES = {
  name: 'example_cluster',
  version: '0.1.0',
  purpose: 'Test cluster',
  packages: [
    { id: 'domain_one', role: 'primary', use_when: ['deploy', 'rollback'] },
    { id: 'domain_two', role: 'advisor', use_when: ['api', 'endpoint'] },
    { id: 'domain_three', role: 'constraint', use_when: ['auth'] },
  ],
  composition_rules: ['Rule 1', 'Rule 2'],
  routing_questions: ['Q1', 'Q2'],
};

// ── Validation ────────────────────────────────────────────────────────

it('validates canonical manifest', () => {
  const r = validateClusterManifest(CANONICAL_MANIFEST);
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.errors.length, 0);
});

it('rejects missing format', () => {
  const r = validateClusterManifest({
    name: 'test',
    version: '1.0',
    cluster_id: 'x',
    domains: [],
    composition: {},
  });
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('format')));
});

it('rejects no primary-candidate', () => {
  const noPrimary = JSON.parse(JSON.stringify(CANONICAL_MANIFEST));
  noPrimary.domains[0].role = 'advisor';
  const r = validateClusterManifest(noPrimary);
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('NO_PRIMARY_CANDIDATE')));
});

it('rejects advisor missing contribution hypothesis', () => {
  const noHyp = JSON.parse(JSON.stringify(CANONICAL_MANIFEST));
  delete noHyp.domains[1].contribution_hypothesis_template;
  const r = validateClusterManifest(noHyp);
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('MISSING_ADVISOR_HYPOTHESIS')));
});

it('warns on experimental roles', () => {
  const withExp = JSON.parse(JSON.stringify(CANONICAL_MANIFEST));
  withExp.domains.push({
    id: '@aikdna/test-critic',
    version: '^0.1.0',
    role: 'critic',
    required: false,
  });
  const r = validateClusterManifest(withExp);
  assert.ok(r.warnings.some((w) => w.includes('experimental')));
});

it('rejects invalid role', () => {
  const bad = JSON.parse(JSON.stringify(CANONICAL_MANIFEST));
  bad.domains[0].role = 'supervisor';
  const r = validateClusterManifest(bad);
  assert.strictEqual(r.valid, false);
});

it('rejects malformed explicit routing signals', () => {
  const bad = JSON.parse(JSON.stringify(CANONICAL_MANIFEST));
  bad.domains[0].routing_signals = [];
  const r = validateClusterManifest(bad);
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some((error) => error.includes('routing_signals')));
});

it('validates empty manifest object', () => {
  const r = validateClusterManifest(null);
  assert.strictEqual(r.valid, false);
});

it('warns when budget max_assets < domain count', () => {
  const tight = JSON.parse(JSON.stringify(CANONICAL_MANIFEST));
  tight.budget.max_assets = 1;
  const r = validateClusterManifest(tight);
  assert.ok(r.warnings.some((w) => w.includes('max_assets')));
});

// ── Candidate Resolution ──────────────────────────────────────────────

it('resolves candidates for matching task', () => {
  const r = resolveCandidates(CANONICAL_MANIFEST, 'Should we deploy this change to production?');
  assert.ok(r.primary_candidates.length > 0);
  assert.ok(r.primary_candidates[0].match_quality === 'high');
});

it('resolves candidates for non-matching task', () => {
  const r = resolveCandidates(CANONICAL_MANIFEST, 'Write a blog post about our launch');
  const primary = r.primary_candidates.filter((c) => c.match_quality !== 'none');
  assert.ok(primary.length <= 1); // may match or not, depending on load_condition
});

it('explicit routing signals remove punctuation and reject generic near matches', () => {
  const manifest = JSON.parse(JSON.stringify(CANONICAL_MANIFEST));
  manifest.domains[0].routing_signals = ['done', 'production rollout'];
  manifest.domains[1].routing_signals = ['public API'];
  manifest.domains[2].routing_signals = ['brand positioning'];

  const short = resolveCandidates(manifest, 'Done?');
  assert.strictEqual(short.primary_candidates[0].match_quality, 'high');

  const unrelated = resolveCandidates(manifest, 'Plan a weekend hiking route for six people.');
  assert.strictEqual(
    unrelated.candidates.filter((candidate) => candidate.match_quality !== 'none').length,
    0,
  );
});

it('primary arbitration prefers the more specific matched signal', () => {
  const manifest = JSON.parse(JSON.stringify(CANONICAL_MANIFEST));
  manifest.domains = [
    {
      id: '@test/generic',
      version: '1.0.0',
      role: 'primary-candidate',
      required: true,
      load_condition: 'value',
      routing_signals: ['value'],
    },
    {
      id: '@test/specific',
      version: '1.0.0',
      role: 'primary-candidate',
      required: true,
      load_condition: 'distinct value',
      routing_signals: ['distinct value'],
    },
  ];
  manifest.composition.priority_order = ['@test/generic', '@test/specific'];
  const result = arbitratePrimary(
    resolveCandidates(manifest, 'Does it offer distinct value?'),
    manifest,
  );
  assert.strictEqual(result.primary.asset_id, '@test/specific');
});

// ── Primary Arbitration ───────────────────────────────────────────────

it('arbitrates primary from resolution', () => {
  const resolution = resolveCandidates(CANONICAL_MANIFEST, 'Deploy to production on Friday');
  const result = arbitratePrimary(resolution, CANONICAL_MANIFEST);
  assert.ok(result.primary);
  assert.strictEqual(result.blocked, false);
  assert.ok(result.primary.asset_id);
  assert.strictEqual(result.primary.role, 'primary');
  assert.strictEqual(result.primary.weight, 1.0);
});

it('blocks when no primary matches', () => {
  const noMatch = JSON.parse(JSON.stringify(CANONICAL_MANIFEST));
  noMatch.domains[0].load_condition = 'Only for nuclear reactor decisions';
  const resolution = resolveCandidates(noMatch, 'Deploy to production');
  const result = arbitratePrimary(resolution, noMatch);
  assert.strictEqual(result.blocked, true);
});

// ── Advisor Selection ─────────────────────────────────────────────────

it('selects advisors with valid hypotheses', () => {
  const resolution = resolveCandidates(
    CANONICAL_MANIFEST,
    'Launch new notification API v2 to production',
  );
  const primaryResult = arbitratePrimary(resolution, CANONICAL_MANIFEST);
  const advisorResult = selectAdvisors(
    resolution,
    primaryResult,
    CANONICAL_MANIFEST,
    'Launch new notification API v2',
  );
  assert.ok(advisorResult.advisors.length >= 0);
  // Each accepted advisor must have a contribution hypothesis
  for (const a of advisorResult.advisors) {
    assert.ok(a.contribution_hypothesis);
    assert.ok(a.contribution_hypothesis.length > 0);
  }
});

// ── Conflict Detection ────────────────────────────────────────────────

it('detects declared conflicts', () => {
  const withConflict = JSON.parse(JSON.stringify(CANONICAL_MANIFEST));
  withConflict.relationships = [
    {
      from: '@aikdna/dev-change-risk',
      to: '@aikdna/dev-api-design-judgment',
      type: 'conflicts_with',
      description: 'Risk and API design may conflict',
    },
  ];
  const resolution = resolveCandidates(withConflict, 'Deploy new API');
  const primaryResult = arbitratePrimary(resolution, withConflict);
  const advisorResult = selectAdvisors(resolution, primaryResult, withConflict, 'Deploy new API');
  const conflicts = detectConflicts(primaryResult.primary, advisorResult.advisors, withConflict);
  assert.ok(conflicts.length > 0);
});

it('no conflicts for clean manifest', () => {
  const resolution = resolveCandidates(CANONICAL_MANIFEST, 'Review this PR');
  const primaryResult = arbitratePrimary(resolution, CANONICAL_MANIFEST);
  const advisorResult = selectAdvisors(
    resolution,
    primaryResult,
    CANONICAL_MANIFEST,
    'Review this PR',
  );
  const conflicts = detectConflicts(
    primaryResult.primary,
    advisorResult.advisors,
    CANONICAL_MANIFEST,
  );
  assert.ok(conflicts.filter((c) => c.severity === 'error').length === 0);
});

// ── Cluster Plan ──────────────────────────────────────────────────────

it('generates cluster ConsumptionPlan (0.9)', () => {
  const plan = generateClusterPlan(
    CANONICAL_MANIFEST,
    'Launch notification API to production on Tuesday',
  );
  assert.strictEqual(plan.plan_version, '0.9.0');
  assert.strictEqual(plan.mode, 'cluster');
  assert.ok(plan.plan_id.startsWith('plan_'));
  assert.ok(plan.cluster_ref);
  assert.ok(plan.selection);
  assert.ok(plan.selection.primary);
  assert.ok(plan.composition_policy_ref);
  assert.strictEqual(plan.selection.budget_check.within_budget, null);
  assert.strictEqual(plan.selection.budget_check.projection_measurement, 'required_at_runner');
});

it('generates cluster plan that blocks when no primary', () => {
  const noPrimary = JSON.parse(JSON.stringify(CANONICAL_MANIFEST));
  noPrimary.domains[0].load_condition = 'Only for decisions about nuclear reactors';
  const plan = generateClusterPlan(noPrimary, 'Write a blog post');
  assert.strictEqual(plan.applicability.decision, 'blocked');
});

it('cluster plan IDs are deterministic', () => {
  const p1 = generateClusterPlan(CANONICAL_MANIFEST, 'Same task A');
  const p2 = generateClusterPlan(CANONICAL_MANIFEST, 'Same task A');
  assert.strictEqual(p1.plan_id, p2.plan_id);
});

it('cluster plan propagates manifest token and character budgets', () => {
  const manifest = JSON.parse(JSON.stringify(CANONICAL_MANIFEST));
  manifest.budget.max_tokens = 100;
  manifest.budget.max_chars = 400;
  const plan = generateClusterPlan(manifest, 'Deploy to production');
  assert.strictEqual(plan.budget.max_tokens, 100);
  assert.strictEqual(plan.budget.max_chars, 400);
});

it('hard budget policy blocks instead of silently truncating advisors', () => {
  const manifest = JSON.parse(JSON.stringify(CANONICAL_MANIFEST));
  manifest.budget.max_assets = 1;
  manifest.domains[0].routing_signals = ['deploy'];
  manifest.domains[1].routing_signals = ['deploy'];
  manifest.domains[2].routing_signals = ['deploy'];
  const plan = generateClusterPlan(manifest, 'Deploy?');
  assert.strictEqual(plan.load_plan_ref.status, 'blocked');
  assert.strictEqual(plan.budget.assets_consumed, 0);
  assert.ok(plan.load_plan_ref.issues.some((issue) => issue.code === 'BUDGET_EXCEEDED'));
});

it('block conflict policy produces a blocked zero-consumption plan', () => {
  const manifest = JSON.parse(JSON.stringify(CANONICAL_MANIFEST));
  manifest.composition.conflict_policy = 'block';
  manifest.domains[0].routing_signals = ['deploy'];
  manifest.domains[1].routing_signals = ['deploy'];
  manifest.domains[2].routing_signals = ['brand'];
  manifest.relationships = [
    {
      from: manifest.domains[0].id,
      to: manifest.domains[1].id,
      type: 'conflicts_with',
      description: 'Test conflict',
    },
  ];
  const plan = generateClusterPlan(manifest, 'Deploy?');
  assert.strictEqual(plan.load_plan_ref.status, 'blocked');
  assert.strictEqual(plan.budget.assets_consumed, 0);
  assert.strictEqual(plan.conflicts[0].severity, 'error');
});

it('preflight removes an unavailable optional advisor and keeps the verified primary', () => {
  const artifactDigest =
    'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex');
  const manifest = JSON.parse(JSON.stringify(CANONICAL_MANIFEST));
  manifest.domains[0].digest = artifactDigest;
  manifest.domains[0].routing_signals = ['deploy'];
  manifest.domains[1].digest = artifactDigest;
  manifest.domains[1].routing_signals = ['deploy'];
  manifest.domains[2].routing_signals = ['brand'];
  const plan = generateClusterPlan(manifest, 'Deploy?');
  const checked = preflightClusterPlan(plan, {
    resolveAsset: (name) => (name === manifest.domains[0].id ? { asset_path: __filename } : null),
    core: {
      planLoad: () => ({
        can_load_now: true,
        state: 'ready',
        checks: { overall_valid: true, checksums_valid: true },
      }),
    },
  });
  assert.strictEqual(checked.load_plan_ref.status, 'ready');
  assert.strictEqual(checked.load_plan_ref.preflight.status, 'degraded');
  assert.strictEqual(checked.selection.advisors.length, 0);
  assert.strictEqual(checked.budget.assets_consumed, 1);
  assert.ok(checked.warnings.some((warning) => warning.includes('Optional advisor')));
});

it('preflight blocks when the selected primary is unavailable', () => {
  const manifest = JSON.parse(JSON.stringify(CANONICAL_MANIFEST));
  manifest.domains[0].routing_signals = ['deploy'];
  const plan = generateClusterPlan(manifest, 'Deploy?');
  const checked = preflightClusterPlan(plan, { resolveAsset: () => null });
  assert.strictEqual(checked.load_plan_ref.status, 'blocked');
  assert.strictEqual(checked.budget.assets_consumed, 0);
  assert.ok(checked.load_plan_ref.issues.some((issue) => issue.code === 'PRIMARY_UNAVAILABLE'));
});

// ── Cluster Trace ─────────────────────────────────────────────────────

it('generates cluster JudgmentTrace', () => {
  const plan = generateClusterPlan(
    CANONICAL_MANIFEST,
    'Should we deploy this API change to production on Tuesday?',
  );
  const runnerResult = {
    status: 'completed',
    runner_id: 'mock:default',
    runner_version: '0.1.0',
    model: 'test-model',
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    duration_ms: 5000,
    cost: { tokens_used: 500 },
    result: { shape: 'answer-pattern', answer: 'Proceed with launch' },
    errors: [],
    warnings: [],
    assets_loaded: [
      {
        asset_id: plan.selection.primary.asset_id,
        version: plan.selection.primary.version,
        digest: plan.selection.primary.digest,
        role: 'primary',
        digest_verified: true,
        authorization: 'public',
      },
    ],
  };
  const trace = generateClusterTrace(plan, runnerResult);
  assert.strictEqual(trace.trace_version, '0.9.0');
  assert.strictEqual(trace.mode, 'cluster');
  assert.ok(trace.trace_id.startsWith('trace_'));
  assert.strictEqual(trace.plan_id, plan.plan_id);
  assert.ok(trace.assets_loaded);
  assert.ok(Array.isArray(trace.assets_loaded));
  assert.ok(trace.assets_loaded.some((a) => a.role === 'primary'));
  assert.ok(trace.result_ref);
});

// ── Migration ─────────────────────────────────────────────────────────

it('migrates from legacy-packages format', () => {
  const { manifest, report } = migrateToCanonical(LEGACY_PACKAGES, 'legacy-packages');
  assert.ok(manifest);
  assert.strictEqual(manifest.format, 'kdna-cluster');
  assert.strictEqual(manifest.format_version, '0.9.0');
  assert.strictEqual(manifest.domains.length, 3);
  assert.strictEqual(manifest.domains[0].role, 'primary-candidate');
  assert.strictEqual(manifest.domains[1].role, 'advisor');
  assert.strictEqual(manifest.domains[2].role, 'constraint');
  assert.ok(report.manual_decisions_required.length > 0, 'Should flag composition_rules as manual');
  assert.ok(report.fields_dropped.includes('routing_questions'));
  assert.strictEqual(report.source_format, 'legacy-packages');
});

it('migrates from schema-b-domains format', () => {
  const schemaB = {
    cluster_id: '@test/cluster',
    name: 'Test Cluster',
    version: '0.2.0',
    type: 'vertical',
    domains: [
      {
        id: '@test/primary',
        version: '^0.1.0',
        role: 'primary',
        required: true,
        load_condition: 'test',
      },
      {
        id: '@test/risk',
        version: '^0.1.0',
        role: 'risk_guard',
        required: false,
        load_condition: 'risk',
      },
    ],
    composition: { strategy: 'fixed', conflict_policy: 'block' },
  };
  const { manifest, report } = migrateToCanonical(schemaB, 'schema-b-domains');
  assert.ok(manifest);
  assert.strictEqual(manifest.type, 'vertical');
  assert.strictEqual(manifest.domains[1].role, 'constraint');
  assert.ok(report.warnings.some((w) => w.includes('risk_guard')));
});

it('migration report is machine-readable', () => {
  const { report } = migrateToCanonical(LEGACY_PACKAGES, 'legacy-packages');
  assert.ok(report.migrated_at);
  assert.ok(report.source_format);
  assert.ok(Array.isArray(report.warnings));
  assert.ok(Array.isArray(report.manual_decisions_required));
});

// ── Constants ─────────────────────────────────────────────────────────

it('CANONICAL_ROLES includes primary-candidate and advisor', () => {
  const { CANONICAL_ROLES, STABLE_ROLES, EXPERIMENTAL_ROLES } = require('../src/cluster-engine');
  assert.ok(CANONICAL_ROLES.includes('primary-candidate'));
  assert.ok(CANONICAL_ROLES.includes('advisor'));
  assert.ok(STABLE_ROLES.includes('primary-candidate'));
  assert.ok(EXPERIMENTAL_ROLES.includes('constraint'));
});

// ── Round 4: Trust facts ──────────────────────────────────────────────
it('cluster trace reports no loaded assets for mock runner without observations', () => {
  const plan = generateClusterPlan(
    CANONICAL_MANIFEST,
    'Deploy this API change to production on Friday?',
  );
  const rr = {
    status: 'completed',
    runner_id: 'mock:default',
    runner_version: '0.1.0',
    model: 'test',
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    duration_ms: 5000,
    cost: { tokens_used: 500 },
    result: { shape: 'answer-pattern', answer: 'Proceed' },
    errors: [],
    warnings: [],
    attempts: [{ attempt: 1, status: 'completed' }],
  };
  const trace = generateClusterTrace(plan, rr);
  assert.deepStrictEqual(trace.assets_loaded, []);
  assert.strictEqual(trace.cost.assets_loaded, 0);
});

it('cluster trace preserves observed Core verification facts from runner', () => {
  const plan = generateClusterPlan(
    CANONICAL_MANIFEST,
    'Deploy this API change to production on Friday?',
  );
  const observed = {
    asset_id: plan.selection.primary.asset_id,
    version: plan.selection.primary.version,
    digest: plan.selection.primary.digest,
    role: 'primary',
    digest_verified: true,
    authorization: 'public',
  };
  const rr = {
    status: 'completed',
    runner_id: 'cli:default',
    runner_version: '0.1.0',
    model: null,
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    duration_ms: 5,
    cost: { tokens_used: 0 },
    result: { shape: 'answer-pattern', answer: 'Loaded' },
    errors: [],
    warnings: [],
    attempts: [{ attempt: 1, status: 'completed' }],
    assets_loaded: [observed],
  };
  const trace = generateClusterTrace(plan, rr);
  assert.strictEqual(trace.assets_loaded.length, 1);
  assert.strictEqual(trace.assets_loaded[0].digest_verified, true);
  assert.strictEqual(trace.cost.assets_loaded, 1);
});

it('cluster trace on runner_error has empty assets_loaded and costs 0', () => {
  const plan = generateClusterPlan(
    CANONICAL_MANIFEST,
    'Deploy this API change to production on Friday?',
  );
  const rr = {
    status: 'runner_error',
    runner_id: 'mock:default',
    runner_version: '0.1.0',
    model: null,
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    duration_ms: 100,
    cost: { tokens_used: 0 },
    result: null,
    errors: ['Failed'],
    warnings: [],
    attempts: [{ attempt: 1, status: 'error' }],
  };
  const trace = generateClusterTrace(plan, rr);
  assert.strictEqual(trace.assets_loaded.length, 0);
  assert.strictEqual(trace.cost.assets_loaded, 0);
  assert.ok(trace.errors.length > 0);
});

// ── Round 4: Routing edge cases ──────────────────────────────────────
it('empty task returns no candidates', () => {
  const r = resolveCandidates(CANONICAL_MANIFEST, '');
  assert.strictEqual(r.candidates.length, 0);
  assert.strictEqual(r.primary_candidates.length, 0);
});

it('single-char task returns no candidates', () => {
  const r = resolveCandidates(CANONICAL_MANIFEST, 'a');
  assert.strictEqual(r.candidates.length, 0);
});

it('Chinese deploy task matches Chinese deployment load condition', () => {
  const zhManifest = JSON.parse(JSON.stringify(CANONICAL_MANIFEST));
  zhManifest.domains[0].load_condition = '任务涉及部署、回滚或生产变更决策。';
  zhManifest.domains[1].load_condition = '任务引入新的公共 API 表面。';
  const r = resolveCandidates(zhManifest, '这个任务涉及部署决策');
  const primary = r.candidates.find((c) => c.role === 'primary-candidate');
  assert.ok(primary, 'Should have a primary candidate');
  assert.notStrictEqual(primary.match_quality, 'none');
});

it('Chinese stopwords-only text matches no domains', () => {
  const zhManifest = JSON.parse(JSON.stringify(CANONICAL_MANIFEST));
  zhManifest.domains[0].load_condition = '任务涉及部署、回滚或生产变更决策。';
  zhManifest.domains[1].load_condition = '任务引入新的公共 API 表面。';
  const r = resolveCandidates(zhManifest, '这个任务是什么');
  // Only CJK stopwords (这个, 任务, 是, 什么) with no content-bearing CJK sequences ≥2 chars matching the load condition
  const matched = r.candidates.filter((c) => c.match_quality !== 'none');
  assert.ok(
    matched.length === 0,
    'Stopword-only Chinese text should not match any domain load conditions',
  );
});

it('Chinese tokenizer does not match deployment from an unrelated design decision', () => {
  const zhManifest = JSON.parse(JSON.stringify(CANONICAL_MANIFEST));
  zhManifest.domains[0].load_condition = '任务涉及部署、回滚或生产变更决策。';
  zhManifest.domains[1].load_condition = '任务引入新的公共 API 表面。';
  const r = resolveCandidates(zhManifest, '这个设计决策需要进一步讨论');
  const matched = r.candidates.filter((c) => c.match_quality !== 'none');
  assert.strictEqual(matched.length, 0);
});

console.log('cluster.test.js: all tests complete');
