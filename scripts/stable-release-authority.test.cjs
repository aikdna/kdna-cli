'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAuthority } = require('./release-channel-authority.cjs');
const trusted = require('./release-tools/core-release-authority.js');
const publisher = require('./stable-release-publisher.cjs');
const COMMIT = 'a'.repeat(40), TREE = 'b'.repeat(40), BASE = 'c'.repeat(40);
const configuration = {
  channel: 'stable', version: '0.39.0', base_commit: BASE,
  companions: [
    {name: '@aikdna/kdna-core', version: '0.37.3', sha256: 'd'.repeat(64)},
    {name: '@aikdna/kdna-read', version: '0.12.0', sha256: 'e'.repeat(64)},
  ],
};
const authority = createAuthority(configuration);
test('release-path manifest validation refuses the pinned candidate coordinate; only the source-host check may opt in', () => {
  const pinned = {name: '@aikdna/kdna-cli', version: '0.39.0',
    dependencies: {'@aikdna/kdna-core': 'file:vendor/aikdna-kdna-core-0.37.3.tgz', '@aikdna/kdna-read': '0.12.0'}};
  // Default (release-path) contexts keep the strict registry-only rule: the
  // pinned candidate coordinate is refused even though the source-host source
  // check accepts the exact same graph under its explicit allowance.
  assert.throws(() => authority.validateManifest(pinned, 'cli'), /exact registry dependency coordinates/);
  // The allowance names the exact pinned shape: any other file: form is still
  // refused when the allowance is requested.
  assert.throws(
    () => authority.validateManifest({...pinned, dependencies: {'@aikdna/kdna-core': 'file:../outside.tgz', '@aikdna/kdna-read': '0.12.0'}},
      'cli', {allowPinnedFileCoordinates: true}),
    /exact registry dependency coordinates/,
  );
});
function fixture() {
  const pkg = {name: '@aikdna/kdna-cli', version: '0.39.0',
    files: authority.SOURCE_FILES.filter(file => file !== 'package.json'),
    bin: {kdna: 'src/cli.js'}, dependencies: {'@aikdna/kdna-core': '0.37.3', '@aikdna/kdna-read': '0.12.0'}};
  const notes = '## CLI 0.39.0\n\nExact stable native source and independently approved companion bytes.';
  const approval = {schema: 'kdna.stable-release-approval/1', unit: 'cli', repository: 'aikdna/kdna-cli',
    source_commit: COMMIT, source_tree: TREE, base_commit: BASE, version: pkg.version,
    dist_tag: 'latest', artifact_sha256: 'f'.repeat(64), notes_sha256: trusted.sha256(Buffer.from(notes)),
    companions: configuration.companions.map(peer => ({...peer, integrity: 'sha512-' + Buffer.alloc(64).toString('base64'), shasum: COMMIT, gitHead: COMMIT}))};
  const event = {action: 'published', repository: {full_name: 'aikdna/kdna-cli'},
    release: {id: 7, published_at: '2026-10-11T00:00:00Z', draft: false, prerelease: false,
      tag_name: '0.39.0', target_commitish: COMMIT, html_url: 'https://github.com/aikdna/kdna-cli/releases/tag/0.39.0',
      body: notes + '\n\n```kdna-stable-release\n' + JSON.stringify(approval, null, 2) + '\n```'}};
  return {unit: 'cli', pkg, notes, approval, event,
    env: {GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'aikdna/kdna-cli', GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_EVENT_NAME: 'release', GITHUB_REF: 'refs/tags/0.39.0', GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: '0.39.0', GITHUB_SHA: COMMIT},
    observation: {commit: COMMIT, tree: TREE, tagCommit: COMMIT, clean: true, mainContainsSource: true, dco: true, baseCommit: BASE}};
}
test('stable channel requires its own exact non-prerelease event and approval', () => {
  const f = fixture();
  const context = authority.validateContext(f);
  assert.equal(context.tag, '0.39.0');
  assert.equal(context.authorization, 'published-stable-release-event');
  for (const change of [
    f => f.event.release.prerelease = true,
    f => f.event.release.draft = true,
    f => f.event.action = 'edited',
    f => f.event.repository.full_name = 'other/kdna-cli',
    f => f.event.release.tag_name = 'preview/cli/0.39.0',
    f => f.event.release.target_commitish = BASE,
    f => f.env.GITHUB_ACTIONS = 'false',
    f => f.env.GITHUB_REF = 'refs/heads/main',
    f => f.env.GITHUB_SHA = BASE,
    f => f.observation.clean = false,
    f => f.observation.mainContainsSource = false,
    f => f.observation.dco = false,
    f => f.observation.tree = BASE,
    f => f.approval.schema = 'kdna.preview-release-approval/1',
    f => f.approval.dist_tag = 'native-preview',
    f => f.approval.companions[0].sha256 = '0'.repeat(64),
    f => f.approval.companions[1].gitHead = BASE,
    f => f.event.release.body = f.event.release.body.replace('kdna-stable-release', 'kdna-preview-release'),
  ]) {
    const bad = fixture(); change(bad);
    assert.throws(() => authority.validateContext(bad));
  }
});
test('stable coordinates reject RC aliases and leave other dist-tags unchanged', () => {
  for (const version of ['0.39.0-rc.native-sections.3', 'v0.39.0', '00.39.0', '0.39', '0.39.9007199254740992'])
    assert.throws(() => createAuthority({...configuration, version}));
  const before = {latest: '0.36.1', 'native-preview': '0.39.0-rc.native-sections.3'};
  assert.equal(authority.validateChannel({...before, latest: '0.39.0'}, before, '0.39.0', true).latest_unchanged, false);
  assert.equal(authority.validateChannel(before, before, '0.39.0', false).latest_unchanged, true);
  assert.throws(() => authority.validateChannel(before, before, '0.39.0', true));
  assert.throws(() => authority.validateChannel({...before, latest: '0.39.0'}, before, '0.39.0', false));
  assert.throws(() => authority.validateChannel({...before, latest: '0.39.0', 'native-preview': '0.39.0'}, before, '0.39.0', true));
});
test('stable publish failures expose policy observations without provider bodies', () => {
  const sentinel = 'synthetic-provider-body-and-secret';
  let output = '';
  const write = process.stderr.write;
  process.stderr.write = chunk => { output += String(chunk); return true; };
  try {
    authority.reportPublisherFailure({
      result: {status: 1, signal: null, error: {message: sentinel}, stdout: sentinel, stderr: sentinel},
      token: sentinel,
      invocation: {command: '/synthetic/node', prefixArgs: ['/synthetic/npm-cli.js']},
      expected: {name: '@aikdna/kdna-cli', version: '0.39.0'},
      decision: {decision: 'publish', shouldPublish: true},
      distTagsBefore: {stdout: JSON.stringify({latest: '0.36.1'})},
    });
  } finally { process.stderr.write = write; }
  assert.equal(output.includes(sentinel), false);
  assert.equal(output.includes('publisher-stdout'), false);
  assert.equal(output.includes('publisher-stderr'), false);
  assert.match(output, /"status":1/u);
  assert.match(output, /registry-decision/u);
});
test('source Host rejects a self-consistent earlier SDK graph before installation', () => {
  const peers = configuration.companions.map(peer => ({...peer}));
  const receipts = [...peers, ...Array.from({length: 9}, (_, index) => ({
    name: 'synthetic-dependency-' + index, version: '1.0.0', sha256: '0'.repeat(64),
  }))];
  assert.equal(authority.validateSourceHostCompanions(receipts), true);
  for (const change of [
    rows => rows[0].version = '0.37.1-rc.browser.1',
    rows => rows[1].version = '0.11.2-rc.browser.1',
    rows => rows[0].sha256 = '0'.repeat(64),
    rows => rows[1].sha256 = '0'.repeat(64),
    rows => rows[0].name = rows[1].name,
    rows => rows[1].name = 'synthetic-unapproved-read',
  ]) {
    const bad = structuredClone(receipts); change(bad);
    assert.throws(() => authority.validateSourceHostCompanions(bad));
  }
});
test('stable publisher passes only exact retained bytes and stable identity to the audited library', async () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-cli-stable-publisher-')));
  try {
    const artifactPath = path.join(directory, 'artifact.tgz'), manifestPath = path.join(directory, 'manifest.json');
    const bytes = Buffer.from('retained fixture bytes');
    fs.writeFileSync(artifactPath, bytes);fs.writeFileSync(manifestPath, JSON.stringify({name: '@aikdna/kdna-cli', version: '0.43.0', gitHead: COMMIT}));
    let calls = 0;
    const options = {libraryPath: path.join(directory, 'audited-library.js'), artifactPath, manifestPath,
      artifactSha256: trusted.sha256(bytes), token: 'synthetic-token',
      library: {async publish(manifest, actual, settings) {
        calls++; assert.equal(manifest.version, '0.43.0'); assert.deepEqual(actual, bytes);
        assert.equal(settings.defaultTag, 'latest');assert.equal(settings.provenance, true);
      }}};
    assert.equal(await publisher.publishVerified(options), true);assert.equal(calls, 1);
    await assert.rejects(publisher.publishVerified({...options, artifactSha256: '0'.repeat(64)}));
    fs.writeFileSync(manifestPath, JSON.stringify({name: '@aikdna/kdna-cli', version: '0.39.0-rc.native-sections.3', gitHead: COMMIT}));
    await assert.rejects(publisher.publishVerified(options));assert.equal(calls, 1);
  } finally {fs.rmSync(directory, {recursive: true, force: true});}
});
