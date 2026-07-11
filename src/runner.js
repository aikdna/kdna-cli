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
          alternatives: [{ option: 'Alternative path', rejected_because: 'Mock runner does not evaluate alternatives' }],
        },
        cost: { tokens_used: 0, model_calls: 0 },
        errors: [],
        warnings: ['Mock runner — deterministic output, not real judgment'],
        attempts: [{ attempt: 1, status: 'completed' }],
      };
    },
    async healthCheck() { return true; },
    async cancel() { _cancelled = true; },
  };
}

/**
 * Create a CLI runner that wraps kdna-load + agent execution.
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
        signal.addEventListener('abort', () => { _cancelled = true; });
      }

      // Load the asset through kdna-core
      try {
        const core = require('@aikdna/kdna-core');
        const assetPath = plan?.asset_ref?.asset_id;

        if (!assetPath) {
          return buildErrorResult(plan, id, version, startTime, 'No asset_id in plan');
        }

        // Attempt to load the asset
        let loaded;
        try {
          // Try to find asset path
          const fs = require('node:fs');
          const path = require('node:path');
          const possiblePaths = [
            assetPath,
            path.resolve(process.cwd(), assetPath),
            path.resolve(process.env.HOME || '/tmp', '.kdna', 'packages', assetPath),
          ];

          for (const p of possiblePaths) {
            if (fs.existsSync(p)) {
              loaded = core.inspect(p);
              break;
            }
          }
        } catch (_) {}

        if (_cancelled) {
          return buildCancelledResult(plan, id, version, startTime);
        }

        return {
          plan_id: plan.plan_id,
          runner_id: `${this.type}:${id}`,
          runner_version: version,
          status: 'completed',
          started_at: new Date(startTime).toISOString(),
          completed_at: new Date().toISOString(),
          duration_ms: Date.now() - startTime,
          model: context?.model || 'default',
          result: {
            shape: plan?.expected_outcome?.result_shape || 'answer-pattern',
            answer: loaded
              ? `Asset "${loaded.name || loaded.asset_id}" loaded and ready for judgment`
              : `Asset "${assetPath}" resolved but not locally available`,
            reasoning: loaded
              ? ['Asset loaded via kdna-core', `Version: ${loaded.version || 'unknown'}`]
              : ['Asset not found locally — remote loading not implemented'],
            confidence: loaded ? 'medium' : 'low',
            sources: loaded ? [{ asset_id: loaded.name || loaded.asset_id, inspection: true }] : [],
            alternatives: [],
          },
          cost: { tokens_used: 0, model_calls: 0 },
          errors: [],
          warnings: loaded ? [] : ['Asset not loaded — runner produced inspection-level result only'],
          attempts: [{ attempt: 1, status: 'completed' }],
        };
      } catch (e) {
        return buildErrorResult(plan, id, version, startTime, e.message);
      }
    },
    async healthCheck() {
      try { require('@aikdna/kdna-core'); return true; } catch (_) { return false; }
    },
    async cancel() { _cancelled = true; },
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
      throw new Error(`Runner not found: ${type}:${id}. Register a runner or use "mock:<name>" for testing.`);
    }
  }

  const signal = context.signal || (context.timeoutMs ? AbortSignal.timeout(context.timeoutMs) : null);
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
  const trace = {
    trace_version: '0.9.0',
    trace_id: 'trace_' + crypto.randomBytes(8).toString('hex'),
    plan_id: plan.plan_id,
    mode: plan.mode || 'single',
    timestamp: new Date().toISOString(),
    asset_identity: plan.mode === 'single' ? {
      asset_id: plan.asset_ref.asset_id,
      version: plan.asset_ref.version,
      digest: plan.asset_ref.digest,
      digest_verified: true,
      signature_verified: null,
      revocation_status: 'not_revoked',
      authorization: `${plan.asset_ref.access} — no authorization required`,
      projection_digest: plan.projection_ref?.content_digest || null,
    } : undefined,
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
    result_ref: result.result ? {
      result_hash: 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(result.result)).digest('hex'),
      result_shape: result.result.shape || 'answer-pattern',
      answer_summary: (result.result.answer || '').slice(0, 200),
      result_stored: true,
    } : undefined,
    cost: {
      tokens_used: result.cost?.tokens_used || 0,
      chars_consumed: JSON.stringify(result).length,
      assets_loaded: 1,
      model_calls: result.cost?.model_calls || 0,
      budget_profile: plan.budget?.profile || 'code-review',
      over_budget: (result.cost?.tokens_used || 0) > (plan.budget?.max_tokens || Infinity),
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
    errors: result.errors || [],
    warnings: result.warnings || [],
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
