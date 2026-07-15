'use strict';

const { after, test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cbor = require('cbor-x');

const contract = require('./fixtures/golden-single-asset-host-contract.json');

const CLI = path.resolve(__dirname, '..', 'src', 'cli.js');
const PRELOAD = path.resolve(__dirname, 'helpers', 'require-golden-core.js');
const CORE_ROOT = process.env.KDNA_GOLDEN_CORE_ROOT
  ? path.resolve(process.env.KDNA_GOLDEN_CORE_ROOT)
  : null;
const TEMPORARY = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-golden-host-request-'));
const CAPABILITIES = Object.freeze({
  type: 'kdna.agent-host-capabilities',
  protocol_version: '0.1.0',
  capability_basis: 'registered_descriptor',
  host_protocols: ['kdna.agent-host'],
  capsule_versions: ['0.1.0'],
  capsule_digest_profiles: ['kdna.canonicalization.runtime-capsule-jcs'],
  capsule_digest_profile_versions: ['0.1.0'],
});

after(() => fs.rmSync(TEMPORARY, { recursive: true, force: true }));

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function requireCandidateCore() {
  assert.ok(CORE_ROOT, 'KDNA_GOLDEN_CORE_ROOT must point to the candidate Core package.');
  return require(path.join(CORE_ROOT, 'src'));
}

function buildGoldenAsset(core) {
  const source = path.join(TEMPORARY, 'source');
  const asset = path.join(TEMPORARY, 'golden-single-asset.kdna');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'mimetype'), core.MIMETYPE);
  fs.writeFileSync(path.join(source, 'kdna.json'), JSON.stringify(contract.source.manifest));
  fs.writeFileSync(path.join(source, 'payload.kdnab'), cbor.encode(contract.source.payload));
  fs.writeFileSync(
    path.join(source, 'checksums.json'),
    JSON.stringify(core.buildChecksums(source)),
  );
  core.pack(source, asset);
  return asset;
}

function normalizeRuntimeFields(capsule) {
  const normalized = globalThis.structuredClone(capsule);
  assert.match(normalized.trace.loaded_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  normalized.trace.loaded_at = contract.provenance.dynamic_field_normalization['trace.loaded_at'];
  return normalized;
}

function writeHost(coreEntry, capturePath) {
  const host = path.join(TEMPORARY, 'golden-agent-host.js');
  fs.writeFileSync(
    host,
    `'use strict';
const core = require(${JSON.stringify(coreEntry)});
const fs = require('node:fs');
const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  const raw = Buffer.concat(chunks);
  fs.writeFileSync(${JSON.stringify(capturePath)}, raw);
  const request = core.parseRuntimeContractJson(raw);
  const digest = core.computeCapsuleDeliveryDigest(request.capsule);
  process.stdout.write(JSON.stringify({
    protocol: request.protocol,
    protocol_version: request.protocol_version,
    request_id: request.request_id,
    runtime_receipt: {
      type: 'kdna.agent-host.runtime-receipt',
      contract_version: '0.1.0',
      capsule_version: request.runtime_contract.capsule_version,
      capsule_digest_profile: request.runtime_contract.capsule_digest_profile,
      capsule_digest_profile_version: request.runtime_contract.capsule_digest_profile_version,
      sender_capsule_delivery_digest: request.runtime_contract.capsule_delivery_digest,
      host_recomputed_capsule_delivery_digest: digest,
      echoed_capsule_delivery_digest: digest,
      capsule_delivery_comparison: 'matched',
      capsule_schema_validation: 'passed',
      asset_id_correlation: 'matched',
      provider_execution_status: 'completed',
      usage: {
        elapsed_ms: 1,
        elapsed_basis: 'host_monotonic',
        tokens_used: null,
        model_calls: null,
        basis: 'not_observed'
      },
      semantic_consumption: { state: 'not_observed', basis: null },
      model_identity: { value: null, basis: 'not_observed' }
    },
    outcome: {
      judgment: {
        answer: 'Correlated Golden fixture response.',
        reasoning: [],
        confidence: null
      },
      usage: null
    }
  }));
});
`,
  );
  return host;
}

function writeRegistration(host) {
  const registration = path.join(TEMPORARY, 'golden-agent-host-registration.json');
  fs.writeFileSync(
    registration,
    JSON.stringify({
      type: 'kdna.cli.agent-host-registration',
      protocol_version: '0.1.0',
      process: { command: process.execPath, args: [host] },
      capabilities: CAPABILITIES,
    }),
  );
  return registration;
}

test('Golden Runtime Capsule reaches the real process Host without semantic loss', () => {
  const core = requireCandidateCore();
  const coreRepository = path.resolve(CORE_ROOT, '..', '..');
  const actualCommit = execFileSync('git', ['-C', coreRepository, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  assert.ok(actualCommit.startsWith(contract.provenance.core_commit));

  const upstreamFixture = JSON.parse(
    fs.readFileSync(path.join(CORE_ROOT, 'test', 'fixtures', 'golden-single-asset.json'), 'utf8'),
  );
  assert.deepEqual(contract.source, upstreamFixture);

  const asset = buildGoldenAsset(core);
  assert.equal(core.validate(asset).overall_valid, true);
  const coreCapsule = core.loadRuntimeCapsule(fs.readFileSync(asset), { profile: 'compact' });
  const normalizedCoreCapsule = normalizeRuntimeFields(coreCapsule);
  assert.deepEqual(normalizedCoreCapsule, contract.expected_compact_capsule);
  assert.equal(
    sha256(JSON.stringify(normalizedCoreCapsule)),
    contract.provenance.normalized_capsule_sha256,
  );

  const requestCapture = path.join(TEMPORARY, 'host-request.json');
  const evidencePath = path.join(TEMPORARY, 'runtime-evidence.json');
  const host = writeHost(path.join(CORE_ROOT, 'src', 'index.js'), requestCapture);
  const registration = writeRegistration(host);
  const execution = spawnSync(
    process.execPath,
    [
      '--require',
      PRELOAD,
      CLI,
      'use',
      asset,
      `--task=${contract.task}`,
      `--agent-host=${process.execPath}`,
      `--agent-host-arg=${host}`,
      `--agent-host-capabilities=${registration}`,
      '--budget=offline-audit',
      '--as=json',
      `--out=${evidencePath}`,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        KDNA_GOLDEN_CORE_ROOT: CORE_ROOT,
        KDNA_QUIET: '1',
      },
    },
  );
  assert.equal(execution.status, 0, execution.stderr);

  const output = JSON.parse(execution.stdout);
  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  const request = core.parseRuntimeContractJson(fs.readFileSync(requestCapture));
  assert.equal(
    core.validateAgentHostRequest(request, {
      plan: evidence.plan,
      trustedPlanDigest: evidence.plan.integrity.plan_digest,
      capabilities: CAPABILITIES,
      coreCapsuleVersions: core.DEFAULT_CORE_CAPSULE_CONTRACT_VERSIONS,
    }).valid,
    true,
  );
  assert.equal(core.validateAgentHostReceipt(evidence.receipt, { request }).valid, true);
  assert.equal(
    core.validateJudgmentTrace(evidence.trace, {
      plan: evidence.plan,
      trustedPlanDigest: evidence.plan.integrity.plan_digest,
      capabilities: CAPABILITIES,
      coreCapsuleVersions: core.DEFAULT_CORE_CAPSULE_CONTRACT_VERSIONS,
      request,
      receipt: evidence.receipt,
      trustedDeliveryObservation: 'host_receipt',
    }).valid,
    true,
  );

  assert.equal(request.protocol, 'kdna.agent-host');
  assert.equal(request.protocol_version, '0.1.0');
  assert.equal(request.task.summary, contract.task);
  assert.equal(request.authority.asset_id, contract.source.manifest.asset_id);
  assert.equal(request.asset.asset_id, contract.source.manifest.asset_id);
  assert.equal(JSON.stringify(request).includes(asset), false);
  assert.deepEqual(normalizeRuntimeFields(request.capsule), contract.expected_compact_capsule);
  assert.deepEqual(request.capsule.context.worldview, contract.source.payload.core.worldview);
  assert.deepEqual(request.capsule.context.value_order, contract.source.payload.core.value_order);
  assert.deepEqual(
    request.capsule.context.judgment_role,
    contract.source.payload.core.judgment_role,
  );
  assert.equal(
    request.capsule.context.highest_question,
    contract.source.payload.core.highest_question,
  );
  assert.deepEqual(
    request.capsule.context.self_checks,
    contract.source.payload.reasoning.self_check,
  );
  assert.equal(
    request.runtime_contract.capsule_delivery_digest,
    core.computeCapsuleDeliveryDigest(request.capsule),
  );
  assert.equal(output.status, 'execution_completed');
  assert.equal(output.trace.overall_status, 'execution_completed');
  assert.equal(output.trace.execution.semantic_consumption.state, 'not_observed');
  assert.equal(output.trace.execution.model_identity.value, null);
  assert.equal(output.trace.budget.actual.tokens_used, null);
  assert.equal(output.trace.budget.actual.model_calls, null);
  assert.deepEqual(output.trace, evidence.trace);
});
