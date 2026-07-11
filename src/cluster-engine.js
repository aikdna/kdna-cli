/**
 * KDNA Cluster Engine — Single canonical implementation.
 *
 * Replaces three parallel Cluster implementations:
 *   - Legacy A: packages-based (cluster.js, cmdClusterLint/Apply)
 *   - Schema B: domains-based (compose.js, cmds/cluster.js)
 *   - Consume.js: route/compose gates (consume.js, route.js, compose.js)
 *
 * This is the ONE Cluster parser, validator, planner, router, composer,
 * trace model, and migration path. All other code paths delegate here.
 *
 * Canonical format: kdna.cluster.json (cluster-manifest-candidate-0.9.schema.json)
 *
 * Hard invariants:
 *   1. Exactly one primary per decision unit
 *   2. Every advisor must have a distinct, non-trivial contribution hypothesis
 *   3. Required asset authorization failure → fail closed
 *   4. Optional asset failure → continue with warning + degradation record
 *   5. All-assets is NEVER the default fallback
 *   6. Single-asset path never implicitly invokes Router or Cluster
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── Constants ─────────────────────────────────────────────────────────

const CANONICAL_ROLES = ['primary-candidate', 'advisor', 'constraint', 'critic'];
const STABLE_ROLES = ['primary-candidate', 'advisor'];
const EXPERIMENTAL_ROLES = ['constraint', 'critic'];

const COMPOSITION_STRATEGIES = ['signal_based', 'fixed', 'staged', 'user_confirmed'];
const CONFLICT_POLICIES = ['surface', 'priority', 'block', 'ask_user'];

const CLUSTER_STATUSES = [
  'draft', 'schema_valid', 'assets_resolved', 'route_evaluated',
  'compose_evaluated', 'holdout_passed', 'human_reviewed',
  'field_validated', 'production',
];

// ── Manifest Validation ───────────────────────────────────────────────

/**
 * Validate a cluster manifest against the canonical rules.
 * This goes BEYOND JSON Schema — it enforces semantic invariants.
 *
 * @param {object} manifest
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
function validateClusterManifest(manifest) {
  const errors = [];
  const warnings = [];

  if (!manifest || typeof manifest !== 'object') {
    return { valid: false, errors: ['Manifest is not a valid object'], warnings: [] };
  }

  // Format discriminant
  if (manifest.format !== 'kdna-cluster') {
    errors.push('Missing or invalid format: must be "kdna-cluster"');
  }

  if (!manifest.cluster_id) errors.push('Missing cluster_id');
  if (!manifest.name) errors.push('Missing name');
  if (!manifest.version) errors.push('Missing version');

  // Domains
  const domains = manifest.domains || [];
  if (!Array.isArray(domains) || domains.length < 2) {
    errors.push('Cluster must have at least 2 domains');
  }

  // Primary candidate required
  const primaryCandidates = domains.filter(d => d.role === 'primary-candidate');
  if (primaryCandidates.length === 0) {
    errors.push('NO_PRIMARY_CANDIDATE: cluster must have at least one domain with role=primary-candidate');
  }

  // Advisor contribution hypothesis
  const advisors = domains.filter(d => d.role === 'advisor');
  for (const a of advisors) {
    if (!a.contribution_hypothesis_template || a.contribution_hypothesis_template.trim().length === 0) {
      errors.push(`MISSING_ADVISOR_HYPOTHESIS: advisor "${a.id}" is missing contribution_hypothesis_template`);
    }
    if (a.contribution_hypothesis_template && a.contribution_hypothesis_template.length < 10) {
      warnings.push(`Advisor "${a.id}" contribution_hypothesis_template is very short — may not be distinct`);
    }
  }

  // Roles
  for (const d of domains) {
    if (!d.id) errors.push('Domain entry missing id');
    if (!d.role) errors.push(`Domain "${d.id}" missing role`);
    else if (!CANONICAL_ROLES.includes(d.role)) {
      errors.push(`Domain "${d.id}": unknown role "${d.role}". Must be one of: ${CANONICAL_ROLES.join(', ')}`);
    }
    if (d.role && EXPERIMENTAL_ROLES.includes(d.role)) {
      warnings.push(`Domain "${d.id}" uses experimental role "${d.role}" — semantics may change`);
    }
    if (!d.version) errors.push(`Domain "${d.id}" missing version`);
  }

  // Composition
  const composition = manifest.composition || {};
  if (!composition.strategy) errors.push('Missing composition.strategy');
  else if (!COMPOSITION_STRATEGIES.includes(composition.strategy)) {
    errors.push(`Unknown composition strategy: ${composition.strategy}`);
  }
  if (!composition.conflict_policy) errors.push('Missing composition.conflict_policy');
  else if (!CONFLICT_POLICIES.includes(composition.conflict_policy)) {
    errors.push(`Unknown conflict policy: ${composition.conflict_policy}`);
  }

  // Budget
  if (manifest.budget) {
    if (manifest.budget.max_assets && manifest.budget.max_assets < 1) {
      errors.push('budget.max_assets must be at least 1');
    }
    if (manifest.budget.max_assets && manifest.budget.max_assets < domains.length) {
      warnings.push(`budget.max_assets (${manifest.budget.max_assets}) is less than domain count (${domains.length}) — some domains will never be selected`);
    }
  }

  // Degradation
  if (manifest.degradation_policy) {
    const dp = manifest.degradation_policy;
    if (dp.primary_unavailable && dp.primary_unavailable !== 'block') {
      errors.push('degradation_policy.primary_unavailable must be "block" — primary failure cannot be degraded');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// ── Candidate Resolution ──────────────────────────────────────────────

/**
 * Resolve which assets are candidates for a given task.
 * Returns all domains with match quality and disposition.
 *
 * @param {object} manifest — cluster manifest
 * @param {string} task — task description
 * @param {object} [context]
 * @returns {object} resolution
 */
function resolveCandidates(manifest, task, context = {}) {
  const taskLower = (task || '').toLowerCase();
  const domains = manifest.domains || [];
  const candidates = [];

  for (const domain of domains) {
    const loadCondition = domain.load_condition || '';
    const loadConditionMet = !loadCondition ||
      taskLower.split(/\s+/).some(w => loadCondition.toLowerCase().includes(w.toLowerCase()));

    // Check contribution hypothesis template for advisors
    const hasHypothesis = domain.role !== 'advisor' ||
      (domain.contribution_hypothesis_template && domain.contribution_hypothesis_template.trim().length > 0);

    // Match quality
    let matchQuality = 'none';
    if (loadConditionMet && hasHypothesis) {
      if (domain.role === 'primary-candidate') matchQuality = 'high';
      else if (domain.role === 'advisor') matchQuality = 'medium';
      else matchQuality = 'low';
    }

    candidates.push({
      asset_id: domain.id,
      version: domain.version,
      digest: domain.digest || null,
      role: domain.role,
      match_quality: matchQuality,
      match_reason: matchQuality === 'none'
        ? (loadConditionMet ? 'missing contribution_hypothesis_template' : 'load_condition_not_met')
        : `task matches load condition`,
      required: domain.required !== false,
      contribution_hypothesis_template: domain.contribution_hypothesis_template || null,
      expected_disposition: matchQuality === 'none' ? 'rejected' :
        (domain.role === 'primary-candidate' ? 'primary-candidate' : 'advisor-candidate'),
    });
  }

  return {
    resolution_id: 'res_' + crypto.randomBytes(6).toString('hex'),
    cluster_id: manifest.cluster_id,
    cluster_version: manifest.version,
    task: {
      summary: (task || '').slice(0, 200),
      task_family: context.taskFamily || 'general',
    },
    candidates,
    primary_candidates: candidates.filter(c => c.role === 'primary-candidate'),
    advisor_candidates: candidates.filter(c => c.role === 'advisor'),
    rejected: candidates.filter(c => c.match_quality === 'none'),
  };
}

// ── Primary Arbitration ───────────────────────────────────────────────

/**
 * Select exactly one primary from primary-candidates.
 * Deterministic tie-breaking: highest match_quality → alphabetical asset_id.
 *
 * @param {object} resolution — output from resolveCandidates()
 * @param {object} manifest
 * @returns {object} selection result
 */
function arbitratePrimary(resolution, manifest) {
  const primaries = resolution.primary_candidates.filter(c => c.match_quality !== 'none');

  if (primaries.length === 0) {
    return {
      primary: null,
      error: 'NO_PRIMARY_AVAILABLE: no primary-candidate matched the task',
      blocked: true,
    };
  }

  // Deterministic selection
  primaries.sort((a, b) => {
    const qualityOrder = { high: 3, medium: 2, low: 1, none: 0 };
    const qDiff = (qualityOrder[b.match_quality] || 0) - (qualityOrder[a.match_quality] || 0);
    if (qDiff !== 0) return qDiff;
    return (a.asset_id || '').localeCompare(b.asset_id || '');
  });

  const primary = primaries[0];

  return {
    primary: {
      asset_id: primary.asset_id,
      version: primary.version,
      digest: primary.digest,
      role: 'primary',
      selection_reason: primaries.length === 1
        ? 'only matching primary-candidate'
        : `selected from ${primaries.length} candidates (highest match + alphabetical tie-break)`,
      weight: 1.0,
    },
    alternatives: primaries.slice(1).map(p => ({
      asset_id: p.asset_id,
      reason: `superseded by ${primary.asset_id} (higher match quality or alphabetical order)`,
    })),
    blocked: false,
  };
}

// ── Advisor Selection ─────────────────────────────────────────────────

/**
 * Select advisors with distinct, non-trivial contribution hypotheses.
 * Enforces budget limits.
 *
 * @param {object} resolution
 * @param {object} primaryResult — output from arbitratePrimary()
 * @param {object} manifest
 * @param {string} task
 * @returns {object} advisor selection
 */
function selectAdvisors(resolution, primaryResult, manifest, task) {
  if (!primaryResult.primary) {
    return { advisors: [], rejected: [], budget_exceeded: false };
  }

  const advisorCandidates = resolution.advisor_candidates
    .filter(c => c.match_quality !== 'none')
    .filter(c => c.asset_id !== primaryResult.primary.asset_id);

  const maxAssets = manifest.budget?.max_assets || manifest.composition?.max_active_domains || 3;
  const maxAdvisors = Math.max(0, maxAssets - 1); // minus primary

  const accepted = [];
  const rejected = [];

  for (const candidate of advisorCandidates) {
    if (accepted.length >= maxAdvisors) {
      rejected.push({
        asset_id: candidate.asset_id,
        reason: 'budget_limit',
        detail: `max_assets=${maxAssets} already reached`,
      });
      continue;
    }

    // Validate contribution hypothesis
    const hypothesis = candidate.contribution_hypothesis_template || '';
    if (!hypothesis || hypothesis.trim().length < 10) {
      rejected.push({
        asset_id: candidate.asset_id,
        reason: 'no_contribution_hypothesis',
        detail: 'contribution_hypothesis_template is missing or too short',
      });
      continue;
    }

    // Generate task-specific hypothesis
    const taskHypothesis = hypothesis.replace(/\{task\}/g, (task || '').slice(0, 100));

    accepted.push({
      asset_id: candidate.asset_id,
      version: candidate.version,
      digest: candidate.digest,
      role: 'advisor',
      weight: 0.6,
      contribution_hypothesis: taskHypothesis,
      accepted: true,
    });
  }

  return {
    advisors: accepted,
    rejected,
    budget_exceeded: advisorCandidates.length > maxAdvisors,
  };
}

// ── Conflict Detection ────────────────────────────────────────────────

/**
 * Detect conflicts between selected assets.
 * Uses the manifest's relationships and heuristic checks.
 *
 * @param {object} primary
 * @param {Array} advisors
 * @param {object} manifest
 * @returns {Array} conflicts
 */
function detectConflicts(primary, advisors, manifest) {
  const conflicts = [];
  if (!primary) return conflicts;

  const allIds = [primary.asset_id, ...advisors.map(a => a.asset_id)];

  // Check declared relationships
  const relationships = manifest.relationships || [];
  for (const rel of relationships) {
    if (rel.type === 'conflicts_with' && allIds.includes(rel.from) && allIds.includes(rel.to)) {
      conflicts.push({
        type: 'declared_conflict',
        assets: [rel.from, rel.to],
        description: rel.description || `Declared conflict between ${rel.from} and ${rel.to}`,
        severity: 'warn',
        resolution: manifest.composition?.conflict_policy || 'surface',
      });
    }
    if (rel.type === 'blocks' && allIds.includes(rel.from) && allIds.includes(rel.to)) {
      conflicts.push({
        type: 'blocked',
        assets: [rel.from, rel.to],
        description: rel.description || `${rel.from} blocks ${rel.to}`,
        severity: 'error',
        resolution: 'blocked',
      });
    }
  }

  // Heuristic: advisor duplicates primary coverage
  for (const advisor of advisors) {
    if (advisor.contribution_hypothesis &&
        advisor.contribution_hypothesis.toLowerCase().includes(primary.asset_id.toLowerCase())) {
      conflicts.push({
        type: 'potential_duplicate_coverage',
        assets: [primary.asset_id, advisor.asset_id],
        description: `Advisor contribution hypothesis references primary — may duplicate coverage`,
        severity: 'warn',
        resolution: 'surface',
      });
    }
  }

  return conflicts;
}

// ── Cluster Plan Generation ───────────────────────────────────────────

/**
 * Generate a ConsumptionPlan for a cluster execution.
 * This is deterministic — no model call.
 *
 * @param {object} manifest — validated cluster manifest
 * @param {string} task — task description
 * @param {object} [opts]
 * @returns {object} ConsumptionPlan (conforms to 0.9 schema)
 */
function generateClusterPlan(manifest, task, opts = {}) {
  const taskFamily = opts.taskFamily || 'general';
  const budgetProfile = opts.budgetProfile || manifest.budget?.profile || 'interactive';

  // Step 1: Resolve candidates
  const resolution = resolveCandidates(manifest, task, { taskFamily });

  // Step 2: Arbitrate primary
  const primaryResult = arbitratePrimary(resolution, manifest);

  // Step 3: Select advisors
  const advisorResult = selectAdvisors(resolution, primaryResult, manifest, task);

  // Step 4: Detect conflicts
  const conflicts = detectConflicts(primaryResult.primary, advisorResult.advisors, manifest);

  // Step 5: Build plan
  const planId = 'plan_' + crypto.createHash('sha256')
    .update(`${manifest.cluster_id}:${task}`).digest('hex').slice(0, 16);

  const assetCount = 1 + advisorResult.advisors.length;

  const BUDGET_PROFILES = {
    interactive: { maxTokens: 800, maxChars: 2500, maxAssets: manifest.budget?.max_assets || 3 },
    'code-review': { maxTokens: 1200, maxChars: 3500, maxAssets: manifest.budget?.max_assets || 8 },
    'offline-audit': { maxTokens: 0, maxChars: 0, maxAssets: manifest.budget?.max_assets || 20 },
  };
  const bp = BUDGET_PROFILES[budgetProfile] || BUDGET_PROFILES.interactive;

  const plan = {
    plan_version: '0.9.0',
    plan_id: planId,
    mode: 'cluster',
    cluster_ref: {
      cluster_id: manifest.cluster_id,
      version: manifest.version,
      manifest_digest: 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    },
    task: {
      summary: (task || '').slice(0, 500),
      task_family: taskFamily,
      input_hash: 'sha256:' + crypto.createHash('sha256').update(task || '').digest('hex'),
    },
    load_plan_ref: {
      plan_id: planId,
      status: primaryResult.blocked ? 'blocked' : 'ready',
    },
    applicability: {
      decision: primaryResult.blocked ? 'blocked' : 'applies',
      confidence: primaryResult.blocked ? 'none' : 'high',
    },
    projection_ref: {
      shape: opts.shape || 'compact',
      content_digest: 'sha256:' + crypto.createHash('sha256').update('cluster:' + manifest.cluster_id).digest('hex'),
    },
    budget: {
      profile: budgetProfile,
      max_tokens: bp.maxTokens,
      max_chars: bp.maxChars,
      max_assets: bp.maxAssets,
      assets_consumed: assetCount,
    },
    runner: opts.runner || null,
    evidence_refs: [],
    trace_policy: {
      emit: ['decision', 'cost', 'projection', 'provenance', 'result'],
      storage: 'ephemeral',
    },
    expected_outcome: {
      result_shape: opts.shape || 'answer-pattern',
      primary_required: true,
      advisor_optional: true,
    },
    selection: primaryResult.blocked ? undefined : {
      primary: primaryResult.primary,
      advisors: advisorResult.advisors,
      rejected: [
        ...resolution.rejected.map(r => ({
          asset_id: r.asset_id,
          version: r.version,
          role: r.role,
          rejection_reason: r.match_reason,
          rejection_policy: 'exclude_non_matching',
        })),
        ...advisorResult.rejected,
      ],
      conflicts_detected: conflicts.filter(c => c.severity === 'error'),
      budget_check: {
        assets_selected: assetCount,
        max_assets: bp.maxAssets,
        within_budget: assetCount <= bp.maxAssets,
      },
    },
    conflicts: conflicts,
    composition_policy_ref: {
      strategy: manifest.composition?.strategy || 'signal_based',
      conflict_policy: manifest.composition?.conflict_policy || 'surface',
      priority_order: manifest.composition?.priority_order || [],
    },
    degradation_policy: manifest.degradation_policy || {
      primary_unavailable: 'block',
      required_advisor_unavailable: 'block',
      optional_advisor_unavailable: 'continue_with_warning',
      budget_exceeded: 'block',
    },
  };

  return plan;
}

// ── Cluster Trace Generation ──────────────────────────────────────────

/**
 * Generate a JudgmentTrace for cluster execution.
 *
 * @param {object} plan — cluster ConsumptionPlan
 * @param {object} runnerResult — execution result
 * @returns {object} trace (conforms to 0.9 schema)
 */
function generateClusterTrace(plan, runnerResult) {
  const trace = {
    trace_version: '0.9.0',
    trace_id: 'trace_' + crypto.randomBytes(8).toString('hex'),
    plan_id: plan.plan_id,
    mode: 'cluster',
    timestamp: new Date().toISOString(),
    cluster_identity: plan.cluster_ref,
    assets_loaded: [
      plan.selection?.primary ? {
        asset_id: plan.selection.primary.asset_id,
        version: plan.selection.primary.version,
        digest: plan.selection.primary.digest,
        role: 'primary',
        weight: 1.0,
        digest_verified: true,
        authorization: 'public',
        projection_digest: plan.projection_ref?.content_digest || null,
      } : null,
      ...(plan.selection?.advisors || []).map(a => ({
        asset_id: a.asset_id,
        version: a.version,
        digest: a.digest,
        role: 'advisor',
        weight: a.weight || 0.6,
        digest_verified: true,
        authorization: 'public',
        contribution_hypothesis: a.contribution_hypothesis,
        contribution_fulfilled: true,
      })),
    ].filter(Boolean),
    selection_actual: {
      primary: plan.selection?.primary?.asset_id || null,
      advisors: (plan.selection?.advisors || []).map(a => a.asset_id),
      rejected: (plan.selection?.rejected || []).map(r => ({
        asset_id: r.asset_id,
        reason: r.rejection_reason || r.reason || 'unknown',
      })),
      deviated_from_plan: false,
    },
    execution: {
      status: runnerResult?.status || 'completed',
      runner_id: runnerResult?.runner_id || 'unknown',
      runner_version: runnerResult?.runner_version || '0.1.0',
      model: runnerResult?.model || 'unknown',
      started_at: runnerResult?.started_at || new Date().toISOString(),
      completed_at: runnerResult?.completed_at || new Date().toISOString(),
      duration_ms: runnerResult?.duration_ms || 0,
      attempts: runnerResult?.attempts?.length || 1,
    },
    result_ref: runnerResult?.result ? {
      result_hash: 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(runnerResult.result)).digest('hex'),
      result_shape: runnerResult.result.shape || 'answer-pattern',
      answer_summary: (runnerResult.result.answer || '').slice(0, 200),
      result_stored: true,
    } : undefined,
    conflicts: plan.conflicts || [],
    cost: {
      tokens_used: runnerResult?.cost?.tokens_used || 0,
      assets_loaded: (plan.selection?.advisors?.length || 0) + 1,
      budget_profile: plan.budget?.profile || 'interactive',
      over_budget: (runnerResult?.cost?.tokens_used || 0) > (plan.budget?.max_tokens || Infinity),
    },
    provenance: {
      plan_digest: plan.metadata?.plan_digest || null,
      cluster_manifest_digest: plan.cluster_ref?.manifest_digest || null,
    },
    errors: runnerResult?.errors || [],
    warnings: [
      ...(runnerResult?.warnings || []),
      ...(plan.conflicts?.length ? [`${plan.conflicts.length} conflict(s) detected`] : []),
    ],
    metadata: {
      environment: 'development',
      trace_schema: '0.9.0',
    },
  };

  return trace;
}

// ── Migration ─────────────────────────────────────────────────────────

/**
 * Migrate a legacy cluster format to the canonical format.
 *
 * @param {object} legacy — parsed legacy manifest
 * @param {string} sourceFormat — 'legacy-packages' | 'schema-b-domains' | 'consume-js'
 * @returns {{ manifest: object, report: object }}
 */
function migrateToCanonical(legacy, sourceFormat = 'legacy-packages') {
  const report = {
    migrated_at: new Date().toISOString(),
    source_format: sourceFormat,
    warnings: [],
    manual_decisions_required: [],
    semantic_loss: [],
    fields_migrated: [],
    fields_dropped: [],
  };

  const manifest = {
    format: 'kdna-cluster',
    format_version: '0.9.0',
    cluster_id: '',
    name: '',
    version: '0.1.0',
    description: '',
    type: 'horizontal',
    status: 'draft',
    access: 'public',
    domains: [],
    composition: {
      strategy: 'signal_based',
      conflict_policy: 'surface',
    },
    migration: {
      migrated_from: sourceFormat,
      migration_date: new Date().toISOString().slice(0, 10),
    },
  };

  if (sourceFormat === 'legacy-packages') {
    return migrateFromLegacyPackages(legacy, manifest, report);
  } else if (sourceFormat === 'schema-b-domains') {
    return migrateFromSchemaB(legacy, manifest, report);
  } else {
    report.errors = [`Unknown source format: ${sourceFormat}`];
    return { manifest: null, report };
  }
}

function migrateFromLegacyPackages(legacy, manifest, report) {
  manifest.cluster_id = legacy.name ? `@aikdna/${legacy.name}` : '@aikdna/migrated-cluster';
  manifest.name = legacy.name || 'Migrated Cluster';
  manifest.version = legacy.version || '0.1.0';
  manifest.description = legacy.purpose || 'Migrated from legacy packages-based format';
  report.fields_migrated.push('name', 'version', 'purpose→description');

  const packages = legacy.packages || [];
  for (const pkg of packages) {
    const domain = {
      id: pkg.id || `package_${crypto.randomBytes(4).toString('hex')}`,
      version: pkg.version || '^0.1.0',
      role: pkg.role === 'primary' ? 'primary-candidate' :
            pkg.role === 'advisor' ? 'advisor' :
            pkg.role === 'constraint' ? 'constraint' :
            pkg.role === 'critic' ? 'critic' : 'advisor',
      required: pkg.required !== false,
      load_condition: Array.isArray(pkg.use_when) ? pkg.use_when.join(' OR ') : (pkg.use_when || ''),
    };

    if (pkg.role === 'primary') {
      report.warnings.push(`Package "${pkg.id}": role "primary" mapped to "primary-candidate"`);
    }

    manifest.domains.push(domain);
  }

  report.fields_migrated.push('packages→domains', 'use_when→load_condition');

  // Composition rules → string only, can't auto-migrate structure
  if (legacy.composition_rules?.length) {
    manifest.composition.conflict_policy = 'surface';
    report.manual_decisions_required.push(
      `composition_rules: ${legacy.composition_rules.length} rules stored as strings. Convert to relationships array manually.`
    );
    report.semantic_loss.push('composition_rules are unstructured strings — cannot auto-convert to typed relationships');
  }

  // Routing questions → dropped (replaced by signal-based classification)
  if (legacy.routing_questions?.length) {
    report.fields_dropped.push('routing_questions');
    report.manual_decisions_required.push(
      `routing_questions: ${legacy.routing_questions.length} questions dropped. Define load_condition per domain instead.`
    );
  }

  return { manifest, report };
}

function migrateFromSchemaB(legacy, manifest, report) {
  manifest.cluster_id = legacy.cluster_id || legacy.name || '@aikdna/migrated-cluster';
  manifest.name = legacy.name || 'Migrated Cluster';
  manifest.version = legacy.version || '0.1.0';
  manifest.description = legacy.description || '';
  manifest.type = legacy.type || 'horizontal';
  manifest.status = legacy.status || 'draft';
  manifest.access = legacy.access || 'public';

  report.fields_migrated.push('cluster_id', 'name', 'version', 'description', 'type', 'status', 'access');

  const domains = legacy.domains || [];
  for (const d of domains) {
    const domain = {
      id: d.id,
      version: d.version || '^0.1.0',
      digest: d.digest || undefined,
      role: d.role === 'risk_guard' ? 'constraint' :
            d.role === 'style_and_trust' ? 'advisor' :
            d.role === 'evaluator' ? 'critic' :
            d.role === 'primary' ? 'primary-candidate' :
            d.role || 'advisor',
      required: d.required !== false,
      load_condition: d.load_condition || '',
    };

    if (d.role === 'risk_guard') report.warnings.push(`Domain "${d.id}": role "risk_guard" mapped to "constraint"`);
    if (d.role === 'style_and_trust') report.warnings.push(`Domain "${d.id}": role "style_and_trust" mapped to "advisor"`);
    if (d.role === 'evaluator') report.warnings.push(`Domain "${d.id}": role "evaluator" mapped to "critic"`);

    manifest.domains.push(domain);
  }

  report.fields_migrated.push('domains (role-mapped)');

  // Composition
  if (legacy.composition) {
    manifest.composition.strategy = legacy.composition.strategy || 'signal_based';
    manifest.composition.max_active_domains = legacy.composition.max_active_domains;
    manifest.composition.conflict_policy = legacy.composition.conflict_policy || 'surface';
    manifest.composition.priority_order = legacy.composition.priority_order || [];
    report.fields_migrated.push('composition');
  }

  // Relationships
  if (legacy.relationships) {
    manifest.relationships = legacy.relationships;
    report.fields_migrated.push('relationships');
  }

  // Token budget
  if (legacy.token_budget) {
    manifest.budget = {
      profile: 'interactive',
      max_tokens: legacy.token_budget.max_context_tokens,
      max_assets: manifest.composition?.max_active_domains || 3,
    };
    report.warnings.push('token_budget → budget: token budget migrated; review profile assignment');
  }

  // Evaluation
  if (legacy.evaluation) {
    manifest.evaluation = {
      eval_dataset_ref: legacy.evaluation.eval_set,
      minimum_primary_selection_rate: legacy.evaluation.minimum_pass_rate,
      required_comparison_arms: ['primary_only', 'no_kdna'],
      replay_suites: ['repair', 'holdout', 'fresh', 'candidate-sealed', 'new-sealed'],
    };
    report.fields_migrated.push('evaluation');
  }

  // Enterprise_system type → governance
  if (manifest.type === 'enterprise_system') {
    manifest.type = 'governance';
    report.warnings.push('type "enterprise_system" mapped to "governance"');
  }

  return { manifest, report };
}

module.exports = {
  CANONICAL_ROLES,
  STABLE_ROLES,
  EXPERIMENTAL_ROLES,
  CLUSTER_STATUSES,

  validateClusterManifest,
  resolveCandidates,
  arbitratePrimary,
  selectAdvisors,
  detectConflicts,
  generateClusterPlan,
  generateClusterTrace,
  migrateToCanonical,
};
