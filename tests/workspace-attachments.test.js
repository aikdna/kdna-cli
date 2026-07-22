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

test('protected or remote assets block before scope when authorization is not satisfied', () => {
  const root = temporaryRoot('authorization');
  attach(root, buildAsset(root, { access: 'remote' }));
  const result = resolve(root, 'draft this');
  assert.equal(result.decision, 'block');
  assert.equal(result.reason_code, 'authorization_required');
  assert.equal(result.authorization, 'required');
  assert.equal(result.integrity, 'verified');
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

test('nearest nested workspace wins and parent and child records are never merged', () => {
  const root = temporaryRoot('nested');
  const child = path.join(root, 'packages', 'child');
  const deep = path.join(child, 'src');
  fs.mkdirSync(deep, { recursive: true });
  attach(root, buildAsset(root), { role: 'parent' });
  attach(child, buildAsset(root), { role: 'child' });
  const taskFile = writeTask(root, 'draft this');
  const result = resolveWorkspace({ cwd: deep, taskFile });
  assert.equal(result.decision, 'load');
  assert.equal(result.selected.role, 'child');
  assert.equal(result.candidates.length, 1);
  assert.equal(result.workspace_root, '..');
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
  removeWorkspaceAttachment({ cwd: root, attachmentId: attached.attachment.attachment_id });
  assert.equal(readRecord(root).attachments.length, 0);
  assert.ok(fs.existsSync(snapshot));
  assert.equal(resolve(root, 'draft').reason_code, 'no_approved_attachment');
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

test('CLI exposes the eight attachment operations and resolver closed JSON', () => {
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
  assert.equal(runCli(['remove', id, '--cwd', root]).status, 0);
});

test('old global store routes are unknown and absent from default help', () => {
  for (const command of ['available', 'match', 'install', 'update', 'list', 'registry', 'setup']) {
    const result = runCli([command]);
    assert.notEqual(result.status, 0, `${command} unexpectedly routed`);
    assert.match(result.stderr + result.stdout, /Unknown command/);
  }
  const help = runCli(['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /attach <file\.kdna>/);
  assert.match(help.stdout, /resolve --cwd/);
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
  const view = listWorkspaceAttachments(child);
  assert.equal(view.workspace_root, fs.realpathSync(root));
  assert.equal(view.record.attachments.length, 1);
  assert.equal(Object.hasOwn(view.record.attachments[0], 'content'), false);
  assert.equal(Object.hasOwn(view.record.attachments[0], 'projection'), false);
});
