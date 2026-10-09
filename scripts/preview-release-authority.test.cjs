'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const authority = require('./preview-release-authority.cjs');
const publisher = require('./preview-release-publisher.cjs');
const trusted = require('./release-tools/core-release-authority.js');
const SHA = 'a'.repeat(40),
  TREE = 'b'.repeat(40),
  OTHER = 'c'.repeat(40),
  DIGEST = 'd'.repeat(64);
function body(f) {
  f.event.release.body =
    f.notes + '\n\n```kdna-preview-release\n' + JSON.stringify(f.approval, null, 2) + '\n```';
}
function fixture() {
  const pkg = {
    name: authority.POLICIES.cli.name,
    version: authority.POLICIES.cli.version,
    files: authority.SOURCE_FILES.filter((x) => x !== 'package.json'),
    bin: { kdna: 'src/cli.js' },
    dependencies: Object.fromEntries(authority.COMPANIONS.map((x) => [x.name, x.version])),
  };
  const notes = '## CLI ' + pkg.version + '\n\nExact native source change notes and preview scope.';
  const approval = {
    schema: 'kdna.preview-release-approval/1',
    unit: 'cli',
    repository: 'aikdna/kdna-cli',
    source_commit: SHA,
    source_tree: TREE,
    base_commit: authority.BASE_COMMIT,
    version: pkg.version,
    dist_tag: 'native-preview',
    artifact_sha256: DIGEST,
    notes_sha256: trusted.sha256(Buffer.from(notes)),
    companions: authority.COMPANIONS.map((x) => ({
      ...x,
      integrity: 'sha512-' + Buffer.alloc(64).toString('base64'),
      shasum: OTHER,
      gitHead: SHA,
    })),
  };
  const tag = 'preview/cli/' + pkg.version;
  const event = {
    action: 'published',
    repository: { full_name: 'aikdna/kdna-cli' },
    release: {
      id: 1,
      published_at: '2026-10-09T00:00:00Z',
      draft: false,
      prerelease: true,
      tag_name: tag,
      target_commitish: SHA,
      html_url: 'https://github.com/aikdna/kdna-cli/releases/tag/' + tag,
    },
  };
  const env = {
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'aikdna/kdna-cli',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_EVENT_NAME: 'release',
    GITHUB_REF: 'refs/tags/' + tag,
    GITHUB_REF_TYPE: 'tag',
    GITHUB_REF_NAME: tag,
    GITHUB_SHA: SHA,
  };
  const f = {
    unit: 'cli',
    pkg,
    notes,
    approval,
    event,
    env,
    observation: {
      commit: SHA,
      tree: TREE,
      tagCommit: SHA,
      clean: true,
      mainContainsSource: true,
      dco: true,
      baseCommit: authority.BASE_COMMIT,
    },
  };
  body(f);
  return f;
}
function directory() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-cli-preview-test-')));
}
function git(root, args) {
  return execFileSync(
    '/usr/bin/git',
    [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'user.name=Fixture Author',
      '-c',
      'user.email=fixture@example.invalid',
      ...args,
    ],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        PATH: '/usr/bin:/bin',
        HOME: root,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
      },
    },
  ).trim();
}
function sourceFixture() {
  const root = directory(),
    f = fixture();
  fs.writeFileSync(path.join(root, 'base.txt'), 'baseline\n');
  git(root, ['init', '--quiet']);
  git(root, ['add', '.']);
  git(root, ['commit', '--quiet', '--no-gpg-sign', '-s', '-m', 'baseline']);
  const baseline = git(root, ['rev-parse', 'HEAD']);
  const binding = {
    implementation: { name: f.pkg.name, version: f.pkg.version },
    release_state: 'RELEASE_CANDIDATE',
    accepted_core: {
      version: authority.COMPANIONS[0].version,
      tar_sha256: authority.COMPANIONS[0].sha256,
    },
    accepted_read: {
      version: authority.COMPANIONS[1].version,
      tar_sha256: authority.COMPANIONS[1].sha256,
    },
  };
  const members = Object.fromEntries(
    authority.SOURCE_FILES.map((x) => [
      x,
      x === 'package.json'
        ? JSON.stringify(f.pkg) + '\n'
        : x === 'public-contract-binding.json'
          ? JSON.stringify(binding) + '\n'
          : 'fixture\n',
    ]),
  );
  for (const [file, content] of Object.entries(members)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  fs.mkdirSync(path.join(root, 'release-surface'));
  fs.writeFileSync(
    path.join(root, 'release-surface/npm-file-allowlist.json'),
    JSON.stringify({ files: authority.SOURCE_FILES }),
  );
  fs.writeFileSync(path.join(root, 'docs/release-cli-preview-notes.md'), f.notes + '\n');
  git(root, ['add', '.']);
  git(root, ['commit', '--quiet', '--no-gpg-sign', '-s', '-m', 'preview']);
  return { root, baseline, members };
}
function tarball(members, mode = 0o644) {
  const chunks = [];
  for (const [name, value] of Object.entries(members)) {
    const bytes = Buffer.from(value),
      header = Buffer.alloc(512);
    header.write('package/' + name, 0, 100, 'utf8');
    const octal = (at, width, number) =>
      header.write(number.toString(8).padStart(width - 1, '0') + '\0', at, width, 'ascii');
    octal(100, 8, mode);
    octal(108, 8, 0);
    octal(116, 8, 0);
    octal(124, 12, bytes.length);
    octal(136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = 0x30;
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    header.write(
      header
        .reduce((sum, byte) => sum + byte, 0)
        .toString(8)
        .padStart(6, '0') + '\0 ',
      148,
      8,
      'ascii',
    );
    chunks.push(header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(chunks));
}
test('only exact CLI published prerelease context passes', () => {
  assert.equal(authority.validateContext(fixture()).authorization, 'published-prerelease-event');
});
test('wrong event/tag/commit/tree/dirty/DCO/notes/artifact/channel/companions fail closed', async (t) => {
  const cases = [
    ['fake dispatch', (f) => (f.env.GITHUB_EVENT_NAME = 'workflow_dispatch')],
    ['local event', (f) => (f.env.GITHUB_ACTIONS = 'false')],
    ['wrong repo', (f) => (f.env.GITHUB_REPOSITORY = 'aikdna/kdna')],
    ['draft', (f) => (f.event.release.draft = true)],
    ['stable', (f) => (f.event.release.prerelease = false)],
    ['edited', (f) => (f.event.action = 'edited')],
    ['wrong tag', (f) => (f.event.release.tag_name += '-changed')],
    ['wrong ref', (f) => (f.env.GITHUB_REF = 'refs/heads/main')],
    ['wrong SHA', (f) => (f.env.GITHUB_SHA = OTHER)],
    ['branch target', (f) => (f.event.release.target_commitish = 'main')],
    ['wrong tree', (f) => (f.approval.source_tree = OTHER)],
    ['dirty', (f) => (f.observation.clean = false)],
    ['tag moved', (f) => (f.observation.tagCommit = OTHER)],
    ['not main', (f) => (f.observation.mainContainsSource = false)],
    ['no DCO', (f) => (f.observation.dco = false)],
    ['latest', (f) => (f.approval.dist_tag = 'latest')],
    ['bad artifact', (f) => (f.approval.artifact_sha256 = 'invalid')],
    ['wrong version', (f) => (f.pkg.version = '0.39.0-rc.native-sections.2')],
    ['unknown approval key', (f) => (f.approval.allow_dirty = true)],
    ['notes changed', (f) => (f.notes += 'changed')],
    ['body changed', (f) => (f.event.release.body += '\nextra')],
    [
      'duplicate JSON keys',
      (f) =>
        (f.event.release.body = f.event.release.body.replace(
          '"unit": "cli",',
          '"unit": "cli", "unit": "other",',
        )),
    ],
    ['private', (f) => (f.pkg.private = true)],
    ['file dependency', (f) => (f.pkg.dependencies['@aikdna/kdna-core'] = 'file:../core')],
    ['missing files', (f) => f.pkg.files.pop()],
    ['extra file', (f) => f.pkg.files.push('secret.txt')],
    ['companion changed', (f) => (f.approval.companions[0].sha256 = DIGEST)],
    ['companion source pair', (f) => (f.approval.companions[1].gitHead = OTHER)],
    ['missing companion', (f) => f.approval.companions.pop()],
  ];
  for (const [name, change] of cases)
    await t.test(name, () => {
      const f = fixture();
      change(f);
      assert.throws(() => authority.validateContext(f));
    });
});
test('real Git inspection requires exact source file manifest, clean index and all commit DCO', () => {
  const f = sourceFixture();
  try {
    const source = authority.inspectSource('cli', f.root, { baseline: f.baseline });
    assert.equal(source.commit, git(f.root, ['rev-parse', 'HEAD']));
    assert.equal(source.tree, git(f.root, ['rev-parse', 'HEAD^{tree}']));
    fs.writeFileSync(path.join(f.root, 'untracked'), 'new');
    assert.throws(() => authority.inspectSource('cli', f.root, { baseline: f.baseline }), /clean/u);
    fs.rmSync(path.join(f.root, 'untracked'));
    fs.appendFileSync(path.join(f.root, 'src/public-cli.js'), '// changed');
    git(f.root, ['add', '.']);
    assert.throws(() => authority.inspectSource('cli', f.root, { baseline: f.baseline }), /clean/u);
    git(f.root, ['commit', '--quiet', '--no-gpg-sign', '-m', 'missing DCO']);
    assert.throws(() => authority.inspectSource('cli', f.root, { baseline: f.baseline }), /DCO/u);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
test('every retained artifact member is source-bound, exact set and mode required', () => {
  const f = sourceFixture();
  try {
    const tree = trusted.inspectTree(git(f.root, ['rev-parse', 'HEAD']), f.root),
      bytes = tarball(f.members);
    assert.equal(
      authority.validateArtifact(bytes, authority.POLICIES.cli, tree, f.root).files.length,
      17,
    );
    assert.throws(
      () =>
        authority.validateArtifact(
          tarball({ ...f.members, 'src/public-cli.js': 'changed' }),
          authority.POLICIES.cli,
          tree,
          f.root,
        ),
      /differs from source/u,
    );
    assert.throws(
      () =>
        authority.validateArtifact(
          tarball({ ...f.members, 'extra.js': 'extra' }),
          authority.POLICIES.cli,
          tree,
          f.root,
        ),
      /member manifest/u,
    );
    assert.throws(
      () =>
        authority.validateArtifact(tarball(f.members, 0o755), authority.POLICIES.cli, tree, f.root),
      /mode/u,
    );
    assert.throws(
      () =>
        authority.validateArtifact(
          tarball({
            ...f.members,
            'package.json': JSON.stringify({ ...fixture().pkg, gitHead: SHA }),
          }),
          authority.POLICIES.cli,
        ),
      /publisher-owned/u,
    );
    const missing = { ...f.members };
    delete missing.LICENSE;
    assert.throws(
      () => authority.validateArtifact(tarball(missing), authority.POLICIES.cli),
      /member manifest/u,
    );
    const installed = path.join(f.root, 'installed');
    fs.mkdirSync(installed);
    for (const [file, content] of Object.entries(f.members)) {
      fs.mkdirSync(path.dirname(path.join(installed, file)), { recursive: true });
      fs.writeFileSync(path.join(installed, file), content);
    }
    authority.verifyInstalledMembers(installed, bytes);
    fs.writeFileSync(path.join(installed, 'extra'), 'extra');
    assert.throws(() => authority.verifyInstalledMembers(installed, bytes), /extra/u);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
test('duplicate same identity skips, changed bytes/source and ambiguous failures reject', () => {
  const expected = {
    name: authority.POLICIES.cli.name,
    version: authority.POLICIES.cli.version,
    integrity: 'sha512-fixture',
    shasum: OTHER,
    gitHead: SHA,
  };
  const result = (change) => ({
    status: 0,
    stderr: '',
    stdout: JSON.stringify({
      name: expected.name,
      version: expected.version,
      'dist.integrity': expected.integrity,
      'dist.shasum': expected.shasum,
      gitHead: expected.gitHead,
      ...change,
    }),
  });
  assert.equal(authority.registryDecision(result({}), expected).decision, 'skip-identical');
  for (const change of [
    { 'dist.integrity': 'different' },
    { 'dist.shasum': SHA },
    { gitHead: OTHER },
    { version: '0.39.0' },
    { extra: true },
  ])
    assert.throws(() => authority.registryDecision(result(change), expected), /collision|fields/u);
  for (const invalid of [
    { status: 1, stderr: '', stdout: '{}' },
    { status: 1, stderr: 'auth failed', stdout: '' },
    { status: 0, stderr: '', stdout: 'invalid' },
  ])
    assert.throws(() => authority.registryDecision(invalid, expected));
  const error = {
    code: 'E404',
    summary: 'No match found for version ' + expected.version,
    detail:
      "The requested resource '" +
      expected.name +
      '@' +
      expected.version +
      "' could not be found or you do not have permission to access it.\n\nNote that you can also install from a\ntarball, folder, http url, or git url.",
  };
  assert.equal(
    authority.registryDecision(
      { status: 1, stderr: '', stdout: JSON.stringify({ error }) },
      expected,
    ).shouldPublish,
    true,
  );
  error.code = 'E401';
  assert.throws(() =>
    authority.registryDecision(
      { status: 1, stderr: '', stdout: JSON.stringify({ error }) },
      expected,
    ),
  );
});
test('exact native-preview and unchanged latest are mandatory for existing/public versions', () => {
  const before = { latest: '0.36.1' },
    after = { ...before, 'native-preview': authority.POLICIES.cli.version };
  assert.equal(
    authority.validateChannel(after, before, authority.POLICIES.cli.version, true).latest_unchanged,
    true,
  );
  assert.throws(
    () => authority.validateChannel(before, before, authority.POLICIES.cli.version, true),
    /dist-tag/u,
  );
  assert.throws(
    () =>
      authority.validateChannel(
        { ...after, latest: authority.POLICIES.cli.version },
        before,
        authority.POLICIES.cli.version,
        true,
      ),
    /latest/u,
  );
  assert.throws(() => authority.validateDistTags({ latest: 'file:local' }));
});
test('publisher passes retained bytes only, fixed preview tag and provenance; modified artifact rejects', async () => {
  const root = directory();
  try {
    const artifactPath = path.join(root, 'retained.tgz'),
      manifestPath = path.join(root, 'manifest.json'),
      bytes = Buffer.from('fixture bytes');
    fs.writeFileSync(artifactPath, bytes);
    fs.writeFileSync(manifestPath, JSON.stringify({ ...fixture().pkg, gitHead: SHA }));
    let calls = 0;
    const options = {
      libraryPath: '/fixture/audited-library',
      manifestPath,
      artifactPath,
      artifactSha256: trusted.sha256(bytes),
      token: 'synthetic-fixture',
      library: {
        publish: async (manifest, packed, config) => {
          calls++;
          assert.equal(manifest.gitHead, SHA);
          assert.ok(packed.equals(bytes));
          assert.equal(config.defaultTag, 'native-preview');
          assert.equal(config.provenance, true);
          assert.equal(config.registry, 'https://registry.npmjs.org/');
        },
      },
    };
    await publisher.publishVerified(options);
    assert.equal(calls, 1);
    fs.appendFileSync(artifactPath, 'changed');
    await assert.rejects(publisher.publishVerified(options), /digest/u);
    assert.equal(calls, 1);
    fs.writeFileSync(artifactPath, bytes);
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({ ...fixture().pkg, gitHead: SHA, publishConfig: { tag: 'latest' } }),
    );
    await assert.rejects(publisher.publishVerified(options), /conflicting/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('local candidate cannot obtain publication authority through function or CLI overrides', () => {
  assert.throws(() => authority.publish({ requireRelease: false }), /real release authority/u);
  assert.throws(() => authority.parseArgs(['publish', '--unit', 'cli', '--skip-release', 'true']));
  assert.throws(() => authority.parseArgs(['publish', '--unit', 'cli', '--unit', 'cli']));
});
test('vendored public origin hashes are exact and stable authority exports disabled', () => {
  const origin = JSON.parse(fs.readFileSync(path.join(__dirname, 'release-tools/ORIGIN.json')));
  assert.equal(origin.repository, 'https://github.com/aikdna/kdna');
  assert.match(origin.commit, /^[a-f0-9]{40}$/u);
  for (const entry of origin.files)
    assert.equal(
      trusted.sha256(fs.readFileSync(path.join(__dirname, '..', entry.vendored_path))),
      entry.vendored_sha256,
    );
  for (const forbidden of [
    'inspectAuthoritativeRelease',
    'publishCandidate',
    'prepareRelease',
    'validateReleaseContext',
  ])
    assert.equal(trusted[forbidden], undefined);
  const child = require('node:child_process').spawnSync(
    process.execPath,
    [path.join(__dirname, 'release-tools/core-release-authority.js')],
    { encoding: 'utf8' },
  );
  assert.notEqual(child.status, 0);
});
