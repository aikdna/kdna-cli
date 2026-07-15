'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { validateCurrentReleaseBinding } = require('../scripts/current-release-binding');
const { validateReleaseContext } = require('../scripts/release-policy');
const {
  validateEvidenceArtifact,
  validatePackReport,
  validateReleaseEvidence,
} = require('../scripts/release-evidence');
const { publishArguments, publishCandidate } = require('../scripts/publish-verified-artifact');
const { guardCandidate } = require('../scripts/registry-duplicate-guard');
const {
  evaluateRegistryResult,
  expectedE404,
  isCanonicalE404Stderr,
} = require('../scripts/registry-duplicate-policy');

const ROOT = path.resolve(__dirname, '..');
const HASH = 'a'.repeat(40);
const CHECKOUT_V7_SHA = ['9c091bb21b7c1c1d1991b', 'b908d89e4e9dddfe3e0'].join('');
const SETUP_NODE_V6_SHA = ['249970729cb0ef3589644e', '2896645e5dc5ba9c38'].join('');

function releaseInput(overrides = {}) {
  const version = overrides.pkg?.version || '1.2.3';
  return {
    pkg: { name: '@aikdna/kdna-cli', version, ...overrides.pkg },
    changelog: overrides.changelog ?? `# Changelog\n\n## ${version} (2026-07-15)\n`,
    env: {
      GITHUB_EVENT_NAME: 'release',
      RELEASE_EVENT_ACTION: 'published',
      RELEASE_TAG_NAME: `v${version}`,
      RELEASE_IS_DRAFT: 'false',
      RELEASE_IS_PRERELEASE: 'false',
      GITHUB_REF: `refs/tags/v${version}`,
      GITHUB_SHA: HASH,
      ...overrides.env,
    },
    git: {
      status: '',
      head: HASH,
      tagCommit: HASH,
      ...overrides.git,
    },
  };
}

function evidence(overrides = {}) {
  const base = {
    schema: 'kdna.cli.release-evidence',
    version: '1.0',
    source: { ref: 'refs/tags/v1.2.3', commit: HASH },
    package: { name: '@aikdna/kdna-cli', version: '1.2.3' },
    artifact: {
      filename: 'aikdna-kdna-cli-1.2.3.tgz',
      integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
      shasum: 'b'.repeat(40),
      packed_size: 100,
      unpacked_size: 200,
      file_count: 1,
      files: [{ path: 'package.json', size: 200 }],
    },
  };
  return {
    ...base,
    ...overrides,
    source: { ...base.source, ...overrides.source },
    package: { ...base.package, ...overrides.package },
    artifact: { ...base.artifact, ...overrides.artifact },
  };
}

function registryMetadata(candidate = evidence(), overrides = {}) {
  return JSON.stringify({
    name: candidate.package.name,
    version: candidate.package.version,
    'dist.integrity': candidate.artifact.integrity,
    'dist.shasum': candidate.artifact.shasum,
    ...overrides,
  });
}

function e404Result(candidate = evidence(), stderr = '') {
  const expected = expectedE404(candidate);
  return {
    status: 1,
    stdout: JSON.stringify({ error: { code: 'E404', ...expected } }),
    stderr,
  };
}

function canonicalE404Stderr(candidate = evidence()) {
  const expected = expectedE404(candidate);
  const lines = expected.detail.split('\n');
  return [
    'npm error code E404',
    `npm error 404 ${expected.summary}`,
    'npm error 404',
    `npm error 404  ${lines[0]}`,
    'npm error 404',
    `npm error 404 ${lines[2]}`,
    `npm error 404 ${lines[3]}`,
    'npm error A complete log of this run can be found in: /tmp/npm-debug.log',
    '',
  ].join('\n');
}

test('publish workflow has one canonical release-only path and publishes the verified tarball', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/publish.yml'), 'utf8');
  assert.doesNotMatch(workflow, /workflow_dispatch/);
  assert.match(workflow, /release:\n\s+types: \[published\]/);
  assert.match(
    workflow,
    /concurrency:\n\s+group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.event\.release\.tag_name \}\}\n\s+cancel-in-progress: false/,
  );
  assert.match(workflow, /release\.draft == false/);
  assert.match(workflow, /release\.prerelease == false/);
  assert.match(workflow, /startsWith\(github\.event\.release\.tag_name, 'v'\)/);
  assert.match(
    workflow,
    /npm install --global npm@11\.17\.0 --ignore-scripts --registry=https:\/\/registry\.npmjs\.org\//,
  );
  assert.match(workflow, /npm --version \| grep -Fx 11\.17\.0/);
  assert.match(workflow, /npm ci --ignore-scripts/);
  assert.match(workflow, new RegExp(`actions/checkout@${CHECKOUT_V7_SHA} # v7`));
  assert.match(workflow, new RegExp(`actions/setup-node@${SETUP_NODE_V6_SHA} # v6`));
  assert.match(workflow, /npm run release:check/);
  assert.match(workflow, /npm run release:preflight/);
  assert.match(workflow, /generate-release-evidence\.js/);
  assert.match(workflow, /registry-duplicate-guard\.js/);
  assert.match(workflow, /publish-verified-artifact\.js/);
  assert.match(workflow, /--artifact "\$RUNNER_TEMP\/kdna-cli-release\.tgz"/);
  assert.match(workflow, /if: always\(\)/);
  assert.ok(workflow.indexOf('npm@11.17.0') < workflow.indexOf('npm ci --ignore-scripts'));
  assert.ok(workflow.indexOf('release:check') < workflow.indexOf('release:preflight'));
  assert.ok(workflow.indexOf('release:preflight') < workflow.indexOf('generate-release-evidence'));
  assert.ok(
    workflow.indexOf('generate-release-evidence') < workflow.indexOf('registry-duplicate-guard'),
  );
  assert.ok(
    workflow.indexOf('registry-duplicate-guard') < workflow.indexOf('publish-verified-artifact'),
  );
});

test('release context binds event, tag ref, package, changelog, HEAD, and workflow commit', () => {
  const context = validateReleaseContext(releaseInput());
  assert.deepEqual(context, {
    name: '@aikdna/kdna-cli',
    version: '1.2.3',
    tag: 'v1.2.3',
    ref: 'refs/tags/v1.2.3',
    commit: HASH,
  });
});

test('release context rejects every ambiguous or mutable release input', async (t) => {
  const cases = [
    ['renamed package', releaseInput({ pkg: { name: '@other/name' } })],
    ['prerelease version', releaseInput({ pkg: { version: '1.2.3-rc.1' } })],
    ['wrong event', releaseInput({ env: { GITHUB_EVENT_NAME: 'workflow_dispatch' } })],
    ['wrong action', releaseInput({ env: { RELEASE_EVENT_ACTION: 'created' } })],
    ['wrong event tag', releaseInput({ env: { RELEASE_TAG_NAME: 'v9.9.9' } })],
    ['draft', releaseInput({ env: { RELEASE_IS_DRAFT: 'true' } })],
    ['prerelease', releaseInput({ env: { RELEASE_IS_PRERELEASE: 'true' } })],
    ['branch ref', releaseInput({ env: { GITHUB_REF: 'refs/heads/main' } })],
    ['short workflow sha', releaseInput({ env: { GITHUB_SHA: HASH.slice(0, 12) } })],
    ['dirty tree', releaseInput({ git: { status: '?? artifact.tgz' } })],
    ['tag differs from head', releaseInput({ git: { tagCommit: 'c'.repeat(40) } })],
    ['workflow sha differs from head', releaseInput({ env: { GITHUB_SHA: 'c'.repeat(40) } })],
    ['substring changelog', releaseInput({ changelog: '# Changelog\n\nnotes for 1.2.3 only\n' })],
    ['prefix changelog heading', releaseInput({ changelog: '# Changelog\n\n## 1.2.30\n' })],
    [
      'duplicate changelog heading',
      releaseInput({ changelog: '# Changelog\n\n## 1.2.3\n\n## 1.2.3 (2026-07-15)\n' }),
    ],
    [
      'not first finalized changelog heading',
      releaseInput({ changelog: '# Changelog\n\n## 1.2.2\n\n## 1.2.3\n' }),
    ],
  ];
  for (const [name, input] of cases) {
    await t.test(name, () => assert.throws(() => validateReleaseContext(input)));
  }
});

test('current release binding rejects stale evidence before network or publication', async (t) => {
  const valid = releaseInput();
  const matching = evidence();
  assert.equal(validateCurrentReleaseBinding({ evidence: matching, ...valid }), matching);
  const cases = [
    ['evidence name', evidence({ package: { name: '@other/name' } }), valid],
    ['evidence version', evidence({ package: { version: '1.2.4' } }), valid],
    ['evidence ref', evidence({ source: { ref: 'refs/tags/v9.9.9' } }), valid],
    ['evidence commit', evidence({ source: { commit: 'c'.repeat(40) } }), valid],
    ['current package', matching, releaseInput({ pkg: { version: '1.2.4' } })],
    ['current ref', matching, releaseInput({ env: { GITHUB_REF: 'refs/tags/v9.9.9' } })],
    ['current sha', matching, releaseInput({ env: { GITHUB_SHA: 'c'.repeat(40) } })],
    ['current head', matching, releaseInput({ git: { head: 'c'.repeat(40) } })],
    ['current tag', matching, releaseInput({ git: { tagCommit: 'c'.repeat(40) } })],
    ['current dirty tree', matching, releaseInput({ git: { status: ' M package.json' } })],
  ];
  for (const [name, candidate, current] of cases) {
    await t.test(name, () =>
      assert.throws(() => validateCurrentReleaseBinding({ evidence: candidate, ...current })),
    );
  }
});

test('stale current binding prevents registry lookup and npm publication from being called', () => {
  let lookupCalls = 0;
  let publishCalls = 0;
  const stale = () => {
    throw new Error('stale binding');
  };
  assert.throws(() =>
    guardCandidate({
      evidence: evidence(),
      tarball: Buffer.from('not reached'),
      bindCurrent: stale,
      lookup: () => {
        lookupCalls += 1;
      },
    }),
  );
  assert.throws(() =>
    publishCandidate({
      evidence: evidence(),
      tarball: Buffer.from('not reached'),
      artifactPath: '/tmp/not-reached.tgz',
      bindCurrent: stale,
      publish: () => {
        publishCalls += 1;
      },
    }),
  );
  assert.equal(lookupCalls, 0);
  assert.equal(publishCalls, 0);
});

test('release evidence recomputes hashes and reads file facts from the tarball', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-cli-pack-test-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const packed = spawnSync(
    'npm',
    ['pack', '--json', '--ignore-scripts', '--pack-destination', temp],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, shell: false },
  );
  assert.equal(packed.status, 0, packed.stderr);
  const report = JSON.parse(packed.stdout)[0];
  const tarball = fs.readFileSync(path.join(temp, report.filename));
  const pkg = require('../package.json');
  const candidate = validatePackReport({
    reportText: packed.stdout,
    tarball,
    pkg,
    source: { ref: `refs/tags/v${pkg.version}`, commit: HASH },
  });
  assert.equal(candidate.artifact.shasum, crypto.createHash('sha1').update(tarball).digest('hex'));
  assert.equal(candidate.artifact.packed_size, tarball.length);
  assert.equal(candidate.artifact.files.length, candidate.artifact.file_count);
  assert.ok(candidate.artifact.files.some((file) => file.path === 'package.json'));
  assert.equal(validateReleaseEvidence(candidate), candidate);
  assert.equal(validateEvidenceArtifact(candidate, tarball), candidate);

  const tamperedReport = JSON.parse(packed.stdout);
  tamperedReport[0].integrity = `sha512-${Buffer.alloc(64, 1).toString('base64')}`;
  assert.throws(
    () =>
      validatePackReport({
        reportText: JSON.stringify(tamperedReport),
        tarball,
        pkg,
        source: { ref: `refs/tags/v${pkg.version}`, commit: HASH },
      }),
    /integrity/,
  );
  const tamperedBytes = Buffer.from(tarball);
  tamperedBytes[tamperedBytes.length - 1] ^= 1;
  assert.throws(
    () =>
      validatePackReport({
        reportText: packed.stdout,
        tarball: tamperedBytes,
        pkg,
        source: { ref: `refs/tags/v${pkg.version}`, commit: HASH },
      }),
    /shasum|integrity|tar/i,
  );
  assert.throws(() => validateEvidenceArtifact(candidate, tamperedBytes), /shasum|integrity|tar/i);
});

test('verified publisher uses the exact tarball with scripts disabled, provenance, and fixed registry', () => {
  assert.deepEqual(publishArguments('/tmp/exact.tgz'), [
    'publish',
    '/tmp/exact.tgz',
    '--ignore-scripts',
    '--provenance',
    '--access',
    'public',
    '--registry=https://registry.npmjs.org/',
  ]);
});

test('release evidence rejects forged identity, ref, hashes, counts, and sizes', async (t) => {
  const cases = [
    ['name', evidence({ package: { name: '@other/name' } })],
    ['version', evidence({ package: { version: '1.2.3-rc.1' } })],
    ['ref', evidence({ source: { ref: 'refs/heads/main' } })],
    ['commit', evidence({ source: { commit: 'abc' } })],
    ['integrity', evidence({ artifact: { integrity: 'sha512-no' } })],
    ['shasum', evidence({ artifact: { shasum: 'B'.repeat(40) } })],
    ['packed size', evidence({ artifact: { packed_size: 0 } })],
    ['unpacked size', evidence({ artifact: { unpacked_size: -1 } })],
    ['file count', evidence({ artifact: { file_count: 2 } })],
  ];
  for (const [name, candidate] of cases) {
    await t.test(name, () => assert.throws(() => validateReleaseEvidence(candidate)));
  }
});

test('exact complete E404 permits publication with silent or canonical npm diagnostics', () => {
  assert.deepEqual(evaluateRegistryResult(e404Result(), evidence()), {
    decision: 'publish',
    shouldPublish: true,
  });
  const stderr = canonicalE404Stderr();
  assert.equal(isCanonicalE404Stderr(stderr, evidence()), true);
  assert.deepEqual(evaluateRegistryResult(e404Result(evidence(), stderr), evidence()), {
    decision: 'publish',
    shouldPublish: true,
  });
});

test('registry absence policy rejects prefix, suffix, wrong target/version, extra fields, and stderr injection', async (t) => {
  const base = e404Result();
  const wrongVersion = JSON.parse(base.stdout);
  wrongVersion.error.summary = 'No match found for version 9.9.9';
  const wrongTarget = JSON.parse(base.stdout);
  wrongTarget.error.detail = wrongTarget.error.detail.replace(
    '@aikdna/kdna-cli@1.2.3',
    '@aikdna/kdna-cli@9.9.9',
  );
  const extra = JSON.parse(base.stdout);
  extra.error.retryable = true;
  const cases = [
    ['prefix', { ...base, stdout: `notice\n${base.stdout}` }],
    ['suffix', { ...base, stdout: `${base.stdout}\nnotice` }],
    ['malformed', { ...base, stdout: '{"error":' }],
    ['wrong version', { ...base, stdout: JSON.stringify(wrongVersion) }],
    ['wrong target', { ...base, stdout: JSON.stringify(wrongTarget) }],
    ['extra field', { ...base, stdout: JSON.stringify(extra) }],
    ['E401 stderr injection', { ...base, stderr: 'npm error code E401\n' }],
    ['E403 stderr injection', { ...base, stderr: `${canonicalE404Stderr()}npm error code E403\n` }],
    ['timeout text injection', { ...base, stderr: 'request timeout\n' }],
    ['outage exit', { status: 2, stdout: '', stderr: 'network unavailable' }],
    ['timeout result', { status: null, stdout: '', stderr: '', error: new Error('ETIMEDOUT') }],
    [
      'structured E401',
      {
        status: 1,
        stdout: JSON.stringify({ error: { code: 'E401', summary: 'auth', detail: 'auth' } }),
        stderr: '',
      },
    ],
  ];
  for (const [name, result] of cases) {
    await t.test(name, () => assert.throws(() => evaluateRegistryResult(result, evidence())));
  }
});

test('an existing version without registry gitHead skips only when both artifact hashes are exact', () => {
  const candidate = evidence();
  const exact = { status: 0, stdout: registryMetadata(candidate), stderr: '' };
  assert.deepEqual(evaluateRegistryResult(exact, candidate), {
    decision: 'skip-identical',
    shouldPublish: false,
  });
});

test('an existing version collision fails closed for every identity or artifact mismatch', async (t) => {
  const candidate = evidence();
  const cases = [
    ['name', { name: '@other/name' }],
    ['version', { version: '1.2.4' }],
    ['integrity', { 'dist.integrity': `sha512-${Buffer.alloc(64, 1).toString('base64')}` }],
    ['shasum', { 'dist.shasum': 'c'.repeat(40) }],
  ];
  for (const [name, changes] of cases) {
    await t.test(name, () => {
      const metadata = JSON.parse(registryMetadata(candidate, changes));
      assert.throws(() =>
        evaluateRegistryResult(
          { status: 0, stdout: JSON.stringify(metadata), stderr: '' },
          candidate,
        ),
      );
    });
  }
  assert.throws(() =>
    evaluateRegistryResult(
      { status: 0, stdout: registryMetadata(candidate), stderr: 'npm warning injected\n' },
      candidate,
    ),
  );
  assert.throws(() =>
    evaluateRegistryResult(
      { status: 0, stdout: `${registryMetadata(candidate)}\ntrailing`, stderr: '' },
      candidate,
    ),
  );
});
