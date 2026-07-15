/**
 * kdna plan-use — Deterministic pre-execution consumption planning.
 *
 * Loads an asset (or cluster), validates, authorizes, projects, and emits a
 * ConsumptionPlan 0.9 candidate. No model call. No runner execution.
 *
 * This is the "what should happen" — not "what did happen."
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { error, EXIT, readJson } = require('./_common');

// ── Helpers ──────────────────────────────────────────────────────────

function hex16() {
  return crypto.randomBytes(16).toString('hex');
}
function sha256(data) {
  return 'sha256:' + crypto.createHash('sha256').update(data).digest('hex');
}

function loadCore() {
  try {
    return require('@aikdna/kdna-core');
  } catch (_) {}
  try {
    return require(path.resolve(__dirname, '..', '..', '..', 'kdna', 'packages', 'kdna-core'));
  } catch (_) {}
  error(
    '@aikdna/kdna-core is required for kdna plan-use. Install: npm install @aikdna/kdna-core',
    EXIT.DEPENDENCY_ERROR || 6,
  );
}

function resolveAssetReference(nameOrPath) {
  try {
    const { resolveAsset } = require('../package-store');
    const result = resolveAsset(nameOrPath);
    if (result?.asset_path) return result;
  } catch (_) {}
  const abs = path.resolve(nameOrPath);
  if (fs.existsSync(abs)) {
    return {
      asset_path: abs,
      asset_digest: fs.statSync(abs).isFile() ? sha256(fs.readFileSync(abs)) : null,
    };
  }
  return null;
}

function resolveAssetTarget(nameOrPath) {
  return resolveAssetReference(nameOrPath)?.asset_path || null;
}

function loadManifest(absPath) {
  try {
    const core = loadCore();
    const stat = fs.statSync(absPath);
    if (stat.isDirectory()) {
      const mf = path.join(absPath, 'kdna.json');
      if (fs.existsSync(mf)) return JSON.parse(fs.readFileSync(mf, 'utf8'));
    }
    const m = core.inspect(absPath);
    if (m) return m;
  } catch (_) {}
  return null;
}

// ── Applicability ────────────────────────────────────────────────────

/**
 * Determine whether an asset applies to a given task.
 *
 * @returns {{ decision: string, confidence: string, matched_signals: string[], boundary_check: object, load_condition_met: boolean }}
 */
function determineApplicability(manifest, task) {
  const taskLower = (task || '').toLowerCase();

  // Empty/single-char/whitespace-only tasks cannot match any domain
  if (!task || task.trim().length < 2) {
    return {
      decision: 'ask',
      confidence: 'low',
      matched_signals: [],
      boundary_check: {
        in_scope: false,
        warnings: [
          'Task is too short to determine applicability. Provide a meaningful task description.',
        ],
        not_applicable_reasons: ['insufficient task description'],
      },
      load_condition_met: false,
    };
  }

  const signals = [];

  // Check trigger_signals from core
  const core = manifest?.trigger_signals || manifest?.core?.trigger_signals || [];
  for (const signal of core) {
    if (taskLower.includes(signal.toLowerCase())) signals.push(signal);
  }

  // Check load_condition
  const loadCondition = manifest?.load_condition || manifest?.core?.load_condition || '';
  const loadConditionMet =
    !loadCondition ||
    taskLower.split(/\s+/).some((w) => loadCondition.toLowerCase().includes(w.toLowerCase())) ||
    signals.length > 0;

  // Check boundaries
  const appliesWhen = manifest?.applies_when || manifest?.core?.applies_when || [];
  const doesNotApplyWhen =
    manifest?.does_not_apply_when || manifest?.core?.does_not_apply_when || [];

  const inScope =
    appliesWhen.length === 0 || appliesWhen.some((aw) => taskLower.includes(aw.toLowerCase()));
  const outOfScope = doesNotApplyWhen.some((na) => taskLower.includes(na.toLowerCase()));

  if (outOfScope) {
    return {
      decision: 'does_not_apply',
      confidence: 'high',
      matched_signals: [],
      boundary_check: {
        in_scope: false,
        warnings: [],
        not_applicable_reasons: ['Task matches does_not_apply_when boundary'],
      },
      load_condition_met: true,
    };
  }

  if (!inScope) {
    return {
      decision: 'ask',
      confidence: 'low',
      matched_signals: signals,
      boundary_check: {
        in_scope: false,
        warnings: [
          'Task does not clearly match applies_when boundaries. Consider asking user to confirm scope.',
        ],
        not_applicable_reasons: [],
      },
      load_condition_met: loadConditionMet,
    };
  }

  if (signals.length === 0 && appliesWhen.length > 0) {
    return {
      decision: 'ask',
      confidence: 'medium',
      matched_signals: [],
      boundary_check: {
        in_scope: true,
        warnings: ['No trigger signals matched but boundaries are in scope. Confirm with user.'],
        not_applicable_reasons: [],
      },
      load_condition_met: loadConditionMet,
    };
  }

  // Fail closed: an explicit load condition that is not met blocks applicability
  if (!loadConditionMet && loadCondition) {
    return {
      decision: 'does_not_apply',
      confidence: 'medium',
      matched_signals: [],
      boundary_check: {
        in_scope: true,
        warnings: [],
        not_applicable_reasons: ['Load condition not met for this task'],
      },
      load_condition_met: false,
    };
  }

  return {
    decision: 'applies',
    confidence: signals.length >= 2 ? 'high' : 'medium',
    matched_signals: signals,
    boundary_check: { in_scope: true, warnings: [], not_applicable_reasons: [] },
    load_condition_met: loadConditionMet,
  };
}

// ── Projection ───────────────────────────────────────────────────────

function computeProjection(manifest, shape, budgetProfile) {
  const validShapes = ['answer-pattern', 'compact', 'scenario', 'full'];
  const shape_ = validShapes.includes(shape) ? shape : 'compact';

  // Budget-to-shape alignment
  const budgetToShape = {
    interactive: 'answer-pattern',
    'code-review': 'compact',
    'offline-audit': 'full',
  };

  return {
    shape: shape_,
    content_digest: sha256(
      JSON.stringify({ manifest: manifest?.name || manifest?.asset_id, shape: shape_ }),
    ),
    inline: false,
  };
}

// ── Budget ────────────────────────────────────────────────────────────

const BUDGET_PROFILES = {
  interactive: { max_tokens: 800, max_chars: 2500, max_assets: 3 },
  'code-review': { max_tokens: 1200, max_chars: 3500, max_assets: 8 },
  'offline-audit': { max_tokens: 0, max_chars: 0, max_assets: 20 },
};

function computeBudget(profile, assetsConsumed) {
  const bp = BUDGET_PROFILES[profile] || BUDGET_PROFILES['interactive'];
  return {
    profile,
    max_tokens: bp.max_tokens,
    max_chars: bp.max_chars,
    max_assets: bp.max_assets,
    assets_consumed: assetsConsumed,
  };
}

// ── Plan Generation ──────────────────────────────────────────────────

function generatePlanId(assetPath, task) {
  return (
    'plan_' + crypto.createHash('sha256').update(`${assetPath}:${task}`).digest('hex').slice(0, 16)
  );
}

function generateConsumptionPlan(opts) {
  const {
    assetPath,
    assetDigest,
    task,
    taskFamily,
    budgetProfile,
    shape,
    manifest,
    loadPlan,
    mode,
  } = opts;

  const abs = path.resolve(assetPath);
  const planId = generatePlanId(abs, task || '');
  const applicability = determineApplicability(manifest, task || '');
  const projection = computeProjection(
    manifest,
    shape || 'compact',
    budgetProfile || 'code-review',
  );
  const budget = computeBudget(budgetProfile || 'code-review', 1);

  const inputHash = sha256(task || '');
  const plan = {
    plan_version: '0.9.0',
    plan_id: planId,
    mode: mode || 'single',
    asset_ref: {
      asset_id: manifest?.asset_id || manifest?.name || path.basename(abs, '.kdna'),
      version: manifest?.version || '0.1.0',
      digest: assetDigest || manifest?.asset_digest || manifest?.content_digest || null,
      access: manifest?.access || 'public',
    },
    task: {
      summary: (task || '').slice(0, 200),
      task_family: taskFamily || 'general',
      input_hash: inputHash,
    },
    load_plan_ref: {
      plan_id: loadPlan?.plan_id || planId,
      status: loadPlan?.status || 'ready',
      issues: loadPlan?.issues || [],
    },
    applicability,
    projection_ref: projection,
    budget,
    evidence_refs: [],
    trace_policy: {
      emit: ['decision', 'cost', 'projection', 'provenance', 'result'],
      storage: 'ephemeral',
      retention_hours: 0,
    },
    expected_outcome: {
      result_shape: shape || 'answer-pattern',
      required_fields: ['answer', 'reasoning', 'sources', 'confidence', 'alternatives'],
    },
    metadata: {
      plan_digest: sha256(JSON.stringify({ planId, assetPath: abs, task, mode: mode || 'single' })),
    },
  };

  return plan;
}

// ── Plan for asset.kdna ──────────────────────────────────────────────

function planSingleAsset(assetPath, opts = {}) {
  const { task, taskFamily, budgetProfile, shape } = opts;
  const resolved = resolveAssetReference(assetPath);
  if (!resolved?.asset_path) error(`Asset not found: ${assetPath}`, EXIT.INPUT_ERROR);
  const abs = resolved.asset_path;

  const core = loadCore();
  const manifest = loadManifest(abs);
  if (!manifest) error(`Cannot read asset: ${assetPath}`, EXIT.INPUT_ERROR);

  // Run LoadPlan (deterministic — no model call)
  let loadPlan;
  try {
    if (typeof core.planLoad === 'function') {
      loadPlan = core.planLoad(abs, {
        hasPassword: false,
        entitlement: undefined,
      });
    }
  } catch (e) {
    loadPlan = {
      state: 'invalid',
      can_load_now: false,
      issues: [{ code: 'LOADPLAN_ERROR', message: e.message, blocking: true }],
    };
  }

  // If loadPlan is blocked, still emit a plan — but with blocked status
  const plan = generateConsumptionPlan({
    assetPath: abs,
    assetDigest: resolved.asset_digest || null,
    task,
    taskFamily,
    budgetProfile,
    shape,
    manifest,
    loadPlan: loadPlan
      ? {
          plan_id: loadPlan.plan_id,
          status: loadPlan.state === 'valid' || loadPlan.can_load_now ? 'ready' : 'blocked',
          issues: loadPlan.issues || [],
        }
      : undefined,
    mode: 'single',
  });

  return plan;
}

// ── Command ──────────────────────────────────────────────────────────

function optionOccurrences(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === name) {
      values.push(null);
    } else if (value.startsWith(`${name}=`)) {
      values.push(value.slice(name.length + 1));
    }
  }
  return values;
}

function cmdPlanUse(args) {
  const getFlag = (name) => {
    const eqIdx = args.findIndex((a) => a === name + '=' || a.startsWith(name + '='));
    if (eqIdx >= 0) {
      const parts = args[eqIdx].split('=');
      return parts.slice(1).join('=') || null;
    }
    const idx = args.indexOf(name);
    return idx >= 0 && args[idx + 1] && !args[idx + 1].startsWith('--') ? args[idx + 1] : null;
  };

  const posArgs = args.filter((a) => !a.startsWith('--'));
  const target = posArgs[0];
  const runtimeContractValues = optionOccurrences(args, '--runtime-contract');

  if (!target || args.includes('--help') || args.includes('-h')) {
    process.stderr.write(
      'Usage: kdna plan-use <name[@version]|asset.kdna|kdna.cluster.json> [options]\n\n' +
        'Generate a deterministic ConsumptionPlan without model execution.\n\n' +
        'Options:\n' +
        '  --task=<text>         Task description\n' +
        '  --task-family=<name>  Task family for routing (default: general)\n' +
        '  --budget=<profile>    interactive|code-review|offline-audit (default: code-review)\n' +
        '  --shape=<name>        answer-pattern|compact|scenario|full (default: compact)\n' +
        '  --as=<format>         json|md (default: json)\n' +
        '  --out=<path>          Write plan to file\n' +
        '  --plan-id=<id>        Use a specific plan_id (deterministic default)\n' +
        '  --runtime-contract=1  Opt in to strict ConsumptionPlan 1 (JSON only)\n' +
        '\n' +
        'The plan is deterministic: same asset + same task = same plan_id.\n' +
        'No model call is made. No runner is required.\n',
    );
    if (args.includes('--help') || args.includes('-h')) process.exit(0);
    process.exit(EXIT.INPUT_ERROR);
  }

  const task = getFlag('--task') || '';
  const taskFamily = getFlag('--task-family') || 'general';
  const budgetProfile = getFlag('--budget') || 'code-review';
  const shape = getFlag('--shape') || 'compact';
  const as = getFlag('--as') || 'json';
  const outPath = getFlag('--out');
  const planIdOverride = getFlag('--plan-id');

  if (runtimeContractValues.length > 0) {
    if (runtimeContractValues.length !== 1 || runtimeContractValues[0] !== '1') {
      error(
        'Runtime contract must be one unique --runtime-contract=1 occurrence; no legacy fallback was selected.',
        EXIT.INPUT_ERROR,
      );
    }
    if (as !== 'json') {
      error('Runtime contract 1 plan output supports --as=json only.', EXIT.INPUT_ERROR);
    }
    try {
      const { prepareExecutionContractV1 } = require('../execution-contract-v1');
      const prepared = prepareExecutionContractV1(target, {
        task,
        taskFamily: taskFamily === 'general' ? null : taskFamily,
        budgetProfile,
        profile: shape,
        planId: planIdOverride || undefined,
      });
      const json = JSON.stringify(prepared.plan, null, 2);
      if (outPath) fs.writeFileSync(path.resolve(outPath), `${json}\n`);
      console.log(json);
      return;
    } catch (runtimeError) {
      error(`Runtime contract 1 planning failed: ${runtimeError.message}`, EXIT.VALIDATION_FAILED);
    }
  }

  // Determine mode: single asset or cluster
  const abs = resolveAssetTarget(target);
  if (!abs) error(`Target not found: ${target}`, EXIT.INPUT_ERROR);

  let plan;
  const isCluster =
    abs.endsWith('.json') && !abs.endsWith('kdna.json') && !abs.endsWith('checksums.json');

  if (isCluster) {
    // Cluster plan — route to cluster engine
    try {
      const manifest = readJson(abs);
      if (manifest?.format === 'kdna-cluster' || manifest?.cluster_id) {
        const { generateClusterPlan, validateClusterManifest } = require('../cluster-engine');
        const validation = validateClusterManifest(manifest);
        if (!validation.valid) {
          error(
            `Cluster manifest invalid:\n${validation.errors.map((e) => `  - ${e}`).join('\n')}`,
            EXIT.VALIDATION_FAILED,
          );
        }
        plan = generateClusterPlan(manifest, task || '', { taskFamily, budgetProfile, shape });
        if (planIdOverride) plan.plan_id = planIdOverride;
      } else {
        error(`Not a valid cluster manifest: ${target}`, EXIT.INPUT_ERROR);
      }
    } catch (e) {
      if (e.code === 'MODULE_NOT_FOUND' || e.message?.includes('Cannot find')) throw e;
      error(`Cannot process cluster manifest: ${e.message}`, EXIT.INPUT_ERROR);
    }
  } else {
    plan = planSingleAsset(target, { task, taskFamily, budgetProfile, shape });
  }

  if (planIdOverride) plan.plan_id = planIdOverride;

  // Output
  const jsonOutput = JSON.stringify(plan, null, 2);

  if (outPath) {
    fs.writeFileSync(path.resolve(outPath), jsonOutput + '\n');
  }

  if (as === 'json') {
    console.log(jsonOutput);
  } else if (as === 'md') {
    // Markdown rendering — use mode-appropriate fields
    let md = `# Consumption Plan\n\n`;
    md += `**Plan ID:** ${plan.plan_id}\n`;
    md += `**Mode:** ${plan.mode}\n`;
    if (plan.mode === 'cluster' && plan.cluster_ref) {
      md += `**Cluster:** ${plan.cluster_ref.cluster_id} v${plan.cluster_ref.version}\n\n`;
    } else if (plan.asset_ref) {
      md += `**Asset:** ${plan.asset_ref.asset_id} v${plan.asset_ref.version}\n\n`;
    }
    md += `## Task\n\n${plan.task.summary || '(no task)'}\n\n`;
    md += `## Applicability\n\n`;
    md += `- **Decision:** ${plan.applicability.decision}\n`;
    md += `- **Confidence:** ${plan.applicability.confidence}\n`;
    md += `- **Load condition met:** ${plan.applicability.load_condition_met}\n`;
    if (plan.applicability.matched_signals?.length) {
      md += `- **Matched signals:** ${plan.applicability.matched_signals.join(', ')}\n`;
    }
    md += `\n## Budget\n\n`;
    md += `- **Profile:** ${plan.budget.profile}\n`;
    md += `- **Max tokens:** ${plan.budget.max_tokens || 'unlimited'}\n`;
    md += `- **Max assets:** ${plan.budget.max_assets}\n`;
    md += `\n## Projection\n\n`;
    md += `- **Shape:** ${plan.projection_ref.shape}\n`;
    if (plan.projection_ref.content_digest) {
      md += `- **Digest:** ${plan.projection_ref.content_digest}\n`;
    }
    md += `\n## Load Plan\n\n`;
    md += `- **Status:** ${plan.load_plan_ref.status}\n`;
    if (plan.load_plan_ref.issues?.length) {
      for (const iss of plan.load_plan_ref.issues) {
        md += `- ${iss.blocking ? 'BLOCKED' : 'WARN'}: ${iss.message || iss.code}\n`;
      }
    }
    console.log(md);
  }
}

module.exports = { cmdPlanUse, generateConsumptionPlan, planSingleAsset };
