'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  readCurrentReleaseBinding,
  validateCurrentReleaseBinding,
} = require('../scripts/current-release-binding');
const { validateReleaseContext } = require('../scripts/release-policy');
const { REQUIRED_CORE_VERSION, validateReleaseReadiness } = require('../scripts/release-readiness');
const {
  canonicalRegistryUrl,
  resolveTrustedNpmInvocation,
} = require('../scripts/runtime-candidate-binding');
const {
  validateEvidenceArtifact,
  validatePackReport,
  validatePackedFilePolicy,
  validateReleaseEvidence,
} = require('../scripts/release-evidence');
const { publishArguments, publishCandidate } = require('../scripts/publish-verified-artifact');
const { guardCandidate } = require('../scripts/registry-duplicate-guard');
const {
  assertTrustedIndexIsOrdinary,
  materializeTrustedCommit,
  trustedGitEnvironment,
} = require('../scripts/trusted-git');
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
      RELEASE_TAG_NAME: version,
      RELEASE_IS_DRAFT: 'false',
      RELEASE_IS_PRERELEASE: 'false',
      GITHUB_REF: `refs/tags/${version}`,
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
    source: { ref: 'refs/tags/1.2.3', commit: HASH },
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

function git(repository, args) {
  const result = spawnSync('git', ['-C', repository, ...args], {
    encoding: 'utf8',
    env: trustedGitEnvironment(),
    shell: false,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
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
  assert.doesNotMatch(workflow, /startsWith\(github\.event\.release\.tag_name, 'v'\)/);
  assert.doesNotMatch(workflow, /npm install --global|npm --version/);
  assert.match(workflow, /node scripts\/run-trusted-npm\.js ci --ignore-scripts/);
  assert.match(workflow, new RegExp(`actions/checkout@${CHECKOUT_V7_SHA} # v7`));
  assert.match(workflow, new RegExp(`actions/setup-node@${SETUP_NODE_V6_SHA} # v6`));
  assert.match(workflow, /node scripts\/release-check\.js/);
  assert.match(workflow, /node scripts\/release-preflight\.js/);
  assert.match(workflow, /generate-release-evidence\.js/);
  assert.match(workflow, /node scripts\/registry-duplicate-guard\.js/);
  assert.match(workflow, /node scripts\/publish-verified-artifact\.js/);
  assert.match(workflow, /--artifact "\$RUNNER_TEMP\/kdna-cli-release\.tgz"/);
  assert.match(workflow, /if: always\(\)/);
  assert.doesNotMatch(workflow, /\bnpm (?:ci|run|test|pack)\b/);
  assert.ok(workflow.indexOf('release-check.js') < workflow.indexOf('release-preflight.js'));
  assert.ok(
    workflow.indexOf('release-preflight.js') < workflow.indexOf('generate-release-evidence'),
  );
  assert.ok(
    workflow.indexOf('generate-release-evidence') < workflow.indexOf('registry-duplicate-guard.js'),
  );
  assert.ok(
    workflow.indexOf('registry-duplicate-guard.js') <
      workflow.indexOf('publish-verified-artifact.js'),
  );

  const preflight = fs.readFileSync(path.join(ROOT, 'scripts/release-preflight.js'), 'utf8');
  assert.match(preflight, /scripts\/check-public-surface\.mjs/);
  assert.match(preflight, /scripts\/check-current-protocol-names\.js/);

  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts.test, 'node scripts/run-complete-suite.js --complete');
  assert.equal(packageJson.scripts['test:unit'], 'node scripts/run-complete-suite.js --unit');
  assert.equal(packageJson.scripts['test:all'], 'node scripts/run-complete-suite.js --complete');
  assert.equal(packageJson.scripts['test:smoke'], 'node scripts/run-complete-suite.js --smoke');
  const completeSuite = fs.readFileSync(path.join(ROOT, 'scripts/run-complete-suite.js'), 'utf8');
  assert.match(completeSuite, /tests\/e2e-encrypt\.test\.js/);
  assert.doesNotMatch(completeSuite, /spawnSync\(['"]npm['"]/);
  assert.equal(
    packageJson.scripts['test:golden-host-request'],
    'node scripts/generate-golden-host-contract.js --check && node --test tests/golden-host-request.test.js',
  );
  assert.equal(
    packageJson.scripts['release:registry-guard'],
    'node scripts/registry-duplicate-guard.js',
  );
  assert.equal(
    packageJson.scripts['release:publish-verified'],
    'node scripts/publish-verified-artifact.js',
  );
  assert.doesNotMatch(preflight, /\['npm'/);
  assert.match(preflight, /scripts\/run-trusted-npm\.js/);
  assert.match(preflight, /scripts\/run-complete-suite\.js/);
  assert.match(preflight, /runTrustedGit\(root, \['diff', '--check'\]/);

  const ci = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  assert.doesNotMatch(ci, /npm install --global|npm --version|\bnpm run\b/);
  assert.ok((ci.match(/run-trusted-npm\.js ci/g) || []).length >= 4);
  assert.equal((ci.match(/run: npm ci --ignore-scripts --no-audit --no-fund/g) || []).length, 3);
  assert.equal(
    (ci.match(/Install Core test dependencies with its lock-compatible client/g) || []).length,
    2,
  );
  assert.match(ci, /Install dependencies for compatibility only/);
  assert.match(ci, /if: matrix\.node == 18/);
  assert.match(ci, /node scripts\/verify-core-candidate-tar\.js/);
  assert.match(ci, /node scripts\/check-public-surface\.mjs/);
  assert.doesNotMatch(ci, /npm ci --prefix \.cross-repo\/kdna/);
  assert.equal((ci.match(/working-directory: \.cross-repo\/kdna/g) || []).length, 2);
  assert.equal((ci.match(/node scripts\/verify-core-source-dependencies\.js/g) || []).length, 2);
  const registryGuard = fs.readFileSync(
    path.join(ROOT, 'scripts/registry-duplicate-guard.js'),
    'utf8',
  );
  assert.match(registryGuard, /--@aikdna:registry=https:\/\/registry\.npmjs\.org\//);

  for (const script of [
    'scripts/check-current-protocol-names.js',
    'scripts/generate-release-evidence.js',
    'scripts/generate-core-candidate-evidence.js',
    'scripts/verify-pack-policy.js',
    'scripts/verify-core-candidate-tar.js',
  ]) {
    const source = fs.readFileSync(path.join(ROOT, script), 'utf8');
    assert.match(source, /resolveTrustedNpmInvocation/);
    assert.doesNotMatch(source, /(?:execFileSync|spawnSync|run)\(\s*['"]npm['"]/);
  }

  for (const script of [
    'scripts/current-release-binding.js',
    'scripts/generate-release-evidence.js',
    'scripts/release-check.js',
    'scripts/release-preflight.js',
    'scripts/verify-pack-policy.js',
  ]) {
    const source = fs.readFileSync(path.join(ROOT, script), 'utf8');
    assert.match(source, /require\(['"]\.\/trusted-git['"]\)/);
    assert.match(source, /assertTrustedIndexIsOrdinary/);
    assert.doesNotMatch(source, /(?:execFileSync|spawnSync|run)\(\s*['"]git['"]/);
  }

  for (const script of ['scripts/generate-release-evidence.js', 'scripts/verify-pack-policy.js']) {
    const source = fs.readFileSync(path.join(ROOT, script), 'utf8');
    assert.match(source, /materializeTrustedCommit/);
    assert.doesNotMatch(source, /packOnce\(root,/);
  }

  for (const script of [
    'scripts/generate-golden-host-contract.js',
    'scripts/verify-runtime-contract-core.js',
    'scripts/verify-core-source-dependencies.js',
  ]) {
    const source = fs.readFileSync(path.join(ROOT, script), 'utf8');
    assert.match(source, /inspectCoreSourceAuthority/);
    assert.doesNotMatch(source, /(?:execFileSync|spawnSync|run)\(\s*['"]git['"]/);
  }
});

test('release context binds event, tag ref, package, changelog, HEAD, and workflow commit', () => {
  const context = validateReleaseContext(releaseInput());
  assert.deepEqual(context, {
    name: '@aikdna/kdna-cli',
    version: '1.2.3',
    tag: '1.2.3',
    ref: 'refs/tags/1.2.3',
    commit: HASH,
  });
});

test('current release Git binding ignores hostile Git environment redirection', (t) => {
  const repository = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-cli-release-git-')),
  );
  t.after(() => fs.rmSync(repository, { recursive: true, force: true }));
  git(repository, ['init', '--quiet']);
  git(repository, ['config', 'user.email', 'test@example.invalid']);
  git(repository, ['config', 'user.name', 'KDNA Test']);
  fs.writeFileSync(
    path.join(repository, 'package.json'),
    `${JSON.stringify({ name: '@aikdna/kdna-cli', version: '1.2.3' })}\n`,
  );
  fs.writeFileSync(path.join(repository, 'CHANGELOG.md'), '# Changelog\n\n## 1.2.3 (2026-07-15)\n');
  git(repository, ['add', '--all']);
  git(repository, ['commit', '--quiet', '-m', 'test: release binding']);
  git(repository, ['tag', '1.2.3']);
  const commit = git(repository, ['rev-parse', 'HEAD']);
  const poison = path.join(repository, 'hostile-git-environment');
  const variables = {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_GLOBAL: path.join(poison, 'global-config'),
    GIT_CONFIG_KEY_0: 'core.useReplaceRefs',
    GIT_CONFIG_SYSTEM: path.join(poison, 'system-config'),
    GIT_CONFIG_VALUE_0: 'true',
    GIT_DIR: path.join(poison, '.git'),
    GIT_INDEX_FILE: path.join(poison, 'index'),
    GIT_OBJECT_DIRECTORY: path.join(poison, 'objects'),
    GIT_WORK_TREE: poison,
  };
  const previous = new Map(Object.keys(variables).map((name) => [name, process.env[name]]));
  Object.assign(process.env, variables);
  try {
    const candidate = evidence({ source: { ref: 'refs/tags/1.2.3', commit } });
    const release = releaseInput({ env: { GITHUB_SHA: commit } });
    assert.deepEqual(
      readCurrentReleaseBinding({ root: repository, evidence: candidate, env: release.env }),
      candidate,
    );
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  git(repository, ['update-index', '--assume-unchanged', 'package.json']);
  fs.writeFileSync(
    path.join(repository, 'package.json'),
    `${JSON.stringify({ name: '@aikdna/kdna-cli', version: '9.9.9' })}\n`,
  );
  assert.throws(() => assertTrustedIndexIsOrdinary(repository), /hidden or non-ordinary state/);
  const materialized = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-release-commit-tree-')),
  );
  t.after(() => fs.rmSync(materialized, { recursive: true, force: true }));
  materializeTrustedCommit(repository, commit, materialized);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(materialized, 'package.json'), 'utf8')), {
    name: '@aikdna/kdna-cli',
    version: '1.2.3',
  });
  assert.throws(
    () =>
      readCurrentReleaseBinding({
        root: repository,
        evidence: evidence({ source: { ref: 'refs/tags/1.2.3', commit } }),
        env: releaseInput({ env: { GITHUB_SHA: commit } }).env,
      }),
    /hidden or non-ordinary state/,
  );
  git(repository, ['update-index', '--no-assume-unchanged', 'package.json']);
  git(repository, ['checkout', '--', 'package.json']);

  fs.writeFileSync(path.join(repository, 'replacement.txt'), 'replacement\n');
  git(repository, ['add', 'replacement.txt']);
  git(repository, ['commit', '--quiet', '-m', 'test: replacement commit']);
  const replacement = git(repository, ['rev-parse', 'HEAD']);
  git(repository, ['checkout', '--quiet', '--detach', commit]);
  git(repository, ['replace', commit, replacement]);
  assert.throws(
    () =>
      readCurrentReleaseBinding({
        root: repository,
        evidence: evidence({ source: { ref: 'refs/tags/1.2.3', commit } }),
        env: releaseInput({ env: { GITHUB_SHA: commit } }).env,
      }),
    /must not contain Git replace refs/,
  );
});

test('release readiness requires the formal Core release across manifest, lock, and install', () => {
  const integrity = `sha512-${Buffer.alloc(64).toString('base64')}`;
  const pkg = {
    name: '@aikdna/kdna-cli',
    version: '0.34.0',
    dependencies: { '@aikdna/kdna-core': REQUIRED_CORE_VERSION },
  };
  const lock = {
    lockfileVersion: 3,
    packages: {
      '': {
        name: pkg.name,
        version: pkg.version,
        dependencies: { '@aikdna/kdna-core': REQUIRED_CORE_VERSION },
      },
      'node_modules/@aikdna/kdna-core': {
        version: REQUIRED_CORE_VERSION,
        resolved: canonicalRegistryUrl('@aikdna/kdna-core', REQUIRED_CORE_VERSION),
        integrity,
      },
    },
  };
  const installedCore = { name: '@aikdna/kdna-core', version: REQUIRED_CORE_VERSION };
  assert.deepEqual(validateReleaseReadiness({ pkg, lock, installedCore }), {
    cli: '@aikdna/kdna-cli@0.34.0',
    core: `@aikdna/kdna-core@${REQUIRED_CORE_VERSION}`,
  });

  assert.throws(
    () =>
      validateReleaseReadiness({
        pkg: { ...pkg, dependencies: { '@aikdna/kdna-core': '0.18.0' } },
        lock,
        installedCore,
      }),
    /Core dependency must be/,
  );
  assert.throws(
    () =>
      validateReleaseReadiness({
        pkg,
        lock: {
          ...lock,
          packages: {
            ...lock.packages,
            'node_modules/@aikdna/kdna-core': { version: '0.18.0' },
          },
        },
        installedCore,
      }),
    /locked Core artifact is stale/,
  );
  assert.throws(
    () =>
      validateReleaseReadiness({
        pkg,
        lock: {
          ...lock,
          packages: {
            ...lock.packages,
            'node_modules/@aikdna/kdna-core': {
              ...lock.packages['node_modules/@aikdna/kdna-core'],
              resolved: 'file:tests/fixtures/runtime-candidates/kdna-core-0.19.0.tgz',
            },
          },
        },
        installedCore,
      }),
    /canonical registry artifact/,
  );
  assert.throws(
    () =>
      validateReleaseReadiness({
        pkg,
        lock: {
          ...lock,
          packages: {
            ...lock.packages,
            'node_modules/@aikdna/kdna-core': {
              ...lock.packages['node_modules/@aikdna/kdna-core'],
              integrity: '',
            },
          },
        },
        installedCore,
      }),
    /integrity is missing or invalid/,
  );

  const currentPackage = require('../package.json');
  const currentLock = require('../package-lock.json');
  const currentInstalledCore = require('@aikdna/kdna-core/package.json');
  assert.equal(currentPackage.dependencies['@aikdna/kdna-core'], REQUIRED_CORE_VERSION);
  assert.throws(
    () =>
      validateReleaseReadiness({
        pkg: currentPackage,
        lock: currentLock,
        installedCore: currentInstalledCore,
      }),
    /canonical registry artifact/,
  );
});

test('release context rejects every ambiguous or mutable release input', async (t) => {
  const cases = [
    ['renamed package', releaseInput({ pkg: { name: '@other/name' } })],
    ['prerelease version', releaseInput({ pkg: { version: '1.2.3-rc.1' } })],
    ['wrong event', releaseInput({ env: { GITHUB_EVENT_NAME: 'workflow_dispatch' } })],
    ['wrong action', releaseInput({ env: { RELEASE_EVENT_ACTION: 'created' } })],
    ['wrong event tag', releaseInput({ env: { RELEASE_TAG_NAME: '9.9.9' } })],
    ['prefixed event tag', releaseInput({ env: { RELEASE_TAG_NAME: 'v1.2.3' } })],
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
    ['evidence ref', evidence({ source: { ref: 'refs/tags/9.9.9' } }), valid],
    ['evidence commit', evidence({ source: { commit: 'c'.repeat(40) } }), valid],
    ['current package', matching, releaseInput({ pkg: { version: '1.2.4' } })],
    ['current ref', matching, releaseInput({ env: { GITHUB_REF: 'refs/tags/9.9.9' } })],
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
  const npm = resolveTrustedNpmInvocation(ROOT);
  let packed;
  try {
    packed = spawnSync(
      npm.command,
      [
        ...npm.prefixArgs,
        'pack',
        '--json',
        '--ignore-scripts',
        '--pack-destination',
        temp,
        '--registry=https://registry.npmjs.org/',
        '--@aikdna:registry=https://registry.npmjs.org/',
      ],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, shell: false },
    );
  } finally {
    npm.dispose();
  }
  assert.equal(packed.status, 0, packed.stderr);
  const report = JSON.parse(packed.stdout)[0];
  const tarball = fs.readFileSync(path.join(temp, report.filename));
  const pkg = require('../package.json');
  const candidate = validatePackReport({
    reportText: packed.stdout,
    tarball,
    pkg,
    source: { ref: `refs/tags/${pkg.version}`, commit: HASH },
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
        source: { ref: `refs/tags/${pkg.version}`, commit: HASH },
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
        source: { ref: `refs/tags/${pkg.version}`, commit: HASH },
      }),
    /shasum|integrity|tar/i,
  );
  assert.throws(() => validateEvidenceArtifact(candidate, tamperedBytes), /shasum|integrity|tar/i);
});

test('pack policy requires the current runtime surface and rejects retired or private files', () => {
  const required = [
    'package.json',
    'src/cli.js',
    'src/runtime-contract.js',
    'src/agent-host-capabilities.js',
    'src/agent-host-process.js',
    'src/cmds/plan-use.js',
    'src/cmds/use.js',
    'validators/kdna-lint.js',
    'validators/kdna-validate.js',
    'skills/kdna-loader/SKILL.md',
    'schema/manifest.schema.json',
    'schema/payload-profile.schema.json',
    'schema/load-contract.schema.json',
    'schema/trace.schema.json',
    'fixtures/minimal/kdna.json',
    'fixtures/minimal/payload.kdnab',
    'fixtures/judgment/kdna.json',
    'fixtures/judgment/payload.kdnab',
  ].map((file) => ({ path: file, size: 1 }));
  assert.equal(validatePackedFilePolicy(required), required);
  assert.throws(
    () => validatePackedFilePolicy([...required, { path: 'tests/private.test.js', size: 1 }]),
    /unexpected packed file/,
  );
  for (const hostilePath of [
    'src/AGENTS.md',
    'src/WORKLOG.md',
    'templates/private-launch-plan.md',
    'skills/kdna-loader/credentials.txt',
  ]) {
    assert.throws(
      () => validatePackedFilePolicy([...required, { path: hostilePath, size: 1 }]),
      /private coordination file|sensitive-category file/,
      hostilePath,
    );
  }
  assert.throws(
    () => validatePackedFilePolicy([...required, { path: 'src/runner.js', size: 1 }]),
    /retired implementation was packed/,
  );
  assert.throws(
    () =>
      validatePackedFilePolicy(required.filter((file) => file.path !== 'src/runtime-contract.js')),
    /required packed file is missing/,
  );
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
    '--@aikdna:registry=https://registry.npmjs.org/',
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
