#!/usr/bin/env node
'use strict';

// This is a separate, exact prerelease channel. Stable release policy is unchanged.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const trusted = require('./release-tools/core-release-authority.js');
const ROOT = path.resolve(__dirname, '..');
const REPOSITORY = 'aikdna/kdna-cli';
const DIST_TAG = 'native-preview';
const BASE_COMMIT = '2adb6d403802e2ba6b9923258959c2179e05e32c';
const HEX40 = /^[a-f0-9]{40}$/u;
const HEX64 = /^[a-f0-9]{64}$/u;
const POLICIES = Object.freeze({
  cli: Object.freeze({
    name: '@aikdna/kdna-cli',
    version: '0.39.0-rc.native-sections.3',
    directory: '',
  }),
});
const SOURCE_FILES = Object.freeze([
  'LICENSE',
  'LICENSE-DOCS',
  'NOTICE',
  'README.md',
  'public-contract-binding.json',
  'src/cli.js',
  'src/public-cli.js',
  'src/authored-input.js',
  'src/source-input.js',
  'SECURITY.md',
  'docs/asset-authorization.md',
  'docs/consumption-runtime.md',
  'docs/native-delivery.md',
  'examples/native-workflow.cjs',
  'examples/team-update/author.json',
  'examples/team-update/README.md',
  'package.json',
]);
const COMPANIONS = Object.freeze([
  Object.freeze({
    name: '@aikdna/kdna-core',
    version: '0.37.1-rc.browser.1',
    sha256: '81639dd57dc3a56a2d9171ce3a6ce956847f4877461b8722897e4f598aa8a8ca',
  }),
  Object.freeze({
    name: '@aikdna/kdna-read',
    version: '0.11.2-rc.browser.1',
    sha256: 'c5c2d6b65c44dd30aeddd49d6f2a4c915e9fd4d8f2a28297d6d677564e261cb7',
  }),
]);
function sourcePath(pkg, file) {
  return pkg.directory ? pkg.directory + '/' + file : file;
}
const APPROVAL_KEYS = [
  'schema',
  'unit',
  'repository',
  'source_commit',
  'source_tree',
  'base_commit',
  'version',
  'dist_tag',
  'artifact_sha256',
  'notes_sha256',
  'companions',
];
function assert(value, message) {
  if (!value) throw new Error(message);
}
function exactKeys(value, keys, label) {
  assert(value && typeof value === 'object' && !Array.isArray(value), label + ' must be an object');
  assert(
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()),
    label + ' fields are not exact',
  );
}
function policy(unit) {
  assert(Object.hasOwn(POLICIES, unit), 'unsupported preview package');
  return POLICIES[unit];
}
function filename(pkg) {
  return (
    (pkg.name.startsWith('@') ? pkg.name.slice(1).replace('/', '-') : pkg.name) +
    '-' +
    pkg.version +
    '.tgz'
  );
}
function git(args, root) {
  return trusted
    .runGit(args, { cwd: root, encoding: 'utf8', label: 'preview Git observation' })
    .stdout.trim();
}
function readRegular(file, label, maximum = 8 * 1024 * 1024) {
  const full = path.resolve(file);
  assert(fs.realpathSync(full) === full, label + ' must have a canonical path');
  const stat = fs.lstatSync(full);
  assert(
    stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= maximum,
    label + ' must be one bounded regular file',
  );
  return fs.readFileSync(full);
}
function readSource(tree, relative, root) {
  const entry = tree.entries.find((x) => x.path === relative);
  assert(entry, 'source file missing: ' + relative);
  return trusted.batchReadBlobs([entry], root)[0];
}
function previewNotes(text, unit) {
  const heading = '## ' + 'CLI ' + policy(unit).version;
  const sections = text.split(/(?=^## )/mu).filter((x) => x.startsWith(heading + '\n'));
  assert(sections.length === 1, 'exact preview change notes are missing or duplicated');
  const notes = sections[0].trim();
  assert(notes.length > heading.length + 30, 'preview change notes are empty');
  return notes;
}
function validateManifest(pkg, unit) {
  const expected = policy(unit);
  assert(
    pkg && pkg.name === expected.name && pkg.version === expected.version && pkg.private !== true,
    'preview source manifest identity mismatch',
  );
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const spec of Object.values(pkg[field] || {}))
      assert(
        typeof spec === 'string' &&
          /^\d+\.\d+\.\d+(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/u.test(spec),
        'preview package requires exact registry dependency coordinates',
      );
  }
  assert(
    JSON.stringify(Object.keys(pkg.dependencies || {}).sort()) ===
      JSON.stringify(COMPANIONS.map((x) => x.name).sort()),
    'CLI preview requires exactly Core/Read dependencies',
  );
  for (const peer of COMPANIONS)
    assert(pkg.dependencies[peer.name] === peer.version, 'CLI preview companion version mismatch');
  assert(
    !pkg.peerDependencies && !pkg.optionalDependencies && !pkg.bundledDependencies,
    'CLI preview dependency fields invalid',
  );
  assert(
    Array.isArray(pkg.files) &&
      JSON.stringify([...pkg.files].sort()) ===
        JSON.stringify(SOURCE_FILES.filter((x) => x !== 'package.json').sort()),
    'CLI source file manifest mismatch',
  );
  assert(
    JSON.stringify(pkg.bin) === JSON.stringify({ kdna: 'src/cli.js' }),
    'CLI source binary mismatch',
  );
  return pkg;
}
function validateApproval(approval, unit) {
  const pkg = policy(unit);
  exactKeys(approval, APPROVAL_KEYS, 'preview approval');
  assert(approval.schema === 'kdna.preview-release-approval/1', 'preview approval schema mismatch');
  assert(
    approval.unit === unit && approval.repository === REPOSITORY,
    'preview approval target mismatch',
  );
  assert(approval.version === pkg.version, 'preview approval version mismatch');
  assert(
    approval.dist_tag === DIST_TAG && approval.dist_tag !== 'latest',
    'preview dist-tag must be native-preview',
  );
  assert(approval.base_commit === BASE_COMMIT, 'preview approved baseline mismatch');
  assert(
    HEX40.test(approval.source_commit) && HEX40.test(approval.source_tree),
    'preview source coordinate invalid',
  );
  assert(
    HEX64.test(approval.artifact_sha256) && HEX64.test(approval.notes_sha256),
    'preview approved digest invalid',
  );
  assert(
    Array.isArray(approval.companions) && approval.companions.length === 2,
    'CLI preview requires two approved companions',
  );
  for (let i = 0; i < COMPANIONS.length; i++) {
    const expected = COMPANIONS[i],
      peer = approval.companions[i];
    exactKeys(
      peer,
      ['name', 'version', 'sha256', 'integrity', 'shasum', 'gitHead'],
      'CLI preview companion',
    );
    assert(
      peer.name === expected.name &&
        peer.version === expected.version &&
        peer.sha256 === expected.sha256,
      'CLI preview companion identity/bytes mismatch',
    );
    assert(
      HEX40.test(peer.gitHead) &&
        HEX40.test(peer.shasum) &&
        /^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(peer.integrity),
      'CLI preview companion registry coordinate invalid',
    );
  }
  assert(
    approval.companions[0].gitHead === approval.companions[1].gitHead,
    'CLI preview companion source pair mismatch',
  );
  return approval;
}
function parseReleaseBody(body, unit) {
  assert(typeof body === 'string', 'preview release body missing');
  const blocks = [...body.matchAll(/^```kdna-preview-release\n([\s\S]*?)\n```\s*$/gmu)];
  assert(blocks.length === 1, 'exactly one final preview approval block is required');
  const block = blocks[0];
  assert(
    body.slice(block.index + block[0].length).trim() === '',
    'preview approval must be the final release body block',
  );
  const notes = body.slice(0, block.index).trim();
  const approval = validateApproval(
    trusted.strictJson(Buffer.from(block[1]), 'preview approval'),
    unit,
  );
  assert(
    trusted.sha256(Buffer.from(notes)) === approval.notes_sha256,
    'preview release notes digest mismatch',
  );
  return { approval, notes };
}
function validateContext({ pkg, unit, notes, approval, event, env, observation }) {
  const expected = policy(unit);
  const tag = 'preview/' + unit + '/' + expected.version;
  validateManifest(pkg, unit);
  validateApproval(approval, unit);
  assert(
    env.GITHUB_ACTIONS === 'true' &&
      env.GITHUB_REPOSITORY === REPOSITORY &&
      env.GITHUB_SERVER_URL === 'https://github.com',
    'preview requires official GitHub Actions repository context',
  );
  assert(
    env.GITHUB_EVENT_NAME === 'release' && event.action === 'published',
    'preview requires a real published release event',
  );
  assert(
    event.repository?.full_name === REPOSITORY &&
      event.release?.draft === false &&
      event.release?.prerelease === true,
    'preview requires a nondraft prerelease in the exact repository',
  );
  assert(
    event.release.tag_name === tag &&
      event.release.html_url === 'https://github.com/' + REPOSITORY + '/releases/tag/' + tag,
    'preview event scoped tag mismatch',
  );
  assert(
    event.release.target_commitish === observation.commit,
    'preview release target must name the exact source commit',
  );
  assert(
    Number.isSafeInteger(event.release.id) &&
      event.release.id > 0 &&
      typeof event.release.published_at === 'string',
    'preview release identity missing',
  );
  assert(
    env.GITHUB_REF === 'refs/tags/' + tag &&
      env.GITHUB_REF_TYPE === 'tag' &&
      env.GITHUB_REF_NAME === tag,
    'preview GitHub tag ref mismatch',
  );
  assert(
    env.GITHUB_SHA === observation.commit &&
      approval.source_commit === observation.commit &&
      approval.source_tree === observation.tree,
    'preview source commit/tree mismatch',
  );
  assert(
    observation.tagCommit === observation.commit &&
      observation.clean === true &&
      observation.mainContainsSource === true,
    'preview tag/source/clean/main binding mismatch',
  );
  assert(
    observation.dco === true && observation.baseCommit === approval.base_commit,
    'preview source range DCO mismatch',
  );
  assert(
    trusted.sha256(Buffer.from(notes)) === approval.notes_sha256,
    'preview source change notes mismatch',
  );
  const parsed = parseReleaseBody(event.release.body, unit);
  assert(
    JSON.stringify(parsed.approval) === JSON.stringify(approval) && parsed.notes === notes,
    'preview event body does not match source notes and approved artifact',
  );
  return {
    unit,
    package: expected,
    tag,
    commit: observation.commit,
    tree: observation.tree,
    approval,
    notes_sha256: approval.notes_sha256,
    authorization: 'published-prerelease-event',
    release_id: event.release.id,
  };
}
function inspectSource(unit, root = ROOT, { requireMain = false, baseline = BASE_COMMIT } = {}) {
  const pkg = policy(unit);
  assert(
    fs.realpathSync(git(['rev-parse', '--show-toplevel'], root)) === fs.realpathSync(root),
    'preview repository root is ambiguous',
  );
  const commit = git(['rev-parse', '--verify', 'HEAD^{commit}'], root);
  const tree = trusted.inspectTree(commit, root);
  assert(
    git(['status', '--porcelain=v2', '--untracked-files=all'], root) === '',
    'preview source worktree must be clean',
  );
  trusted.assertIndexMatchesTree(tree, root);
  git(['merge-base', '--is-ancestor', baseline, commit], root);
  const commits = git(['rev-list', baseline + '..' + commit], root)
    .split('\n')
    .filter(Boolean);
  assert(
    commits.length > 0 && commits.length <= 100,
    'preview source range must be a bounded nonempty change',
  );
  for (const current of commits) trusted.commitDocument(current, root);
  const manifest = trusted.strictJson(
    readSource(tree, sourcePath(pkg, 'package.json'), root),
    'preview source manifest',
  );
  validateManifest(manifest, unit);
  const allowlist = trusted.strictJson(
    readSource(tree, 'release-surface/npm-file-allowlist.json', root),
    'CLI package file allowlist',
  );
  assert(
    JSON.stringify([...(allowlist.files || [])].sort()) ===
      JSON.stringify([...SOURCE_FILES].sort()),
    'CLI committed package allowlist mismatch',
  );
  const binding = trusted.strictJson(
    readSource(tree, 'public-contract-binding.json', root),
    'CLI public contract binding',
  );
  assert(
    binding.implementation?.name === pkg.name &&
      binding.implementation?.version === pkg.version &&
      binding.release_state === 'RELEASE_CANDIDATE',
    'CLI source contract identity mismatch',
  );
  for (const [key, peer] of [
    ['accepted_core', COMPANIONS[0]],
    ['accepted_read', COMPANIONS[1]],
  ])
    assert(
      binding[key]?.version === peer.version && binding[key]?.tar_sha256 === peer.sha256,
      'CLI exact companion source binding mismatch',
    );
  const notes = previewNotes(
    readSource(tree, 'docs/release-cli-preview-notes.md', root).toString('utf8'),
    unit,
  );
  if (requireMain) git(['merge-base', '--is-ancestor', commit, 'refs/remotes/origin/main'], root);
  return {
    unit,
    package: pkg,
    commit,
    tree: tree.tree,
    treeState: tree,
    notes,
    manifest,
    baseCommit: baseline,
    clean: true,
    dco: true,
    dco_commit_count: commits.length,
    mainContainsSource: requireMain,
  };
}
function inspectRelease(unit, env = process.env, root = ROOT) {
  const source = inspectSource(unit, root, { requireMain: true });
  const event = trusted.strictJson(
    readRegular(env.GITHUB_EVENT_PATH, 'GitHub release event'),
    'GitHub release event',
  );
  const { approval } = parseReleaseBody(event.release?.body, unit);
  const tag = 'preview/' + unit + '/' + source.package.version;
  git(['show-ref', '--verify', '--hash', 'refs/tags/' + tag], root);
  const tagCommit = git(['rev-parse', '--verify', 'refs/tags/' + tag + '^{commit}'], root);
  return {
    ...source,
    ...validateContext({
      pkg: source.manifest,
      unit,
      notes: source.notes,
      approval,
      event,
      env,
      observation: { ...source, tagCommit },
    }),
  };
}
function validateArtifact(bytes, pkg, tree, root) {
  const files = trusted.parseTarFiles(bytes, { includeBytes: true });
  assert(
    JSON.stringify(files.map((x) => x.path).sort()) === JSON.stringify([...SOURCE_FILES].sort()),
    'CLI artifact member manifest mismatch',
  );
  const manifestFile = files.find((x) => x.path === 'package.json');
  assert(manifestFile, 'preview artifact has no manifest');
  const manifest = trusted.strictJson(manifestFile.bytes, 'preview artifact manifest');
  const unit = Object.keys(POLICIES).find((unit) => POLICIES[unit].name === pkg.name);
  validateManifest(manifest, unit);
  for (const field of [
    '_id',
    '_nodeVersion',
    '_npmVersion',
    'dist',
    'gitHead',
    'tag',
    'publishConfig',
  ])
    assert(
      !Object.hasOwn(manifest, field),
      'preview artifact contains publisher-owned metadata: ' + field,
    );
  assert(
    files.some((x) => x.path === 'LICENSE') && files.some((x) => x.path === 'NOTICE'),
    'preview artifact license/notice missing',
  );
  if (tree) {
    const entries = files.map((file) => {
      const entry = tree.entries.find((x) => x.path === sourcePath(pkg, file.path));
      assert(entry, 'preview artifact member has no exact source: ' + file.path);
      assert(
        file.mode === (entry.mode === '100755' ? 0o755 : 0o644),
        'preview artifact member source mode mismatch',
      );
      return entry;
    });
    const blobs = trusted.batchReadBlobs(entries, root);
    files.forEach((file, index) =>
      assert(
        file.bytes.equals(blobs[index]),
        'preview artifact member differs from source: ' + file.path,
      ),
    );
  }
  return {
    filename: filename(pkg),
    sha256: trusted.sha256(bytes),
    shasum: trusted.sha1(bytes),
    integrity: trusted.integrity(bytes),
    bytes: bytes.length,
    files: files.map(({ bytes: omitted, ...entry }) => entry),
  };
}
function packSource(sourceRoot, context, invocation, work, label) {
  const destination = path.join(work, label);
  fs.mkdirSync(destination, { mode: 0o700 });
  const result = trusted.runNpm(
    invocation,
    ['pack', '--json', '--ignore-scripts', '--pack-destination', destination],
    {
      cwd: path.join(sourceRoot, context.package.directory),
      projectRoot: sourceRoot,
      label: 'preview exact-source pack',
      timeout: 120000,
    },
  );
  assert(result.stderr === '', 'preview pack wrote unexpected diagnostics');
  const report = trusted.strictJson(result.stdout, 'preview pack report');
  assert(
    Array.isArray(report) &&
      report.length === 1 &&
      report[0].filename === filename(context.package),
    'preview pack output identity mismatch',
  );
  const bytes = readRegular(
    path.join(destination, report[0].filename),
    'preview packed artifact',
    trusted.TAR_LIMITS.packedBytes,
  );
  const artifact = validateArtifact(bytes, context.package, context.treeState, context.objectRoot);
  assert(
    report[0].name === context.package.name &&
      report[0].version === context.package.version &&
      report[0].size === bytes.length &&
      report[0].shasum === artifact.shasum &&
      report[0].integrity === artifact.integrity,
    'preview pack report disagrees with bytes',
  );
  const reportedFiles = report[0].files
    .map(({ path: filePath, size, mode }) => ({ path: filePath, size, mode }))
    .sort((a, b) => a.path.localeCompare(b.path));
  assert(
    JSON.stringify(reportedFiles) ===
      JSON.stringify(
        artifact.files.map(({ path: filePath, size, mode }) => ({ path: filePath, size, mode })),
      ),
    'preview pack member report disagrees with tar',
  );
  assert(
    report[0].entryCount === artifact.files.length &&
      report[0].unpackedSize === artifact.files.reduce((n, f) => n + f.size, 0) &&
      report[0].bundled.length === 0,
    'preview pack counts/bundles disagree',
  );
  return { bytes, artifact };
}
function build({
  unit,
  evidencePath,
  artifactPath,
  env = process.env,
  root = ROOT,
  candidate = false,
}) {
  const context = candidate ? inspectSource(unit, root) : inspectRelease(unit, env, root);
  const evidenceOutput = trusted.assertOutsideRepository(evidencePath, 'preview evidence', root);
  const artifactOutput = trusted.assertOutsideRepository(artifactPath, 'preview artifact', root);
  assert(
    evidenceOutput !== artifactOutput &&
      !fs.existsSync(evidenceOutput) &&
      !fs.existsSync(artifactOutput),
    'preview outputs must be new distinct files',
  );
  assert(
    path.basename(artifactOutput) === filename(context.package),
    'preview artifact output filename mismatch',
  );
  const work = trusted.makePrivateTemp('kdna-preview-build-');
  let invocation;
  const created = [];
  try {
    invocation = trusted.resolveTrustedNpmInvocation({ environment: env, root });
    const sources = [1, 2].map((n) =>
      trusted.materializeTree(context.treeState, path.join(work, 'source-' + n), root),
    );
    for (const source of sources)
      trusted.initializeIsolatedGateRepository(source, context.treeState, context.commit, root);
    for (const script of ['check-surface.cjs', 'check-inventory.cjs']) {
      const checked = spawnSync(invocation.command, [path.join(sources[0], 'scripts', script)], {
        cwd: sources[0],
        encoding: 'utf8',
        env: trusted.cleanNpmEnvironment({
          invocation,
          home: path.join(work, 'gate-' + script),
          cache: path.join(work, 'gate-cache-' + script),
          environment: env,
        }),
        timeout: 120000,
      });
      assert(
        !checked.error && checked.status === 0,
        'CLI preview exact-source surface/inventory gate failed',
      );
    }
    const first = packSource(
      sources[0],
      { ...context, objectRoot: root },
      invocation,
      work,
      'pack-one',
    );
    const second = packSource(
      sources[1],
      { ...context, objectRoot: root },
      invocation,
      work,
      'pack-two',
    );
    assert(first.bytes.equals(second.bytes), 'preview exact-source packs differ');
    if (!candidate)
      assert(
        first.artifact.sha256 === context.approval.artifact_sha256,
        'preview bytes differ from Owner-approved artifact SHA',
      );
    const evidence = {
      schema: 'kdna.preview-release-evidence/1',
      authorization: candidate ? 'local-candidate-no-publication-authority' : context.authorization,
      unit,
      source: {
        repository: REPOSITORY,
        commit: context.commit,
        tree: context.tree,
        base_commit: context.baseCommit,
        dco_commit_count: context.dco_commit_count,
      },
      package: context.package,
      dist_tag: DIST_TAG,
      notes_sha256: trusted.sha256(Buffer.from(context.notes)),
      approval: candidate ? null : context.approval,
      release_id: candidate ? null : context.release_id,
      registry_before: candidate ? null : lookupDistTags(invocation, context.package.name, work),
      tooling: {
        npm: trusted.AUDITED_NPM_VERSION,
        node: process.version,
        platform: process.platform,
        arch: process.arch,
      },
      build: {
        materialization: 'git-cat-file-blobs',
        independent_source_exports: 2,
        same_platform_byte_equal: true,
        source_member_equality: true,
        source_surface_inventory: true,
      },
      artifact: first.artifact,
    };
    for (const output of [artifactOutput, evidenceOutput])
      fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
    fs.writeFileSync(artifactOutput, first.bytes, { flag: 'wx', mode: 0o600 });
    created.push(artifactOutput);
    fs.writeFileSync(evidenceOutput, JSON.stringify(evidence, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    created.push(evidenceOutput);
    assert(
      readRegular(
        artifactOutput,
        'retained preview artifact',
        trusted.TAR_LIMITS.packedBytes,
      ).equals(first.bytes),
      'retained preview artifact changed',
    );
    const rebound = candidate ? inspectSource(unit, root) : inspectRelease(unit, env, root);
    assert(
      rebound.commit === context.commit && rebound.tree === context.tree,
      'preview source changed while building',
    );
    return evidence;
  } catch (error) {
    for (const output of created) fs.rmSync(output, { force: true });
    throw error;
  } finally {
    if (invocation) invocation.cleanup();
    fs.rmSync(work, { recursive: true, force: true });
  }
}
function readCandidate({
  unit,
  evidencePath,
  artifactPath,
  env = process.env,
  root = ROOT,
  requireRelease = true,
}) {
  trusted.assertOutsideRepository(evidencePath, 'preview evidence', root);
  trusted.assertOutsideRepository(artifactPath, 'preview artifact', root);
  const evidence = trusted.strictJson(
    readRegular(evidencePath, 'preview evidence'),
    'preview evidence',
  );
  exactKeys(
    evidence,
    [
      'schema',
      'authorization',
      'unit',
      'source',
      'package',
      'dist_tag',
      'notes_sha256',
      'approval',
      'release_id',
      'registry_before',
      'tooling',
      'build',
      'artifact',
    ],
    'preview evidence',
  );
  assert(
    evidence.schema === 'kdna.preview-release-evidence/1' &&
      evidence.unit === unit &&
      evidence.dist_tag === DIST_TAG,
    'preview evidence target/channel mismatch',
  );
  exactKeys(
    evidence.source,
    ['repository', 'commit', 'tree', 'base_commit', 'dco_commit_count'],
    'preview evidence source',
  );
  exactKeys(evidence.tooling, ['npm', 'node', 'platform', 'arch'], 'preview evidence tooling');
  const context = requireRelease ? inspectRelease(unit, env, root) : inspectSource(unit, root);
  assert(
    evidence.source.dco_commit_count === context.dco_commit_count,
    'preview evidence DCO range count mismatch',
  );
  assert(
    evidence.source.commit === context.commit &&
      evidence.source.tree === context.tree &&
      evidence.source.base_commit === context.baseCommit &&
      evidence.source.repository === REPOSITORY,
    'preview evidence source binding stale',
  );
  assert(
    JSON.stringify(evidence.package) === JSON.stringify(context.package),
    'preview evidence package binding stale',
  );
  assert(
    evidence.notes_sha256 === trusted.sha256(Buffer.from(context.notes)),
    'preview evidence notes binding stale',
  );
  assert(
    evidence.tooling.npm === trusted.AUDITED_NPM_VERSION &&
      evidence.tooling.node === process.version &&
      evidence.tooling.platform === process.platform &&
      evidence.tooling.arch === process.arch,
    'preview evidence tooling binding stale',
  );
  assert(
    JSON.stringify(evidence.build) ===
      JSON.stringify({
        materialization: 'git-cat-file-blobs',
        independent_source_exports: 2,
        same_platform_byte_equal: true,
        source_member_equality: true,
        source_surface_inventory: true,
      }),
    'preview evidence build claims invalid',
  );
  if (requireRelease) validateDistTags(evidence.registry_before);
  if (requireRelease)
    assert(
      evidence.authorization === 'published-prerelease-event' &&
        evidence.release_id === context.release_id &&
        JSON.stringify(evidence.approval) === JSON.stringify(context.approval),
      'preview evidence has no current real release authority',
    );
  else
    assert(
      ['local-candidate-no-publication-authority', 'published-prerelease-event'].includes(
        evidence.authorization,
      ),
      'preview evidence authorization invalid',
    );
  const bytes = readRegular(
    artifactPath,
    'retained preview artifact',
    trusted.TAR_LIMITS.packedBytes,
  );
  const artifact = validateArtifact(bytes, context.package, context.treeState, root);
  assert(
    JSON.stringify(artifact) === JSON.stringify(evidence.artifact),
    'preview evidence/artifact mismatch',
  );
  assert(path.basename(artifactPath) === artifact.filename, 'preview retained filename mismatch');
  if (requireRelease)
    assert(
      artifact.sha256 === context.approval.artifact_sha256,
      'preview retained artifact differs from approval',
    );
  return { evidence, bytes, context };
}
function registryDecision(result, expected) {
  assert(
    result &&
      !result.error &&
      Number.isInteger(result.status) &&
      typeof result.stdout === 'string' &&
      result.stderr === '',
    'preview registry lookup failed',
  );
  if (result.status === 1) {
    const document = trusted.strictJson(result.stdout, 'preview registry absence');
    exactKeys(document, ['error'], 'preview registry absence');
    exactKeys(document.error, ['code', 'summary', 'detail'], 'preview registry absence detail');
    const spec = expected.name + '@' + expected.version;
    assert(
      document.error.code === 'E404' &&
        document.error.summary === 'No match found for version ' + expected.version &&
        document.error.detail ===
          "The requested resource '" +
            spec +
            "' could not be found or you do not have permission to access it.\n\nNote that you can also install from a\ntarball, folder, http url, or git url.",
      'preview registry absence is not exact',
    );
    return { decision: 'publish', shouldPublish: true };
  }
  assert(result.status === 0, 'preview registry lookup failed');
  const data = trusted.strictJson(result.stdout, 'preview registry metadata');
  exactKeys(
    data,
    ['name', 'version', 'dist.integrity', 'dist.shasum', 'gitHead'],
    'preview registry metadata',
  );
  assert(
    data.name === expected.name &&
      data.version === expected.version &&
      data['dist.integrity'] === expected.integrity &&
      data['dist.shasum'] === expected.shasum &&
      data.gitHead === expected.gitHead,
    'preview registry version collision',
  );
  return { decision: 'skip-identical', shouldPublish: false };
}
function lookup(invocation, expected, work) {
  return spawnSync(
    invocation.command,
    [
      ...invocation.prefixArgs,
      'view',
      expected.name + '@' + expected.version,
      'name',
      'version',
      'dist.integrity',
      'dist.shasum',
      'gitHead',
      '--json',
      '--loglevel=silent',
      '--registry=' + trusted.OFFICIAL_REGISTRY,
    ],
    {
      cwd: work,
      encoding: 'utf8',
      env: trusted.cleanNpmEnvironment({
        invocation,
        home: path.join(work, 'home'),
        cache: path.join(work, 'cache'),
      }),
      maxBuffer: 1024 * 1024,
      timeout: 30000,
    },
  );
}
function validateDistTags(tags) {
  assert(
    tags && typeof tags === 'object' && !Array.isArray(tags),
    'preview registry dist-tags invalid',
  );
  for (const [tag, version] of Object.entries(tags))
    assert(
      /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(tag) &&
        typeof version === 'string' &&
        /^\d+\.\d+\.\d+(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/u.test(version),
      'preview registry dist-tags invalid',
    );
  assert(typeof tags.latest === 'string', 'preview registry latest baseline missing');
  return tags;
}
function lookupDistTags(invocation, name, work) {
  const result = spawnSync(
    invocation.command,
    [
      ...invocation.prefixArgs,
      'view',
      name,
      'dist-tags',
      '--json',
      '--prefer-online',
      '--loglevel=silent',
      '--registry=' + trusted.OFFICIAL_REGISTRY,
    ],
    {
      cwd: work,
      encoding: 'utf8',
      env: trusted.cleanNpmEnvironment({
        invocation,
        home: path.join(work, 'tag-home'),
        cache: path.join(work, 'tag-cache'),
      }),
      maxBuffer: 1024 * 1024,
      timeout: 30000,
    },
  );
  assert(
    !result.error &&
      result.status === 0 &&
      result.stderr === '' &&
      typeof result.stdout === 'string',
    'preview registry dist-tags lookup failed',
  );
  return validateDistTags(trusted.strictJson(result.stdout, 'preview registry dist-tags'));
}
function validateChannel(tags, before, version, requirePreview = false) {
  validateDistTags(tags);
  validateDistTags(before);
  assert(
    tags.latest === before.latest,
    'preview publication changed latest or latest baseline is stale',
  );
  if (requirePreview)
    assert(
      tags[DIST_TAG] === version,
      'preview registry dist-tag does not select exact published version',
    );
  return {
    dist_tag: DIST_TAG,
    version: tags[DIST_TAG] || null,
    latest_before: before.latest,
    latest_after: tags.latest,
    latest_unchanged: true,
  };
}
function expectedRegistry(candidate) {
  return {
    name: candidate.context.package.name,
    version: candidate.context.package.version,
    integrity: candidate.evidence.artifact.integrity,
    shasum: candidate.evidence.artifact.shasum,
    gitHead: candidate.context.commit,
  };
}
function withInvocation(options, action) {
  const candidate = readCandidate(options);
  const work = trusted.makePrivateTemp('kdna-preview-operation-');
  let invocation;
  try {
    invocation = trusted.resolveTrustedNpmInvocation({
      environment: options.env || process.env,
      root: options.root || ROOT,
    });
    return action(candidate, invocation, work);
  } finally {
    if (invocation) invocation.cleanup();
    fs.rmSync(work, { recursive: true, force: true });
  }
}
function guard(options) {
  return withInvocation(options, (candidate, invocation, work) => {
    const decision = registryDecision(
      lookup(invocation, expectedRegistry(candidate), work),
      expectedRegistry(candidate),
    );
    const channel = validateChannel(
      lookupDistTags(invocation, candidate.context.package.name, work),
      candidate.evidence.registry_before,
      candidate.context.package.version,
      !decision.shouldPublish,
    );
    if (!decision.shouldPublish)
      smoke({ ...options, requireRelease: true, publicAcquisition: true });
    return { ...decision, channel };
  });
}
function publish(options) {
  assert(options.requireRelease !== false, 'preview publish requires real release authority');
  // Publication itself requires the exact public companion journey, even when
  // invoked directly rather than through the workflow's earlier smoke step.
  smoke({ ...options, requireRelease: true });
  return withInvocation({ ...options, requireRelease: true }, (candidate, invocation, work) => {
    const expected = expectedRegistry(candidate);
    const decision = registryDecision(lookup(invocation, expected, work), expected);
    const channelBefore = validateChannel(
      lookupDistTags(invocation, expected.name, work),
      candidate.evidence.registry_before,
      expected.version,
      !decision.shouldPublish,
    );
    if (!decision.shouldPublish) {
      smoke({ ...options, requireRelease: true, publicAcquisition: true });
      return { ...decision, channel: channelBefore };
    }
    const rebound = readCandidate({ ...options, requireRelease: true });
    assert(rebound.bytes.equals(candidate.bytes), 'preview artifact changed before publish');
    const artifact = path.join(work, candidate.evidence.artifact.filename);
    fs.writeFileSync(artifact, candidate.bytes, { flag: 'wx', mode: 0o600 });
    const manifest = trusted.strictJson(
      trusted
        .parseTarFiles(candidate.bytes, { includeBytes: true })
        .find((x) => x.path === 'package.json').bytes,
      'preview publisher manifest',
    );
    const manifestPath = path.join(work, 'manifest.json');
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({ ...manifest, gitHead: candidate.context.commit }) + '\n',
      { flag: 'wx', mode: 0o600 },
    );
    const tree = candidate.context.treeState;
    const publisher = path.join(work, 'publisher.js');
    fs.writeFileSync(
      publisher,
      readSource(tree, 'scripts/preview-release-publisher.cjs', options.root || ROOT),
      { flag: 'wx', mode: 0o600 },
    );
    const environment = trusted.cleanNpmEnvironment({
      invocation,
      home: path.join(work, 'auth-home'),
      cache: path.join(work, 'auth-cache'),
      environment: options.env || process.env,
      allowAuth: true,
    });
    assert(
      typeof environment.NODE_AUTH_TOKEN === 'string' && environment.NODE_AUTH_TOKEN !== '',
      'preview publication token missing',
    );
    const result = spawnSync(
      invocation.command,
      [
        publisher,
        invocation.publishLibraryPath,
        manifestPath,
        artifact,
        candidate.evidence.artifact.sha256,
      ],
      { cwd: work, env: environment, encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 300000 },
    );
    assert(!result.error && result.status === 0, 'verified preview publisher failed');
    const channel = validateChannel(
      lookupDistTags(invocation, expected.name, work),
      candidate.evidence.registry_before,
      expected.version,
      true,
    );
    return { decision: 'published', shouldPublish: true, channel };
  });
}
function smoke(options) {
  return withInvocation(
    { ...options, requireRelease: options.requireRelease ?? true },
    (candidate, invocation, work) => {
      const packages = [
        {
          name: candidate.context.package.name,
          version: candidate.context.package.version,
          bytes: candidate.bytes,
        },
      ];
      fs.mkdirSync(path.join(work, 'vendor'), { mode: 0o700 });
      let dependencies;
      if (options.requireRelease === false) {
        const receipt = trusted.strictJson(
          readSource(
            candidate.context.treeState,
            'release-surface/native-delivery-archives.json',
            options.root || ROOT,
          ),
          'CLI source dependency receipts',
        );
        assert(
          receipt.archives?.length === 11,
          'CLI candidate requires complete eleven-archive graph',
        );
        for (const input of receipt.archives) {
          assert(
            typeof input.file === 'string' && path.basename(input.file) === input.file,
            'CLI dependency filename invalid',
          );
          const bytes = readSource(
            candidate.context.treeState,
            'vendor/' + input.file,
            options.root || ROOT,
          );
          assert(
            trusted.sha256(bytes) === input.sha256 &&
              trusted.integrity(bytes) === input.integrity &&
              bytes.length === input.bytes,
            'CLI source dependency receipt mismatch',
          );
          const members = trusted.parseTarFiles(bytes, { includeBytes: true });
          const manifest = trusted.strictJson(
            members.find((x) => x.path === 'package.json').bytes,
            'CLI source dependency manifest',
          );
          assert(
            manifest.name === input.name && manifest.version === input.version,
            'CLI source dependency identity mismatch',
          );
          const peer = COMPANIONS.find((x) => x.name === input.name);
          if (peer)
            assert(
              input.version === peer.version && input.sha256 === peer.sha256,
              'CLI candidate companion bytes mismatch',
            );
          packages.push({ name: input.name, version: input.version, bytes });
        }
        assert(
          new Set(packages.map((x) => x.name)).size === 12 &&
            COMPANIONS.every((peer) => packages.some((x) => x.name === peer.name)),
          'CLI candidate dependency graph duplicate or missing',
        );
        dependencies = Object.fromEntries(
          packages.map((pkg) => {
            const file = filename(pkg);
            fs.writeFileSync(path.join(work, 'vendor', file), pkg.bytes, {
              flag: 'wx',
              mode: 0o600,
            });
            return [pkg.name, 'file:vendor/' + file];
          }),
        );
      } else {
        for (const companion of candidate.context.approval.companions) {
          assert(
            !registryDecision(lookup(invocation, companion, work), companion).shouldPublish,
            'CLI preview requires publicly released Core and Read first',
          );
          const report = trusted.strictJson(
            trusted.runNpm(
              invocation,
              [
                'pack',
                companion.name + '@' + companion.version,
                '--json',
                '--ignore-scripts',
                '--pack-destination',
                work,
              ],
              {
                cwd: work,
                projectRoot: work,
                timeout: 120000,
                label: 'CLI official companion acquisition',
              },
            ).stdout,
            'CLI companion pack report',
          );
          assert(
            Array.isArray(report) &&
              report.length === 1 &&
              report[0].filename === filename(companion),
            'CLI companion acquisition filename mismatch',
          );
          const bytes = readRegular(
            path.join(work, report[0].filename),
            'CLI public companion',
            trusted.TAR_LIMITS.packedBytes,
          );
          assert(
            trusted.sha256(bytes) === companion.sha256 &&
              trusted.integrity(bytes) === companion.integrity &&
              trusted.sha1(bytes) === companion.shasum,
            'CLI public companion bytes mismatch',
          );
          packages.push({ ...companion, bytes });
        }
        const tar = path.join(work, 'vendor', filename(candidate.context.package));
        fs.writeFileSync(tar, candidate.bytes, { flag: 'wx', mode: 0o600 });
        dependencies = Object.fromEntries(
          packages.map((pkg) => [
            pkg.name,
            options.publicAcquisition || pkg.name !== candidate.context.package.name
              ? pkg.version
              : 'file:vendor/' + filename(candidate.context.package),
          ]),
        );
      }
      const manifest = {
        name: 'kdna-cli-preview-installed-consumer',
        version: '1.0.0',
        private: true,
        dependencies,
      };
      if (options.requireRelease === false)
        manifest.overrides = {
          '@aikdna/kdna-core': '$@aikdna/kdna-core',
          '@aikdna/kdna-read': '$@aikdna/kdna-read',
          'fast-uri': '$fast-uri',
        };
      fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify(manifest) + '\n', {
        flag: 'wx',
      });
      let consumerLock = null;
      if (options.requireRelease === false) {
        const sourceLock = trusted.strictJson(
          readSource(
            candidate.context.treeState,
            'release-surface/native-offline-host/package-lock.json',
            options.root || ROOT,
          ),
          'CLI source companion lock',
        );
        consumerLock = createCandidateLock(
          packages,
          sourceLock,
          manifest,
          candidate.context.manifest,
        );
        fs.writeFileSync(
          path.join(work, 'package-lock.json'),
          JSON.stringify(consumerLock) + '\n',
          { flag: 'wx' },
        );
      }
      trusted.runNpm(
        invocation,
        [
          'install',
          ...(options.requireRelease === false ? ['--offline'] : ['--prefer-online']),
          '--ignore-scripts',
          '--omit=optional',
          '--no-audit',
          '--no-fund',
        ],
        {
          cwd: work,
          projectRoot: work,
          timeout: 180000,
          label: 'CLI empty-cache after-pack consumer',
        },
      );
      if (consumerLock) {
        const observedLock = trusted.strictJson(
          readRegular(path.join(work, 'package-lock.json'), 'CLI installed consumer lock'),
          'CLI installed consumer lock',
        );
        validateCandidateLock(observedLock, packages, manifest);
        consumerLock = observedLock;
      }
      for (const pkg of packages)
        verifyInstalledMembers(path.join(work, 'node_modules', ...pkg.name.split('/')), pkg.bytes);
      const installed = path.join(work, 'node_modules/@aikdna/kdna-cli');
      const journey = spawnSync(
        invocation.command,
        [
          path.join(installed, 'examples/native-workflow.cjs'),
          path.join(installed, 'examples/team-update/author.json'),
          path.join(work, 'journey'),
        ],
        {
          cwd: work,
          encoding: 'utf8',
          env: trusted.cleanNpmEnvironment({
            invocation,
            home: path.join(work, 'journey-home'),
            cache: path.join(work, 'journey-cache'),
          }),
          timeout: 120000,
          maxBuffer: 1024 * 1024,
        },
      );
      assert(
        !journey.error && journey.status === 0,
        'CLI installed create/inspect/read/expand/source/edit/repack journey failed',
      );
      const summary = trusted.strictJson(journey.stdout, 'CLI installed journey summary');
      assert(
        summary.status === 'example_completed' &&
          summary.original_unchanged === true &&
          HEX64.test(summary.original_sha256) &&
          HEX64.test(summary.revised_sha256) &&
          summary.original_sha256 !== summary.revised_sha256 &&
          summary.human_acceptance === 'not_observed',
        'CLI installed journey result mismatch',
      );
      return {
        installed: packages.map((x) => x.name),
        exact_members: true,
        empty_cache: true,
        required_package_count: packages.length,
        consumer_lock_scope: consumerLock ? 'private-scratch-only' : 'public-registry-consumer',
        consumer_lock_sha256: consumerLock
          ? trusted.sha256(Buffer.from(JSON.stringify(consumerLock) + '\n'))
          : null,
        installed_journey: summary,
        acquisition: options.publicAcquisition
          ? 'exact-public-registry-versions'
          : options.requireRelease === false
            ? 'source-bound-twelve-archive-offline-consumer'
            : 'retained-cli-with-public-companions',
      };
    },
  );
}
function createCandidateLock(packages, sourceLock, manifest, cliManifest) {
  assert(
    sourceLock.lockfileVersion === 3 && sourceLock.packages && packages.length === 12,
    'CLI candidate lock inputs invalid',
  );
  const companions = packages.filter((x) => x.name !== POLICIES.cli.name);
  assert(
    JSON.stringify(Object.keys(sourceLock.packages).sort()) ===
      JSON.stringify(['', ...companions.map((x) => 'node_modules/' + x.name)].sort()),
    'CLI source lock closure differs',
  );
  const nodes = {
    '': { name: manifest.name, version: manifest.version, dependencies: manifest.dependencies },
  };
  for (const peer of companions) {
    const key = 'node_modules/' + peer.name,
      node = sourceLock.packages[key];
    assert(
      node.version === peer.version &&
        node.integrity === trusted.integrity(peer.bytes) &&
        node.resolved === 'file:../../vendor/' + filename(peer) &&
        node.optional !== true,
      'CLI source companion lock coordinate mismatch',
    );
    nodes[key] = { ...node, resolved: 'file:vendor/' + filename(peer) };
  }
  const cli = packages.find((x) => x.name === POLICIES.cli.name);
  assert(cli && cli.version === POLICIES.cli.version, 'CLI candidate lock CLI identity mismatch');
  nodes['node_modules/' + cli.name] = {
    version: cli.version,
    resolved: 'file:vendor/' + filename(cli),
    integrity: trusted.integrity(cli.bytes),
    license: cliManifest.license,
    dependencies: cliManifest.dependencies,
    bin: cliManifest.bin,
    engines: cliManifest.engines,
  };
  return {
    name: manifest.name,
    version: manifest.version,
    lockfileVersion: 3,
    requires: true,
    packages: nodes,
  };
}
function validateCandidateLock(lock, packages, manifest) {
  assert(lock.lockfileVersion === 3 && lock.packages, 'CLI installed lock invalid');
  assert(
    JSON.stringify(Object.keys(lock.packages).sort()) ===
      JSON.stringify(['', ...packages.map((x) => 'node_modules/' + x.name)].sort()),
    'CLI installed lock closure differs',
  );
  assert(
    JSON.stringify(lock.packages[''].dependencies) === JSON.stringify(manifest.dependencies),
    'CLI installed lock root dependencies changed',
  );
  for (const pkg of packages) {
    const node = lock.packages['node_modules/' + pkg.name];
    assert(
      node.version === pkg.version &&
        node.integrity === trusted.integrity(pkg.bytes) &&
        node.resolved === 'file:vendor/' + filename(pkg) &&
        node.optional !== true,
      'CLI installed lock coordinate changed',
    );
  }
  return lock;
}
function sourceHost({ root = ROOT, env = process.env } = {}) {
  const source = inspectSource('cli', root);
  const receipts = trusted.strictJson(
    readSource(source.treeState, 'release-surface/native-delivery-archives.json', root),
    'CLI source host receipts',
  ).archives;
  const lock = trusted.strictJson(
    readSource(source.treeState, 'release-surface/native-offline-host/package-lock.json', root),
    'CLI source host lock',
  );
  // The lock must describe exactly the declared archives. It may also carry the
  // optional native accelerator that `--omit=optional` keeps out of the runtime
  // tree: npm validates the lock against the complete dependency graph before it
  // installs anything, so a lock without those entries fails with EUSAGE even
  // when the documented command passes `--omit=optional`. The names are spelled
  // out one by one - no pattern - so any other extra entry still fails the gate.
  const OPTIONAL_ACCELERATOR_ENTRIES = [
    'node_modules/cbor-extract',
    'node_modules/@cbor-extract/cbor-extract-darwin-arm64',
    'node_modules/@cbor-extract/cbor-extract-darwin-x64',
    'node_modules/@cbor-extract/cbor-extract-linux-arm',
    'node_modules/@cbor-extract/cbor-extract-linux-arm64',
    'node_modules/@cbor-extract/cbor-extract-linux-x64',
    'node_modules/@cbor-extract/cbor-extract-win32-x64',
    'node_modules/detect-libc',
    'node_modules/node-gyp-build-optional-packages',
  ];
  const expectedKeys = ['', ...receipts.map((x) => 'node_modules/' + x.name)];
  const optional = new Set(OPTIONAL_ACCELERATOR_ENTRIES);
  const actualKeys = Object.keys(lock.packages);
  const requiredKeys = actualKeys.filter((key) => !optional.has(key)).sort();
  const unexpectedOptional = actualKeys.filter(
    (key) => !expectedKeys.includes(key) && !optional.has(key),
  );
  assert(
    Array.isArray(receipts) &&
      receipts.length === 11 &&
      lock.lockfileVersion === 3 &&
      JSON.stringify(requiredKeys) === JSON.stringify(expectedKeys.sort()) &&
      unexpectedOptional.length === 0,
    'CLI source host closure invalid',
  );
  const packages = receipts.map((input) => {
    assert(path.basename(input.file) === input.file, 'CLI source host filename invalid');
    const bytes = readSource(source.treeState, 'vendor/' + input.file, root),
      node = lock.packages['node_modules/' + input.name];
    assert(
      trusted.sha256(bytes) === input.sha256 &&
        trusted.integrity(bytes) === input.integrity &&
        bytes.length === input.bytes &&
        node.version === input.version &&
        node.integrity === input.integrity &&
        node.resolved === 'file:../../vendor/' + input.file &&
        node.optional !== true,
      'CLI source host receipt/lock mismatch',
    );
    return { name: input.name, version: input.version, bytes };
  });
  const directory = path.join(root, 'release-surface/native-offline-host');
  const sourceLockBytes = readRegular(
    path.join(directory, 'package-lock.json'),
    'CLI committed source host lock',
  );
  assert(
    sourceLockBytes.equals(
      readSource(source.treeState, 'release-surface/native-offline-host/package-lock.json', root),
    ),
    'CLI source host lock differs from committed source',
  );
  let invocation;
  try {
    invocation = trusted.resolveTrustedNpmInvocation({ environment: env, root });
    // npm11 ci includes an inert missing optional node in its validation. Install
    // offline without rewriting the already validated committed source lock.
    trusted.runNpm(
      invocation,
      [
        'install',
        '--offline',
        '--package-lock=false',
        '--ignore-scripts',
        '--omit=optional',
        '--no-audit',
        '--no-fund',
      ],
      {
        cwd: directory,
        projectRoot: root,
        timeout: 180000,
        label: 'CLI declared source host install',
      },
    );
    for (const pkg of packages)
      verifyInstalledMembers(
        path.join(directory, 'node_modules', ...pkg.name.split('/')),
        pkg.bytes,
      );
    assert(
      readRegular(
        path.join(directory, 'package-lock.json'),
        'CLI committed source host lock',
      ).equals(sourceLockBytes),
      'CLI source host lock bytes changed',
    );
    const names = [];
    for (const name of fs.readdirSync(path.join(directory, 'node_modules'))) {
      if (name.startsWith('.')) continue;
      const installed = path.join(directory, 'node_modules', name);
      assert(
        fs.lstatSync(installed).isDirectory() && !fs.lstatSync(installed).isSymbolicLink(),
        'CLI source host package entry invalid',
      );
      if (name.startsWith('@'))
        for (const child of fs.readdirSync(installed)) names.push(name + '/' + child);
      else names.push(name);
    }
    assert(
      JSON.stringify(names.sort()) === JSON.stringify(packages.map((x) => x.name).sort()),
      'CLI source host installed package closure differs',
    );
    const rebound = inspectSource('cli', root);
    assert(
      rebound.commit === source.commit && rebound.tree === source.tree,
      'CLI source host source changed',
    );
    return {
      status: 'source_host_verified',
      required_packages: packages.length,
      exact_members: true,
      source_commit: source.commit,
      source_tree: source.tree,
      lock_rewritten: false,
    };
  } finally {
    if (invocation) invocation.cleanup();
  }
}
function verifyInstalledMembers(directory, bytes) {
  const files = trusted.parseTarFiles(bytes, { includeBytes: true });
  for (const file of files)
    assert(
      readRegular(
        path.join(directory, file.path),
        'CLI installed member',
        trusted.TAR_LIMITS.fileBytes,
      ).equals(file.bytes),
      'CLI installed member mismatch',
    );
  for (const file of files)
    assert(
      (fs.lstatSync(path.join(directory, file.path)).mode & 0o777) === file.mode,
      'CLI installed member mode mismatch',
    );
  const actual = [];
  function walk(dir, prefix = '') {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name),
        stat = fs.lstatSync(file);
      assert(!stat.isSymbolicLink(), 'CLI installed package contains symlink');
      if (stat.isDirectory()) walk(file, prefix + name + '/');
      else {
        assert(stat.isFile(), 'CLI installed package contains special file');
        actual.push(prefix + name);
      }
    }
  }
  walk(directory);
  assert(
    JSON.stringify(actual.sort()) === JSON.stringify(files.map((x) => x.path).sort()),
    'CLI installed package has extra or missing members',
  );
}
function verifyPublic(options) {
  const registry = withInvocation(options, (candidate, invocation, work) => {
    const expected = expectedRegistry(candidate);
    const decision = registryDecision(lookup(invocation, expected, work), expected);
    assert(!decision.shouldPublish, 'preview registry publication not observed');
    const channel = validateChannel(
      lookupDistTags(invocation, expected.name, work),
      candidate.evidence.registry_before,
      expected.version,
      true,
    );
    return { publicRegistryIdentity: 'exact', ...decision, channel };
  });
  return { ...registry, publicInstall: smoke({ ...options, publicAcquisition: true }) };
}
function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = { '--unit': 'unit', '--evidence': 'evidencePath', '--artifact': 'artifactPath' }[
      rest[i]
    ];
    assert(
      key &&
        typeof rest[i + 1] === 'string' &&
        !rest[i + 1].startsWith('--') &&
        !Object.hasOwn(options, key),
      'preview arguments invalid',
    );
    options[key] = rest[i + 1];
  }
  policy(options.unit);
  if (command !== 'check')
    assert(
      options.evidencePath && options.artifactPath,
      'preview evidence and retained artifact required',
    );
  return { command, options };
}
async function main(argv = process.argv.slice(2)) {
  if (argv[0] === 'source-host' && argv.length === 1) {
    console.log(JSON.stringify(sourceHost(), null, 2));
    return;
  }
  if (argv[0] === 'provision-npm' && argv.length === 3 && argv[1] === '--artifact') {
    return trusted.provisionTrustedNpmTarball({ artifactPath: argv[2] });
  }
  if (argv[0] === 'trusted-npm' && argv.length > 1) {
    trusted.runTrustedNpmCommand(argv.slice(1), { root: ROOT });
    return;
  }
  const { command, options } = parseArgs(argv);
  let result;
  if (command === 'check') {
    const context = inspectRelease(options.unit);
    result = {
      commit: context.commit,
      tree: context.tree,
      unit: context.unit,
      authorization: context.authorization,
    };
  } else if (command === 'candidate') result = build({ ...options, candidate: true });
  else if (command === 'prepare') result = build(options);
  else if (command === 'smoke') result = smoke(options);
  else if (command === 'candidate-smoke') result = smoke({ ...options, requireRelease: false });
  else if (command === 'guard') result = guard(options);
  else if (command === 'publish') result = publish(options);
  else if (command === 'verify-public') result = verifyPublic(options);
  else throw new Error('unknown preview command');
  console.log(JSON.stringify(result, null, 2));
}
if (require.main === module)
  main().catch((error) => {
    console.error('CLI preview release rejected: ' + error.message);
    process.exitCode = 1;
  });
module.exports = {
  BASE_COMMIT,
  COMPANIONS,
  createCandidateLock,
  validateCandidateLock,
  sourceHost,
  SOURCE_FILES,
  verifyInstalledMembers,
  DIST_TAG,
  POLICIES,
  build,
  filename,
  guard,
  inspectRelease,
  inspectSource,
  parseArgs,
  parseReleaseBody,
  policy,
  previewNotes,
  publish,
  readCandidate,
  registryDecision,
  smoke,
  validateApproval,
  validateArtifact,
  validateContext,
  validateChannel,
  validateDistTags,
  validateManifest,
  verifyPublic,
};
