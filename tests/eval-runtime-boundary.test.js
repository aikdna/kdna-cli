const { afterEach, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const LOADER = path.join(ROOT, 'src', 'cmds', '_kdna-eval.js');
const CLI = path.join(ROOT, 'src', 'cli.js');
const HELPER = path.join(ROOT, 'tests', 'helpers', 'require-kdna-eval-fixture.js');
const FAILURE =
  'Error: @aikdna/kdna-eval@0.3.2 is missing or incompatible; reinstall @aikdna/kdna-cli.\n';
const tempDirs = [];

const CONTRACTS = Object.freeze({
  compose: ['createConsumptionRunner', 'loadConsumerIndex', 'resolveConsumerIndex'],
  'compose-review': ['createMultiGateRunner', 'createConsumptionRunner', 'createReplayEngine'],
  route: [
    'createConsumptionRunner',
    'loadRouteCard',
    'applyRouteCard',
    'loadConsumerIndex',
    'resolveConsumerIndex',
  ],
  'eval-consumption': [
    'createMultiGateRunner',
    'createConsumptionRunner',
    'createReplayEngine',
    'createCostTracker',
  ],
  'eval-asset': [
    'createAssayProfile',
    'validateFixtureSet',
    'classifyAsset',
    'runAssay',
    'FIXTURE_CATEGORIES',
  ],
  'eval-cluster': ['runClusterAssay'],
});

afterEach(() => {
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function runLoader(command, spec = {}, extraEnv = {}, script) {
  const source =
    script ||
    `const { loadKdnaEval } = require(${JSON.stringify(LOADER)});` +
      `const first = loadKdnaEval(${JSON.stringify(command)});` +
      `const second = loadKdnaEval(${JSON.stringify(command)});` +
      `if (first !== second) throw new Error('module cache identity changed');` +
      `const counts = global.__KDNA_EVAL_TEST_FIXTURE__;` +
      `if (counts.metadata !== 1 || counts.root !== 1 || counts.subpath !== 0) ` +
      `throw new Error('unexpected load counts ' + JSON.stringify(counts));`;
  return spawnSync(process.execPath, ['--require', HELPER, '-e', source], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...extraEnv,
      KDNA_TEST_EVAL_SPEC: JSON.stringify(spec),
    },
  });
}

function assertRejected(result, secret) {
  assert.equal(result.status, 6, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, FAILURE);
  if (secret) assert.doesNotMatch(result.stderr, new RegExp(secret));
}

test('all six command contracts accept only the exact official Eval identity', async (t) => {
  for (const command of Object.keys(CONTRACTS)) {
    await t.test(command, () => {
      const result = runLoader(command);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, '');
    });
  }
});

test('package name and every non-exact or invalid version fail closed', async (t) => {
  await t.test('wrong package name', () => {
    assertRejected(runLoader('compose', { name: '@example/kdna-eval' }));
  });
  for (const version of ['0.3.0', '0.3.1', '0.3.3', '0.4.0', '1.0.0', 'garbage']) {
    await t.test(version, () => {
      assertRejected(runLoader('compose', { version }));
    });
  }
});

test('metadata, root initialization, and root value failures use one non-leaking error', async (t) => {
  const secret = 'EVAL_INITIALIZATION_SECRET';
  for (const [name, spec] of [
    ['metadata', { metadataError: secret }],
    ['root initialization', { rootError: secret }],
    ['root value', { rootValue: 'null' }],
  ]) {
    await t.test(name, () => {
      assertRejected(runLoader('compose', spec), secret);
    });
  }
});

test('metadata entry and throwing export accessors fail with the same non-leaking error', async (t) => {
  const secret = 'EVAL_EXPORT_GETTER_SECRET';
  for (const [name, spec] of [
    ['missing root entry', { requireEntry: null }],
    ['escaping root entry', { requireEntry: './../../outside.js' }],
    [
      'throwing export accessor',
      { getterError: { name: 'createConsumptionRunner', message: secret } },
    ],
  ]) {
    await t.test(name, () => {
      assertRejected(runLoader('compose', spec), secret);
    });
  }
});

test('every command contract rejects each missing or mistyped required root export', async (t) => {
  for (const [command, exports] of Object.entries(CONTRACTS)) {
    for (const name of exports) {
      await t.test(`${command}: missing ${name}`, () => {
        assertRejected(runLoader(command, { omit: [name] }));
      });
      await t.test(`${command}: wrong ${name}`, () => {
        const wrongType = name === 'FIXTURE_CATEGORIES' ? 'object' : 'string';
        assertRejected(runLoader(command, { types: { [name]: wrongType } }));
      });
    }
  }
});

test('KDNA_EVAL_PATH cannot replace a missing official dependency', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-eval-path-bypass-'));
  tempDirs.push(dir);
  const marker = path.join(dir, 'loaded');
  const malicious = path.join(dir, 'malicious.js');
  fs.writeFileSync(
    malicious,
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'loaded\\n'); module.exports = {};\n`,
  );
  const result = runLoader(
    'compose',
    { rootError: 'official package unavailable' },
    { KDNA_EVAL_PATH: malicious },
  );
  assertRejected(result);
  assert.equal(fs.existsSync(marker), false, 'environment-selected module was executed');
});

test('Cluster root API cannot be replaced by a package subpath', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-eval-subpath-bypass-'));
  tempDirs.push(dir);
  const marker = path.join(dir, 'loaded');
  const result = runLoader('eval-cluster', {
    omit: ['runClusterAssay'],
    subpathMarker: marker,
  });
  assertRejected(result);
  assert.equal(fs.existsSync(marker), false, 'Eval subpath was loaded');
});

test('help output remains available without initializing Eval', () => {
  const secret = 'HELP_MUST_NOT_LOAD_EVAL';
  const result = spawnSync(process.execPath, ['--require', HELPER, CLI, 'compose', '--help'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      KDNA_TEST_EVAL_SPEC: JSON.stringify({ rootError: secret, metadataError: secret }),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Usage: kdna compose/);
  assert.doesNotMatch(result.stderr, new RegExp(secret));
});

test('production command files contain no Eval environment, sibling, or subpath fallback', () => {
  const commands = {
    'compose.js': 'compose',
    'compose-review.js': 'compose-review',
    'route.js': 'route',
    'eval-consumption.js': 'eval-consumption',
    'eval-asset.js': 'eval-asset',
    'eval-cluster.js': 'eval-cluster',
  };
  for (const [file, contract] of Object.entries(commands)) {
    const source = fs.readFileSync(path.join(ROOT, 'src', 'cmds', file), 'utf8');
    assert.match(source, new RegExp(`loadKdnaEval\\('${contract}'\\)`), file);
    assert.doesNotMatch(source, /KDNA_EVAL_PATH|cluster-assay|packages['"], ['"]kdna-eval/, file);
    assert.doesNotMatch(source, /\^0\.2\.0|>=?0\.3\.1|DEPENDENCY_ERROR/, file);
  }
});

test('test-only Eval preload helper is outside the npm package surface', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(!pkg.files.some((entry) => entry === 'tests' || entry.startsWith('tests/')));
  assert.ok(!pkg.files.some((entry) => entry === 'scripts' || entry.startsWith('scripts/')));
});
