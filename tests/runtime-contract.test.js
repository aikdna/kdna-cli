'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { after, before, test } = require('node:test');
const { CORE_CANDIDATE_VERSION } = require('../scripts/core-candidate');

const core = require('@aikdna/kdna-core');
const {
  createAgentHostCapabilityRegistry,
  snapshotRegularFile,
} = require('../src/agent-host-capabilities');
const { createProcessAgentHost } = require('../src/agent-host-process');
const {
  BUDGETS,
  executePreparedRuntimeContract,
  prepareRuntimeContract,
  snapshotAssetFile,
} = require('../src/runtime-contract');

const CLI = path.resolve(__dirname, '..', 'src', 'cli.js');
const CORE_PRELOAD = path.resolve(__dirname, 'helpers', 'require-golden-core.js');
const CORE_SOURCE_ROOT = process.env.KDNA_CORE_SOURCE_ROOT || process.env.KDNA_GOLDEN_CORE_ROOT;
const CORE_ENTRY = CORE_SOURCE_ROOT
  ? path.join(path.resolve(CORE_SOURCE_ROOT), 'src', 'index.js')
  : require.resolve('@aikdna/kdna-core');
const SOURCE_FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'minimal');
const REGISTERED = Object.freeze({
  type: 'kdna.agent-host-capabilities',
  protocol_version: '0.1.0',
  capability_basis: 'registered_descriptor',
  host_protocols: ['kdna.agent-host'],
  capsule_versions: ['0.1.0'],
  capsule_digest_profiles: ['kdna.canonicalization.runtime-capsule-jcs'],
  capsule_digest_profile_versions: ['0.1.0'],
});

let root;
let asset;
let invalidPayloadAsset;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-cli-runtime-contract-'));
  asset = path.join(root, 'fixture.kdna');
  core.pack(SOURCE_FIXTURE, asset);
  const invalidSource = path.join(root, 'invalid-payload-source');
  fs.cpSync(SOURCE_FIXTURE, invalidSource, { recursive: true });
  fs.writeFileSync(path.join(invalidSource, 'payload.kdnab'), Buffer.from('not-cbor', 'utf8'));
  invalidPayloadAsset = path.join(root, 'invalid-payload.kdna');
  core.pack(invalidSource, invalidPayloadAsset);
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

function run(args, env = {}) {
  const nodeOptions = [
    process.env.NODE_OPTIONS,
    CORE_SOURCE_ROOT ? `--require=${JSON.stringify(CORE_PRELOAD)}` : null,
  ]
    .filter(Boolean)
    .join(' ');
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: nodeOptions, KDNA_QUIET: '1', ...env },
  });
}

function write(file, value) {
  fs.writeFileSync(file, value);
  return file;
}

function registration(file, command, args, capabilities = REGISTERED) {
  write(
    file,
    JSON.stringify(
      {
        type: 'kdna.cli.agent-host-registration',
        protocol_version: '0.1.0',
        process: { command, args },
        capabilities,
      },
      null,
      2,
    ),
  );
  return file;
}

function hostScript(
  file,
  status = 'completed',
  mismatch = false,
  captureFile = null,
  expectedArgs = null,
) {
  return write(
    file,
    `'use strict';
const core = require(${JSON.stringify(CORE_ENTRY)});
const fs = require('node:fs');
${expectedArgs ? `if (JSON.stringify(process.argv.slice(2)) !== ${JSON.stringify(JSON.stringify(expectedArgs))}) process.exit(19);` : ''}
const chunks = [];
process.stdin.on('data', (chunk) => { chunks.push(chunk); });
process.stdin.on('end', () => {
  ${captureFile ? `fs.writeFileSync(${JSON.stringify(captureFile)}, Buffer.concat(chunks));` : ''}
  let request;
  try {
    request = core.parseRuntimeContractJson(Buffer.concat(chunks));
  } catch (_) {
    process.exit(20);
    return;
  }
  if (
    request.protocol !== 'kdna.agent-host' ||
    request.protocol_version !== '0.1.0' ||
    request.runtime_contract?.capsule_version !== '0.1.0' ||
    request.runtime_contract?.capsule_digest_profile !== 'kdna.canonicalization.runtime-capsule-jcs' ||
    request.runtime_contract?.capsule_digest_profile_version !== '0.1.0' ||
    request.capsule?.type !== 'kdna.runtime-capsule' ||
    request.authority?.asset_id !== request.asset?.asset_id ||
    request.asset?.asset_id !== request.capsule?.asset?.asset_id ||
    request.asset?.asset_uid !== request.capsule?.asset?.asset_uid ||
    request.asset?.version !== request.capsule?.asset?.version ||
    request.asset?.judgment_version !== request.capsule?.asset?.judgment_version
  ) {
    process.exit(21);
    return;
  }
  const sender = request.runtime_contract.capsule_delivery_digest;
  const hostP = ${mismatch ? "`sha256:${'0'.repeat(64)}`" : 'core.computeCapsuleDeliveryDigest(request.capsule)'};
  const status = ${JSON.stringify(status)};
  const matched = sender === hostP;
  const usage = {
    elapsed_ms: status === 'timed_out' ? request.budget.deadline_ms + 1 : 1,
    elapsed_basis: 'host_monotonic',
    tokens_used: null,
    model_calls: null,
    basis: 'not_observed'
  };
  process.stdout.write(JSON.stringify({
    protocol: request.protocol,
    protocol_version: request.protocol_version,
    request_id: request.request_id,
    runtime_receipt: {
      type: 'kdna.agent-host.runtime-receipt',
      contract_version: '0.1.0',
      capsule_version: '0.1.0',
      capsule_digest_profile: 'kdna.canonicalization.runtime-capsule-jcs',
      capsule_digest_profile_version: '0.1.0',
      sender_capsule_delivery_digest: sender,
      host_recomputed_capsule_delivery_digest: hostP,
      echoed_capsule_delivery_digest: hostP,
      capsule_delivery_comparison: matched ? 'matched' : 'mismatched',
      capsule_schema_validation: 'passed',
      asset_id_correlation: 'matched',
      provider_execution_status: matched ? status : 'not_started',
      semantic_consumption: { state: 'not_observed', basis: null },
      model_identity: { value: null, basis: 'not_observed' },
      usage
    },
    outcome: status === 'completed' && matched ? {
      judgment: { answer: 'Host-native correlated result.', reasoning: [], confidence: null },
      usage: null
    } : null
  }));
});
`,
  );
}

function preparedRequest() {
  const prepared = prepareRuntimeContract(asset, {
    task: 'Review this packaged decision.',
    createdAt: '2026-07-15T00:00:00.000Z',
  });
  const context = {
    plan: prepared.plan,
    trustedPlanDigest: prepared.trustedPlanDigest,
    capabilities: REGISTERED,
    coreCapsuleVersions: core.DEFAULT_CORE_CAPSULE_CONTRACT_VERSIONS,
  };
  const capsule = core.loadRuntimeCapsule(prepared.bytes, {
    profile: prepared.plan.projection_request.profile,
    expectedDigests: prepared.capsuleExpectedDigests,
    loadedAt: prepared.createdAt,
  });
  const request = core.buildAgentHostRequest(
    { request_id: 'host_0123456789abcdef01234567', capsule },
    context,
  );
  return { prepared, context, request };
}

test('byte-authenticated source fixture retains its declared bytes on checkout', () => {
  const checksums = JSON.parse(
    fs.readFileSync(path.join(SOURCE_FIXTURE, 'checksums.json'), 'utf8'),
  );
  for (const [field, file] of [
    ['manifest_digest', 'kdna.json'],
    ['payload_digest', 'payload.kdnab'],
  ]) {
    const actual =
      'sha256:' +
      crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(SOURCE_FIXTURE, file)))
        .digest('hex');
    assert.equal(actual, checksums[field], file + ' checkout bytes');
  }
});

test('Core candidate is explicit while the unpublished registry dependency remains unchanged', () => {
  const pkg = require('../package.json');
  const tarInstall = process.env.KDNA_CORE_CANDIDATE_TAR === '1';
  if (tarInstall) {
    assert.match(pkg.dependencies['@aikdna/kdna-core'], /^file:/);
  } else {
    assert.equal(pkg.dependencies['@aikdna/kdna-core'], '0.18.0');
  }
  const corePackage = CORE_SOURCE_ROOT
    ? require(path.join(path.resolve(CORE_SOURCE_ROOT), 'package.json'))
    : require('@aikdna/kdna-core/package.json');
  assert.equal(
    corePackage.version,
    CORE_SOURCE_ROOT || tarInstall ? CORE_CANDIDATE_VERSION : '0.18.0',
  );
  const current = run(['plan-use', asset, '--task=Review', '--as=json']);
  assert.equal(current.status, 0, current.stderr);
  assert.equal(JSON.parse(current.stdout).contract_version, '0.1.0');
});

test('Core default Capsule versions are the only authority and are snapshotted immutably', async () => {
  const prepared = prepareRuntimeContract(asset, { task: 'Review Core version authority.' });
  assert.deepEqual(prepared.coreCapsuleVersions, core.DEFAULT_CORE_CAPSULE_CONTRACT_VERSIONS);
  assert.notStrictEqual(prepared.coreCapsuleVersions, core.DEFAULT_CORE_CAPSULE_CONTRACT_VERSIONS);
  assert.throws(() => prepared.coreCapsuleVersions.push('9.0'));

  const coreWithoutDefaults = new Proxy(core, {
    get(target, property) {
      if (property === 'DEFAULT_CORE_CAPSULE_CONTRACT_VERSIONS') return Object.freeze([]);
      return target[property];
    },
  });
  assert.throws(
    () =>
      prepareRuntimeContract(asset, {
        core: coreWithoutDefaults,
        task: 'Review Core-selected versions.',
      }),
    /valid default Capsule versions/,
  );
});

test('exported budget profiles cannot be mutated across Plan builds', () => {
  assert.throws(() => {
    BUDGETS.interactive.max_projection_chars = 1;
  });
  const plan = prepareRuntimeContract(asset, {
    task: 'Review immutable budget.',
    budgetProfile: 'interactive',
  }).plan;
  assert.equal(plan.budget.max_projection_chars, 2500);
});

test('runtime-contract flag is isolated and unknown values never fall back', () => {
  const unknown = run(['plan-use', asset, '--task=Review', '--runtime-contract=2']);
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /no generation selector/);
  const leaked = run(['plan-use', asset, '--task=Review', '--agent-host-capabilities=x']);
  assert.equal(leaked.status, 0, leaked.stderr);
  assert.equal(JSON.parse(leaked.stdout).contract_version, '0.1.0');
  const useLeaked = run(['use', asset, '--task=Review', '--agent-host-capabilities=x']);
  assert.notEqual(useLeaked.status, 0);
  assert.match(useLeaked.stderr, /requires an explicit --agent-host/);
});

test('plan-use rejects selectors and every duplicate runtime-contract occurrence', () => {
  for (const flags of [
    ['--runtime-contract', '--runtime-contract'],
    ['--runtime-contract=0.1.0'],
  ]) {
    const result = run(['plan-use', asset, '--task=Review', ...flags]);
    assert.notEqual(result.status, 0, flags.join('+'));
    assert.match(result.stderr, /no generation selector/);
    assert.equal(result.stdout, '');
  }
});

test('use rejects selectors and every duplicate runtime-contract occurrence', () => {
  for (const flags of [
    ['--runtime-contract', '--runtime-contract'],
    ['--runtime-contract=0.1.0'],
  ]) {
    const result = run(['use', asset, '--task=Review', ...flags]);
    assert.notEqual(result.status, 0, flags.join('+'));
    assert.match(result.stderr, /no generation selector/);
    assert.equal(result.stdout, '');
  }
});

test('ConsumptionPlan uses one packaged-byte snapshot and contains no local path', () => {
  let evidenceBytes;
  let capsuleBytes;
  const observedCore = new Proxy(core, {
    get(target, property) {
      if (property === 'computeDigestEvidence') {
        return (bytes, options) => {
          evidenceBytes = bytes;
          return target.computeDigestEvidence(bytes, options);
        };
      }
      if (property === 'loadRuntimeCapsule') {
        return (bytes, options) => {
          capsuleBytes = bytes;
          return target.loadRuntimeCapsule(bytes, options);
        };
      }
      return target[property];
    },
  });
  const prepared = prepareRuntimeContract(asset, {
    core: observedCore,
    task: 'Review this packaged decision.',
    createdAt: '2026-07-15T00:00:00.000Z',
  });
  assert.equal(prepared.plan.contract_version, '0.1.0');
  assert.equal(prepared.plan.projection_request.require_packaged_asset, true);
  assert.equal(JSON.stringify(prepared.plan).includes(root), false);
  const capture = path.join(root, 'snapshot-host-request.json');
  return executePreparedRuntimeContract(prepared, {
    capabilities: REGISTERED,
    command: process.execPath,
    args: [hostScript(path.join(root, 'snapshot-host.js'), 'completed', false, capture)],
    timeoutMs: 5000,
  }).then(({ trace }) => {
    assert.strictEqual(evidenceBytes, capsuleBytes);
    assert.equal(trace.contract_version, '0.1.0');
    assert.equal(JSON.stringify(trace).includes(root), false);
    const request = core.parseRuntimeContractJson(fs.readFileSync(capture));
    assert.equal(
      core.validateAgentHostRequest(request, {
        plan: prepared.plan,
        trustedPlanDigest: prepared.trustedPlanDigest,
        capabilities: REGISTERED,
        coreCapsuleVersions: core.DEFAULT_CORE_CAPSULE_CONTRACT_VERSIONS,
      }).valid,
      true,
    );
    assert.equal(request.request_id, trace.capsule_delivery_evidence.request_id);
    assert.equal(
      request.runtime_contract.capsule_delivery_digest,
      trace.projection_actual.capsule_delivery_digest,
    );
    assert.equal(JSON.stringify(request).includes(root), false);
  });
});

test('installed ConsumptionPlan binds A and C to the independent install receipt', () => {
  const home = path.join(root, 'installed-home');
  const env = { HOME: home, KDNA_HOME: path.join(home, '.kdna') };
  const readOnlyAsset = path.join(root, 'read-only-fixture.kdna');
  fs.copyFileSync(asset, readOnlyAsset);
  fs.chmodSync(readOnlyAsset, 0o444);
  const sourceBytes = fs.readFileSync(readOnlyAsset);
  const sourceMode = fs.statSync(readOnlyAsset).mode & 0o777;
  try {
    const installed = run(['install', readOnlyAsset, '--yes', '--json'], env);
    assert.equal(installed.status, 0, installed.stderr);
    const receipt = JSON.parse(installed.stdout);
    assert.deepEqual(fs.readFileSync(readOnlyAsset), sourceBytes);
    assert.deepEqual(fs.readFileSync(receipt.path), sourceBytes);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(readOnlyAsset).mode & 0o777, sourceMode);
      assert.equal(fs.statSync(receipt.path).mode & 0o777, 0o600);
    }
    assert.equal(
      fs
        .readdirSync(path.dirname(path.dirname(receipt.path)))
        .some((entry) => entry.includes('.tmp-')),
      false,
    );

    const planned = run(
      [
        'plan-use',
        receipt.name + '@1.0.0',
        '--task=Review installed asset',
        '--runtime-contract',
        '--as=json',
      ],
      env,
    );
    assert.equal(planned.status, 0, planned.stderr);
    const plan = JSON.parse(planned.stdout);
    assert.deepEqual(
      {
        source: plan.asset_ref.expected_digests.asset.source,
        comparison: plan.asset_ref.expected_digests.asset.comparison,
      },
      { source: 'install_receipt', comparison: 'matched' },
    );
    assert.deepEqual(
      {
        source: plan.asset_ref.expected_digests.content.source,
        comparison: plan.asset_ref.expected_digests.content.comparison,
      },
      { source: 'install_receipt', comparison: 'matched' },
    );
  } finally {
    fs.chmodSync(readOnlyAsset, 0o600);
  }
});

test('missing capability descriptor is rejected before projection', () => {
  const result = run([
    'use',
    asset,
    '--task=Review',
    '--runtime-contract',
    '--runner=cli:default',
    `--agent-host=${process.execPath}`,
    `--agent-host-arg=${hostScript(path.join(root, 'unused-host.js'))}`,
    '--as=trace',
  ]);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /No capability registration matches the selected process Host/);
});

test('capability registration is strict, process-bound, snapshotted, and mutation-safe', () => {
  const registry = createAgentHostCapabilityRegistry(core);
  const script = hostScript(path.join(root, 'bound-host.js'));
  const file = registration(path.join(root, 'bound.json'), process.execPath, [script]);
  const selected = { command: process.execPath, args: [script] };
  registry.registerProcessFile(file, selected);
  write(file, Buffer.from([0xff]));
  assert.deepEqual(registry.resolveProcess(selected), REGISTERED);
  assert.throws(
    () => registry.resolveProcess({ command: 'other', args: [] }),
    /No capability registration matches/,
  );

  const mismatch = registration(path.join(root, 'mismatch.json'), 'other', []);
  assert.throws(() => registry.registerProcessFile(mismatch, selected), /does not match/);
  for (const [name, raw] of [
    ['duplicate', '{"type":"x","type":"y"}'],
    ['bom', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{}')])],
    ['invalid-utf8', Buffer.from([0xff])],
    ['trailing', '{}{}'],
    ['deep', `${'['.repeat(17)}0${']'.repeat(17)}`],
    ['large', Buffer.alloc(64 * 1024 + 1, 0x20)],
  ]) {
    const invalid = write(path.join(root, `${name}.json`), raw);
    assert.throws(() => registry.registerProcessFile(invalid, selected), undefined, name);
  }
});

test('symlink and lstat-to-open replacement checks run without relying on O_NOFOLLOW', () => {
  const fileStat = (dev, ino) => ({
    dev,
    ino,
    size: 4,
    mtimeMs: 1,
    ctimeMs: 1,
    isFile: () => true,
    isSymbolicLink: () => false,
  });
  const symlinkStat = {
    ...fileStat(1, 1),
    isFile: () => false,
    isSymbolicLink: () => true,
  };
  const facade = (pathStat, openedStat) => ({
    constants: { O_RDONLY: 0 },
    lstatSync: () => pathStat,
    openSync: () => 7,
    fstatSync: () => openedStat,
    readFileSync: () => Buffer.from('safe'),
    closeSync: () => {},
  });

  assert.throws(
    () => snapshotRegularFile('registration.json', 64, facade(symlinkStat, fileStat(1, 1))),
    /non-symlink/,
  );
  assert.throws(
    () => snapshotAssetFile('asset.kdna', facade(symlinkStat, fileStat(1, 1))),
    /non-symlink/,
  );
  assert.throws(
    () => snapshotRegularFile('registration.json', 64, facade(fileStat(1, 1), fileStat(2, 2))),
    /changed before it was opened/,
  );
  assert.throws(
    () => snapshotAssetFile('asset.kdna', facade(fileStat(1, 1), fileStat(2, 2))),
    /changed before it was opened/,
  );
});

test('registered descriptor must also pass Core capability schema before projection', async () => {
  const prepared = prepareRuntimeContract(asset, { task: 'Review this packaged decision.' });
  await assert.rejects(
    executePreparedRuntimeContract(prepared, {
      capabilities: { ...REGISTERED, capsule_versions: ['9.0'] },
      command: process.execPath,
      args: [],
    }),
    /failed Core validation/,
  );
});

test('negotiation blocks a missing delivery digest profile before Host calls', async () => {
  const cases = [{ ...REGISTERED, capsule_digest_profiles: [] }];
  for (const capabilities of cases) {
    const prepared = prepareRuntimeContract(asset, { task: 'Review this packaged decision.' });
    let calls = 0;
    const execution = await executePreparedRuntimeContract(prepared, {
      capabilities,
      command: process.execPath,
      args: [],
      createHost: () => {
        calls += 1;
        throw new Error('must not be called');
      },
    });
    assert.equal(calls, 0);
    assert.equal(execution.trace.overall_status, 'blocked');
    assert.equal(execution.trace.projection_actual.profile, null);
  }
});

test('selected negotiation followed by Capsule load failure returns an honest blocked JudgmentTrace', () => {
  const planned = run([
    'plan-use',
    invalidPayloadAsset,
    '--task=Review invalid payload',
    '--runtime-contract',
    '--as=json',
  ]);
  assert.equal(planned.status, 0, planned.stderr);
  const plan = JSON.parse(planned.stdout);
  const negotiation = core.negotiateRuntimePair(plan, {
    trustedPlanDigest: plan.integrity.plan_digest,
    capabilities: REGISTERED,
    coreCapsuleVersions: core.DEFAULT_CORE_CAPSULE_CONTRACT_VERSIONS,
  });
  assert.equal(negotiation.state, 'selected');

  const capture = path.join(root, 'invalid-payload-host-capture.json');
  const script = hostScript(
    path.join(root, 'invalid-payload-host.js'),
    'completed',
    false,
    capture,
  );
  const descriptor = registration(path.join(root, 'invalid-payload-host.json'), process.execPath, [
    script,
  ]);
  const result = run([
    'use',
    invalidPayloadAsset,
    '--task=Review invalid payload',
    '--runtime-contract',
    '--runner=cli:default',
    `--agent-host=${process.execPath}`,
    `--agent-host-arg=${script}`,
    `--agent-host-capabilities=${descriptor}`,
    '--as=trace',
  ]);
  assert.notEqual(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(fs.existsSync(capture), false);
  const trace = JSON.parse(result.stdout);
  assert.equal(trace.contract_version, '0.1.0');
  assert.equal(trace.overall_status, 'blocked');
  assert.equal(trace.errors[0].phase, 'load');
  assert.equal(trace.runtime_contract.negotiation_state, 'not_started');
  assert.equal(trace.runtime_contract.issue_code, null);
  assert.equal(trace.projection_actual.profile, null);
  assert.equal(trace.digest_evidence.asset.comparison.state, 'unavailable');
  assert.equal(trace.capsule_delivery_evidence.host_boundary_comparison, 'unavailable');
  assert.equal(trace.capsule_delivery_evidence.request_id, null);
  assert.equal(trace.execution.delivery_status, 'not_delivered');
  assert.equal(trace.host_receipt, null);
});

test('Host adapter construction failure returns a blocked Trace without a receipt', async () => {
  const prepared = prepareRuntimeContract(asset, { task: 'Review Host construction.' });
  const execution = await executePreparedRuntimeContract(prepared, {
    capabilities: REGISTERED,
    command: process.execPath,
    args: [],
    timeoutMs: 5000,
    createHost: () => {
      throw new Error('construction detail must not escape');
    },
  });
  assert.equal(execution.receipt, null);
  assert.equal(execution.trace.overall_status, 'blocked');
  assert.equal(execution.trace.errors[0].phase, 'host');
  assert.equal(execution.trace.host_receipt, null);
  assert.equal(execution.trace.capsule_delivery_evidence.host_boundary_comparison, 'not_delivered');
  assert.equal(execution.trace.capsule_delivery_evidence.request_id, null);
  assert.equal(execution.trace.execution.execution_status, 'not_started');
});

test('runtime contract rejects space-form flags and invalid timeout before execution', () => {
  for (const command of ['plan-use', 'use']) {
    for (const args of [
      [command, asset, '--task=Review', '--runtime-contract', '1'],
      [command, '--runtime-contract', '1', asset, '--task=Review'],
    ]) {
      const result = run(args);
      assert.notEqual(result.status, 0, command);
      assert.match(result.stderr, /no generation selector/);
      assert.equal(result.stdout, '');
    }
  }
  for (const timeout of ['100', '0', '-1', '1ms', '2147483648']) {
    const timeoutArgs = timeout === '100' ? ['--timeout', timeout] : [`--timeout=${timeout}`];
    const result = run(['use', asset, '--task=Review', '--runtime-contract', ...timeoutArgs]);
    assert.notEqual(result.status, 0, timeout);
    assert.match(result.stderr, /positive integer/);
    assert.equal(result.stdout, '');
  }
  const timeoutBeforeTarget = run([
    'use',
    '--runtime-contract',
    '--timeout',
    '100',
    asset,
    '--task=Review',
  ]);
  assert.notEqual(timeoutBeforeTarget.status, 0);
  assert.match(timeoutBeforeTarget.stderr, /positive integer/);
  assert.equal(timeoutBeforeTarget.stdout, '');
});

test('over-budget evidence uses Core terminal and calls Host adapter zero times', async () => {
  const prepared = prepareRuntimeContract(asset, { task: 'Review this packaged decision.' });
  prepared.plan.budget.max_projection_chars = 1;
  prepared.plan.integrity.plan_digest = core.computeConsumptionPlanDigest(prepared.plan);
  prepared.trustedPlanDigest = prepared.plan.integrity.plan_digest;
  let calls = 0;
  const execution = await executePreparedRuntimeContract(prepared, {
    capabilities: REGISTERED,
    command: process.execPath,
    args: [],
    createHost: () => {
      calls += 1;
      throw new Error('must not be called');
    },
  });
  assert.equal(calls, 0);
  assert.equal(execution.trace.overall_status, 'blocked');
  assert.equal(execution.trace.budget.comparison.projection_chars, 'exceeded');
  assert.equal(execution.trace.capsule_delivery_evidence.request_id, null);
  assert.equal(execution.trace.host_receipt, null);
  assert.equal(execution.trace.budget.actual.model_calls, null);
});

test('Agent Host raw boundary rejects duplicate keys, BOM, invalid UTF-8, depth, size, and trailing JSON', async () => {
  const { context, request } = preparedRequest();
  const vectors = [
    ['duplicate', '{"protocol":"kdna.agent-host","protocol":"kdna.agent-host"}'],
    ['bom', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{}')])],
    ['invalid', Buffer.from([0xff])],
    ['deep', `${'['.repeat(65)}0${']'.repeat(65)}`],
    ['trailing', '{}{}'],
  ];
  for (const [name, raw] of vectors) {
    const script = write(
      path.join(root, `raw-${name}.js`),
      `process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(Buffer.from(${JSON.stringify(Buffer.from(raw).toString('base64'))},'base64')));`,
    );
    const host = createProcessAgentHost({
      command: process.execPath,
      args: [script],
      core,
      validationContext: context,
      timeoutMs: 5000,
    });
    await assert.rejects(
      host.run(request),
      (error) => error.deliveryObservation === 'not_observed',
    );
  }
  const huge = write(
    path.join(root, 'raw-huge.js'),
    "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('x'.repeat(101)));",
  );
  await assert.rejects(
    createProcessAgentHost({
      command: process.execPath,
      args: [huge],
      core,
      validationContext: context,
      timeoutMs: 5000,
      maxOutputBytes: 100,
    }).run(request),
    (error) => error.code === 'KDNA_HOST_OUTPUT_LIMIT',
  );
});

test('Agent Host process timeout and diagnostic output are bounded', async () => {
  const { context, request } = preparedRequest();
  const timeout = write(
    path.join(root, 'host-timeout.js'),
    "process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>{},1000));",
  );
  await assert.rejects(
    createProcessAgentHost({
      command: process.execPath,
      args: [timeout],
      core,
      validationContext: context,
      timeoutMs: 20,
    }).run(request),
    (error) => error.code === 'KDNA_HOST_TIMEOUT',
  );
  const diagnostics = write(
    path.join(root, 'host-diagnostics.js'),
    "process.stdin.resume();process.stdin.on('end',()=>process.stderr.write('x'.repeat(101)));",
  );
  await assert.rejects(
    createProcessAgentHost({
      command: process.execPath,
      args: [diagnostics],
      core,
      validationContext: context,
      timeoutMs: 5000,
      maxDiagnosticBytes: 100,
    }).run(request),
    (error) => error.code === 'KDNA_HOST_DIAGNOSTIC_LIMIT',
  );
});

test('Agent Host executes exact ordered args containing spaces and shell metacharacters', () => {
  const exactArgs = [
    'argument with spaces',
    '$HOME & echo injected | more; $(whoami)',
    '"quoted" \'single\' \\backslash ^caret %PATH% !bang!',
    '--looks-like-an-option',
  ];
  const script = hostScript(
    path.join(root, 'host exact argv.js'),
    'completed',
    false,
    null,
    exactArgs,
  );
  const processArgs = [script, ...exactArgs];
  const descriptor = registration(
    path.join(root, 'host exact argv registration.json'),
    process.execPath,
    processArgs,
  );
  const result = run([
    'use',
    asset,
    '--task=Review exact process arguments',
    '--runtime-contract',
    '--runner=cli:default',
    `--agent-host=${process.execPath}`,
    ...processArgs.map((argument) => `--agent-host-arg=${argument}`),
    `--agent-host-capabilities=${descriptor}`,
    '--budget=offline-audit',
    '--as=trace',
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).overall_status, 'execution_completed');
});

test('strict Trace distinguishes not_delivered from delivered-but-not_observed', async () => {
  const unavailable = await executePreparedRuntimeContract(
    prepareRuntimeContract(asset, { task: 'Review unavailable Host.' }),
    {
      capabilities: REGISTERED,
      command: path.join(root, 'missing-host-executable'),
      args: [],
      timeoutMs: 5000,
    },
  );
  assert.equal(unavailable.trace.execution.delivery_status, 'not_delivered');
  assert.equal(
    unavailable.trace.capsule_delivery_evidence.host_boundary_comparison,
    'not_delivered',
  );
  assert.equal(unavailable.trace.capsule_delivery_evidence.request_id, null);

  const invalidHost = write(
    path.join(root, 'host-invalid-observation.js'),
    "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('{}'));",
  );
  const unobserved = await executePreparedRuntimeContract(
    prepareRuntimeContract(asset, { task: 'Review invalid Host receipt.' }),
    {
      capabilities: REGISTERED,
      command: process.execPath,
      args: [invalidHost],
      timeoutMs: 5000,
    },
  );
  assert.equal(unobserved.trace.execution.delivery_status, 'rejected_before_execution');
  assert.equal(unobserved.trace.capsule_delivery_evidence.host_boundary_comparison, 'not_observed');
  assert.match(unobserved.trace.capsule_delivery_evidence.request_id, /^host_[0-9a-f]{24}$/);
});

test('Host-native matched receipt and all five terminal states produce strict JudgmentTrace evidence', () => {
  const expected = {
    completed: 'execution_completed',
    failed: 'execution_failed',
    cancelled: 'cancelled',
    timed_out: 'timed_out',
    mismatched: 'blocked',
  };
  for (const [status, terminal] of Object.entries(expected)) {
    const mismatch = status === 'mismatched';
    const script = hostScript(path.join(root, `terminal-${status}.js`), status, mismatch);
    const descriptor = registration(path.join(root, `terminal-${status}.json`), process.execPath, [
      script,
    ]);
    const result = run([
      'use',
      asset,
      '--task=Review this packaged decision',
      '--runtime-contract',
      '--runner=cli:default',
      `--agent-host=${process.execPath}`,
      `--agent-host-arg=${script}`,
      `--agent-host-capabilities=${descriptor}`,
      '--budget=offline-audit',
      '--as=trace',
    ]);
    const trace = JSON.parse(result.stdout);
    assert.equal(trace.overall_status, terminal, `${status}: ${result.stderr}`);
    assert.equal(trace.contract_version, '0.1.0');
    assert.equal(trace.runtime_contract.selected_host_protocol, 'kdna.agent-host');
    if (status === 'completed') {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(trace.execution.model_identity.value, null);
      assert.equal(trace.execution.model_identity.basis, 'not_observed');
      assert.equal(trace.budget.actual.tokens_used, null);
      assert.equal(trace.budget.actual.model_calls, null);
      assert.equal(trace.budget.actual.usage_basis, 'not_observed');
    } else {
      assert.notEqual(result.status, 0);
    }
  }
});

test('fixture Host independently rejects identity tampering and reports Capsule P tampering as mismatched', () => {
  const script = hostScript(path.join(root, 'host-independent-negative.js'));
  const { request } = preparedRequest();

  const identityTampered = globalThis.structuredClone(request);
  identityTampered.capsule.asset.asset_id = 'kdna:fixture:different-asset';
  const rejected = spawnSync(process.execPath, [script], {
    input: JSON.stringify(identityTampered),
    encoding: 'utf8',
  });
  assert.equal(rejected.status, 21);
  assert.equal(rejected.stdout, '');

  const pTampered = globalThis.structuredClone(request);
  pTampered.capsule.context.highest_question = 'A changed Capsule at the Host boundary.';
  const mismatch = spawnSync(process.execPath, [script], {
    input: JSON.stringify(pTampered),
    encoding: 'utf8',
  });
  assert.equal(mismatch.status, 0, mismatch.stderr);
  const receipt = core.parseRuntimeContractJson(mismatch.stdout);
  assert.equal(receipt.runtime_receipt.capsule_delivery_comparison, 'mismatched');
  assert.equal(receipt.runtime_receipt.provider_execution_status, 'not_started');
  assert.equal(receipt.outcome, null);
  assert.equal(core.validateAgentHostReceipt(receipt, { request: pTampered }).valid, true);
});

test('runtime contract blocks source directories, Cluster, mock, and missing Host explicitly', () => {
  const source = run([
    'plan-use',
    path.resolve(__dirname, '..', 'fixtures', 'minimal'),
    '--task=Review',
    '--runtime-contract',
  ]);
  assert.notEqual(source.status, 0);
  assert.match(source.stderr, /regular packaged \.kdna/);
  const cluster = run([
    'plan-use',
    path.resolve(__dirname, '..', 'fixtures', 'cluster-launch-decision.json'),
    '--task=Review',
    '--runtime-contract',
  ]);
  assert.notEqual(cluster.status, 0);
  assert.match(cluster.stderr, /packaged \.kdna/);
  const mock = run([
    'use',
    asset,
    '--task=Review',
    '--runtime-contract',
    '--runner=mock:default',
    '--agent-host=node',
  ]);
  assert.notEqual(mock.status, 0);
  assert.match(mock.stderr, /requires --runner=cli:default/);
  const missing = run([
    'use',
    asset,
    '--task=Review',
    '--runtime-contract',
    '--runner=cli:default',
  ]);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /requires an explicit --agent-host/);
});

test('Host registration and Trace never expose the local descriptor, executable, or asset paths', () => {
  const script = hostScript(path.join(root, 'privacy-host.js'));
  const descriptor = registration(path.join(root, 'privacy-registration.json'), process.execPath, [
    script,
  ]);
  const result = run([
    'use',
    asset,
    '--task=Review privacy',
    '--runtime-contract',
    '--runner=cli:default',
    `--agent-host=${process.execPath}`,
    `--agent-host-arg=${script}`,
    `--agent-host-capabilities=${descriptor}`,
    '--budget=offline-audit',
    '--as=json',
  ]);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(JSON.stringify(output).includes(root), false);
  assert.equal(JSON.stringify(output).includes(process.execPath), false);
  assert.match(output.trace.capsule_delivery_evidence.observed, /^sha256:[0-9a-f]{64}$/);
  assert.equal(output.trace.execution.semantic_consumption.state, 'not_observed');
});

test('plan-only uses the same ConsumptionPlan planner and does not require a Host', () => {
  const direct = run(['plan-use', asset, '--task=Review', '--runtime-contract', '--as=json']);
  const alias = run([
    'use',
    asset,
    '--task=Review',
    '--runtime-contract',
    '--plan-only',
    '--as=json',
  ]);
  assert.equal(direct.status, 0, direct.stderr);
  assert.equal(alias.status, 0, alias.stderr);
  const left = JSON.parse(direct.stdout);
  const right = JSON.parse(alias.stdout);
  assert.equal(left.contract_version, '0.1.0');
  assert.equal(right.contract_version, '0.1.0');
  assert.equal(left.plan_id, right.plan_id);
  assert.equal(
    left.asset_ref.expected_digests.asset.value,
    right.asset_ref.expected_digests.asset.value,
  );
});

test('request identity is a digest of protocol values, not local resolution paths', () => {
  const { request } = preparedRequest();
  assert.equal(JSON.stringify(request).includes(root), false);
  assert.equal(request.asset.asset_id, 'kdna:example:deployment-review');
  assert.match(request.runtime_contract.capsule_delivery_digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(
    request.runtime_contract.capsule_delivery_digest,
    core.computeCapsuleDeliveryDigest(request.capsule),
  );
  assert.equal(crypto.createHash('sha256').update(JSON.stringify(request)).digest().length, 32);
});
