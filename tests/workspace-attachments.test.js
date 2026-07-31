'use strict';

const { after, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const core = require('@aikdna/kdna-core');
const {
  GITIGNORE_PATTERNS,
  WorkspaceAttachmentError,
  attachWorkspace,
  cleanupWorkspaceSnapshots,
  findWorkspace,
  listWorkspaceAttachments,
  removeWorkspaceAttachment,
  resolveWorkspace,
  rollbackWorkspaceAttachment,
  safeReadRegular,
  setAttachmentState,
  sha256,
  switchWorkspaceAttachment,
} = require('../src/workspace-attachments');

const CLI = path.resolve(__dirname, '..', 'src', 'cli.js');
const FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'minimal');
const temporaryRoots = [];

test('attachWorkspace persists its approved record exactly once', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '..', 'src', 'workspace-attachments.js'),
    'utf8',
  );
  const start = source.indexOf('function attachWorkspace(');
  const end = source.indexOf('function listWorkspaceAttachments(', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  assert.equal((source.slice(start, end).match(/atomicWriteRecord\(/gu) || []).length, 1);
});

after(() => {
  for (const root of temporaryRoots) fs.rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(label = 'workspace') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `kdna-${label}-`));
  temporaryRoots.push(root);
  return root;
}

function writeJson(file, value, mode = 0o600) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode });
}

function buildAsset(root, options = {}) {
  const suffix = options.suffix || crypto.randomBytes(4).toString('hex');
  const source = path.join(root, `source-${suffix}`);
  const asset = path.join(root, `asset-${suffix}.kdna`);
  fs.cpSync(FIXTURE, source, { recursive: true });
  const manifestPath = path.join(source, 'kdna.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (options.assetId) manifest.asset_id = options.assetId;
  if (options.version) {
    manifest.version = options.version;
    manifest.judgment_version = options.version;
  }
  if (options.access === 'remote') {
    manifest.access = 'remote';
    manifest.runtime = { endpoint: 'https://runtime.example.test/project' };
  }
  writeJson(manifestPath, manifest);
  writeJson(path.join(source, 'checksums.json'), core.buildChecksums(source));
  core.pack(source, asset);
  return asset;
}

function buildProtectedAsset(root, password = 'workspace-test-password') {
  const suffix = crypto.randomBytes(4).toString('hex');
  const source = path.join(root, `protected-source-${suffix}`);
  const protectedAsset = path.join(root, `protected-${suffix}.kdna`);
  const demo = runCli(['demo', 'minimal', source, '--password-stdin'], { input: `${password}\n` });
  assert.equal(demo.status, 0, demo.stderr);
  const packed = runCli(['pack', source, protectedAsset]);
  assert.equal(packed.status, 0, packed.stderr);
  return protectedAsset;
}

function writeTask(root, text, name = `task-${crypto.randomBytes(4).toString('hex')}.txt`) {
  const task = path.join(root, name);
  fs.writeFileSync(task, text, { mode: 0o600 });
  return task;
}

function approve() {
  return true;
}

function attach(root, asset, options = {}) {
  return attachWorkspace({
    cwd: root,
    sourcePath: asset,
    role: options.role || 'article-writing',
    appliesTo: options.appliesTo || ['draft'],
    doesNotApplyTo: options.doesNotApplyTo || ['code'],
    approve,
    now: options.now,
  });
}

function resolve(root, text, options = {}) {
  const taskFile = writeTask(root, text);
  return resolveWorkspace({
    cwd: options.cwd || root,
    workspaceRoot: options.workspaceRoot || options.cwd || root,
    taskFile,
    adapterSchema: options.adapterSchema,
  });
}

function recordPath(root) {
  return path.join(root, '.kdna', 'attachments.json');
}

function readRecord(root) {
  return JSON.parse(fs.readFileSync(recordPath(root), 'utf8'));
}

function executeCleanup(root) {
  const preview = cleanupWorkspaceSnapshots({ cwd: root });
  return cleanupWorkspaceSnapshots({ cwd: root, planDigest: preview.plan_digest });
}

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: options.cwd || path.resolve(__dirname, '..'),
    env: { ...process.env, ...(options.env || {}) },
    input: options.input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

test('attach snapshots exact bytes, writes the closed record, and survives source removal', () => {
  const root = temporaryRoot('attach');
  const asset = buildAsset(root);
  const original = fs.readFileSync(asset);
  const result = attach(root, asset);
  const record = readRecord(root);
  assert.equal(record.document_type, 'kdna.workspace-attachments');
  assert.equal(record.schema_version, '0.1.0');
  assert.deepEqual(record.workspace, { root_marker: '.kdna/attachments.json' });
  assert.equal(record.attachments.length, 1);
  assert.deepEqual(record.attachments[0], result.attachment);
  assert.match(result.attachment.attachment_id, /^att_[0-9a-f]{24}$/);
  assert.equal(result.attachment.asset.digest, sha256(original));
  const snapshot = path.join(root, '.kdna', ...result.attachment.asset.snapshot.split('/'));
  assert.deepEqual(fs.readFileSync(snapshot), original);
  fs.unlinkSync(asset);
  assert.equal(resolve(root, 'Please draft the article.').decision, 'load');
});

test(
  'workspace directories, record, snapshot, and lock policy use private POSIX modes',
  {
    skip: process.platform === 'win32',
  },
  () => {
    const root = temporaryRoot('modes');
    const result = attach(root, buildAsset(root));
    const mode = (file) => fs.statSync(file).mode & 0o777;
    assert.equal(mode(path.join(root, '.kdna')), 0o700);
    assert.equal(mode(path.join(root, '.kdna', 'assets')), 0o700);
    assert.equal(mode(recordPath(root)), 0o600);
    assert.equal(
      mode(path.join(root, '.kdna', ...result.attachment.asset.snapshot.split('/'))),
      0o600,
    );
  },
);

test('.kdna/.gitignore protects records, locks, immutable assets, and record temporaries', () => {
  const root = temporaryRoot('gitignore');
  attach(root, buildAsset(root));
  const lines = fs
    .readFileSync(path.join(root, '.kdna', '.gitignore'), 'utf8')
    .trim()
    .split('\n');
  for (const pattern of GITIGNORE_PATTERNS) assert.ok(lines.includes(pattern), pattern);
});

test('attachment record contains no source path, task, authorization material, or judgment text', () => {
  const root = temporaryRoot('privacy');
  const asset = buildAsset(root);
  attach(root, asset);
  const serialized = fs.readFileSync(recordPath(root), 'utf8');
  assert.doesNotMatch(serialized, new RegExp(asset.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')));
  assert.doesNotMatch(serialized, /password|token|authorization|highest_question|axioms/iu);
});

test(
  'attach rejects regular-file violations, invalid containers, and missing approval',
  {
    skip: process.platform === 'win32',
  },
  () => {
    const root = temporaryRoot('attach-reject');
    const asset = buildAsset(root);
    const symlink = path.join(root, 'linked.kdna');
    fs.symlinkSync(asset, symlink);
    assert.throws(() => attach(root, symlink), /regular non-symlink/);
    const invalid = path.join(root, 'invalid.kdna');
    fs.writeFileSync(invalid, 'not a KDNA container');
    assert.throws(() => attach(root, invalid), /valid KDNA|valid identity/);
    assert.throws(
      () =>
        attachWorkspace({
          cwd: root,
          sourcePath: asset,
          role: 'writing',
          appliesTo: [],
          doesNotApplyTo: [],
          approve: () => false,
        }),
      (error) => error instanceof WorkspaceAttachmentError && error.code === 'approval_required',
    );
  },
);

test('safe regular-file reads detect a same-descriptor TOCTOU change', () => {
  const root = temporaryRoot('toctou');
  const file = writeTask(root, 'stable bytes');
  let fstatCalls = 0;
  const injected = {
    ...fs,
    constants: fs.constants,
    fstatSync(descriptor) {
      const stat = fs.fstatSync(descriptor);
      fstatCalls += 1;
      if (fstatCalls === 2) return { ...stat, mtimeMs: stat.mtimeMs + 1 };
      return stat;
    },
  };
  assert.throws(() => safeReadRegular(file, 1024, 'Injected file', injected), /changed while/);
});

test('no record or no enabled attachment skips without scanning a global store', () => {
  const root = temporaryRoot('no-record');
  assert.deepEqual(resolve(root, 'draft this').reason_code, 'no_approved_attachment');
  const attached = attach(root, buildAsset(root));
  setAttachmentState({
    cwd: root,
    attachmentId: attached.attachment.attachment_id,
    state: 'disabled',
  });
  const result = resolve(root, 'draft this');
  assert.equal(result.decision, 'skip');
  assert.equal(result.reason_code, 'no_approved_attachment');
  assert.deepEqual(result.candidates, []);
});

test('one positive scope loads and one explicit exclusion skips', () => {
  const root = temporaryRoot('scope');
  attach(root, buildAsset(root), { appliesTo: ['draft'], doesNotApplyTo: ['code'] });
  const load = resolve(root, 'Please DRAFT the launch article.');
  assert.equal(load.decision, 'load');
  assert.equal(load.reason_code, 'single_approved_attachment_clearly_applies');
  assert.equal(load.selected.attachment_id, load.candidates[0].attachment_id);
  assert.equal(load.authorization, 'satisfied');
  assert.equal(load.integrity, 'verified');
  const skip = resolve(root, 'Review this code change.');
  assert.equal(skip.decision, 'skip');
  assert.equal(skip.reason_code, 'outside_scope');
});

test('empty, unmatched, and internally contradictory scope asks rather than infers', () => {
  const emptyRoot = temporaryRoot('empty-scope');
  attach(emptyRoot, buildAsset(emptyRoot), { appliesTo: [], doesNotApplyTo: [] });
  assert.equal(resolve(emptyRoot, 'draft').reason_code, 'ambiguous_scope');

  const unmatchedRoot = temporaryRoot('unmatched-scope');
  attach(unmatchedRoot, buildAsset(unmatchedRoot), {
    appliesTo: ['headline'],
    doesNotApplyTo: ['administration'],
  });
  assert.equal(resolve(unmatchedRoot, 'draft').reason_code, 'ambiguous_scope');

  const contradictoryRoot = temporaryRoot('contradictory-scope');
  attach(contradictoryRoot, buildAsset(contradictoryRoot), {
    appliesTo: ['review'],
    doesNotApplyTo: ['review'],
  });
  const contradiction = resolve(contradictoryRoot, 'review this');
  assert.equal(contradiction.decision, 'ask');
  assert.equal(contradiction.reason_code, 'ambiguous_scope');
});

test('scope hints use deterministic token boundaries, normalized roles, and explicit CJK matching', () => {
  for (const [term, task] of [
    ['code', 'decode this payload'],
    ['draft', 'redraft this paragraph'],
  ]) {
    const root = temporaryRoot('scope-token-boundary');
    attach(root, buildAsset(root), { appliesTo: [term], doesNotApplyTo: [] });
    const result = resolve(root, task);
    assert.equal(result.decision, 'ask');
    assert.equal(result.reason_code, 'ambiguous_scope');
  }

  const phraseRoot = temporaryRoot('scope-phrase-boundary');
  attach(phraseRoot, buildAsset(phraseRoot), {
    appliesTo: ['code-review'],
    doesNotApplyTo: [],
  });
  assert.equal(resolve(phraseRoot, 'Please perform a code review.').decision, 'load');

  const roleRoot = temporaryRoot('scope-normalized-role');
  attach(roleRoot, buildAsset(roleRoot), {
    role: 'Writing Review',
    appliesTo: ['draft'],
    doesNotApplyTo: [],
  });
  attach(roleRoot, buildAsset(roleRoot), {
    role: 'writing   review',
    appliesTo: [],
    doesNotApplyTo: ['draft'],
  });
  assert.equal(resolve(roleRoot, 'draft this').reason_code, 'attachment_conflict');

  const cjkRoot = temporaryRoot('scope-cjk');
  attach(cjkRoot, buildAsset(cjkRoot), {
    appliesTo: ['文章起草'],
    doesNotApplyTo: [],
  });
  assert.equal(resolve(cjkRoot, '请完成文章起草。').decision, 'load');
  assert.equal(resolve(cjkRoot, '请解释“文章起草”这个标签。').decision, 'ask');
  assert.equal(resolve(cjkRoot, '请检查文章。').decision, 'ask');
});

test('negation, quotation, broad hints, and contrastive clauses never auto-load', () => {
  const ordinary = temporaryRoot('scope-clear-phrase');
  attach(ordinary, buildAsset(ordinary), {
    appliesTo: ['draft article'],
    doesNotApplyTo: [],
  });
  assert.equal(resolve(ordinary, 'Please draft article now.').decision, 'load');
  for (const task of [
    'Do not draft article; only edit code.',
    'Do not draft an article; only edit code.',
    'Do not draft an article; only change code.',
    'Explain the phrase draft article.',
    'Discuss whether "draft article" is a useful label.',
  ]) {
    const result = resolve(ordinary, task);
    assert.equal(result.decision, 'ask');
    assert.equal(result.reason_code, 'ambiguous_scope');
  }

  for (const term of ['go', 'work']) {
    const root = temporaryRoot('scope-broad-term');
    attach(root, buildAsset(root), { appliesTo: [term], doesNotApplyTo: [] });
    assert.equal(resolve(root, `Please ${term} now.`).decision, 'ask');
  }

  const contrasted = temporaryRoot('scope-contrast');
  attach(contrasted, buildAsset(contrasted), {
    appliesTo: ['draft'],
    doesNotApplyTo: ['code'],
  });
  const multiClause = resolve(contrasted, 'Draft this; but only edit code.');
  assert.equal(multiClause.decision, 'ask');
  assert.equal(multiClause.reason_code, 'ambiguous_scope');

  const cjk = temporaryRoot('scope-cjk-negation');
  attach(cjk, buildAsset(cjk), {
    appliesTo: ['写文章'],
    doesNotApplyTo: [],
  });
  assert.equal(resolve(cjk, '请写文章。').decision, 'load');
  for (const task of [
    '不要写文章，只改代码。',
    '请讨论“写文章”这个标签。',
    '请讨论‘写文章’这个词。',
  ]) {
    const result = resolve(cjk, task);
    assert.equal(result.decision, 'ask');
    assert.equal(result.reason_code, 'ambiguous_scope');
  }

  const shortCjk = temporaryRoot('scope-cjk-short');
  attach(shortCjk, buildAsset(shortCjk), {
    appliesTo: ['文章'],
    doesNotApplyTo: [],
  });
  assert.equal(resolve(shortCjk, '处理文章。').decision, 'ask');
});

test('multiple positive attachments and same-role disagreement ask with attachment_conflict', () => {
  const multipleRoot = temporaryRoot('multi-conflict');
  attach(multipleRoot, buildAsset(multipleRoot), { role: 'writing' });
  attach(multipleRoot, buildAsset(multipleRoot), { role: 'editing' });
  const multiple = resolve(multipleRoot, 'draft this');
  assert.equal(multiple.decision, 'ask');
  assert.equal(multiple.reason_code, 'attachment_conflict');
  assert.equal(multiple.candidates.length, 2);

  const roleRoot = temporaryRoot('role-conflict');
  attach(roleRoot, buildAsset(roleRoot), {
    role: 'writing',
    appliesTo: ['draft'],
    doesNotApplyTo: [],
  });
  attach(roleRoot, buildAsset(roleRoot), {
    role: 'writing',
    appliesTo: [],
    doesNotApplyTo: ['draft'],
  });
  assert.equal(resolve(roleRoot, 'draft this').reason_code, 'attachment_conflict');
});

test('in-scope protected or remote assets block when authorization is not satisfied', () => {
  const root = temporaryRoot('authorization');
  const attached = attach(root, buildAsset(root, { access: 'remote' }));
  const recordBefore = fs.readFileSync(recordPath(root));
  const snapshot = path.join(root, '.kdna', ...attached.attachment.asset.snapshot.split('/'));
  const snapshotBefore = fs.readFileSync(snapshot);
  const result = resolve(root, 'draft this');
  assert.equal(result.decision, 'block');
  assert.equal(result.reason_code, 'authorization_required');
  assert.equal(result.authorization, 'required');
  assert.equal(result.integrity, 'verified');
  assert.deepEqual(fs.readFileSync(recordPath(root)), recordBefore);
  assert.deepEqual(fs.readFileSync(snapshot), snapshotBefore);
});

test('explicitly outside-scope assets do not block on missing authorization or damaged snapshots', () => {
  const encryptedRoot = temporaryRoot('outside-encrypted');
  attach(encryptedRoot, buildProtectedAsset(encryptedRoot), {
    appliesTo: ['draft'],
    doesNotApplyTo: ['code'],
  });
  const encryptedOutside = resolve(encryptedRoot, 'review this code');
  assert.equal(encryptedOutside.decision, 'skip');
  assert.equal(encryptedOutside.reason_code, 'outside_scope');
  assert.equal(encryptedOutside.authorization, 'not_checked');
  assert.equal(encryptedOutside.integrity, 'not_checked');
  assert.equal(resolve(encryptedRoot, 'draft this').reason_code, 'authorization_required');

  const missingRoot = temporaryRoot('outside-missing');
  const missing = attach(missingRoot, buildAsset(missingRoot), {
    appliesTo: ['draft'],
    doesNotApplyTo: ['code'],
  });
  fs.unlinkSync(path.join(missingRoot, '.kdna', ...missing.attachment.asset.snapshot.split('/')));
  const missingOutside = resolve(missingRoot, 'review this code');
  assert.equal(missingOutside.decision, 'skip');
  assert.equal(missingOutside.reason_code, 'outside_scope');
  assert.equal(missingOutside.integrity, 'not_checked');
  assert.equal(resolve(missingRoot, 'draft this').reason_code, 'snapshot_missing');
});
test('adapter schema mismatch blocks with a closed adapter_incompatible result', () => {
  const root = temporaryRoot('adapter');
  const result = resolve(root, 'draft', { adapterSchema: '0.0.1' });
  assert.equal(result.decision, 'block');
  assert.equal(result.reason_code, 'adapter_incompatible');
  assert.equal(result.selected, null);
  assert.deepEqual(result.candidates, []);
});

test('unsupported schema, unknown fields, and path traversal fail closed', () => {
  for (const mutation of [
    (record) => {
      record.schema_version = '9.9.9';
    },
    (record) => {
      record.unexpected = true;
    },
    (record) => {
      record.attachments[0].asset.snapshot = '../escape.kdna';
    },
  ]) {
    const root = temporaryRoot('schema');
    attach(root, buildAsset(root));
    const record = readRecord(root);
    mutation(record);
    writeJson(recordPath(root), record);
    const result = resolve(root, 'draft');
    assert.equal(result.decision, 'block');
    assert.equal(result.reason_code, 'attachment_schema_unsupported');
  }
});

test(
  'missing, digest-mismatched, symlink, and invalid snapshots have distinct fail-closed results',
  {
    skip: process.platform === 'win32',
  },
  () => {
    const missingRoot = temporaryRoot('missing');
    const missing = attach(missingRoot, buildAsset(missingRoot));
    const missingPath = path.join(
      missingRoot,
      '.kdna',
      ...missing.attachment.asset.snapshot.split('/'),
    );
    fs.unlinkSync(missingPath);
    assert.equal(resolve(missingRoot, 'draft').reason_code, 'snapshot_missing');

    const mismatchRoot = temporaryRoot('mismatch');
    const mismatch = attach(mismatchRoot, buildAsset(mismatchRoot));
    const mismatchPath = path.join(
      mismatchRoot,
      '.kdna',
      ...mismatch.attachment.asset.snapshot.split('/'),
    );
    fs.writeFileSync(mismatchPath, 'tampered');
    assert.equal(resolve(mismatchRoot, 'draft').reason_code, 'snapshot_digest_mismatch');

    const symlinkRoot = temporaryRoot('snapshot-symlink');
    const linked = attach(symlinkRoot, buildAsset(symlinkRoot));
    const linkedPath = path.join(
      symlinkRoot,
      '.kdna',
      ...linked.attachment.asset.snapshot.split('/'),
    );
    const retained = `${linkedPath}.retained`;
    fs.renameSync(linkedPath, retained);
    fs.symlinkSync(retained, linkedPath);
    assert.equal(resolve(symlinkRoot, 'draft').reason_code, 'asset_invalid');

    const invalidRoot = temporaryRoot('snapshot-invalid');
    const invalid = attach(invalidRoot, buildAsset(invalidRoot));
    const invalidPath = path.join(
      invalidRoot,
      '.kdna',
      ...invalid.attachment.asset.snapshot.split('/'),
    );
    const invalidBytes = Buffer.from('not a KDNA container');
    fs.writeFileSync(invalidPath, invalidBytes);
    const invalidRecord = readRecord(invalidRoot);
    const digest = sha256(invalidBytes);
    invalidRecord.attachments[0].asset.digest = digest;
    invalidRecord.attachments[0].asset.snapshot = `assets/sha256-${digest.slice(7)}.kdna`;
    fs.renameSync(
      invalidPath,
      path.join(invalidRoot, '.kdna', invalidRecord.attachments[0].asset.snapshot),
    );
    writeJson(recordPath(invalidRoot), invalidRecord);
    assert.equal(resolve(invalidRoot, 'draft').reason_code, 'asset_invalid');
  },
);

test('explicit Host boundary contains lookup and nearest nested workspace wins without merging', () => {
  const root = temporaryRoot('nested');
  const child = path.join(root, 'packages', 'child');
  const deep = path.join(child, 'src');
  fs.mkdirSync(deep, { recursive: true });
  attach(root, buildAsset(root), { role: 'parent' });
  attach(child, buildAsset(root), { role: 'child' });
  const taskFile = writeTask(root, 'draft this');
  const result = resolveWorkspace({ cwd: deep, workspaceRoot: root, taskFile });
  assert.equal(result.decision, 'load');
  assert.equal(result.selected.role, 'child');
  assert.equal(result.candidates.length, 1);
  assert.equal(result.workspace_root, '..');
});

test('home and out-of-boundary parent records never become implicit project authority', () => {
  const fakeHome = temporaryRoot('fake-home');
  const homeAttachment = attach(fakeHome, buildAsset(fakeHome), { role: 'home-record' });
  const project = path.join(fakeHome, 'projects', 'unrelated');
  const deep = path.join(project, 'src');
  fs.mkdirSync(deep, { recursive: true });
  const taskFile = writeTask(project, 'draft this');
  const originalHome = os.homedir;
  os.homedir = () => fakeHome;
  try {
    const bounded = resolveWorkspace({
      cwd: deep,
      workspaceRoot: project,
      taskFile,
    });
    assert.equal(bounded.decision, 'skip');
    assert.equal(bounded.reason_code, 'no_approved_attachment');
    assert.equal(bounded.candidates.length, 0);
    assert.throws(
      () => listWorkspaceAttachments(fakeHome, fakeHome),
      (error) =>
        error instanceof WorkspaceAttachmentError && error.code === 'home_workspace_ambiguous',
    );
    assert.throws(
      () =>
        setAttachmentState({
          cwd: fakeHome,
          attachmentId: homeAttachment.attachment.attachment_id,
          state: 'disabled',
        }),
      (error) =>
        error instanceof WorkspaceAttachmentError && error.code === 'home_workspace_ambiguous',
    );
  } finally {
    os.homedir = originalHome;
  }

  const outer = temporaryRoot('outside-host-root');
  attach(outer, buildAsset(outer), { role: 'outside-boundary' });
  const hostRoot = path.join(outer, 'workspace');
  const hostStart = path.join(hostRoot, 'nested');
  fs.mkdirSync(hostStart, { recursive: true });
  const outsideResult = resolveWorkspace({
    cwd: hostStart,
    workspaceRoot: hostRoot,
    taskFile: writeTask(hostRoot, 'draft this'),
  });
  assert.equal(outsideResult.decision, 'skip');
  assert.equal(outsideResult.reason_code, 'no_approved_attachment');
});

test(
  'workspace boundary rejects relative escapes and symlinked launch coordinates',
  { skip: process.platform === 'win32' },
  () => {
    const root = temporaryRoot('boundary-hostile');
    const child = path.join(root, 'child');
    const outside = temporaryRoot('boundary-outside');
    fs.mkdirSync(child);
    assert.throws(
      () => findWorkspace(child, path.join(child, '..', '..', path.basename(outside))),
      (error) =>
        error instanceof WorkspaceAttachmentError && error.code === 'workspace_boundary_escape',
    );

    const linkedBoundary = path.join(root, 'linked-boundary');
    fs.symlinkSync(outside, linkedBoundary);
    assert.throws(
      () => findWorkspace(outside, linkedBoundary),
      (error) => error instanceof WorkspaceAttachmentError && error.code === 'workspace_invalid',
    );

    const linkedStart = path.join(root, 'linked-start');
    fs.symlinkSync(outside, linkedStart);
    assert.throws(
      () => findWorkspace(linkedStart, root),
      (error) => error instanceof WorkspaceAttachmentError && error.code === 'workspace_invalid',
    );
  },
);

test('CLI treats --cwd as the default boundary and requires an explicit root for nested lookup', () => {
  const root = temporaryRoot('cli-boundary');
  const nested = path.join(root, 'packages', 'app');
  fs.mkdirSync(nested, { recursive: true });
  attach(root, buildAsset(root));
  const taskFile = writeTask(root, 'draft this');

  let result = runCli(['resolve', '--cwd', nested, '--task-file', taskFile]);
  assert.equal(result.status, 0);
  let resolution = JSON.parse(result.stdout);
  assert.equal(resolution.decision, 'skip');
  assert.equal(resolution.reason_code, 'no_approved_attachment');

  result = runCli(['resolve', '--cwd', nested, '--workspace-root', root, '--task-file', taskFile]);
  assert.equal(result.status, 0);
  resolution = JSON.parse(result.stdout);
  assert.equal(resolution.decision, 'load');
  assert.equal(resolution.selected.role, 'article-writing');
});

test('disable and enable are atomic state changes and enable re-verifies its snapshot', () => {
  const root = temporaryRoot('state');
  const attached = attach(root, buildAsset(root));
  const id = attached.attachment.attachment_id;
  setAttachmentState({ cwd: root, attachmentId: id, state: 'disabled' });
  assert.equal(readRecord(root).attachments[0].state, 'disabled');
  setAttachmentState({ cwd: root, attachmentId: id, state: 'enabled' });
  assert.equal(readRecord(root).attachments[0].state, 'enabled');
});

test('switch retains scope, snapshots the replacement, and rollback works offline', () => {
  const root = temporaryRoot('history');
  const first = buildAsset(root, { version: '1.0.0' });
  const second = buildAsset(root, { version: '1.1.0' });
  const attached = attach(root, first, {
    role: 'writing',
    appliesTo: ['draft'],
    doesNotApplyTo: ['code'],
  });
  const id = attached.attachment.attachment_id;
  switchWorkspaceAttachment({
    cwd: root,
    attachmentId: id,
    sourcePath: second,
    approve,
    now: '2026-07-23T01:00:00.000Z',
  });
  let record = readRecord(root);
  assert.equal(record.attachments[0].asset.version, '1.1.0');
  assert.equal(record.attachments[0].history.length, 1);
  assert.deepEqual(record.attachments[0].scope, attached.attachment.scope);
  fs.unlinkSync(first);
  fs.unlinkSync(second);
  rollbackWorkspaceAttachment({
    cwd: root,
    attachmentId: id,
    now: '2026-07-23T02:00:00.000Z',
  });
  record = readRecord(root);
  assert.equal(record.attachments[0].asset.version, '1.0.0');
  assert.equal(record.attachments[0].history.length, 0);
  assert.equal(resolve(root, 'draft this').decision, 'load');
});

test('remove deletes only the relation and retains immutable snapshots', () => {
  const root = temporaryRoot('remove');
  const attached = attach(root, buildAsset(root));
  const snapshot = path.join(root, '.kdna', ...attached.attachment.asset.snapshot.split('/'));
  fs.writeFileSync(path.join(root, '.kdna', 'assets', 'unrecognized.txt'), 'retain');
  fs.mkdirSync(path.join(root, '.kdna', 'assets', 'unrecognized-directory'));
  fs.writeFileSync(
    path.join(root, '.kdna', 'assets', `sha256-${'0'.repeat(64)}.kdna`),
    'not-the-named-digest',
  );
  const removal = removeWorkspaceAttachment({
    cwd: root,
    attachmentId: attached.attachment.attachment_id,
  });
  assert.equal(removal.attachment_removed, true);
  assert.equal(removal.removed_attachment.attachment_id, attached.attachment.attachment_id);
  assert.equal(removal.snapshot_retained, true);
  assert.equal(removal.retained_snapshot_count, 1);
  assert.equal(
    removal.retained_snapshot_reason,
    'remove_preserves_managed_workspace_snapshots_for_references_and_explicit_cleanup',
  );
  assert.equal(removal.unknown_storage_entry_count, 2);
  assert.equal(removal.blocked_storage_entry_count, 2);
  assert.equal(readRecord(root).attachments.length, 0);
  assert.ok(fs.existsSync(snapshot));
  assert.equal(resolve(root, 'draft').reason_code, 'no_approved_attachment');
});

test('explicit cleanup previews, preserves rollback references, and deletes only unreferenced ordinary snapshots', () => {
  const root = temporaryRoot('cleanup-ordinary');
  const assetId = 'kdna:test:cleanup-ordinary';
  const first = buildAsset(root, { assetId, version: '1.0.0', suffix: 'cleanup-v1' });
  const replacement = buildAsset(root, {
    assetId,
    version: '1.1.0',
    suffix: 'cleanup-v11',
  });
  const unreferencedSource = buildAsset(root, {
    assetId: 'kdna:test:cleanup-unreferenced',
    suffix: 'cleanup-unreferenced',
  });
  const primary = attach(root, first);
  switchWorkspaceAttachment({
    cwd: root,
    attachmentId: primary.attachment.attachment_id,
    sourcePath: replacement,
    approve,
  });
  const removable = attach(root, unreferencedSource);
  const removableSnapshot = path.join(
    root,
    '.kdna',
    ...removable.attachment.asset.snapshot.split('/'),
  );
  removeWorkspaceAttachment({
    cwd: root,
    attachmentId: removable.attachment.attachment_id,
  });
  const recordBefore = fs.readFileSync(recordPath(root));

  const preview = cleanupWorkspaceSnapshots({ cwd: root });
  assert.equal(preview.mode, 'preview');
  assert.equal(preview.eligible_snapshot_count, 1);
  assert.equal(preview.deleted_snapshot_count, 0);
  assert.equal(preview.retained_snapshot_count, 3);
  assert.equal(preview.retained_reason_counts.attachment_or_rollback_reference, 2);
  assert.equal(preview.retained_reason_counts.awaiting_explicit_cleanup, 1);
  assert.ok(fs.existsSync(removableSnapshot));

  const cleaned = cleanupWorkspaceSnapshots({ cwd: root, planDigest: preview.plan_digest });
  assert.equal(cleaned.mode, 'execute');
  assert.equal(cleaned.eligible_snapshot_count, 1);
  assert.equal(cleaned.deleted_snapshot_count, 1);
  assert.equal(cleaned.retained_snapshot_count, 2);
  assert.equal(cleaned.attachment_record_changed, false);
  assert.equal(fs.existsSync(removableSnapshot), false);
  assert.ok(fs.existsSync(first), 'cleanup must not touch the original source file');
  assert.ok(fs.existsSync(replacement), 'cleanup must not touch replacement source files');
  assert.deepEqual(fs.readFileSync(recordPath(root)), recordBefore);

  rollbackWorkspaceAttachment({
    cwd: root,
    attachmentId: primary.attachment.attachment_id,
  });
  assert.equal(readRecord(root).attachments[0].asset.version, '1.0.0');
});

test('explicit cleanup deletes an unreferenced encrypted snapshot without touching its source', () => {
  const root = temporaryRoot('cleanup-encrypted');
  const protectedAsset = buildProtectedAsset(root, 'cleanup-protected-password');
  const attached = attach(root, protectedAsset);
  const snapshot = path.join(root, '.kdna', ...attached.attachment.asset.snapshot.split('/'));
  removeWorkspaceAttachment({ cwd: root, attachmentId: attached.attachment.attachment_id });
  const cleaned = executeCleanup(root);
  assert.equal(cleaned.deleted_snapshot_count, 1);
  assert.equal(fs.existsSync(snapshot), false);
  assert.equal(fs.existsSync(protectedAsset), true);
  assert.equal(readRecord(root).attachments.length, 0);
});

test(
  'cleanup fails closed for symlinks and a concurrent live workspace mutation lock',
  {
    skip: process.platform === 'win32',
  },
  () => {
    const root = temporaryRoot('cleanup-hostile');
    attach(root, buildAsset(root));
    const outside = path.join(root, 'outside.kdna');
    fs.writeFileSync(outside, 'outside');
    const hostile = path.join(root, '.kdna', 'assets', `sha256-${'0'.repeat(64)}.kdna`);
    fs.symlinkSync(outside, hostile);
    assert.throws(
      () => cleanupWorkspaceSnapshots({ cwd: root }),
      (error) => error instanceof WorkspaceAttachmentError && error.code === 'cleanup_unsafe_path',
    );
    assert.equal(fs.readFileSync(outside, 'utf8'), 'outside');
    fs.unlinkSync(hostile);

    const lock = path.join(root, '.kdna', 'attachments.lock');
    writeJson(lock, { pid: process.pid, created_at: new Date().toISOString() });
    assert.throws(
      () => cleanupWorkspaceSnapshots({ cwd: root }),
      (error) => error instanceof WorkspaceAttachmentError && error.code === 'workspace_locked',
    );
    fs.unlinkSync(lock);
  },
);

test('cleanup confirmation is bound to the exact preview and rejects a newly appeared orphan', () => {
  const root = temporaryRoot('cleanup-plan-drift');
  const first = attach(
    root,
    buildAsset(root, {
      assetId: 'kdna:test:cleanup-plan-first',
      suffix: 'cleanup-plan-first',
    }),
  );
  const firstSnapshot = path.join(root, '.kdna', ...first.attachment.asset.snapshot.split('/'));
  removeWorkspaceAttachment({ cwd: root, attachmentId: first.attachment.attachment_id });
  const preview = cleanupWorkspaceSnapshots({ cwd: root });
  assert.equal(preview.eligible_snapshot_count, 1);

  const second = attach(
    root,
    buildAsset(root, {
      assetId: 'kdna:test:cleanup-plan-second',
      suffix: 'cleanup-plan-second',
    }),
  );
  const secondSnapshot = path.join(root, '.kdna', ...second.attachment.asset.snapshot.split('/'));
  removeWorkspaceAttachment({ cwd: root, attachmentId: second.attachment.attachment_id });
  assert.throws(
    () => cleanupWorkspaceSnapshots({ cwd: root, planDigest: preview.plan_digest }),
    (error) => error instanceof WorkspaceAttachmentError && error.code === 'cleanup_plan_changed',
  );
  assert.equal(fs.existsSync(firstSnapshot), true);
  assert.equal(fs.existsSync(secondSnapshot), true);

  const refreshed = cleanupWorkspaceSnapshots({ cwd: root });
  assert.equal(refreshed.eligible_snapshot_count, 2);
  assert.notEqual(refreshed.plan_digest, preview.plan_digest);
});

test('cleanup recovery rejects a path-traversal staging plan without touching outside bytes', () => {
  const root = temporaryRoot('cleanup-recovery-traversal');
  attach(root, buildAsset(root));
  const outside = path.join(root, 'outside.kdna');
  fs.writeFileSync(outside, 'outside');
  const digest = `sha256:${'0'.repeat(64)}`;
  const plan = {
    document_type: 'kdna.workspace-cleanup-plan',
    schema_version: '0.1.0',
    record_digest: digest,
    eligible_snapshots: [{ snapshot: '../../outside.kdna', digest }],
  };
  plan.plan_digest = sha256(
    Buffer.from(
      JSON.stringify({
        record_digest: plan.record_digest,
        eligible_snapshots: plan.eligible_snapshots,
      }),
      'utf8',
    ),
  );
  const staging = path.join(
    root,
    '.kdna',
    `.cleanup-staging-${plan.plan_digest.slice('sha256:'.length)}`,
  );
  fs.mkdirSync(staging, { mode: 0o700 });
  writeJson(path.join(staging, 'plan.json'), plan);
  assert.throws(
    () => cleanupWorkspaceSnapshots({ cwd: root }),
    (error) =>
      error instanceof WorkspaceAttachmentError && error.code === 'cleanup_recovery_required',
  );
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside');
});

test('cleanup partial failure writes exact deletion facts and restores every undeleted staged snapshot', () => {
  const root = temporaryRoot('cleanup-partial');
  for (const suffix of ['partial-one', 'partial-two']) {
    const attached = attach(root, buildAsset(root, { assetId: `kdna:test:${suffix}`, suffix }));
    removeWorkspaceAttachment({ cwd: root, attachmentId: attached.attachment.attachment_id });
  }
  const preview = cleanupWorkspaceSnapshots({ cwd: root });
  assert.equal(preview.eligible_snapshot_count, 2);
  const originalUnlink = fs.unlinkSync;
  let stagedDeletes = 0;
  fs.unlinkSync = (file) => {
    if (
      String(file).includes('.cleanup-staging-') &&
      /^sha256-[a-f0-9]{64}\.kdna$/.test(path.basename(String(file)))
    ) {
      stagedDeletes += 1;
      if (stagedDeletes === 2) {
        const error = new Error('simulated cleanup deletion failure');
        error.code = 'EIO';
        throw error;
      }
    }
    return originalUnlink(file);
  };
  try {
    assert.throws(
      () => cleanupWorkspaceSnapshots({ cwd: root, planDigest: preview.plan_digest }),
      (error) => error instanceof WorkspaceAttachmentError && error.code === 'cleanup_partial',
    );
  } finally {
    fs.unlinkSync = originalUnlink;
  }
  const receipt = JSON.parse(
    fs.readFileSync(path.join(root, '.kdna', 'cleanup-last-receipt.json'), 'utf8'),
  );
  assert.equal(receipt.status, 'PARTIAL');
  assert.equal(receipt.plan_digest, preview.plan_digest);
  assert.equal(receipt.deleted_snapshot_count, 1);
  assert.equal(receipt.restored_snapshot_count, 1);
  assert.equal(
    fs.readdirSync(path.join(root, '.kdna')).some((entry) => entry.startsWith('.cleanup-staging-')),
    false,
  );
  assert.equal(fs.readdirSync(path.join(root, '.kdna', 'assets')).length, 1);
});

test('exclusive lock contention leaves the complete record unchanged', () => {
  const root = temporaryRoot('lock');
  const attached = attach(root, buildAsset(root));
  const before = fs.readFileSync(recordPath(root));
  const lock = path.join(root, '.kdna', 'attachments.lock');
  fs.writeFileSync(lock, 'orphaned lock\n', { flag: 'wx', mode: 0o600 });
  assert.throws(
    () =>
      setAttachmentState({
        cwd: root,
        attachmentId: attached.attachment.attachment_id,
        state: 'disabled',
      }),
    (error) => error instanceof WorkspaceAttachmentError && error.code === 'workspace_locked',
  );
  assert.deepEqual(fs.readFileSync(recordPath(root)), before);
  fs.unlinkSync(lock);
});

test('workspace lock owner is complete and durable before the exclusive name is published', () => {
  const root = temporaryRoot('lock-publish');
  const asset = buildAsset(root);
  const originalLink = fs.linkSync;
  let observedOwner = null;
  fs.linkSync = (owner, lock) => {
    if (path.basename(lock) === 'attachments.lock') {
      observedOwner = JSON.parse(fs.readFileSync(owner, 'utf8'));
      assert.equal(fs.statSync(owner).mode & 0o777, 0o600);
    }
    return originalLink(owner, lock);
  };
  try {
    attach(root, asset);
  } finally {
    fs.linkSync = originalLink;
  }
  assert.equal(observedOwner.pid, process.pid);
  assert.match(observedOwner.created_at, /^\d{4}-\d{2}-\d{2}T/u);
  assert.equal(fs.existsSync(path.join(root, '.kdna', 'attachments.lock')), false);
  assert.equal(
    fs
      .readdirSync(path.join(root, '.kdna'))
      .some((entry) => entry.startsWith('.attachments-lock-owner-')),
    false,
  );
});

test('a dead process lock is recovered without weakening exclusive mutation', () => {
  const root = temporaryRoot('dead-lock');
  const attached = attach(root, buildAsset(root));
  const lock = path.join(root, '.kdna', 'attachments.lock');
  writeJson(lock, { pid: 2147483647, created_at: '2026-07-23T00:00:00.000Z' });
  setAttachmentState({
    cwd: root,
    attachmentId: attached.attachment.attachment_id,
    state: 'disabled',
  });
  assert.equal(readRecord(root).attachments[0].state, 'disabled');
  assert.equal(fs.existsSync(lock), false);
  assert.equal(
    fs.readdirSync(path.join(root, '.kdna')).some((entry) => entry.includes('lock-stale')),
    false,
  );
});

test('an orphan snapshot after a crash has no authority without a complete record', () => {
  const root = temporaryRoot('orphan');
  const directory = path.join(root, '.kdna', 'assets');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.copyFileSync(buildAsset(root), path.join(directory, 'sha256-orphan.kdna'));
  assert.equal(resolve(root, 'draft').reason_code, 'no_approved_attachment');
});

test(
  'task input must be a bounded regular UTF-8 non-symlink file',
  {
    skip: process.platform === 'win32',
  },
  () => {
    const root = temporaryRoot('task');
    attach(root, buildAsset(root));
    const task = writeTask(root, 'draft');
    const linked = path.join(root, 'linked-task.txt');
    fs.symlinkSync(task, linked);
    assert.throws(() => resolveWorkspace({ cwd: root, taskFile: linked }), /regular non-symlink/);
    const oversized = path.join(root, 'oversized-task.txt');
    fs.writeFileSync(oversized, Buffer.alloc(64 * 1024 + 1, 0x61));
    assert.throws(() => resolveWorkspace({ cwd: root, taskFile: oversized }), /size limit/);
    const invalidUtf8 = path.join(root, 'invalid-task.txt');
    fs.writeFileSync(invalidUtf8, Buffer.from([0xff]));
    assert.throws(() => resolveWorkspace({ cwd: root, taskFile: invalidUtf8 }), /UTF-8/);
  },
);

test('task stdin is bounded, strict UTF-8, mutually exclusive, and leaves no workspace bytes', () => {
  const root = temporaryRoot('task-stdin');
  attach(root, buildAsset(root));
  const recordBefore = fs.readFileSync(recordPath(root));
  const assetsBefore = fs.readdirSync(path.join(root, '.kdna', 'assets')).sort();
  const directoryBefore = fs.readdirSync(path.join(root, '.kdna')).sort();

  let result = runCli(['resolve', '--cwd', root, '--task-stdin'], {
    input: Buffer.from('draft this', 'utf8'),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).decision, 'load');
  assert.deepEqual(fs.readFileSync(recordPath(root)), recordBefore);
  assert.deepEqual(fs.readdirSync(path.join(root, '.kdna', 'assets')).sort(), assetsBefore);
  assert.deepEqual(fs.readdirSync(path.join(root, '.kdna')).sort(), directoryBefore);

  result = runCli(['resolve', '--cwd', root, '--task-stdin'], {
    input: Buffer.alloc(64 * 1024 + 1, 0x61),
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /size limit/u);

  result = runCli(['resolve', '--cwd', root, '--task-stdin'], {
    input: Buffer.from([0xff]),
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /UTF-8/u);

  result = runCli(['resolve', '--cwd', root, '--task-stdin'], { input: Buffer.alloc(0) });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /non-empty UTF-8 text/u);

  const taskFile = writeTask(root, 'draft this', 'mutually-exclusive-task.txt');
  result = runCli(['resolve', '--cwd', root, '--task-file', taskFile, '--task-stdin'], {
    input: Buffer.from('draft this', 'utf8'),
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /exactly one/u);

  result = runCli(['resolve', '--cwd', root]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /exactly one/u);
});

test('task stdin and task file produce identical load, ask, skip, and block decisions', () => {
  for (const [label, task, expected] of [
    ['load', 'draft this', 'load'],
    ['ask', 'review this document', 'ask'],
    ['skip', 'review this code', 'skip'],
  ]) {
    const root = temporaryRoot(`stdin-equivalence-${label}`);
    attach(root, buildAsset(root));
    const taskFile = writeTask(root, task);
    const fromFile = runCli(['resolve', '--cwd', root, '--task-file', taskFile]);
    const fromStdin = runCli(['resolve', '--cwd', root, '--task-stdin'], {
      input: Buffer.from(task, 'utf8'),
    });
    assert.equal(fromFile.status, 0, fromFile.stderr);
    assert.equal(fromStdin.status, 0, fromStdin.stderr);
    assert.deepEqual(JSON.parse(fromStdin.stdout), JSON.parse(fromFile.stdout));
    assert.equal(JSON.parse(fromStdin.stdout).decision, expected);
  }

  const blockedRoot = temporaryRoot('stdin-equivalence-block');
  attach(blockedRoot, buildAsset(blockedRoot, { access: 'remote' }));
  const blockedTask = 'draft this';
  const blockedFile = writeTask(blockedRoot, blockedTask);
  const fromFile = runCli(['resolve', '--cwd', blockedRoot, '--task-file', blockedFile]);
  const fromStdin = runCli(['resolve', '--cwd', blockedRoot, '--task-stdin'], {
    input: Buffer.from(blockedTask, 'utf8'),
  });
  assert.equal(fromFile.status, 0, fromFile.stderr);
  assert.equal(fromStdin.status, 0, fromStdin.stderr);
  assert.deepEqual(JSON.parse(fromStdin.stdout), JSON.parse(fromFile.stdout));
  assert.equal(JSON.parse(fromStdin.stdout).decision, 'block');
});

test('task stdin never enters CLI argv, environment, or resolver output', () => {
  const root = temporaryRoot('task-stdin-sterile');
  attach(root, buildAsset(root));
  const task = 'private-task-sentinel-7d6c6d1b';
  const hook = path.join(root, 'task-stdin-argv-env-guard.cjs');
  fs.writeFileSync(
    hook,
    `
const sentinel = ${JSON.stringify(task)};
if (
  process.argv.some((value) => value.includes(sentinel)) ||
  Object.values(process.env).some((value) => String(value).includes(sentinel))
) {
  throw new Error("task text reached argv or environment");
}
`,
    { mode: 0o600 },
  );
  const inherited = process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ` : '';
  const result = runCli(['resolve', '--cwd', root, '--task-stdin'], {
    input: Buffer.from(task, 'utf8'),
    env: { NODE_OPTIONS: `${inherited}--require=${hook}` },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).decision, 'ask');
  assert.doesNotMatch(result.stdout, new RegExp(task, 'u'));
  assert.doesNotMatch(result.stderr, new RegExp(task, 'u'));
});

test('CLI approval is mandatory off-TTY and --yes performs the exact approved mutation', () => {
  const root = temporaryRoot('cli-approval');
  const asset = buildAsset(root);
  const denied = runCli(['attach', asset, '--cwd', root]);
  assert.equal(denied.status, 2);
  assert.match(denied.stderr, /requires --yes/);
  assert.ok(!fs.existsSync(recordPath(root)));
  const approved = runCli([
    'attach',
    asset,
    '--cwd',
    root,
    '--role',
    'writing',
    '--applies-to',
    'draft',
    '--yes',
  ]);
  assert.equal(approved.status, 0, approved.stderr);
  assert.equal(JSON.parse(approved.stdout).operation, 'attach');
});

test('CLI exposes the workspace attachment operations and resolver closed JSON', () => {
  const root = temporaryRoot('cli-chain');
  const first = buildAsset(root, { version: '1.0.0' });
  const second = buildAsset(root, { version: '1.1.0' });
  const task = writeTask(root, 'draft this');
  let result = runCli(['attach', first, '--cwd', root, '--applies-to', 'draft', '--yes']);
  assert.equal(result.status, 0, result.stderr);
  const id = JSON.parse(result.stdout).attachment.attachment_id;
  result = runCli(['attachments', '--cwd', root]);
  assert.equal(JSON.parse(result.stdout).attachments[0].attachment_id, id);
  result = runCli(['resolve', '--cwd', root, '--task-file', task]);
  const resolution = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(resolution), [
    'document_type',
    'schema_version',
    'decision',
    'reason_code',
    'workspace_root',
    'selected',
    'candidates',
    'authorization',
    'integrity',
  ]);
  assert.equal(resolution.decision, 'load');
  assert.equal(runCli(['disable', id, '--cwd', root]).status, 0);
  assert.equal(runCli(['enable', id, '--cwd', root]).status, 0);
  assert.equal(runCli(['switch', id, second, '--cwd', root, '--yes']).status, 0);
  assert.equal(runCli(['rollback', id, '--cwd', root]).status, 0);
  result = runCli(['remove', id, '--cwd', root]);
  assert.equal(result.status, 0);
  const removal = JSON.parse(result.stdout);
  assert.equal(removal.attachment_removed, true);
  assert.equal(removal.snapshot_retained, true);
  assert.equal(removal.retained_snapshot_count, 2);
  assert.match(removal.retained_snapshot_reason, /explicit_cleanup/u);
  assert.equal(removal.unknown_storage_entry_count, 0);
  assert.equal(removal.blocked_storage_entry_count, 0);
  result = runCli(['cleanup', '--cwd', root]);
  const preview = JSON.parse(result.stdout);
  assert.equal(preview.mode, 'preview');
  assert.equal(preview.deleted_snapshot_count, 0);
  assert.equal(preview.confirmation_required, true);
  result = runCli(['cleanup', '--cwd', root, '--yes']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /requires both --plan-digest and --yes/u);
  result = runCli(['cleanup', '--cwd', root, '--plan-digest', preview.plan_digest, '--yes']);
  const cleaned = JSON.parse(result.stdout);
  assert.equal(cleaned.mode, 'execute');
  assert.equal(cleaned.deleted_snapshot_count, 2);
  assert.equal(cleaned.retained_snapshot_count, 0);
});

test('plain public asset completes one-shot, multi-attachment selection, and reversible workspace lifecycle', () => {
  const root = temporaryRoot('plain-public-lifecycle');
  const assetId = 'kdna:test:plain-public-lifecycle';
  const first = buildAsset(root, { assetId, version: '1.0.0', suffix: 'plain-v1' });
  const replacement = buildAsset(root, { assetId, version: '1.1.0', suffix: 'plain-v11' });
  const independent = buildAsset(root, {
    assetId: 'kdna:test:independent-approved-attachment',
    version: '1.0.0',
    suffix: 'independent',
  });
  const task = writeTask(root, 'draft this');

  let result = runCli(['inspect', first, '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).asset_id, assetId);

  result = runCli(['plan-load', first, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.state, 'ready');
  assert.equal(plan.can_load_now, true);

  result = runCli(['load', first, '--profile=compact', '--as=json']);
  assert.equal(result.status, 0, result.stderr);
  const oneShot = JSON.parse(result.stdout);
  assert.equal(oneShot.profile, 'compact');
  assert.ok(oneShot.context && Object.keys(oneShot.context).length > 0);

  result = runCli([
    'attach',
    first,
    '--cwd',
    root,
    '--role',
    'writing-one',
    '--applies-to',
    'draft',
    '--yes',
  ]);
  assert.equal(result.status, 0, result.stderr);
  const firstId = JSON.parse(result.stdout).attachment.attachment_id;

  result = runCli([
    'attach',
    independent,
    '--cwd',
    root,
    '--role',
    'writing-two',
    '--applies-to',
    'draft',
    '--yes',
  ]);
  assert.equal(result.status, 0, result.stderr);
  const secondId = JSON.parse(result.stdout).attachment.attachment_id;

  result = runCli(['attachments', '--cwd', root]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).attachments.length, 2);

  result = runCli(['resolve', '--cwd', root, '--task-file', task]);
  let resolution = JSON.parse(result.stdout);
  assert.equal(resolution.decision, 'ask');
  assert.equal(resolution.reason_code, 'attachment_conflict');
  assert.equal(resolution.selected, null);
  assert.equal(resolution.candidates.length, 2);

  assert.equal(runCli(['disable', secondId, '--cwd', root]).status, 0);
  result = runCli(['resolve', '--cwd', root, '--task-file', task]);
  resolution = JSON.parse(result.stdout);
  assert.equal(resolution.decision, 'load');
  assert.equal(resolution.selected.attachment_id, firstId);

  assert.equal(runCli(['disable', firstId, '--cwd', root]).status, 0);
  result = runCli(['resolve', '--cwd', root, '--task-file', task]);
  assert.equal(JSON.parse(result.stdout).decision, 'skip');
  assert.equal(runCli(['enable', firstId, '--cwd', root]).status, 0);

  assert.equal(runCli(['switch', firstId, replacement, '--cwd', root, '--yes']).status, 0);
  result = runCli(['attachments', '--cwd', root]);
  assert.equal(
    JSON.parse(result.stdout).attachments.find((entry) => entry.attachment_id === firstId).asset
      .version,
    '1.1.0',
  );
  assert.equal(runCli(['rollback', firstId, '--cwd', root]).status, 0);
  result = runCli(['attachments', '--cwd', root]);
  assert.equal(
    JSON.parse(result.stdout).attachments.find((entry) => entry.attachment_id === firstId).asset
      .version,
    '1.0.0',
  );

  assert.equal(runCli(['remove', secondId, '--cwd', root]).status, 0);
  assert.equal(runCli(['remove', firstId, '--cwd', root]).status, 0);
  assert.equal(readRecord(root).attachments.length, 0);
  assert.ok(fs.readdirSync(path.join(root, '.kdna', 'assets')).length >= 3);
});

test('old global store routes are unknown and absent from default help', () => {
  for (const command of ['available', 'match', 'install', 'update', 'list', 'registry', 'setup']) {
    const result = runCli([command]);
    assert.notEqual(result.status, 0, `${command} unexpectedly routed`);
    assert.match(result.stderr + result.stdout, /command is not in the approved allowlist/);
  }
  const help = runCli(['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /attach <file\.kdna>/);
  assert.match(help.stdout, /resolve --cwd/);
  assert.match(help.stdout, /cleanup/);
  assert.doesNotMatch(help.stdout, /\b(?:available|match|install|update|registry|setup)\b/);
});

test('inspect, plan-load, and load do not fall back to a populated global package index', () => {
  const root = temporaryRoot('no-fallback');
  const home = path.join(root, 'home');
  const kdnaHome = path.join(home, '.kdna');
  const packages = path.join(kdnaHome, 'packages', 'example', 'writing', '1.0.0');
  fs.mkdirSync(packages, { recursive: true });
  const asset = buildAsset(root);
  const installedAsset = path.join(packages, 'asset.kdna');
  fs.copyFileSync(asset, installedAsset);
  writeJson(path.join(kdnaHome, 'index.json'), {
    schema_version: 3,
    packages: {
      '@example/writing': {
        active_version: '1.0.0',
        versions: {
          '1.0.0': { asset_path: installedAsset, version: '1.0.0' },
        },
      },
    },
  });
  const env = { HOME: home, KDNA_HOME: kdnaHome };
  for (const command of ['inspect', 'plan-load', 'load']) {
    const result = runCli([command, '@example/writing'], { env });
    assert.notEqual(result.status, 0, `${command} resolved a global package name`);
    assert.match(result.stderr, /File not found|explicit packaged/);
  }
});

test('attachments reads the nearest record without loading or exposing judgment content', () => {
  const root = temporaryRoot('attachments-view');
  const child = path.join(root, 'nested');
  fs.mkdirSync(child);
  attach(root, buildAsset(root));
  const view = listWorkspaceAttachments(child, root);
  assert.equal(view.workspace_root, fs.realpathSync(root));
  assert.equal(view.record.attachments.length, 1);
  assert.equal(Object.hasOwn(view.record.attachments[0], 'content'), false);
  assert.equal(Object.hasOwn(view.record.attachments[0], 'projection'), false);
});
