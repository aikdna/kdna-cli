'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const core = require('@aikdna/kdna-core');
const { loadExternalAuthorization } = require('./external-entitlement');
const { snapshotAssetFile } = require('./runtime-contract');

const DOCUMENT_TYPE = 'kdna.workspace-attachments';
const RESOLUTION_TYPE = 'kdna.workspace-resolution';
const SCHEMA_VERSION = '0.1.0';
const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_TASK_BYTES = 64 * 1024;
const MAX_ATTACHMENTS = 1024;
const MAX_SCOPE_TERMS = 256;
const MAX_TEXT_LENGTH = 4096;
const ATTACHMENT_ID_PATTERN = /^att_[0-9a-f]{24}$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const GITIGNORE_PATTERNS = Object.freeze([
  '/assets/',
  '/attachments.json',
  '/attachments.lock',
  '/.attachments-*.tmp',
]);

class WorkspaceAttachmentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WorkspaceAttachmentError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new WorkspaceAttachmentError(code, message);
}

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, expected, label) {
  if (!isPlainObject(value)) fail('attachment_schema_unsupported', `${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail('attachment_schema_unsupported', `${label} contains missing or unknown fields.`);
  }
}

function assertText(value, label, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || value.length > MAX_TEXT_LENGTH) {
    fail('attachment_schema_unsupported', `${label} must be a bounded string.`);
  }
  if (!allowEmpty && value.trim().length === 0) {
    fail('attachment_schema_unsupported', `${label} must not be empty.`);
  }
  return value;
}

function assertTimestamp(value, label) {
  assertText(value, label);
  if (!UTC_TIMESTAMP_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    fail('attachment_schema_unsupported', `${label} must be a UTC RFC 3339 timestamp.`);
  }
}

function snapshotPathForDigest(digest) {
  if (!DIGEST_PATTERN.test(digest)) {
    fail('attachment_schema_unsupported', 'asset.digest must be a lowercase SHA-256 digest.');
  }
  return `assets/sha256-${digest.slice('sha256:'.length)}.kdna`;
}

function validateAssetReference(asset, label) {
  assertExactKeys(asset, ['id', 'version', 'digest', 'snapshot'], label);
  assertText(asset.id, `${label}.id`);
  assertText(asset.version, `${label}.version`);
  if (!DIGEST_PATTERN.test(asset.digest)) {
    fail('attachment_schema_unsupported', `${label}.digest must be a lowercase SHA-256 digest.`);
  }
  const expectedSnapshot = snapshotPathForDigest(asset.digest);
  if (asset.snapshot !== expectedSnapshot) {
    fail(
      'attachment_schema_unsupported',
      `${label}.snapshot must be the digest-derived path ${expectedSnapshot}.`,
    );
  }
}

function normalizedPhrase(value) {
  return String(value).trim().replace(/\s+/gu, ' ').toLocaleLowerCase('und');
}

function validateScopeTerms(terms, label) {
  if (!Array.isArray(terms) || terms.length > MAX_SCOPE_TERMS) {
    fail('attachment_schema_unsupported', `${label} must be a bounded array.`);
  }
  const seen = new Set();
  for (const term of terms) {
    assertText(term, label);
    const normalized = normalizedPhrase(term);
    if (seen.has(normalized)) {
      fail('attachment_schema_unsupported', `${label} must contain unique phrases.`);
    }
    seen.add(normalized);
  }
}

function validateAttachment(attachment, index) {
  const label = `attachments[${index}]`;
  assertExactKeys(
    attachment,
    [
      'attachment_id',
      'asset',
      'state',
      'role',
      'scope',
      'resolution_policy',
      'approved_at',
      'update_policy',
      'history',
    ],
    label,
  );
  if (!ATTACHMENT_ID_PATTERN.test(attachment.attachment_id)) {
    fail(
      'attachment_schema_unsupported',
      `${label}.attachment_id must be att_ plus 24 lowercase hexadecimal characters.`,
    );
  }
  validateAssetReference(attachment.asset, `${label}.asset`);
  if (!['enabled', 'disabled'].includes(attachment.state)) {
    fail('attachment_schema_unsupported', `${label}.state must be enabled or disabled.`);
  }
  assertText(attachment.role, `${label}.role`);
  assertExactKeys(attachment.scope, ['kind', 'applies_to', 'does_not_apply_to'], `${label}.scope`);
  if (attachment.scope.kind !== 'workspace') {
    fail('attachment_schema_unsupported', `${label}.scope.kind must be workspace.`);
  }
  validateScopeTerms(attachment.scope.applies_to, `${label}.scope.applies_to`);
  validateScopeTerms(attachment.scope.does_not_apply_to, `${label}.scope.does_not_apply_to`);
  if (attachment.resolution_policy !== 'load_when_clear_ask_when_ambiguous') {
    fail('attachment_schema_unsupported', `${label}.resolution_policy is unsupported.`);
  }
  assertTimestamp(attachment.approved_at, `${label}.approved_at`);
  if (attachment.update_policy !== 'explicit_switch_only') {
    fail('attachment_schema_unsupported', `${label}.update_policy is unsupported.`);
  }
  if (!Array.isArray(attachment.history) || attachment.history.length > MAX_ATTACHMENTS) {
    fail('attachment_schema_unsupported', `${label}.history must be a bounded array.`);
  }
  attachment.history.forEach((entry, historyIndex) => {
    const historyLabel = `${label}.history[${historyIndex}]`;
    assertExactKeys(entry, ['asset', 'replaced_at'], historyLabel);
    validateAssetReference(entry.asset, `${historyLabel}.asset`);
    assertTimestamp(entry.replaced_at, `${historyLabel}.replaced_at`);
  });
}

function validateRecord(record) {
  assertExactKeys(
    record,
    ['document_type', 'schema_version', 'workspace', 'attachments'],
    'record',
  );
  if (record.document_type !== DOCUMENT_TYPE || record.schema_version !== SCHEMA_VERSION) {
    fail('attachment_schema_unsupported', 'Unsupported workspace attachment document or schema.');
  }
  assertExactKeys(record.workspace, ['root_marker'], 'record.workspace');
  if (record.workspace.root_marker !== '.kdna/attachments.json') {
    fail('attachment_schema_unsupported', 'record.workspace.root_marker is unsupported.');
  }
  if (!Array.isArray(record.attachments) || record.attachments.length > MAX_ATTACHMENTS) {
    fail('attachment_schema_unsupported', 'record.attachments must be a bounded array.');
  }
  const ids = new Set();
  record.attachments.forEach((attachment, index) => {
    validateAttachment(attachment, index);
    if (ids.has(attachment.attachment_id)) {
      fail('attachment_schema_unsupported', 'attachment_id values must be unique.');
    }
    ids.add(attachment.attachment_id);
  });
  return record;
}

function emptyRecord() {
  return {
    document_type: DOCUMENT_TYPE,
    schema_version: SCHEMA_VERSION,
    workspace: { root_marker: '.kdna/attachments.json' },
    attachments: [],
  };
}

function safeReadRegular(file, maxBytes, label, fileSystem = fs) {
  const noFollow = fileSystem.constants.O_NOFOLLOW || 0;
  let descriptor;
  try {
    const pathStat = fileSystem.lstatSync(file);
    if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
      fail('asset_invalid', `${label} must be a regular non-symlink file.`);
    }
    descriptor = fileSystem.openSync(file, fileSystem.constants.O_RDONLY | noFollow);
    const before = fileSystem.fstatSync(descriptor);
    if (!before.isFile()) fail('asset_invalid', `${label} must be a regular file.`);
    if (
      before.dev !== pathStat.dev ||
      before.ino !== pathStat.ino ||
      before.size < 0 ||
      before.size > maxBytes
    ) {
      fail('asset_invalid', `${label} changed before it was opened or exceeds its size limit.`);
    }
    const bytes = fileSystem.readFileSync(descriptor);
    const after = fileSystem.fstatSync(descriptor);
    if (
      bytes.length !== before.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      fail('asset_invalid', `${label} changed while it was read.`);
    }
    return bytes;
  } catch (error) {
    if (error instanceof WorkspaceAttachmentError) throw error;
    if (error && error.code === 'ENOENT') fail('snapshot_missing', `${label} was not found.`);
    fail('asset_invalid', `${label} could not be read safely.`);
  } finally {
    if (descriptor !== undefined) fileSystem.closeSync(descriptor);
  }
}

function assertDirectory(directory, label) {
  const absolute = path.resolve(directory);
  let stat;
  try {
    stat = fs.lstatSync(absolute);
  } catch {
    fail('workspace_invalid', `${label} does not exist.`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail('workspace_invalid', `${label} must be a regular directory.`);
  }
  return fs.realpathSync(absolute);
}

function pathsForRoot(root) {
  const kdnaDirectory = path.join(root, '.kdna');
  return {
    root,
    kdnaDirectory,
    assetsDirectory: path.join(kdnaDirectory, 'assets'),
    record: path.join(kdnaDirectory, 'attachments.json'),
    lock: path.join(kdnaDirectory, 'attachments.lock'),
    gitignore: path.join(kdnaDirectory, '.gitignore'),
  };
}

function withinOrEqual(candidate, boundary) {
  const relative = path.relative(boundary, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function findWorkspace(cwd = process.cwd()) {
  const start = assertDirectory(cwd, 'Working directory');
  let home = null;
  try {
    home = fs.realpathSync(os.homedir());
  } catch {
    home = null;
  }
  const startInsideHome = home !== null && withinOrEqual(start, home);
  let current = start;
  while (true) {
    const candidate = pathsForRoot(current);
    try {
      const stat = fs.lstatSync(candidate.record);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        fail('attachment_schema_unsupported', 'Workspace attachment record is not a regular file.');
      }
      return { start, root: current, paths: candidate };
    } catch (error) {
      if (error instanceof WorkspaceAttachmentError) throw error;
      if (!error || error.code !== 'ENOENT') {
        fail('attachment_schema_unsupported', 'Workspace attachment record cannot be inspected.');
      }
    }

    if (startInsideHome && current === home) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    if (startInsideHome && !withinOrEqual(parent, home)) break;
    current = parent;
  }
  return { start, root: null, paths: null };
}

function mutationWorkspace(cwd = process.cwd()) {
  const root = assertDirectory(cwd, 'Working directory');
  return { start: root, root, paths: pathsForRoot(root) };
}

function ensurePrivateDirectory(directory) {
  try {
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      fail('workspace_invalid', 'Workspace attachment storage must be a regular directory.');
    }
  } catch (error) {
    if (error instanceof WorkspaceAttachmentError) throw error;
    if (!error || error.code !== 'ENOENT') throw error;
    fs.mkdirSync(directory, { mode: 0o700 });
  }
  try {
    fs.chmodSync(directory, 0o700);
  } catch {
    // POSIX modes are best effort on platforms without chmod semantics.
  }
}

function fsyncDirectory(directory) {
  let descriptor;
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(descriptor);
  } catch {
    // Directory fsync is unavailable on some supported platforms.
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function unlinkIfPresent(file) {
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if (error && error.code !== 'ENOENT') throw error;
  }
}

function atomicWriteFile(file, bytes, mode, temporaryPrefix) {
  const directory = path.dirname(file);
  const temporary = path.join(
    directory,
    `${temporaryPrefix}${process.pid}-${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      mode,
    );
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, file);
    try {
      fs.chmodSync(file, mode);
    } catch {
      // POSIX modes are best effort on platforms without chmod semantics.
    }
    fsyncDirectory(directory);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    unlinkIfPresent(temporary);
  }
}

function ensureGitignore(paths) {
  let existing = '';
  try {
    const stat = fs.lstatSync(paths.gitignore);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      fail('workspace_invalid', '.kdna/.gitignore must be a regular file.');
    }
    existing = safeReadRegular(paths.gitignore, 64 * 1024, '.kdna/.gitignore').toString('utf8');
  } catch (error) {
    if (error instanceof WorkspaceAttachmentError && error.code !== 'snapshot_missing') throw error;
    if (!(error instanceof WorkspaceAttachmentError) && (!error || error.code !== 'ENOENT'))
      throw error;
  }
  const lines = existing.split(/\r?\n/u).filter((line) => line.length > 0);
  let changed = existing.length === 0;
  for (const pattern of GITIGNORE_PATTERNS) {
    if (!lines.includes(pattern)) {
      lines.push(pattern);
      changed = true;
    }
  }
  if (changed) {
    atomicWriteFile(paths.gitignore, Buffer.from(`${lines.join('\n')}\n`), 0o644, '.gitignore-');
  }
}

function ensureWorkspaceLayout(paths) {
  ensurePrivateDirectory(paths.kdnaDirectory);
  ensurePrivateDirectory(paths.assetsDirectory);
  ensureGitignore(paths);
}

function readRecord(paths, { optional = false } = {}) {
  try {
    const bytes = safeReadRegular(paths.record, MAX_RECORD_BYTES, 'Workspace attachment record');
    let record;
    try {
      record = JSON.parse(bytes.toString('utf8'));
    } catch {
      fail('attachment_schema_unsupported', 'Workspace attachment record is not valid JSON.');
    }
    return validateRecord(record);
  } catch (error) {
    if (
      optional &&
      error instanceof WorkspaceAttachmentError &&
      error.code === 'snapshot_missing'
    ) {
      return null;
    }
    throw error;
  }
}

function atomicWriteRecord(paths, record) {
  validateRecord(record);
  const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
  if (bytes.length > MAX_RECORD_BYTES) {
    fail('attachment_schema_unsupported', 'Workspace attachment record exceeds its size limit.');
  }
  atomicWriteFile(paths.record, bytes, 0o600, '.attachments-');
}

function withWorkspaceLock(paths, action) {
  ensureWorkspaceLayout(paths);
  let descriptor;
  let acquired = false;
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  while (!acquired) {
    try {
      descriptor = fs.openSync(
        paths.lock,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
        0o600,
      );
      acquired = true;
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      if (!recoverDeadLock(paths.lock)) {
        fail('workspace_locked', 'Another workspace attachment mutation holds the lock.');
      }
    }
  }
  try {
    fs.writeFileSync(
      descriptor,
      `${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })}\n`,
      'utf8',
    );
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    return action();
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (acquired) {
      unlinkIfPresent(paths.lock);
      fsyncDirectory(paths.kdnaDirectory);
    }
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

function recoverDeadLock(lock) {
  let owner;
  try {
    const bytes = safeReadRegular(lock, 4096, 'Workspace attachment lock');
    owner = JSON.parse(bytes.toString('utf8'));
  } catch {
    return false;
  }
  if (!isPlainObject(owner) || !Number.isInteger(owner.pid) || processIsAlive(owner.pid)) {
    return false;
  }
  const stale = path.join(
    path.dirname(lock),
    `.attachments-lock-stale-${process.pid}-${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  try {
    fs.renameSync(lock, stale);
    unlinkIfPresent(stale);
    fsyncDirectory(path.dirname(lock));
    return true;
  } catch (error) {
    unlinkIfPresent(stale);
    return Boolean(error && error.code === 'ENOENT');
  }
}

function inspectPreparedAsset(sourcePath) {
  const absolute = path.resolve(sourcePath);
  if (!absolute.endsWith('.kdna')) {
    fail('asset_invalid', 'Attachment source must be an explicit .kdna file.');
  }
  let bytes;
  try {
    bytes = snapshotAssetFile(absolute);
  } catch {
    fail('asset_invalid', 'Attachment source must be a bounded regular non-symlink .kdna file.');
  }
  let manifest;
  let plan;
  try {
    manifest = core.inspect(bytes);
    plan = core.planLoad(bytes);
  } catch {
    fail('asset_invalid', 'Attachment source is not a valid KDNA container.');
  }
  if (
    !manifest ||
    typeof manifest.asset_id !== 'string' ||
    manifest.asset_id.length === 0 ||
    typeof manifest.version !== 'string' ||
    manifest.version.length === 0 ||
    !plan ||
    plan.state === 'invalid' ||
    plan.checks?.overall_valid !== true
  ) {
    fail('asset_invalid', 'Attachment source does not produce a valid identity and LoadPlan.');
  }
  const digest = sha256(bytes);
  return {
    bytes,
    manifest,
    plan,
    digest,
    asset: {
      id: manifest.asset_id,
      version: manifest.version,
      digest,
      snapshot: snapshotPathForDigest(digest),
    },
    preview: {
      asset_id: manifest.asset_id,
      version: manifest.version,
      digest,
      access: plan.access,
      load_plan_state: plan.state,
      can_load_now: plan.can_load_now === true,
    },
  };
}

function verifyExistingSnapshot(snapshot, expectedDigest) {
  const bytes = safeReadRegular(snapshot, 256 * 1024 * 1024, 'Workspace snapshot');
  if (sha256(bytes) !== expectedDigest) {
    fail('snapshot_digest_mismatch', 'Existing workspace snapshot digest does not match its name.');
  }
  return bytes;
}

function storeSnapshot(paths, prepared) {
  const target = path.join(paths.kdnaDirectory, ...prepared.asset.snapshot.split('/'));
  try {
    verifyExistingSnapshot(target, prepared.digest);
    return target;
  } catch (error) {
    if (!(error instanceof WorkspaceAttachmentError) || error.code !== 'snapshot_missing')
      throw error;
  }

  const temporary = path.join(
    paths.assetsDirectory,
    `.snapshot-${process.pid}-${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );
    fs.writeFileSync(descriptor, prepared.bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    if (
      sha256(safeReadRegular(temporary, 256 * 1024 * 1024, 'Temporary snapshot')) !==
      prepared.digest
    ) {
      fail('snapshot_digest_mismatch', 'Temporary snapshot digest verification failed.');
    }
    try {
      verifyExistingSnapshot(target, prepared.digest);
      fs.unlinkSync(temporary);
    } catch (error) {
      if (!(error instanceof WorkspaceAttachmentError) || error.code !== 'snapshot_missing')
        throw error;
      fs.renameSync(temporary, target);
      try {
        fs.chmodSync(target, 0o600);
      } catch {
        // POSIX modes are best effort on platforms without chmod semantics.
      }
      fsyncDirectory(paths.assetsDirectory);
    }
    verifyExistingSnapshot(target, prepared.digest);
    return target;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    unlinkIfPresent(temporary);
  }
}

function cleanScopeTerms(values) {
  const output = [];
  const seen = new Set();
  for (const value of values || []) {
    const cleaned = String(value).trim().replace(/\s+/gu, ' ');
    if (!cleaned || cleaned.length > MAX_TEXT_LENGTH) {
      fail('input_invalid', 'Scope phrases must be non-empty bounded strings.');
    }
    const normalized = normalizedPhrase(cleaned);
    if (seen.has(normalized)) fail('input_invalid', 'Scope phrases must be unique.');
    seen.add(normalized);
    output.push(cleaned);
  }
  if (output.length > MAX_SCOPE_TERMS) fail('input_invalid', 'Too many scope phrases.');
  return output;
}

function requireApproval(prepared, approve) {
  if (typeof approve !== 'function' || approve(prepared.preview) !== true) {
    fail('approval_required', 'Attachment approval was not granted.');
  }
}

function attachWorkspace(options) {
  const prepared = inspectPreparedAsset(options.sourcePath);
  requireApproval(prepared, options.approve);
  const workspace = mutationWorkspace(options.cwd);
  const role = String(options.role || prepared.asset.id)
    .trim()
    .replace(/\s+/gu, ' ');
  if (!role || role.length > MAX_TEXT_LENGTH) fail('input_invalid', 'Attachment role is invalid.');
  const appliesTo = cleanScopeTerms(options.appliesTo);
  const doesNotApplyTo = cleanScopeTerms(options.doesNotApplyTo);
  const now = options.now || new Date().toISOString();
  const attachment = {
    attachment_id: `att_${crypto.randomBytes(12).toString('hex')}`,
    asset: prepared.asset,
    state: 'enabled',
    role,
    scope: {
      kind: 'workspace',
      applies_to: appliesTo,
      does_not_apply_to: doesNotApplyTo,
    },
    resolution_policy: 'load_when_clear_ask_when_ambiguous',
    approved_at: now,
    update_policy: 'explicit_switch_only',
    history: [],
  };
  return withWorkspaceLock(workspace.paths, () => {
    const record = readRecord(workspace.paths, { optional: true }) || emptyRecord();
    if (record.attachments.length >= MAX_ATTACHMENTS) {
      fail('input_invalid', 'Workspace attachment limit reached.');
    }
    storeSnapshot(workspace.paths, prepared);
    record.attachments.push(attachment);
    atomicWriteRecord(workspace.paths, record);
    return { workspace_root: workspace.root, attachment, preview: prepared.preview };
  });
}

function listWorkspaceAttachments(cwd = process.cwd()) {
  const workspace = findWorkspace(cwd);
  if (!workspace.root) return { workspace_root: null, record: null };
  return { workspace_root: workspace.root, record: readRecord(workspace.paths) };
}

function findAttachment(record, attachmentId) {
  if (!ATTACHMENT_ID_PATTERN.test(String(attachmentId))) {
    fail('input_invalid', 'Attachment ID must be att_ plus 24 lowercase hexadecimal characters.');
  }
  const attachment = record.attachments.find((item) => item.attachment_id === attachmentId);
  if (!attachment) fail('attachment_not_found', `Attachment ${attachmentId} was not found.`);
  return attachment;
}

function snapshotAbsolutePath(paths, asset) {
  validateAssetReference(asset, 'asset');
  const absolute = path.resolve(paths.kdnaDirectory, ...asset.snapshot.split('/'));
  if (!withinOrEqual(absolute, paths.assetsDirectory)) {
    fail('attachment_schema_unsupported', 'Snapshot path escapes .kdna/assets.');
  }
  return absolute;
}

function verifyAssetReference(paths, asset) {
  const snapshot = snapshotAbsolutePath(paths, asset);
  let bytes;
  try {
    bytes = safeReadRegular(snapshot, 256 * 1024 * 1024, 'Workspace snapshot');
  } catch (error) {
    if (error instanceof WorkspaceAttachmentError && error.code === 'snapshot_missing') throw error;
    fail('asset_invalid', 'Workspace snapshot is not a regular readable file.');
  }
  if (sha256(bytes) !== asset.digest) {
    fail(
      'snapshot_digest_mismatch',
      'Workspace snapshot digest differs from the attachment record.',
    );
  }
  let manifest;
  let plan;
  let externalSession = null;
  try {
    manifest = core.inspect(bytes);
  } catch {
    fail('asset_invalid', 'Workspace snapshot is not a valid KDNA container.');
  }
  try {
    externalSession = loadExternalAuthorization(snapshot, manifest);
  } catch {
    // A missing, expired, or invalid local grant is represented by the stable
    // authorization_required resolver result below, never by provider details.
  }
  try {
    plan = core.planLoad(bytes, { entitlement: externalSession?.entitlement });
  } finally {
    externalSession?.dispose();
  }
  if (
    !manifest ||
    manifest.asset_id !== asset.id ||
    manifest.version !== asset.version ||
    !plan ||
    plan.state === 'invalid' ||
    plan.checks?.overall_valid !== true
  ) {
    fail('asset_invalid', 'Workspace snapshot identity or LoadPlan is invalid.');
  }
  return { bytes, manifest, plan };
}

function mutateAttachment(cwd, attachmentId, mutation) {
  const workspace = findWorkspace(cwd);
  if (!workspace.root) fail('attachment_not_found', 'No workspace attachment record was found.');
  return withWorkspaceLock(workspace.paths, () => {
    const record = readRecord(workspace.paths);
    const attachment = findAttachment(record, attachmentId);
    const result = mutation({ attachment, record, workspace });
    atomicWriteRecord(workspace.paths, record);
    return result || { workspace_root: workspace.root, attachment };
  });
}

function setAttachmentState(options) {
  if (!['enabled', 'disabled'].includes(options.state)) fail('input_invalid', 'Invalid state.');
  return mutateAttachment(options.cwd, options.attachmentId, ({ attachment, workspace }) => {
    if (options.state === 'enabled') verifyAssetReference(workspace.paths, attachment.asset);
    attachment.state = options.state;
    return { workspace_root: workspace.root, attachment };
  });
}

function switchWorkspaceAttachment(options) {
  const prepared = inspectPreparedAsset(options.sourcePath);
  requireApproval(prepared, options.approve);
  const now = options.now || new Date().toISOString();
  return mutateAttachment(options.cwd, options.attachmentId, ({ attachment, workspace }) => {
    storeSnapshot(workspace.paths, prepared);
    attachment.history.push({ asset: attachment.asset, replaced_at: now });
    attachment.asset = prepared.asset;
    attachment.approved_at = now;
    return { workspace_root: workspace.root, attachment, preview: prepared.preview };
  });
}

function rollbackWorkspaceAttachment(options) {
  return mutateAttachment(options.cwd, options.attachmentId, ({ attachment, workspace }) => {
    if (attachment.history.length === 0)
      fail('history_empty', 'Attachment has no retained version.');
    const previous = attachment.history[attachment.history.length - 1];
    verifyAssetReference(workspace.paths, previous.asset);
    attachment.asset = previous.asset;
    attachment.history.pop();
    attachment.approved_at = options.now || new Date().toISOString();
    return { workspace_root: workspace.root, attachment };
  });
}

function removeWorkspaceAttachment(options) {
  return mutateAttachment(
    options.cwd,
    options.attachmentId,
    ({ attachment, record, workspace }) => {
      record.attachments = record.attachments.filter(
        (item) => item.attachment_id !== attachment.attachment_id,
      );
      return { workspace_root: workspace.root, removed: attachment };
    },
  );
}

function candidateFor(attachment) {
  return {
    attachment_id: attachment.attachment_id,
    asset_id: attachment.asset.id,
    version: attachment.asset.version,
    digest: attachment.asset.digest,
    role: attachment.role,
  };
}

function displayWorkspaceRoot(start, root) {
  const relative = path.relative(start, root) || '.';
  return relative.split(path.sep).join('/');
}

function resolutionResult({
  decision,
  reasonCode,
  workspaceRoot,
  selected = null,
  candidates = [],
  authorization,
  integrity,
}) {
  return {
    document_type: RESOLUTION_TYPE,
    schema_version: SCHEMA_VERSION,
    decision,
    reason_code: reasonCode,
    workspace_root: workspaceRoot,
    selected,
    candidates,
    authorization,
    integrity,
  };
}

function blockResult(reasonCode, workspaceRoot, candidates, authorization, integrity) {
  return resolutionResult({
    decision: 'block',
    reasonCode,
    workspaceRoot,
    candidates,
    authorization,
    integrity,
  });
}

function decodeTaskFile(taskFile) {
  const absolute = path.resolve(taskFile);
  const bytes = safeReadRegular(absolute, MAX_TASK_BYTES, 'Task file');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('input_invalid', 'Task file must contain valid UTF-8 text.');
  }
}

function resolveWorkspace(options) {
  const start = assertDirectory(options.cwd || process.cwd(), 'Working directory');
  if ((options.adapterSchema || SCHEMA_VERSION) !== SCHEMA_VERSION) {
    return blockResult('adapter_incompatible', '.', [], 'not_checked', 'not_checked');
  }
  const task = normalizedPhrase(decodeTaskFile(options.taskFile));
  let workspace;
  try {
    workspace = findWorkspace(start);
  } catch {
    return blockResult('attachment_schema_unsupported', '.', [], 'not_checked', 'not_checked');
  }
  if (!workspace.root) {
    return resolutionResult({
      decision: 'skip',
      reasonCode: 'no_approved_attachment',
      workspaceRoot: '.',
      authorization: 'not_checked',
      integrity: 'not_checked',
    });
  }
  const workspaceRoot = displayWorkspaceRoot(start, workspace.root);
  let record;
  try {
    record = readRecord(workspace.paths);
  } catch {
    return blockResult(
      'attachment_schema_unsupported',
      workspaceRoot,
      [],
      'not_checked',
      'not_checked',
    );
  }
  const enabled = record.attachments.filter((attachment) => attachment.state === 'enabled');
  if (enabled.length === 0) {
    return resolutionResult({
      decision: 'skip',
      reasonCode: 'no_approved_attachment',
      workspaceRoot,
      authorization: 'not_checked',
      integrity: 'not_checked',
    });
  }

  const verified = [];
  for (const attachment of enabled) {
    const candidate = candidateFor(attachment);
    let asset;
    try {
      asset = verifyAssetReference(workspace.paths, attachment.asset);
    } catch (error) {
      const code =
        error instanceof WorkspaceAttachmentError &&
        ['snapshot_missing', 'snapshot_digest_mismatch'].includes(error.code)
          ? error.code
          : 'asset_invalid';
      return blockResult(code, workspaceRoot, [candidate], 'not_checked', 'failed');
    }
    if (asset.plan.can_load_now !== true) {
      return blockResult(
        'authorization_required',
        workspaceRoot,
        [candidate],
        'required',
        'verified',
      );
    }
    verified.push({ attachment, candidate });
  }

  const evaluated = verified.map(({ attachment, candidate }) => {
    const positives = attachment.scope.applies_to.some((term) =>
      task.includes(normalizedPhrase(term)),
    );
    const negatives = attachment.scope.does_not_apply_to.some((term) =>
      task.includes(normalizedPhrase(term)),
    );
    return { attachment, candidate, positives, negatives };
  });
  const internallyAmbiguous = evaluated.filter((item) => item.positives && item.negatives);
  const positive = evaluated.filter((item) => item.positives && !item.negatives);
  const negative = evaluated.filter((item) => item.negatives && !item.positives);
  const unmatched = evaluated.filter((item) => !item.positives && !item.negatives);

  if (internallyAmbiguous.length > 0) {
    return resolutionResult({
      decision: 'ask',
      reasonCode: 'ambiguous_scope',
      workspaceRoot,
      candidates: internallyAmbiguous.map((item) => item.candidate),
      authorization: 'satisfied',
      integrity: 'verified',
    });
  }
  const sameRoleContradiction = positive.some((positiveItem) =>
    negative.some((negativeItem) => negativeItem.attachment.role === positiveItem.attachment.role),
  );
  if (positive.length > 1 || sameRoleContradiction) {
    return resolutionResult({
      decision: 'ask',
      reasonCode: 'attachment_conflict',
      workspaceRoot,
      candidates: [...positive, ...negative].map((item) => item.candidate),
      authorization: 'satisfied',
      integrity: 'verified',
    });
  }
  if (positive.length === 1 && unmatched.length === 0) {
    return resolutionResult({
      decision: 'load',
      reasonCode: 'single_approved_attachment_clearly_applies',
      workspaceRoot,
      selected: positive[0].candidate,
      candidates: [positive[0].candidate],
      authorization: 'satisfied',
      integrity: 'verified',
    });
  }
  if (positive.length === 0 && unmatched.length === 0 && negative.length > 0) {
    return resolutionResult({
      decision: 'skip',
      reasonCode: 'outside_scope',
      workspaceRoot,
      candidates: negative.map((item) => item.candidate),
      authorization: 'satisfied',
      integrity: 'verified',
    });
  }
  return resolutionResult({
    decision: 'ask',
    reasonCode: 'ambiguous_scope',
    workspaceRoot,
    candidates: [...positive, ...unmatched].map((item) => item.candidate),
    authorization: 'satisfied',
    integrity: 'verified',
  });
}

module.exports = {
  ATTACHMENT_ID_PATTERN,
  DOCUMENT_TYPE,
  GITIGNORE_PATTERNS,
  MAX_RECORD_BYTES,
  MAX_TASK_BYTES,
  RESOLUTION_TYPE,
  SCHEMA_VERSION,
  WorkspaceAttachmentError,
  attachWorkspace,
  emptyRecord,
  findWorkspace,
  inspectPreparedAsset,
  listWorkspaceAttachments,
  normalizedPhrase,
  removeWorkspaceAttachment,
  resolveWorkspace,
  rollbackWorkspaceAttachment,
  safeReadRegular,
  setAttachmentState,
  sha256,
  snapshotPathForDigest,
  switchWorkspaceAttachment,
  validateRecord,
  verifyAssetReference,
};
