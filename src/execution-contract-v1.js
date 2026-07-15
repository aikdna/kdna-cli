'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const packageStore = require('./package-store');
const { createProcessAgentHostV2 } = require('./agent-host-process-v2');

const CORE_CAPSULE_VERSIONS = Object.freeze(['2.0', '1.0']);
const MAX_ASSET_BYTES = 256 * 1024 * 1024;
const BUDGETS = Object.freeze({
  interactive: Object.freeze({
    max_projection_chars: 2500,
    max_task_chars: 1000,
    deadline_ms: 30000,
    max_tokens: 800,
    max_model_calls: null,
  }),
  'code-review': Object.freeze({
    max_projection_chars: 3500,
    max_task_chars: 1000,
    deadline_ms: 30000,
    max_tokens: 1200,
    max_model_calls: null,
  }),
  'offline-audit': Object.freeze({
    max_projection_chars: 12000,
    max_task_chars: 1000,
    deadline_ms: 120000,
    max_tokens: null,
    max_model_calls: null,
  }),
});

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function snapshotAssetFile(assetPath) {
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  let descriptor;
  try {
    const pathStat = fs.lstatSync(assetPath);
    if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
      throw new Error('Runtime contract 1 requires a regular non-symlink packaged .kdna file.');
    }
    descriptor = fs.openSync(assetPath, fs.constants.O_RDONLY | noFollow);
    const before = fs.fstatSync(descriptor);
    if (!before.isFile())
      throw new Error('Runtime contract 1 requires a regular packaged .kdna file.');
    if (
      (pathStat.dev !== undefined && pathStat.dev !== before.dev) ||
      (pathStat.ino !== undefined && pathStat.ino !== before.ino)
    ) {
      throw new Error('Packaged asset changed before it was opened.');
    }
    if (before.size <= 0 || before.size > MAX_ASSET_BYTES) {
      throw new Error(`Packaged asset must be between 1 and ${MAX_ASSET_BYTES} bytes.`);
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (
      bytes.length !== before.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error('Packaged asset changed while it was read.');
    }
    return bytes;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function resolvePackagedSnapshot(target) {
  const expanded = String(target).replace(/^~/, process.env.HOME || '');
  const looksLocal =
    expanded.startsWith('.') ||
    expanded.startsWith('/') ||
    expanded.endsWith('.kdna') ||
    fs.existsSync(expanded);

  if (looksLocal) {
    const absolute = path.resolve(expanded);
    let stat;
    try {
      stat = fs.lstatSync(absolute);
    } catch {
      throw new Error('Packaged .kdna asset was not found.');
    }
    if (stat.isSymbolicLink() || !stat.isFile() || !absolute.endsWith('.kdna')) {
      throw new Error('Runtime contract 1 accepts only a regular packaged .kdna file.');
    }
    return {
      bytes: snapshotAssetFile(absolute),
      expectedAsset: null,
      expectedContent: null,
      installed: false,
    };
  }

  const installed = packageStore.getInstalled(target);
  if (!installed?.asset_path) throw new Error('Installed packaged asset was not found.');
  const integrity = packageStore.assertInstalledIntegrity(installed, target);
  return {
    bytes: snapshotAssetFile(installed.asset_path),
    expectedAsset: {
      value: integrity.actual_asset_digest,
      source: 'install_receipt',
    },
    expectedContent: {
      value: integrity.actual_content_digest,
      source: 'install_receipt',
    },
    installed: true,
  };
}

function expectedDigestFromEvidence(item) {
  const comparison = item.comparison;
  if (comparison.state === 'matched') {
    return {
      value: item.value,
      basis: item.basis,
      source: comparison.source,
      comparison: 'matched',
    };
  }
  return {
    value: item.value,
    basis: item.basis,
    source: 'caller',
    comparison: 'not_compared',
  };
}

function canonicalAccess(value) {
  return { open: 'public', protected: 'licensed', runtime: 'remote' }[value] || value || 'public';
}

function prepareExecutionContractV1(target, options = {}) {
  const core = options.core || require('@aikdna/kdna-core');
  const task = options.task;
  const profile = options.profile || 'compact';
  const budgetProfile = options.budgetProfile || 'code-review';
  if (typeof task !== 'string' || task.length === 0 || task.length > 500) {
    throw new Error('Runtime contract 1 requires a task between 1 and 500 characters.');
  }
  if (!['index', 'compact', 'scenario', 'full'].includes(profile)) {
    throw new Error('Runtime contract 1 projection must be index, compact, scenario, or full.');
  }
  if (!Object.hasOwn(BUDGETS, budgetProfile)) {
    throw new Error('Unknown runtime contract 1 budget profile.');
  }

  const snapshot = resolvePackagedSnapshot(target);
  const expectedDigests = {};
  if (snapshot.expectedAsset) expectedDigests.asset = snapshot.expectedAsset;
  if (snapshot.expectedContent) expectedDigests.content = snapshot.expectedContent;
  const evidence = core.computeDigestEvidence(snapshot.bytes, { expectedDigests });
  const manifest = core.inspect(snapshot.bytes);
  if (!manifest || typeof manifest !== 'object') throw new Error('Packaged asset has no manifest.');

  const createdAt = options.createdAt || new Date().toISOString();
  const planId =
    options.planId ||
    `plan_${sha256(Buffer.concat([snapshot.bytes, Buffer.from(`\0${task}`, 'utf8')])).slice(7, 23)}`;
  const plan = core.buildConsumptionPlanV1({
    plan_id: planId,
    created_at: createdAt,
    task: {
      summary: task,
      task_family: options.taskFamily || null,
      context: options.taskContext || {},
    },
    asset_ref: {
      asset_id: manifest.asset_id,
      asset_uid: manifest.asset_uid,
      version: manifest.version,
      judgment_version: manifest.judgment_version,
      access: canonicalAccess(manifest.access),
      expected_digests: {
        asset: expectedDigestFromEvidence(evidence.asset),
        content: expectedDigestFromEvidence(evidence.content),
        runtime_entry_set: expectedDigestFromEvidence(evidence.runtime_entry_set),
      },
    },
    projection_profile: profile,
    budget: globalThis.structuredClone(BUDGETS[budgetProfile]),
    constraints: { enforce_before_host: true, reject_on_exceed: true },
    trace_policy: { emit: true, storage: 'session' },
  });

  return {
    core,
    plan,
    trustedPlanDigest: plan.integrity.plan_digest,
    bytes: snapshot.bytes,
    capsuleExpectedDigests: expectedDigests,
    createdAt,
  };
}

function issue(code, message, phase) {
  return { code, message, phase };
}

function makeTraceId() {
  return `trace_${crypto.randomBytes(8).toString('hex')}`;
}

function makeRequestId() {
  return `host_${crypto.randomBytes(12).toString('hex')}`;
}

function traceContext(prepared, capabilities, request, receipt, trustedDeliveryObservation) {
  return {
    plan: prepared.plan,
    trustedPlanDigest: prepared.trustedPlanDigest,
    capabilities,
    coreCapsuleVersions: CORE_CAPSULE_VERSIONS,
    request,
    receipt,
    trustedDeliveryObservation,
  };
}

function buildBlockedBeforeProjection(prepared, capabilities, negotiation) {
  return prepared.core.buildJudgmentTraceV1(
    {
      trace_id: makeTraceId(),
      timestamp: new Date().toISOString(),
      overall_status: 'blocked',
      errors: [
        issue(
          negotiation.issue_code,
          'No registered Capsule 2 / Agent Host 2 capability pair was selected.',
          'negotiation',
        ),
      ],
    },
    traceContext(prepared, capabilities, null, null, 'not_delivered'),
  );
}

function terminalFromReceipt(receipt) {
  if (receipt.runtime_receipt.capsule_delivery_comparison === 'mismatched') return 'blocked';
  return {
    completed: 'execution_completed',
    failed: 'execution_failed',
    cancelled: 'cancelled',
    timed_out: 'timed_out',
  }[receipt.runtime_receipt.provider_execution_status];
}

async function executePreparedContractV1(prepared, options) {
  const { core, plan } = prepared;
  const capabilities = globalThis.structuredClone(options.capabilities);
  const baseContext = {
    plan,
    trustedPlanDigest: prepared.trustedPlanDigest,
    capabilities,
    coreCapsuleVersions: CORE_CAPSULE_VERSIONS,
  };
  const negotiation = core.negotiateExecutionPairV1(plan, baseContext);
  if (
    ['SCHEMA_INVALID', 'KDNA_INPUT_INVALID', 'KDNA_VALIDATION_CONTEXT_INVALID'].includes(
      negotiation.issue_code,
    )
  ) {
    throw new Error(
      `Agent Host capability descriptor failed Core validation (${negotiation.issue_code}).`,
    );
  }
  if (negotiation.state !== 'selected') {
    return {
      plan,
      receipt: null,
      trace: buildBlockedBeforeProjection(prepared, capabilities, negotiation),
    };
  }

  const capsule = core.loadCapsuleV2(prepared.bytes, {
    profile: plan.projection_request.profile,
    expectedDigests: prepared.capsuleExpectedDigests,
    loadedAt: prepared.createdAt,
  });
  let request;
  try {
    request = core.buildAgentHost2RequestV1({ request_id: makeRequestId(), capsule }, baseContext);
  } catch (error) {
    if (error.code !== 'KDNA_HOST_BUDGET_LIMIT_EXCEEDED') throw error;
    const trace = core.buildPreHostBudgetBlockedTraceV1(
      {
        trace_id: makeTraceId(),
        timestamp: new Date().toISOString(),
        capsule,
      },
      baseContext,
    );
    return { plan, receipt: null, trace };
  }

  const host = (options.createHost || createProcessAgentHostV2)({
    command: options.command,
    args: options.args,
    timeoutMs: options.timeoutMs,
    core,
    validationContext: baseContext,
  });
  let receipt;
  try {
    receipt = await host.run(request);
  } catch (error) {
    const observation =
      error.deliveryObservation === 'not_observed' ? 'not_observed' : 'not_delivered';
    const trace = core.buildJudgmentTraceV1(
      {
        trace_id: makeTraceId(),
        timestamp: new Date().toISOString(),
        overall_status: 'blocked',
        errors: [issue(error.code || 'KDNA_HOST_UNAVAILABLE', error.message, 'delivery')],
      },
      traceContext(prepared, capabilities, request, null, observation),
    );
    return { plan, receipt: null, trace };
  }

  const overallStatus = terminalFromReceipt(receipt);
  if (!overallStatus) throw new Error('Agent Host 2 returned an unsupported terminal state.');
  const errors =
    overallStatus === 'execution_completed'
      ? []
      : [
          issue(
            overallStatus === 'blocked'
              ? 'KDNA_HOST_CAPSULE_DELIVERY_REJECTED'
              : `KDNA_HOST_${overallStatus.toUpperCase()}`,
            'Agent Host 2 reported a non-success terminal state.',
            overallStatus === 'blocked' ? 'delivery' : 'execution',
          ),
        ];
  const trace = core.buildJudgmentTraceV1(
    {
      trace_id: makeTraceId(),
      timestamp: new Date().toISOString(),
      overall_status: overallStatus,
      errors,
    },
    traceContext(prepared, capabilities, request, receipt, 'host_receipt'),
  );
  return { plan, receipt, trace };
}

module.exports = {
  BUDGETS,
  CORE_CAPSULE_VERSIONS,
  executePreparedContractV1,
  prepareExecutionContractV1,
  resolvePackagedSnapshot,
};
