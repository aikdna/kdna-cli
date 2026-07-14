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

after(() => fs.rmSync(TEMPORARY, { recursive: true, force: true }));

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
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
  const normalized = clone(capsule);
  assert.match(normalized.trace.loaded_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  normalized.trace.loaded_at = contract.provenance.dynamic_field_normalization['trace.loaded_at'];
  return normalized;
}

function writeCapturingHost(capturePath, responsePath) {
  const host = path.join(TEMPORARY, 'capture-golden-request.js');
  fs.writeFileSync(
    host,
    `const fs = require('node:fs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(capturePath)}, input);
  const request = JSON.parse(input);
  const response = JSON.stringify({
    protocol: request.protocol,
    request_id: request.request_id,
    outcome: { judgment: { answer: 'Correlated Golden fixture response.' } }
  });
  fs.writeFileSync(${JSON.stringify(responsePath)}, response);
  process.stdout.write(response);
});
`,
  );
  return host;
}

test('Golden compact Capsule reaches the real process Host request without semantic loss', () => {
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
  assert.deepEqual(core.validate(asset), {
    format_valid: true,
    schema_valid: true,
    payload_valid: true,
    checksums_valid: true,
    load_contract_valid: true,
    overall_valid: true,
    problems: [],
  });

  const coreCapsule = core.load(asset, { profile: 'compact', as: 'json' });
  const normalizedCoreCapsule = normalizeRuntimeFields(coreCapsule);
  assert.deepEqual(normalizedCoreCapsule, contract.expected_compact_capsule);
  assert.equal(
    sha256(JSON.stringify(normalizedCoreCapsule)),
    contract.provenance.normalized_capsule_sha256,
  );

  const requestCapture = path.join(TEMPORARY, 'host-request.json');
  const responseCapture = path.join(TEMPORARY, 'host-response.json');
  const host = writeCapturingHost(requestCapture, responseCapture);
  const execution = spawnSync(
    process.execPath,
    [
      '--require',
      PRELOAD,
      CLI,
      'use',
      asset,
      `--task=${contract.task}`,
      '--runner=cli:default',
      `--agent-host=${process.execPath}`,
      `--agent-host-arg=${host}`,
      '--as=json',
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
  const rawRequest = fs.readFileSync(requestCapture, 'utf8');
  const rawResponse = fs.readFileSync(responseCapture, 'utf8');
  assert.ok(rawRequest.endsWith('\n'));
  const request = JSON.parse(rawRequest);
  const receivedCapsule = request.capsule;

  assert.equal(request.protocol, 'kdna.agent-host/1');
  assert.match(request.request_id, /^host_[a-f0-9]{24}$/);
  assert.equal(request.phase, 'single_judgment');
  assert.equal(request.task.summary, contract.task);
  assert.deepEqual(request.authority, {
    asset_id: contract.source.manifest.asset_id,
    role: 'primary',
    final_decision: true,
  });
  assert.deepEqual(request.asset, {
    asset_id: contract.source.manifest.asset_id,
    role: 'primary',
  });
  assert.equal(JSON.stringify(request).includes(asset), false);

  assert.deepEqual(normalizeRuntimeFields(receivedCapsule), contract.expected_compact_capsule);
  assert.deepEqual(receivedCapsule.context.worldview, contract.source.payload.core.worldview);
  assert.deepEqual(receivedCapsule.context.value_order, contract.source.payload.core.value_order);
  assert.deepEqual(
    receivedCapsule.context.judgment_role,
    contract.source.payload.core.judgment_role,
  );
  assert.equal(
    receivedCapsule.context.highest_question,
    contract.source.payload.core.highest_question,
  );
  assert.equal(
    receivedCapsule.context.axioms[0].one_sentence,
    contract.source.payload.core.axioms[0].one_sentence,
  );
  assert.deepEqual(receivedCapsule.context.boundaries, contract.source.payload.core.boundaries);
  assert.equal(
    receivedCapsule.context.self_checks[0].text,
    contract.source.payload.reasoning.self_check[0],
  );

  const receivedCapsuleDigest = sha256(JSON.stringify(receivedCapsule));
  assert.equal(output.trace.projection_actual.content_digest, receivedCapsuleDigest);
  assert.equal(output.trace.assets_loaded[0].asset_id, contract.source.manifest.asset_id);
  assert.equal(output.trace.assets_loaded[0].capsule_digest, receivedCapsuleDigest);
  assert.equal(
    output.trace.attempts[0].host_receipt.request_digest,
    sha256(JSON.stringify(request)),
  );
  assert.equal(output.trace.attempts[0].host_receipt.response_digest, sha256(rawResponse));
  assert.equal(output.trace.attempts[0].host_receipt.request_id, request.request_id);

  assert.equal(output.status, 'execution_completed');
  assert.equal(output.trace.delivery_status, 'correlated_response');
  assert.equal(output.trace.consumption_status, 'not_independently_verified');
  assert.equal(output.trace.execution_status, 'completed');
  assert.equal(output.trace.conformance_status, 'not_evaluated');
  assert.equal(output.trace.evidence_status, 'trace_recorded');
  assert.equal(output.trace.cost.chars_consumed, 0);
  assert.equal(output.trace.cost.chars_consumed_basis, 'not_observed');
  assert.ok(output.trace.cost.projection_chars_delivered > 0);
  assert.equal(output.trace.cost.projection_char_delivery_basis, 'runtime_serialized_projection');
  assert.equal(output.trace.execution.model, null);
  assert.equal(output.trace.execution.reported_model, null);
  assert.equal(output.trace.execution.model_identity_basis, 'not_reported');
  assert.equal(output.trace.cost.tokens_used, 0);
  assert.equal(output.trace.cost.token_usage_basis, 'not_reported');
  assert.equal(output.trace.cost.model_calls, 0);
  assert.equal(output.trace.cost.model_call_count_basis, 'not_reported');
});
