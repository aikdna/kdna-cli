/**
 * kdna use — Run a KDNA asset/Cluster through a registered Runner.
 *
 * This is the "what actually happens" path. It:
 *   1. Generates a ConsumptionPlan via plan-use (deterministic)
 *   2. Validates the plan against the budget
 *   3. Selects and validates a registered Runner
 *   4. Executes through the runner
 *   5. Emits a JudgmentTrace
 *
 * Single-asset mode only. No Router. No Cluster (unless explicitly provided).
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { error, EXIT, readJson } = require('./_common');
const { planSingleAsset } = require('./plan-use');
const { createProcessAgentHost } = require('../agent-host-process');
const {
  executePlan,
  buildTraceFromResult,
  listRunners,
  registerRunner,
  createMockRunner,
  createCliRunner,
} = require('../runner');

// ── Auto-register built-in runners ──────────────────────────────────

try {
  registerRunner('mock', 'default', createMockRunner({ id: 'default' }));
} catch (_) {}
try {
  registerRunner('cli', 'default', createCliRunner({ id: 'default' }));
} catch (_) {}

function cmdUse(args) {
  const getFlag = (name) => {
    const eqIdx = args.findIndex((a) => a === name + '=' || a.startsWith(name + '='));
    if (eqIdx >= 0) {
      const parts = args[eqIdx].split('=');
      return parts.slice(1).join('=') || null;
    }
    const idx = args.indexOf(name);
    return idx >= 0 && args[idx + 1] && !args[idx + 1].startsWith('--') ? args[idx + 1] : null;
  };
  const getFlags = (name) => {
    const values = [];
    for (let index = 0; index < args.length; index += 1) {
      const value = args[index];
      if (value.startsWith(`${name}=`)) {
        values.push(value.slice(name.length + 1));
      } else if (value === name && args[index + 1] !== undefined) {
        values.push(args[index + 1]);
        index += 1;
      }
    }
    return values;
  };

  const posArgs = args.filter((a) => !a.startsWith('--'));
  const target = posArgs[0];

  // --list-runners doesn't require a target
  if (args.includes('--list-runners')) {
    const runners = listRunners();
    console.log(`Registered runners (${runners.length}):`);
    for (const r of runners) console.log(`  - ${r}`);
    return;
  }

  if (!target || args.includes('--help') || args.includes('-h')) {
    process.stderr.write(
      'Usage: kdna use <name[@version]|asset.kdna> [options]\n\n' +
        'Run a KDNA asset through a registered Runner.\n\n' +
        'Options:\n' +
        '  --task=<text>           Task description\n' +
        '  --task-family=<name>    Task family (default: general)\n' +
        '  --runner=<type:id>      Runner to use (default: mock:default)\n' +
        '  --agent-host=<command>  Invoke a JSON process host with cli:default\n' +
        '  --agent-host-arg=<arg>  Add one exact process argument (repeatable)\n' +
        '  --budget=<profile>      interactive|code-review|offline-audit\n' +
        '  --shape=<name>          answer-pattern|compact|scenario|full\n' +
        '  --timeout=<ms>          Execution timeout in ms (default: 30000)\n' +
        '  --as=<format>           json|trace|prompt (default: json)\n' +
        '  --out=<path>            Write output to file\n' +
        '  --list-runners          List registered runners\n' +
        '  --plan-only             Generate plan only (alias for plan-use)\n' +
        "  --dry-run               Plan and validate runner, but don't execute\n" +
        '\n' +
        'Examples:\n' +
        '  kdna use asset.kdna --task "Should we deploy?" --runner mock:default\n' +
        '  kdna use asset.kdna --task "Review this" --runner cli:default --agent-host ./host\n' +
        '  kdna use asset.kdna --task "Review this PR" --as trace\n' +
        '  kdna use asset.kdna --list-runners\n',
    );
    if (args.includes('--help') || args.includes('-h')) process.exit(0);
    process.exit(EXIT.INPUT_ERROR);
  }

  const task = getFlag('--task') || '';
  const taskFamily = getFlag('--task-family') || 'general';
  const runnerSpec = getFlag('--runner') || 'mock:default';
  const agentHostCommand = getFlag('--agent-host');
  const agentHostArgs = getFlags('--agent-host-arg');
  const budgetProfile = getFlag('--budget') || 'code-review';
  const shape = getFlag('--shape') || 'compact';
  const timeoutMs = parseInt(getFlag('--timeout') || '30000', 10);
  const as = getFlag('--as') || 'json';
  const outPath = getFlag('--out');
  const planOnly = args.includes('--plan-only');
  const dryRun = args.includes('--dry-run');

  if (agentHostArgs.length > 0 && !agentHostCommand) {
    error('--agent-host-arg requires --agent-host.', EXIT.INPUT_ERROR);
  }
  if (agentHostCommand && runnerSpec !== 'cli:default') {
    error('--agent-host requires --runner=cli:default.', EXIT.INPUT_ERROR);
  }
  let processAgentHost = null;
  if (agentHostCommand) {
    try {
      processAgentHost = createProcessAgentHost({
        command: agentHostCommand,
        args: agentHostArgs,
        timeoutMs,
      });
    } catch (hostError) {
      error(`Invalid Agent host configuration: ${hostError.message}`, EXIT.INPUT_ERROR);
    }
  }

  // Phase 1: Generate plan (deterministic)
  // Detect cluster manifest vs single asset
  const isClusterManifest =
    target.endsWith('.json') && !target.endsWith('kdna.json') && !target.endsWith('checksums.json');
  let plan;
  if (isClusterManifest) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.resolve(target), 'utf8'));
      if (manifest.format === 'kdna-cluster' || manifest.cluster_id) {
        const {
          generateClusterPlan,
          generateClusterTrace: genClusterTrace,
        } = require('../cluster-engine');
        plan = generateClusterPlan(manifest, task, { taskFamily, budgetProfile, shape });
        if (plan.load_plan_ref.status !== 'blocked') {
          const { preflightClusterPlan } = require('../cluster-preflight');
          plan = preflightClusterPlan(plan);
        }
        plan._cluster_manifest = manifest; // carry forward for trace
      } else {
        plan = planSingleAsset(target, { task, taskFamily, budgetProfile, shape });
      }
    } catch (_) {
      plan = planSingleAsset(target, { task, taskFamily, budgetProfile, shape });
    }
  } else {
    plan = planSingleAsset(target, { task, taskFamily, budgetProfile, shape });
  }

  if (processAgentHost && plan.mode !== 'single') {
    error(
      '--agent-host currently supports one packaged asset; staged Cluster execution remains disabled.',
      EXIT.INPUT_ERROR,
    );
  }

  if (planOnly) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  // Phase 2: Validate plan — fail closed on any blocked state
  if (plan.load_plan_ref.status === 'blocked') {
    const issues = plan.load_plan_ref.issues || [];
    if (plan.mode === 'cluster' && (as === 'trace' || as === 'json')) {
      const { generateClusterTrace } = require('../cluster-engine');
      const now = new Date().toISOString();
      const runnerResult = {
        status: 'blocked',
        runner_id: 'none',
        runner_version: '0.1.0',
        model: null,
        started_at: now,
        completed_at: now,
        duration_ms: 0,
        result: null,
        cost: { tokens_used: 0, model_calls: 0 },
        errors: issues.map((issue) => issue.code || issue.message || 'blocked'),
        warnings: plan.warnings || [],
        attempts: [],
        assets_loaded: [],
      };
      const trace = generateClusterTrace(plan, runnerResult);
      console.log(
        JSON.stringify(
          as === 'trace'
            ? trace
            : { plan_id: plan.plan_id, mode: 'cluster', status: 'blocked', result: null, trace },
          null,
          2,
        ),
      );
      return process.exit(EXIT.TRUST_FAILED);
    }
    // Blocked is blocked: if status is blocked, do not execute regardless of issue details
    error(
      `Cannot execute: LoadPlan is blocked.\n` +
        (issues.length > 0
          ? issues.map((i) => `  - ${i.message || i.code}`).join('\n')
          : '  - No loadable path for this asset.'),
      EXIT.TRUST_FAILED,
    );
  }

  // Applicability: must apply — ask, blocked, does_not_apply all stop execution
  const appDecision = plan.applicability?.decision;
  if (appDecision === 'does_not_apply') {
    error(
      `Cannot execute: Asset does not apply to this task.\n` +
        `  Reasons: ${(plan.applicability.boundary_check?.not_applicable_reasons || ['boundary mismatch']).join(', ')}`,
      EXIT.INPUT_ERROR,
    );
  }
  if (appDecision === 'blocked') {
    error(
      `Cannot execute: Asset is blocked for this task.\n` +
        `  LoadPlan status: ${plan.load_plan_ref.status}`,
      EXIT.TRUST_FAILED,
    );
  }
  if (appDecision === 'ask') {
    error(
      `Cannot execute: Applicability is uncertain ("ask"). Confirm with user before proceeding.\n` +
        `  Confidence: ${plan.applicability.confidence || 'low'}`,
      EXIT.INPUT_ERROR,
    );
  }

  if (dryRun) {
    const runners = listRunners();
    console.log(
      JSON.stringify(
        {
          plan,
          dry_run: true,
          runner_available: runners.includes(runnerSpec),
          registered_runners: runners,
        },
        null,
        2,
      ),
    );
    return;
  }

  // Phase 3: Run through the selected adapter. Only a Runner that actually
  // produces the requested task result may return completed.
  executePlan(plan, runnerSpec, {
    timeoutMs,
    model: process.env.KDNA_MODEL || 'default',
    task,
    taskFamily,
    assetTarget: target,
    runStage: processAgentHost ? (request) => processAgentHost.runStage(request) : undefined,
  })
    .then((runnerResult) => {
      // Phase 4: Build trace — use cluster trace if in cluster mode
      let trace;
      if (plan.mode === 'cluster') {
        try {
          const { generateClusterTrace } = require('../cluster-engine');
          trace = generateClusterTrace(plan, runnerResult);
        } catch (_) {
          trace = buildTraceFromResult(plan, runnerResult);
          trace.mode = 'cluster';
        }
      } else {
        trace = buildTraceFromResult(plan, runnerResult);
      }

      const exitCode =
        runnerResult.execution_status === 'completed' || runnerResult.status === 'completed'
          ? 0
          : EXIT.VALIDATION_FAILED;

      if (outPath) {
        const absOut = path.resolve(outPath);
        const dir = path.dirname(absOut);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const output = {
          plan,
          result: runnerResult,
          trace,
        };
        fs.writeFileSync(absOut, JSON.stringify(output, null, 2) + '\n');
      }

      if (as === 'trace') {
        console.log(JSON.stringify(trace, null, 2));
      } else if (as === 'json') {
        console.log(
          JSON.stringify(
            {
              plan_id: plan.plan_id,
              mode: plan.mode,
              runner: runnerResult.runner_id,
              status: runnerResult.status,
              result: runnerResult.result,
              trace: trace,
            },
            null,
            2,
          ),
        );
      } else if (as === 'prompt') {
        // Human-readable output
        console.log(`# kdna use — ${plan.plan_id}`);
        console.log(`Runner: ${runnerResult.runner_id}`);
        console.log(`Status: ${runnerResult.status}`);
        console.log(`Duration: ${runnerResult.duration_ms}ms`);
        console.log('');
        if (runnerResult.result?.answer) {
          console.log(`## Answer`);
          console.log(runnerResult.result.answer);
          console.log('');
        }
        if (runnerResult.result?.reasoning?.length) {
          console.log(`## Reasoning`);
          runnerResult.result.reasoning.forEach((r, i) => console.log(`${i + 1}. ${r}`));
          console.log('');
        }
        if (runnerResult.warnings?.length) {
          console.log(`## Warnings`);
          runnerResult.warnings.forEach((w) => console.log(`- ${w}`));
        }
        console.log(`\nTrace ID: ${trace.trace_id}`);
      }
      if (exitCode !== 0) process.exit(exitCode);
    })
    .catch((err) => {
      error(`Runner execution failed: ${err.message}`, EXIT.PROVIDER_ERROR);
    });
}

module.exports = { cmdUse };
