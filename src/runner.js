/**
 * KDNA Runner Adapter Contract
 *
 * A Runner is a registered execution target that consumes a ConsumptionPlan
 * and produces a result. Runners are the bridge between KDNA plans and actual
 * model/agent/application execution.
 *
 * Runner Types:
 *   - agent: an AI agent (Claude Code, Codex, etc.) that executes the judgment
 *   - skill: a KDNA skill that loads the asset and invokes the agent
 *   - api: a direct API call (Claude API, OpenAI API, etc.)
 *   - mock: a deterministic mock runner for testing
 *
 * Contract:
 *   1. Every runner must accept a ConsumptionPlan and return a RunnerResult
 *   2. Runners are registered by type and id
 *   3. Runners must not modify the plan
 *   4. Runners must report status: completed, cancelled, timed_out, error, partial
 *   5. A runner that cannot execute must return status: runner_error with an error message
 *   6. Runner outputs must conform to expected_outcome shape from the plan
 */

const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');

// ── Runner Registry ──────────────────────────────────────────────────

/**
 * Global runner registry. Each runner is identified by (type, id).
 */
const RUNNER_REGISTRY = new Map();

function registerRunner(type, id, runner) {
  const key = `${type}:${id}`;
  if (RUNNER_REGISTRY.has(key)) {
    throw new Error(`Runner already registered: ${key}`);
  }
  RUNNER_REGISTRY.set(key, { type, id, runner, registered_at: new Date().toISOString() });
  return key;
}

function getRunner(type, id) {
  const key = `${type}:${id}`;
  const entry = RUNNER_REGISTRY.get(key);
  if (!entry) throw new Error(`Runner not found: ${key}. Available: ${listRunners().join(', ')}`);
  return entry.runner;
}

function listRunners() {
  return Array.from(RUNNER_REGISTRY.keys());
}

// ── Runner Interface ─────────────────────────────────────────────────

/**
 * Runner interface. All runners must implement this shape.
 *
 * @typedef {object} Runner
 * @property {string} type — runner type (agent, skill, api, mock)
 * @property {string} id — runner identifier
 * @property {string} version — runner version
 * @property {function(ConsumptionPlan, RunnerContext): Promise<RunnerResult>} execute
 * @property {function(): Promise<boolean>} healthCheck
 * @property {function(): Promise<void>} cancel
 */

/**
 * Runner context passed to every execution.
 *
 * @typedef {object} RunnerContext
 * @property {number} timeoutMs — max execution time
 * @property {object} credentials — runner-specific credentials
 * @property {AbortSignal} signal — cancellation signal
 * @property {function(string): void} onProgress — progress callback
 */

/**
 * Runner result returned from every execution.
 *
 * @typedef {object} RunnerResult
 * @property {string} plan_id
 * @property {string} runner_id
 * @property {string} runner_version
 * @property {string} status — completed, cancelled, timed_out, runner_error, partial
 * @property {string} started_at
 * @property {string} completed_at
 * @property {number} duration_ms
 * @property {string} model
 * @property {object} result
 * @property {object} cost
 * @property {Array<string>} errors
 * @property {Array<string>} warnings
 * @property {Array<object>} attempts
 * @property {Array<object>} assets_loaded — observed loads only; never inferred from the plan
 */

// ── Runner Factory ───────────────────────────────────────────────────

/**
 * Create a mock runner for testing. Uses deterministic output.
 *
 * @param {object} opts
 * @returns {Runner}
 */
function createMockRunner(opts = {}) {
  const id = opts.id || 'mock-runner';
  const version = opts.version || '0.1.0';

  let _cancelled = false;

  return {
    type: 'mock',
    id,
    version,
    async execute(plan, context = {}) {
      const startTime = Date.now();
      _cancelled = false;

      const timeoutMs = context.timeoutMs || 30000;
      const signal = context.signal;

      // Simulate work
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, Math.min(100, timeoutMs));
        if (signal) {
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            _cancelled = true;
            reject(new Error('Aborted'));
          });
        }
      });

      if (_cancelled) {
        return {
          plan_id: plan.plan_id,
          runner_id: `${this.type}:${id}`,
          runner_version: version,
          status: 'cancelled',
          started_at: new Date(startTime).toISOString(),
          completed_at: new Date().toISOString(),
          duration_ms: Date.now() - startTime,
          model: 'mock',
          result: null,
          cost: { tokens_used: 0, model_calls: 0 },
          errors: [],
          warnings: ['Execution cancelled'],
          attempts: [{ attempt: 1, status: 'cancelled' }],
        };
      }

      const task = plan?.task?.summary || '';
      const assetId = plan?.asset_ref?.asset_id || 'unknown';

      return {
        plan_id: plan.plan_id,
        runner_id: `${this.type}:${id}`,
        runner_version: version,
        status: 'completed',
        started_at: new Date(startTime).toISOString(),
        completed_at: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
        model: 'mock',
        result: {
          shape: plan?.expected_outcome?.result_shape || 'answer-pattern',
          answer: `Mock judgment for "${task}" using ${assetId}`,
          reasoning: [
            `[mock] Task analysis: ${task}`,
            '[mock] Deterministic mock — no real model call',
          ],
          confidence: 'medium',
          sources: [],
          alternatives: [
            {
              option: 'Alternative path',
              rejected_because: 'Mock runner does not evaluate alternatives',
            },
          ],
        },
        cost: { tokens_used: 0, model_calls: 0 },
        errors: [],
        warnings: ['Mock runner — deterministic output, not real judgment'],
        attempts: [{ attempt: 1, status: 'completed' }],
        assets_loaded: [],
        digest_verified: false,
      };
    },
    async healthCheck() {
      return true;
    },
    async cancel() {
      _cancelled = true;
    },
  };
}

/**
 * Create a CLI runner that loads Runtime Capsules for handoff to an Agent host.
 * It deliberately does not claim task completion because it does not invoke a
 * model or otherwise consume the Capsule to produce judgment.
 *
 * @param {object} opts
 * @returns {Runner}
 */
function createCliRunner(opts = {}) {
  const id = opts.id || 'cli-runner';
  const version = opts.version || '0.1.0';
  let _cancelled = false;

  return {
    type: 'cli',
    id,
    version,
    async execute(plan, context = {}) {
      const startTime = Date.now();
      _cancelled = false;

      const signal = context.signal;
      if (signal) {
        signal.addEventListener('abort', () => {
          _cancelled = true;
        });
      }

      // Load the selected asset(s) through kdna-core. A Cluster load is a
      // collection of independent observed asset loads, not a plan-derived
      // claim.
      try {
        const core = require('@aikdna/kdna-core');
        const fs = require('node:fs');
        const path = require('node:path');
        const { resolveAsset } = require('./package-store');

        const refs =
          plan?.mode === 'cluster'
            ? [
                ...(plan.selection?.primary
                  ? [{ ...plan.selection.primary, role: 'primary' }]
                  : []),
                ...(plan.selection?.advisors || []).map((ref) => ({ ...ref, role: 'advisor' })),
              ]
            : [
                {
                  ...(plan.asset_ref || {}),
                  asset_id: context.assetTarget || plan?.asset_ref?.asset_id,
                  role: 'primary',
                },
              ];

        if (refs.length === 0 || !refs[0].asset_id) {
          return buildErrorResult(
            plan,
            id,
            version,
            startTime,
            'No selected asset reference in plan',
          );
        }

        const observations = [];
        const capsules = [];
        let projectionChars = 0;
        let estimatedProjectionTokens = 0;
        const warnings = [...(plan.warnings || [])];
        for (const ref of refs) {
          const protocolName = String(ref.asset_id || '').match(/^kdna:([^:]+):(.+)$/);
          const packageName = protocolName
            ? `@${protocolName[1]}/${protocolName[2]}`
            : ref.asset_id;
          let resolved = resolveAsset(packageName);
          if (!resolved?.asset_path) {
            const expanded = String(packageName).replace(/^~/, process.env.HOME || '');
            const localPath = path.resolve(expanded);
            if (fs.existsSync(localPath)) {
              resolved = {
                asset_path: localPath,
                version: ref.version || null,
                asset_digest: null,
              };
            }
          }
          if (!resolved?.asset_path) {
            if (
              plan?.mode === 'cluster' &&
              ref.role === 'advisor' &&
              ref.required !== true &&
              plan.degradation_policy?.optional_advisor_unavailable === 'continue_with_warning'
            ) {
              warnings.push(
                `Optional advisor "${ref.asset_id}" is unavailable; continuing with the verified primary.`,
              );
              continue;
            }
            return buildErrorResult(
              plan,
              id,
              version,
              startTime,
              `Asset "${ref.asset_id}" could not be resolved from the package store or local path.`,
            );
          }

          const loadPlan = core.planLoad(resolved.asset_path);
          if (loadPlan?.can_load_now !== true || loadPlan?.checks?.overall_valid !== true) {
            if (
              plan?.mode === 'cluster' &&
              ref.role === 'advisor' &&
              ref.required !== true &&
              plan.degradation_policy?.optional_advisor_unavailable === 'continue_with_warning'
            ) {
              warnings.push(
                `Optional advisor "${ref.asset_id}" is not loadable (${loadPlan?.state || 'unknown'}); continuing with the verified primary.`,
              );
              continue;
            }
            return buildErrorResult(
              plan,
              id,
              version,
              startTime,
              `Asset "${ref.asset_id}" failed Core LoadPlan verification (${loadPlan?.state || 'unknown'}).`,
            );
          }

          const inspected = core.inspect(resolved.asset_path);
          const artifactDigest =
            'sha256:' +
            crypto.createHash('sha256').update(fs.readFileSync(resolved.asset_path)).digest('hex');
          const declaredDigestMatches = !ref.digest || ref.digest === artifactDigest;
          if (!declaredDigestMatches) {
            if (
              plan?.mode === 'cluster' &&
              ref.role === 'advisor' &&
              ref.required !== true &&
              plan.degradation_policy?.optional_advisor_unavailable === 'continue_with_warning'
            ) {
              warnings.push(
                `Optional advisor "${ref.asset_id}" does not match its declared digest; continuing with the verified primary.`,
              );
              continue;
            }
            return buildErrorResult(
              plan,
              id,
              version,
              startTime,
              `Asset "${ref.asset_id}" does not match the digest declared by the Cluster manifest.`,
            );
          }
          const requestedProfile = ['index', 'compact', 'scenario', 'full'].includes(
            plan?.projection_ref?.shape,
          )
            ? plan.projection_ref.shape
            : 'compact';
          const capsule = core.load(resolved.asset_path, {
            profile: requestedProfile,
            as: 'json',
          });
          if (capsule?.type !== 'kdna.context.capsule') {
            return buildErrorResult(
              plan,
              id,
              version,
              startTime,
              `Asset "${ref.asset_id}" did not produce a Runtime Capsule.`,
            );
          }
          const capsuleJson = JSON.stringify(capsule);
          const capsuleChars = capsuleJson.length;
          const capsuleTokenEstimate = Math.ceil(capsuleChars / 4);
          projectionChars += capsuleChars;
          estimatedProjectionTokens += capsuleTokenEstimate;
          capsules.push({
            asset_id: ref.asset_id,
            role: ref.role || 'advisor',
            capsule,
          });
          observations.push({
            asset_id: ref.asset_id,
            version: inspected?.version || resolved.version || ref.version || null,
            digest: artifactDigest,
            role: ref.role || 'advisor',
            digest_verified:
              loadPlan.checks?.checksums_valid === true && declaredDigestMatches === true,
            authorization: loadPlan.access || inspected?.access || 'public',
            contribution_hypothesis: ref.contribution_hypothesis,
            contribution_fulfilled: false,
            projection_profile: capsule.profile,
            projection_chars: capsuleChars,
            estimated_projection_tokens: capsuleTokenEstimate,
            capsule_digest:
              'sha256:' + crypto.createHash('sha256').update(capsuleJson).digest('hex'),
          });
        }

        if (_cancelled) {
          return buildCancelledResult(plan, id, version, startTime);
        }

        const primary = observations.find((item) => item.role === 'primary') || observations[0];

        return {
          plan_id: plan.plan_id,
          runner_id: `${this.type}:${id}`,
          runner_version: version,
          status: 'partial',
          started_at: new Date(startTime).toISOString(),
          completed_at: new Date().toISOString(),
          duration_ms: Date.now() - startTime,
          model: 'none',
          result: {
            shape: 'kdna-capsule-bundle',
            capsules,
            task_result: null,
            sources: observations.map((item) => ({ asset_id: item.asset_id, inspection: true })),
          },
          cost: {
            tokens_used: 0,
            model_calls: 0,
            chars_consumed: 0,
            projection_chars: projectionChars,
            estimated_projection_tokens: estimatedProjectionTokens,
          },
          errors: [],
          warnings: [
            'Runtime Capsules were loaded by KDNA Core, but no Agent or model consumed them; no task judgment was produced.',
            ...warnings,
          ],
          attempts: [{ attempt: 1, status: 'partial' }],
          assets_loaded: observations,
          digest: primary.digest,
          digest_verified: primary.digest_verified === true,
        };
      } catch (e) {
        return buildErrorResult(plan, id, version, startTime, e.message);
      }
    },
    async healthCheck() {
      try {
        require('@aikdna/kdna-core');
        return true;
      } catch (_) {
        return false;
      }
    },
    async cancel() {
      _cancelled = true;
    },
  };
}

// ── Result Builders ──────────────────────────────────────────────────

function buildErrorResult(plan, id, version, startTime, errorMessage) {
  return {
    plan_id: plan?.plan_id || 'unknown',
    runner_id: `cli:${id}`,
    runner_version: version,
    status: 'runner_error',
    started_at: new Date(startTime).toISOString(),
    completed_at: new Date().toISOString(),
    duration_ms: Date.now() - startTime,
    model: null,
    result: null,
    cost: { tokens_used: 0, model_calls: 0 },
    errors: [errorMessage],
    warnings: [],
    attempts: [{ attempt: 1, status: 'error', error: errorMessage }],
    assets_loaded: [],
    digest_verified: false,
  };
}

function buildCancelledResult(plan, id, version, startTime) {
  return {
    plan_id: plan?.plan_id || 'unknown',
    runner_id: `runner:${id}`,
    runner_version: version,
    status: 'cancelled',
    started_at: new Date(startTime).toISOString(),
    completed_at: new Date().toISOString(),
    duration_ms: Date.now() - startTime,
    model: null,
    result: null,
    cost: { tokens_used: 0, model_calls: 0 },
    errors: [],
    warnings: ['Execution cancelled by user'],
    attempts: [{ attempt: 1, status: 'cancelled' }],
    assets_loaded: [],
    digest_verified: false,
  };
}

// ── Execution Engine ─────────────────────────────────────────────────

/**
 * Execute a ConsumptionPlan through a registered runner.
 *
 * @param {object} plan — ConsumptionPlan
 * @param {string} runnerType — type:id string or registered key
 * @param {object} [context] — RunnerContext
 * @returns {Promise<object>} RunnerResult
 */
async function executePlan(plan, runnerType, context = {}) {
  // Parse runner spec: "type:id" or just "id" (defaults to type=mock)
  let type, id;
  if (runnerType.includes(':')) {
    [type, id] = runnerType.split(':');
  } else {
    type = 'mock';
    id = runnerType;
  }

  let runner;
  try {
    runner = getRunner(type, id);
  } catch (_) {
    // Auto-create mock runner for unknown ids (test-friendly)
    if (type === 'mock') {
      runner = createMockRunner({ id });
      registerRunner('mock', id, runner);
    } else {
      throw new Error(
        `Runner not found: ${type}:${id}. Register a runner or use "mock:<name>" for testing.`,
      );
    }
  }

  const signal =
    context.signal || (context.timeoutMs ? AbortSignal.timeout(context.timeoutMs) : null);
  const ctx = { ...context, signal };

  return runner.execute(plan, ctx);
}

/**
 * Build a JudgmentTrace from a plan + runner result.
 *
 * @param {object} plan — ConsumptionPlan
 * @param {object} result — RunnerResult
 * @returns {object} trace (conforms to judgment-trace-candidate-0.9 schema)
 */
function buildTraceFromResult(plan, result) {
  // ── Trust facts: digest_verified requires actual Core verification.
  //     The runner does not perform content verification; set false unless
  //     the runner result explicitly reports a verified observation.
  const digest = result.digest || plan.asset_ref?.digest || null;
  // Only accept verification from an observed result, never from format
  const digestVerified = result.digest_verified === true;
  // If the runner could not load the asset, the trace must reflect that
  const assetNotLoaded =
    result.status === 'runner_error' ||
    (result.warnings || []).some(
      (w) =>
        w.includes('not loaded') || w.includes('not locally available') || w.includes('not found'),
    );

  const trace = {
    trace_version: '0.9.0',
    trace_id: 'trace_' + crypto.randomBytes(8).toString('hex'),
    plan_id: plan.plan_id,
    mode: plan.mode || 'single',
    timestamp: new Date().toISOString(),
    asset_identity:
      plan.mode === 'single'
        ? {
            asset_id: plan.asset_ref.asset_id,
            version: plan.asset_ref.version,
            digest: digest || null,
            digest_verified: digestVerified,
            signature_verified: null,
            revocation_status: null,
            authorization:
              plan.asset_ref.access === 'public'
                ? 'public — no authorization required'
                : `${plan.asset_ref.access} — authorization required`,
            projection_digest: plan.projection_ref?.content_digest || null,
          }
        : undefined,
    applicability_actual: {
      decision: plan.applicability.decision,
      confidence: plan.applicability.confidence,
      boundary_respected: true,
      deviated_from_plan: false,
    },
    projection_actual: {
      shape: plan.projection_ref?.shape || 'compact',
      content_digest: plan.projection_ref?.content_digest || null,
      shape_deviated_from_plan: false,
    },
    execution: {
      status: result.status,
      runner_id: result.runner_id,
      runner_version: result.runner_version,
      model: result.model,
      started_at: result.started_at,
      completed_at: result.completed_at,
      duration_ms: result.duration_ms,
      attempts: result.attempts?.length || 1,
    },
    result_ref: result.result
      ? {
          result_hash:
            'sha256:' +
            crypto.createHash('sha256').update(JSON.stringify(result.result)).digest('hex'),
          result_shape: result.result.shape || 'answer-pattern',
          answer_summary: (result.result.answer || '').slice(0, 200),
          result_stored: result.status === 'completed',
        }
      : undefined,
    cost: {
      tokens_used: result.cost?.tokens_used || 0,
      chars_consumed: result.cost?.chars_consumed || 0,
      projection_chars: result.cost?.projection_chars || 0,
      estimated_projection_tokens: result.cost?.estimated_projection_tokens || 0,
      assets_loaded: Array.isArray(result.assets_loaded)
        ? result.assets_loaded.length
        : result.status === 'completed' || result.status === 'partial'
          ? 1
          : 0,
      model_calls: result.cost?.model_calls || 0,
      budget_profile: plan.budget?.profile || 'code-review',
      over_budget:
        (result.cost?.tokens_used || 0) > (plan.budget?.max_tokens || Infinity) ||
        (result.cost?.projection_chars || 0) > (plan.budget?.max_chars || Infinity),
    },
    evaluation: {
      self_checks: [],
      violations: [],
      banned_terms_detected: [],
    },
    provenance: {
      plan_digest: plan.metadata?.plan_digest || null,
      policy_hash: null,
      consumer_index_version: null,
    },
    errors: [
      ...(result.errors || []),
      ...(assetNotLoaded
        ? ['Asset was not successfully loaded — trace reflects inspection-only state']
        : []),
    ],
    warnings: [
      ...(result.warnings || []),
      ...(!digestVerified && plan.mode === 'single'
        ? ['Asset digest not verified — content may differ from expected']
        : []),
    ],
    metadata: {
      environment: 'development',
      trace_schema: '0.9.0',
    },
  };

  return trace;
}

module.exports = {
  registerRunner,
  getRunner,
  listRunners,
  createMockRunner,
  createCliRunner,
  executePlan,
  buildTraceFromResult,
};
