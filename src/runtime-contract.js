'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const packageStore = require('./package-store');
const { createProcessAgentHost } = require('./agent-host-process');

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

function snapshotCoreCapsuleVersions(core) {
  const versions = core.DEFAULT_CORE_CAPSULE_CONTRACT_VERSIONS;
  if (
    !Array.isArray(versions) ||
    versions.length === 0 ||
    versions.some((version) => typeof version !== 'string' || version.length === 0)
  ) {
    throw new Error('KDNA Core did not export valid default Capsule versions.');
  }
  return Object.freeze([...versions]);
}

function snapshotAssetFile(assetPath, fileSystem = fs) {
  const noFollow = fileSystem.constants.O_NOFOLLOW || 0;
  let descriptor;
  try {
    const pathStat = fileSystem.lstatSync(assetPath);
    if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
      throw new Error('Runtime contract requires a regular non-symlink packaged .kdna file.');
    }
    descriptor = fileSystem.openSync(assetPath, fileSystem.constants.O_RDONLY | noFollow);
    const before = fileSystem.fstatSync(descriptor);
    if (!before.isFile())
      throw new Error('Runtime contract requires a regular packaged .kdna file.');
    if (
      pathStat.dev === undefined ||
      pathStat.ino === undefined ||
      before.dev === undefined ||
      before.ino === undefined ||
      pathStat.dev !== before.dev ||
      pathStat.ino !== before.ino
    ) {
      throw new Error('Packaged asset changed before it was opened.');
    }
    if (before.size <= 0 || before.size > MAX_ASSET_BYTES) {
      throw new Error(`Packaged asset must be between 1 and ${MAX_ASSET_BYTES} bytes.`);
    }
    const bytes = fileSystem.readFileSync(descriptor);
    const after = fileSystem.fstatSync(descriptor);
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
    if (descriptor !== undefined) fileSystem.closeSync(descriptor);
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
      throw new Error('Runtime contract accepts only a regular packaged .kdna file.');
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

function prepareRuntimeContract(target, options = {}) {
  const core = options.core || require('@aikdna/kdna-core');
  const coreCapsuleVersions = snapshotCoreCapsuleVersions(core);
  const task = options.task;
  const profile = options.profile || 'compact';
  const budgetProfile = options.budgetProfile || 'code-review';
  if (typeof task !== 'string' || task.length === 0 || task.length > 500) {
    throw new Error('Runtime contract requires a task between 1 and 500 characters.');
  }
  if (!['index', 'compact', 'scenario', 'full'].includes(profile)) {
    throw new Error('Runtime contract projection must be index, compact, scenario, or full.');
  }
  if (!Object.hasOwn(BUDGETS, budgetProfile)) {
    throw new Error('Unknown runtime contract budget profile.');
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
  const plan = core.buildConsumptionPlan({
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
    coreCapsuleVersions,
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
    coreCapsuleVersions: prepared.coreCapsuleVersions,
    request,
    receipt,
    trustedDeliveryObservation,
  };
}

function buildBlockedBeforeProjection(prepared, capabilities, negotiation) {
  return prepared.core.buildJudgmentTrace(
    {
      trace_id: makeTraceId(),
      timestamp: new Date().toISOString(),
      overall_status: 'blocked',
      errors: [
        issue(
          negotiation.issue_code,
          'No registered Runtime Capsule / Agent Host capability pair was selected.',
          'negotiation',
        ),
      ],
    },
    traceContext(prepared, capabilities, null, null, 'not_delivered'),
  );
}

function buildBlockedWithoutRequest(prepared, capabilities, code, message, phase) {
  return prepared.core.buildJudgmentTrace(
    {
      trace_id: makeTraceId(),
      timestamp: new Date().toISOString(),
      overall_status: 'blocked',
      errors: [issue(code, message, phase)],
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

async function executePreparedRuntimeContract(prepared, options) {
  const { core, plan } = prepared;
  const capabilities = globalThis.structuredClone(options.capabilities);
  const baseContext = {
    plan,
    trustedPlanDigest: prepared.trustedPlanDigest,
    capabilities,
    coreCapsuleVersions: prepared.coreCapsuleVersions,
  };
  const negotiation = core.negotiateRuntimePair(plan, baseContext);
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

  let capsule;
  try {
    capsule = core.loadRuntimeCapsule(prepared.bytes, {
      profile: plan.projection_request.profile,
      expectedDigests: prepared.capsuleExpectedDigests,
      loadedAt: prepared.createdAt,
    });
  } catch (error) {
    const trace = buildBlockedWithoutRequest(
      prepared,
      capabilities,
      error.code || 'KDNA_RUNTIME_CAPSULE_LOAD_FAILED',
      'Packaged asset could not be projected as a Runtime Capsule.',
      'load',
    );
    return { plan, receipt: null, trace };
  }
  let request;
  try {
    request = core.buildAgentHostRequest({ request_id: makeRequestId(), capsule }, baseContext);
  } catch (error) {
    if (error.code !== 'KDNA_HOST_BUDGET_LIMIT_EXCEEDED') throw error;
    const trace = core.buildPreHostBudgetBlockedTrace(
      {
        trace_id: makeTraceId(),
        timestamp: new Date().toISOString(),
        capsule,
      },
      baseContext,
    );
    return { plan, receipt: null, trace };
  }

  let host;
  try {
    host = (options.createHost || createProcessAgentHost)({
      command: options.command,
      args: options.args,
      timeoutMs: options.timeoutMs,
      core,
      validationContext: baseContext,
    });
  } catch (error) {
    const trace = core.buildJudgmentTrace(
      {
        trace_id: makeTraceId(),
        timestamp: new Date().toISOString(),
        overall_status: 'blocked',
        errors: [
          issue(
            error.code || 'KDNA_HOST_CONFIGURATION_INVALID',
            'Agent Host adapter could not be constructed.',
            'host',
          ),
        ],
      },
      traceContext(prepared, capabilities, request, null, 'not_delivered'),
    );
    return { plan, receipt: null, trace };
  }
  let receipt;
  try {
    receipt = await host.run(request);
  } catch (error) {
    const observation =
      error.deliveryObservation === 'not_observed' ? 'not_observed' : 'not_delivered';
    const trace = core.buildJudgmentTrace(
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
  if (!overallStatus) throw new Error('Agent Host returned an unsupported terminal state.');
  const errors =
    overallStatus === 'execution_completed'
      ? []
      : [
          issue(
            overallStatus === 'blocked'
              ? 'KDNA_HOST_CAPSULE_DELIVERY_REJECTED'
              : `KDNA_HOST_${overallStatus.toUpperCase()}`,
            'Agent Host reported a non-success terminal state.',
            overallStatus === 'blocked' ? 'delivery' : 'execution',
          ),
        ];
  const trace = core.buildJudgmentTrace(
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
  executePreparedRuntimeContract,
  prepareRuntimeContract,
  resolvePackagedSnapshot,
  snapshotAssetFile,
  snapshotCoreCapsuleVersions,
};
