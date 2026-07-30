'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const core = require('@aikdna/kdna-core');
const { loadExternalAuthorization } = require('./runtime-entitlement');
const { snapshotAssetFile } = require('./snapshot-asset');

const DOCUMENT_TYPE = 'kdna.workspace-attachments';
const RESOLUTION_TYPE = 'kdna.workspace-resolution';
const SCHEMA_VERSION = '0.3.0';
const LEGACY_SCHEMA_VERSIONS = new Set(['0.1.0', '0.2.0']);
const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_TASK_BYTES = 64 * 1024;
const MAX_ATTACHMENTS = 1024;
const MAX_SCOPE_TERMS = 256;
const MAX_TEXT_LENGTH = 4096;
const ATTACHMENT_ID_PATTERN = /^att_[0-9a-f]{24}$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const SNAPSHOT_FILE_PATTERN = /^sha256-([0-9a-f]{64})\.kdna$/;
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const GITIGNORE_PATTERNS = Object.freeze([
  '/.gitignore',
  '/assets/',
  '/attachments.json',
  '/attachments.lock',
  '/.attachments-*.tmp',
  '/cleanup-last-receipt.json',
  '/.cleanup-staging-*/',
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
  return String(value).normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('und');
}

function normalizedLatinRoutingText(value) {
  return normalizedPhrase(value)
    .replace(/[\u2018\u2019\u02bc\uff07]/gu, "'")
    .replace(/\b[\p{L}]+n't\b/gu, ' not ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function scopeTermAssessment(task, term) {
  const normalizedTask = normalizedPhrase(task);
  const normalizedTerm = normalizedPhrase(term);
  if (
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(normalizedTerm)
  ) {
    const cjkComparable = (value) => value.replace(/[\p{P}\p{Z}\s]+/gu, '');
    const comparableTask = cjkComparable(normalizedTask);
    const comparableTerm = cjkComparable(normalizedTerm);
    const start = comparableTask.indexOf(comparableTerm);
    if (start < 0) {
      const approximate =
        comparableTerm.length >= 3 &&
        Array.from({ length: comparableTerm.length - 1 }, (_, index) =>
          comparableTerm.slice(index, index + 2),
        ).some((part) => comparableTask.includes(part));
      return { matched: approximate, uncertain: approximate };
    }
    const preceding = comparableTask.slice(Math.max(0, start - 6), start);
    const uncertain =
      comparableTerm.length < 3 ||
      /(?:不要|不应|不能|不可|别|勿|禁止|避免|无需|不用)$/u.test(preceding) ||
      /(?:讨论|解释|引用|提到|标签|词语|示例|是否)/u.test(comparableTask) ||
      /(?:只|而不是|但|但是|不过|改为|改成)/u.test(comparableTask) ||
      [`“${normalizedTerm}”`, `「${normalizedTerm}」`, `『${normalizedTerm}』`].some((quoted) =>
        normalizedTask.includes(quoted),
      );
    return { matched: true, uncertain };
  }
  const latinTask = normalizedLatinRoutingText(normalizedTask);
  const latinTerm = normalizedLatinRoutingText(normalizedTerm);
  const tokens = (value) => value.match(/[\p{L}\p{N}]+/gu) || [];
  const taskTokens = tokens(latinTask);
  const termTokens = tokens(latinTerm);
  if (termTokens.length === 0 || termTokens.length > taskTokens.length) {
    return { matched: false, uncertain: false };
  }
  const start = taskTokens.findIndex(
    (_, index) =>
      index + termTokens.length <= taskTokens.length &&
      termTokens.every((token, offset) => taskTokens[index + offset] === token),
  );
  if (start < 0) {
    const approximate = termTokens.some(
      (termToken) =>
        termToken.length >= 4 &&
        taskTokens.some((taskToken) => {
          if (taskToken.length < 4) return false;
          if (taskToken.includes(termToken) || termToken.includes(taskToken)) return true;
          let sharedPrefix = 0;
          while (
            sharedPrefix < termToken.length &&
            sharedPrefix < taskToken.length &&
            termToken[sharedPrefix] === taskToken[sharedPrefix]
          ) {
            sharedPrefix += 1;
          }
          return sharedPrefix >= 4;
        }),
    );
    return { matched: approximate, uncertain: approximate };
  }
  const preceding = taskTokens.slice(Math.max(0, start - 6), start);
  const negationTokens = new Set([
    'no',
    'not',
    'never',
    'avoid',
    'without',
    'dont',
  ]);
  const broadTerms = new Set(['all', 'any', 'general', 'help', 'task', 'thing', 'work']);
  const uncertain =
    (termTokens.length === 1 && (termTokens[0].length < 4 || broadTerms.has(termTokens[0]))) ||
    termTokens.some((token) => negationTokens.has(token)) ||
    preceding.some((token) => negationTokens.has(token)) ||
    taskTokens.some((token) =>
      [
        'discuss',
        'explain',
        'mention',
        'quote',
        'label',
        'term',
        'phrase',
        'example',
        'whether',
      ].includes(token),
    ) ||
    /(?:^|[;\s])(?:but|only|instead)(?:[;\s]|$)|\brather\s+than\b|\b(?:do\s+not|not\s+for|instead\s+of)\b/iu.test(
      latinTask,
    ) ||
    [
      `"${normalizedTerm}"`,
      `'${normalizedTerm}'`,
      `“${normalizedTerm}”`,
      `‘${normalizedTerm}’`,
    ].some((quoted) =>
      normalizedTask.includes(quoted),
    );
  return { matched: true, uncertain };
}

function scopeTermMatches(task, term) {
  return scopeTermAssessment(task, term).matched;
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
  assertExactKeys(
    attachment.scope,
    [
      'kind',
      'application',
      'matching_policy',
      'authority',
      'approval_source',
      'applies_to',
      'does_not_apply_to',
    ],
    `${label}.scope`,
  );
  if (attachment.scope.kind !== 'workspace') {
    fail('attachment_schema_unsupported', `${label}.scope.kind must be workspace.`);
  }
  if (attachment.scope.authority !== 'user_approved_routing_hint') {
    fail(
      'attachment_schema_unsupported',
      `${label}.scope.authority must remain a user-approved routing hint.`,
    );
  }
  if (!['user_explicit', 'preview_confirmed'].includes(attachment.scope.approval_source)) {
    fail('attachment_schema_unsupported', `${label}.scope.approval_source is unsupported.`);
  }
  if (!['task_hints', 'all_workspace'].includes(attachment.scope.application)) {
    fail('attachment_schema_unsupported', `${label}.scope.application is unsupported.`);
  }
  if (
    !['open_world_ask', 'closed_world_skip', 'all_workspace'].includes(
      attachment.scope.matching_policy,
    )
  ) {
    fail('attachment_schema_unsupported', `${label}.scope.matching_policy is unsupported.`);
  }
  validateScopeTerms(attachment.scope.applies_to, `${label}.scope.applies_to`);
  validateScopeTerms(attachment.scope.does_not_apply_to, `${label}.scope.does_not_apply_to`);
  if (
    (attachment.scope.application === 'task_hints' && attachment.scope.applies_to.length === 0) ||
    (attachment.scope.application === 'all_workspace' &&
      (attachment.scope.applies_to.length !== 0 ||
        attachment.scope.matching_policy !== 'all_workspace')) ||
    (attachment.scope.application === 'task_hints' &&
      attachment.scope.matching_policy === 'all_workspace')
  ) {
    fail(
      'attachment_schema_unsupported',
      `${label}.scope.application and applies_to do not form an executable scope.`,
    );
  }
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
    assertExactKeys(
      entry,
      [
        'asset',
        'role',
        'scope',
        'resolution_policy',
        'approved_at',
        'update_policy',
        'replaced_at',
      ],
      historyLabel,
    );
    validateAssetReference(entry.asset, `${historyLabel}.asset`);
    assertText(entry.role, `${historyLabel}.role`);
    validateAttachment(
      {
        attachment_id: `att_${'0'.repeat(24)}`,
        asset: entry.asset,
        state: 'enabled',
        role: entry.role,
        scope: entry.scope,
        resolution_policy: entry.resolution_policy,
        approved_at: entry.approved_at,
        update_policy: entry.update_policy,
        history: [],
      },
      `${index}.history.${historyIndex}`,
    );
    assertTimestamp(entry.replaced_at, `${historyLabel}.replaced_at`);
  });
}

function validateRecord(record) {
  assertExactKeys(
    record,
    ['document_type', 'schema_version', 'workspace', 'attachments'],
    'record',
  );
  if (record.document_type === DOCUMENT_TYPE && LEGACY_SCHEMA_VERSIONS.has(record.schema_version)) {
    fail(
      'attachment_schema_migration_required',
      `Workspace attachment schema ${record.schema_version} is an unreleased historical candidate; re-attach under schema 0.3.0 so switch history preserves exact policy and open/closed-world applicability.`,
    );
  }
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

function findWorkspace(cwd = process.cwd(), workspaceRoot = null) {
  const start = assertDirectory(cwd, 'Working directory');
  let home = null;
  try {
    home = fs.realpathSync(os.homedir());
  } catch {
    home = null;
  }
  const explicitBoundary = workspaceRoot !== null && workspaceRoot !== undefined;
  const implicitBoundary =
    home !== null && withinOrEqual(start, home) ? home : path.parse(start).root;
  const boundary = assertDirectory(
    explicitBoundary ? workspaceRoot : implicitBoundary,
    explicitBoundary ? 'Workspace root boundary' : 'Implicit lookup boundary',
  );
  if (!withinOrEqual(start, boundary)) {
    fail(
      'workspace_boundary_escape',
      'Working directory must stay inside the explicit workspace root boundary.',
    );
  }
  let current = start;
  while (true) {
    const candidate = pathsForRoot(current);
    try {
      const kdnaStat = fs.lstatSync(candidate.kdnaDirectory);
      if (kdnaStat.isSymbolicLink() || !kdnaStat.isDirectory()) {
        fail(
          'attachment_schema_unsupported',
          'Workspace attachment directory is not a regular directory.',
        );
      }
      const stat = fs.lstatSync(candidate.record);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        fail('attachment_schema_unsupported', 'Workspace attachment record is not a regular file.');
      }
      if (home !== null && current === home) {
        fail(
          'home_workspace_ambiguous',
          'The home-level .kdna directory cannot act as project attachment authority.',
        );
      }
      if (!explicitBoundary && current === boundary) {
        fail(
          'workspace_boundary_ambiguous',
          'An implicit HOME or filesystem-root record cannot act as project attachment authority.',
        );
      }
      return { start, boundary, root: current, paths: candidate };
    } catch (error) {
      if (error instanceof WorkspaceAttachmentError) throw error;
      if (!error || error.code !== 'ENOENT') {
        fail('attachment_schema_unsupported', 'Workspace attachment record cannot be inspected.');
      }
    }

    if (current === boundary) break;
    const parent = path.dirname(current);
    if (parent === current || !withinOrEqual(parent, boundary)) break;
    current = parent;
  }
  return { start, boundary, root: null, paths: null };
}

function mutationWorkspace(cwd = process.cwd()) {
  const root = assertDirectory(cwd, 'Working directory');
  const rootStat = fs.statSync(root);
  let home = null;
  try {
    home = fs.realpathSync(os.homedir());
  } catch {
    home = null;
  }
  if (home !== null && root === home) {
    fail(
      'home_workspace_ambiguous',
      'The home-level .kdna directory cannot act as project attachment authority.',
    );
  }
  if (root === path.parse(root).root) {
    fail(
      'workspace_root_ambiguous',
      'The filesystem root cannot act as project attachment authority.',
    );
  }
  return {
    start: root,
    root,
    rootBinding: { dev: rootStat.dev, ino: rootStat.ino },
    paths: pathsForRoot(root),
  };
}

function assertMutationWorkspaceBinding(workspace) {
  try {
    const lstat = fs.lstatSync(workspace.root);
    const real = fs.realpathSync(workspace.root);
    const stat = fs.statSync(real);
    if (
      lstat.isSymbolicLink() ||
      !lstat.isDirectory() ||
      real !== workspace.root ||
      stat.dev !== workspace.rootBinding.dev ||
      stat.ino !== workspace.rootBinding.ino
    ) {
      throw new Error('Workspace root changed');
    }
  } catch {
    fail(
      'workspace_binding_changed',
      'The exact workspace root changed after attachment approval.',
    );
  }
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

function readRecordSnapshot(paths, { optional = false } = {}) {
  try {
    const bytes = safeReadRegular(paths.record, MAX_RECORD_BYTES, 'Workspace attachment record');
    let record;
    try {
      record = JSON.parse(bytes.toString('utf8'));
    } catch {
      fail('attachment_schema_unsupported', 'Workspace attachment record is not valid JSON.');
    }
    return {
      bytes,
      digest: sha256(bytes),
      record: validateRecord(record),
    };
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

function readRecord(paths, options = {}) {
  return readRecordSnapshot(paths, options)?.record || null;
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
  let acquired = false;
  while (!acquired) {
    const owner = path.join(
      paths.kdnaDirectory,
      `.attachments-lock-owner-${process.pid}-${crypto.randomBytes(8).toString('hex')}.tmp`,
    );
    let descriptor;
    try {
      descriptor = fs.openSync(
        owner,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
        0o600,
      );
      fs.writeFileSync(
        descriptor,
        `${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })}\n`,
        'utf8',
      );
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.linkSync(owner, paths.lock);
      acquired = true;
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      if (!recoverDeadLock(paths.lock)) {
        fail('workspace_locked', 'Another workspace attachment mutation holds the lock.');
      }
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      unlinkIfPresent(owner);
      fsyncDirectory(paths.kdnaDirectory);
    }
  }
  try {
    return action();
  } finally {
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

function prepareAttachmentPolicy(options, fallback = null) {
  const retain = options.retainPolicy === true;
  if (retain && !fallback) {
    fail('input_invalid', 'No existing attachment policy is available to retain.');
  }
  const appliesTo = cleanScopeTerms(retain ? fallback.scope.applies_to : options.appliesTo);
  const doesNotApplyTo = cleanScopeTerms(
    retain ? fallback.scope.does_not_apply_to : options.doesNotApplyTo,
  );
  const application = retain
    ? fallback.scope.application
    : options.scopeApplication || 'task_hints';
  if (!['task_hints', 'all_workspace'].includes(application)) {
    fail('input_invalid', 'Attachment scope application mode is invalid.');
  }
  if (
    (application === 'task_hints' && appliesTo.length === 0) ||
    (application === 'all_workspace' && appliesTo.length !== 0)
  ) {
    fail(
      'input_invalid',
      'Attachment scope requires positive task hints or an explicit all-workspace authorization.',
    );
  }
  const matchingPolicy = retain
    ? fallback.scope.matching_policy
    : application === 'all_workspace'
      ? 'all_workspace'
      : options.matchingPolicy || 'open_world_ask';
  if (
    (application === 'task_hints' &&
      !['open_world_ask', 'closed_world_skip'].includes(matchingPolicy)) ||
    (application === 'all_workspace' && matchingPolicy !== 'all_workspace')
  ) {
    fail(
      'input_invalid',
      'Attachment matching policy must be open-world ask, explicitly approved closed-world skip, or all-workspace.',
    );
  }
  const derivedRole = application === 'all_workspace' ? 'workspace-wide' : appliesTo[0];
  const role = String(retain ? fallback.role : options.role || derivedRole)
    .trim()
    .replace(/\s+/gu, ' ');
  if (!role || role.length > MAX_TEXT_LENGTH) {
    fail(
      'input_invalid',
      'Attachment role must be a meaningful bounded value approved for this workspace.',
    );
  }
  const scopeApproval =
    options.scopeApproval === undefined ? 'preview_confirmed' : options.scopeApproval;
  if (!['user_explicit', 'preview_confirmed'].includes(scopeApproval)) {
    fail('input_invalid', 'Attachment scope approval source is invalid.');
  }
  return {
    role,
    scope: {
      kind: 'workspace',
      application,
      matching_policy: matchingPolicy,
      authority: 'user_approved_routing_hint',
      approval_source: scopeApproval,
      applies_to: appliesTo,
      does_not_apply_to: doesNotApplyTo,
    },
    resolution_policy: 'load_when_clear_ask_when_ambiguous',
    update_policy: 'explicit_switch_only',
  };
}

function requireApproval(prepared, approve) {
  if (typeof approve !== 'function' || approve(prepared.preview) !== true) {
    fail('approval_required', 'Attachment approval was not granted.');
  }
}

function assertApprovedSourceBinding(sourcePath, expectedDigest) {
  try {
    const current = snapshotAssetFile(path.resolve(sourcePath));
    if (sha256(current) !== expectedDigest) throw new Error('Asset digest changed');
  } catch {
    fail('approval_binding_changed', 'The exact attachment asset changed after approval.');
  }
}

function attachWorkspace(options) {
  const prepared = inspectPreparedAsset(options.sourcePath);
  const workspace = mutationWorkspace(options.cwd);
  const policy = prepareAttachmentPolicy(options);
  const attachmentProposal = {
    asset: prepared.asset,
    state: 'enabled',
    ...policy,
  };
  const consentFacts = {
    workspace_root: workspace.root,
    attachment: attachmentProposal,
    authorization: {
      access: prepared.plan.access,
      required_before_load: prepared.plan.can_load_now !== true,
      load_plan_state: prepared.plan.state,
    },
  };
  const consentDigest = sha256(Buffer.from(JSON.stringify(consentFacts), 'utf8'));
  const preview = {
    operation: 'attach',
    consent_digest: consentDigest,
    workspace_boundary: {
      kind: 'exact_workspace',
      root: displayWorkspaceRoot(process.cwd(), workspace.root),
    },
    attachment: attachmentProposal,
    authorization: consentFacts.authorization,
    scope_contract: {
      authority: 'user_approved_routing_hint',
      asset_declared_preload_boundary: 'not_available_in_current_manifest_contract',
      runtime_boundary_remains_authoritative: true,
    },
  };
  if (options.previewOnly === true) {
    return {
      workspace_root: workspace.root,
      attachment: null,
      preview,
      preview_only: true,
    };
  }
  if (
    options.expectedConsentDigest !== undefined &&
    options.expectedConsentDigest !== consentDigest
  ) {
    fail(
      'approval_binding_changed',
      'The attachment workspace, asset, role, scope, or authorization facts changed after preview.',
    );
  }
  requireApproval({ preview }, options.approve);
  assertMutationWorkspaceBinding(workspace);
  assertApprovedSourceBinding(options.sourcePath, prepared.digest);
  if (sha256(Buffer.from(JSON.stringify(consentFacts), 'utf8')) !== consentDigest) {
    fail(
      'approval_binding_changed',
      'The attachment role, scope, asset, or authorization facts changed after approval.',
    );
  }
  const now = options.now || new Date().toISOString();
  const attachment = {
    attachment_id: `att_${crypto.randomBytes(12).toString('hex')}`,
    ...attachmentProposal,
    approved_at: now,
    history: [],
  };
  return withWorkspaceLock(workspace.paths, () => {
    assertMutationWorkspaceBinding(workspace);
    const record = readRecord(workspace.paths, { optional: true }) || emptyRecord();
    if (record.attachments.length >= MAX_ATTACHMENTS) {
      fail('input_invalid', 'Workspace attachment limit reached.');
    }
    storeSnapshot(workspace.paths, prepared);
    record.attachments.push(attachment);
    atomicWriteRecord(workspace.paths, record);
    return { workspace_root: workspace.root, attachment, preview };
  });
}

function listWorkspaceAttachments(cwd = process.cwd(), workspaceRoot = null) {
  const workspace = findWorkspace(cwd, workspaceRoot);
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

function verifyAssetReference(paths, asset, options = {}) {
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
  const passwordAuthorizationDeferred =
    options.deferPasswordAuthorization === true &&
    plan.state === 'needs_password' &&
    plan.issues?.some(
      (issue) => issue.code === 'KDNA_AUTH_PASSWORD_REQUIRED',
    );
  return { bytes, manifest, plan, passwordAuthorizationDeferred };
}

function mutateAttachment(cwd, workspaceRoot, attachmentId, mutation) {
  const workspace = findWorkspace(cwd, workspaceRoot);
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
  return mutateAttachment(
    options.cwd,
    options.workspaceRoot,
    options.attachmentId,
    ({ attachment, workspace }) => {
      if (options.state === 'enabled') verifyAssetReference(workspace.paths, attachment.asset);
      attachment.state = options.state;
      return { workspace_root: workspace.root, attachment };
    },
  );
}

function attachmentPolicyState(attachment) {
  return {
    asset: { ...attachment.asset },
    role: attachment.role,
    scope: {
      ...attachment.scope,
      applies_to: [...attachment.scope.applies_to],
      does_not_apply_to: [...attachment.scope.does_not_apply_to],
    },
    resolution_policy: attachment.resolution_policy,
    approved_at: attachment.approved_at,
    update_policy: attachment.update_policy,
  };
}

function authorizationFacts(plan) {
  return {
    access: plan.access,
    required_before_load: plan.can_load_now !== true,
    load_plan_state: plan.state,
  };
}

function switchWorkspaceAttachment(options) {
  const prepared = inspectPreparedAsset(options.sourcePath);
  const found = findWorkspace(options.cwd, options.workspaceRoot);
  if (!found.root) fail('attachment_not_found', 'No workspace attachment record was found.');
  const workspace = mutationWorkspace(found.root);
  const initialRecord = readRecord(workspace.paths);
  const initialAttachment = findAttachment(initialRecord, options.attachmentId);
  const existing = verifyAssetReference(workspace.paths, initialAttachment.asset);
  const policy = prepareAttachmentPolicy(options, initialAttachment);
  const now = options.now || new Date().toISOString();
  const proposal = {
    asset: prepared.asset,
    state: initialAttachment.state,
    ...policy,
    approved_at: now,
  };
  const consentFacts = {
    workspace_root: workspace.root,
    attachment_id: initialAttachment.attachment_id,
    old_attachment: attachmentPolicyState(initialAttachment),
    new_attachment: proposal,
    authorization: {
      old: authorizationFacts(existing.plan),
      new: authorizationFacts(prepared.plan),
    },
  };
  const consentDigest = sha256(Buffer.from(JSON.stringify(consentFacts), 'utf8'));
  const preview = {
    operation: 'switch',
    consent_digest: consentDigest,
    workspace_boundary: {
      kind: 'exact_workspace',
      root: displayWorkspaceRoot(process.cwd(), workspace.root),
    },
    attachment_id: initialAttachment.attachment_id,
    old_attachment: consentFacts.old_attachment,
    new_attachment: proposal,
    authorization: consentFacts.authorization,
    scope_contract: {
      inherited_without_review: false,
      asset_declared_preload_boundary: 'not_available_in_current_manifest_contract',
      runtime_boundary_remains_authoritative: true,
    },
  };
  if (options.previewOnly === true) {
    return {
      workspace_root: workspace.root,
      attachment: null,
      preview,
      preview_only: true,
    };
  }
  if (
    options.expectedConsentDigest !== undefined &&
    options.expectedConsentDigest !== consentDigest
  ) {
    fail(
      'approval_binding_changed',
      'The switch workspace, old/new asset, role, scope, or authorization facts changed after preview.',
    );
  }
  requireApproval({ preview }, options.approve);
  assertMutationWorkspaceBinding(workspace);
  assertApprovedSourceBinding(options.sourcePath, prepared.digest);
  const initialBinding = JSON.stringify(initialAttachment);
  return withWorkspaceLock(workspace.paths, () => {
    assertMutationWorkspaceBinding(workspace);
    const record = readRecord(workspace.paths);
    const attachment = findAttachment(record, options.attachmentId);
    if (JSON.stringify(attachment) !== initialBinding) {
      fail(
        'approval_binding_changed',
        'The attachment record or policy changed after switch approval.',
      );
    }
    verifyAssetReference(workspace.paths, attachment.asset);
    assertApprovedSourceBinding(options.sourcePath, prepared.digest);
    storeSnapshot(workspace.paths, prepared);
    attachment.history.push({
      ...attachmentPolicyState(attachment),
      replaced_at: now,
    });
    attachment.asset = prepared.asset;
    attachment.role = policy.role;
    attachment.scope = policy.scope;
    attachment.resolution_policy = policy.resolution_policy;
    attachment.approved_at = now;
    attachment.update_policy = policy.update_policy;
    atomicWriteRecord(workspace.paths, record);
    return { workspace_root: workspace.root, attachment, preview };
  });
}

function rollbackWorkspaceAttachment(options) {
  return mutateAttachment(
    options.cwd,
    options.workspaceRoot,
    options.attachmentId,
    ({ attachment, workspace }) => {
      if (attachment.history.length === 0)
        fail('history_empty', 'Attachment has no retained version.');
      const previous = attachment.history[attachment.history.length - 1];
      verifyAssetReference(workspace.paths, attachment.asset);
      verifyAssetReference(workspace.paths, previous.asset);
      attachment.asset = previous.asset;
      attachment.role = previous.role;
      attachment.scope = previous.scope;
      attachment.resolution_policy = previous.resolution_policy;
      attachment.approved_at = previous.approved_at;
      attachment.update_policy = previous.update_policy;
      attachment.history.pop();
      return { workspace_root: workspace.root, attachment };
    },
  );
}

function removeWorkspaceAttachment(options) {
  return mutateAttachment(
    options.cwd,
    options.workspaceRoot,
    options.attachmentId,
    ({ attachment, record, workspace }) => {
      record.attachments = record.attachments.filter(
        (item) => item.attachment_id !== attachment.attachment_id,
      );
      const storage = summarizeSnapshotStorage(workspace.paths);
      return {
        workspace_root: workspace.root,
        attachment_removed: true,
        removed_attachment: attachment,
        snapshot_retained: storage.managed_snapshot_count > 0,
        retained_snapshot_count: storage.managed_snapshot_count,
        retained_snapshot_reason:
          'remove_preserves_managed_workspace_snapshots_for_references_and_explicit_cleanup',
        unknown_storage_entry_count: storage.unknown_storage_entry_count,
        blocked_storage_entry_count: storage.blocked_storage_entry_count,
      };
    },
  );
}

function summarizeSnapshotStorage(paths) {
  let managedSnapshotCount = 0;
  let unknownStorageEntryCount = 0;
  let blockedStorageEntryCount = 0;
  for (const entry of fs.readdirSync(paths.assetsDirectory, { withFileTypes: true })) {
    const managed = SNAPSHOT_FILE_PATTERN.test(entry.name);
    const absolute = path.join(paths.assetsDirectory, entry.name);
    let stat;
    try {
      stat = fs.lstatSync(absolute);
    } catch {
      blockedStorageEntryCount += 1;
      continue;
    }
    if (managed && stat.isFile() && !stat.isSymbolicLink()) {
      try {
        const match = entry.name.match(SNAPSHOT_FILE_PATTERN);
        const bytes = safeReadRegular(absolute, 256 * 1024 * 1024, 'Workspace managed snapshot');
        if (match && sha256(bytes) === `sha256:${match[1]}`) {
          managedSnapshotCount += 1;
        } else {
          blockedStorageEntryCount += 1;
        }
      } catch {
        blockedStorageEntryCount += 1;
      }
    } else if (managed) {
      blockedStorageEntryCount += 1;
    } else {
      unknownStorageEntryCount += 1;
      if (stat.isSymbolicLink() || !stat.isFile()) blockedStorageEntryCount += 1;
    }
  }
  return {
    managed_snapshot_count: managedSnapshotCount,
    unknown_storage_entry_count: unknownStorageEntryCount,
    blocked_storage_entry_count: blockedStorageEntryCount,
  };
}

function referencedSnapshotPaths(record) {
  const referenced = new Set();
  for (const attachment of record.attachments) {
    referenced.add(attachment.asset.snapshot);
    for (const history of attachment.history) referenced.add(history.asset.snapshot);
  }
  return referenced;
}

function inspectCleanupCandidates(paths, record) {
  const referenced = referencedSnapshotPaths(record);
  const eligible = [];
  const retained = [];
  const entries = fs.readdirSync(paths.assetsDirectory, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(paths.assetsDirectory, entry.name);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      fail(
        'cleanup_unsafe_path',
        'Workspace snapshot cleanup requires every storage entry to be a regular non-symlink file.',
      );
    }
    const match = entry.name.match(SNAPSHOT_FILE_PATTERN);
    if (!match) {
      retained.push({ name: entry.name, reason: 'unrecognized_storage_entry' });
      continue;
    }
    const relative = `assets/${entry.name}`;
    const expectedDigest = `sha256:${match[1]}`;
    const bytes = safeReadRegular(absolute, 256 * 1024 * 1024, 'Workspace cleanup snapshot');
    if (sha256(bytes) !== expectedDigest) {
      fail(
        'snapshot_digest_mismatch',
        'Workspace cleanup snapshot digest differs from its managed filename.',
      );
    }
    if (referenced.has(relative)) {
      retained.push({ name: entry.name, reason: 'attachment_or_rollback_reference' });
    } else {
      eligible.push({ name: entry.name, digest: expectedDigest, absolute });
    }
  }
  return { eligible, retained };
}

function cleanupPlan(recordBytes, inspection) {
  const eligibleSnapshots = inspection.eligible
    .map((entry) => ({
      snapshot: `assets/${entry.name}`,
      digest: entry.digest,
    }))
    .sort((left, right) => left.snapshot.localeCompare(right.snapshot));
  const recordDigest = sha256(recordBytes);
  const planDigest = sha256(
    Buffer.from(
      JSON.stringify({
        record_digest: recordDigest,
        eligible_snapshots: eligibleSnapshots,
      }),
      'utf8',
    ),
  );
  return {
    document_type: 'kdna.workspace-cleanup-plan',
    schema_version: SCHEMA_VERSION,
    record_digest: recordDigest,
    eligible_snapshots: eligibleSnapshots,
    plan_digest: planDigest,
  };
}

function cleanupReceiptPath(paths) {
  return path.join(paths.kdnaDirectory, 'cleanup-last-receipt.json');
}

function validateRecoveryPlan(plan, stagingName) {
  const keys = [
    'document_type',
    'schema_version',
    'record_digest',
    'eligible_snapshots',
    'plan_digest',
  ];
  if (
    !isPlainObject(plan) ||
    Object.keys(plan).sort().join('\n') !== keys.sort().join('\n') ||
    plan.document_type !== 'kdna.workspace-cleanup-plan' ||
    plan.schema_version !== SCHEMA_VERSION ||
    !DIGEST_PATTERN.test(plan.record_digest) ||
    !DIGEST_PATTERN.test(plan.plan_digest) ||
    !Array.isArray(plan.eligible_snapshots) ||
    stagingName !== `.cleanup-staging-${plan.plan_digest.slice('sha256:'.length)}`
  ) {
    fail('cleanup_recovery_required', 'Cleanup staging plan is unsupported.');
  }
  const seen = new Set();
  for (const candidate of plan.eligible_snapshots) {
    if (
      !isPlainObject(candidate) ||
      Object.keys(candidate).sort().join('\n') !== ['digest', 'snapshot'].join('\n') ||
      !DIGEST_PATTERN.test(candidate.digest) ||
      candidate.snapshot !== snapshotPathForDigest(candidate.digest) ||
      seen.has(candidate.snapshot)
    ) {
      fail('cleanup_recovery_required', 'Cleanup staging plan contains an unsafe snapshot.');
    }
    seen.add(candidate.snapshot);
  }
  const expectedPlanDigest = sha256(
    Buffer.from(
      JSON.stringify({
        record_digest: plan.record_digest,
        eligible_snapshots: plan.eligible_snapshots,
      }),
      'utf8',
    ),
  );
  if (expectedPlanDigest !== plan.plan_digest) {
    fail('cleanup_recovery_required', 'Cleanup staging plan digest is invalid.');
  }
  return plan;
}

function writeCleanupReceipt(paths, receipt) {
  atomicWriteFile(
    cleanupReceiptPath(paths),
    Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8'),
    0o600,
    '.cleanup-receipt-',
  );
}

function restoreStagedSnapshots(paths, staging, candidates) {
  const restored = [];
  const missing = [];
  for (const candidate of candidates) {
    const staged = path.join(staging, path.basename(candidate.snapshot));
    const original = path.join(paths.kdnaDirectory, ...candidate.snapshot.split('/'));
    if (!fs.existsSync(staged)) {
      missing.push(candidate.digest);
      continue;
    }
    if (fs.existsSync(original)) {
      fail('cleanup_recovery_required', 'Cleanup recovery found a snapshot path collision.');
    }
    const bytes = safeReadRegular(staged, 256 * 1024 * 1024, 'Staged cleanup snapshot');
    if (sha256(bytes) !== candidate.digest) {
      fail('cleanup_recovery_required', 'Staged cleanup snapshot failed digest verification.');
    }
    fs.renameSync(staged, original);
    restored.push(candidate.digest);
  }
  return { restored, missing };
}

function removeEmptyStaging(staging) {
  const planFile = path.join(staging, 'plan.json');
  unlinkIfPresent(planFile);
  try {
    fs.rmdirSync(staging);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
}

function recoverInterruptedCleanup(paths) {
  const stagingEntries = fs
    .readdirSync(paths.kdnaDirectory, { withFileTypes: true })
    .filter((entry) => entry.name.startsWith('.cleanup-staging-'));
  if (stagingEntries.length > 1) {
    fail('cleanup_recovery_required', 'Multiple cleanup staging directories require review.');
  }
  if (stagingEntries.length === 0) return null;
  const entry = stagingEntries[0];
  const staging = path.join(paths.kdnaDirectory, entry.name);
  const stat = fs.lstatSync(staging);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail('cleanup_recovery_required', 'Cleanup staging path is not a regular directory.');
  }
  const planBytes = safeReadRegular(
    path.join(staging, 'plan.json'),
    MAX_RECORD_BYTES,
    'Cleanup staging plan',
  );
  let plan;
  try {
    plan = JSON.parse(planBytes.toString('utf8'));
  } catch {
    fail('cleanup_recovery_required', 'Cleanup staging plan is invalid.');
  }
  validateRecoveryPlan(plan, entry.name);
  const recovery = restoreStagedSnapshots(paths, staging, plan.eligible_snapshots);
  removeEmptyStaging(staging);
  fsyncDirectory(paths.assetsDirectory);
  const receipt = {
    document_type: 'kdna.workspace-cleanup-receipt',
    schema_version: SCHEMA_VERSION,
    status: 'RECOVERED_AFTER_INTERRUPTION',
    plan_digest: plan.plan_digest,
    deleted_snapshot_count: recovery.missing.length,
    deleted_snapshot_digests: recovery.missing,
    restored_snapshot_count: recovery.restored.length,
    restored_snapshot_digests: recovery.restored,
  };
  writeCleanupReceipt(paths, receipt);
  return receipt;
}

function cleanupWorkspaceSnapshots(options) {
  const workspace = findWorkspace(options.cwd, options.workspaceRoot);
  if (!workspace.root) fail('attachment_not_found', 'No workspace attachment record was found.');
  return withWorkspaceLock(workspace.paths, () => {
    const recovered = recoverInterruptedCleanup(workspace.paths);
    const recordBefore = safeReadRegular(
      workspace.paths.record,
      MAX_RECORD_BYTES,
      'Workspace attachment record',
    );
    let record;
    try {
      record = validateRecord(JSON.parse(recordBefore.toString('utf8')));
    } catch (error) {
      if (error instanceof WorkspaceAttachmentError) throw error;
      fail('attachment_schema_unsupported', 'Workspace attachment record is not valid JSON.');
    }
    const inspection = inspectCleanupCandidates(workspace.paths, record);
    const plan = cleanupPlan(recordBefore, inspection);
    const execute = typeof options.planDigest === 'string';
    const deletedDigests = [];
    const retainedReasonCounts = {};
    for (const entry of inspection.retained) {
      retainedReasonCounts[entry.reason] = (retainedReasonCounts[entry.reason] || 0) + 1;
    }
    if (!execute) {
      return {
        workspace_root: workspace.root,
        mode: 'preview',
        recovered_interrupted_cleanup: recovered,
        attachment_record_changed: false,
        ...plan,
        eligible_snapshot_count: inspection.eligible.length,
        deleted_snapshot_count: 0,
        deleted_snapshot_digests: [],
        retained_snapshot_count: inspection.retained.length + inspection.eligible.length,
        retained_reason_counts: {
          ...retainedReasonCounts,
          ...(inspection.eligible.length === 0
            ? {}
            : { awaiting_explicit_cleanup: inspection.eligible.length }),
        },
        projection_cache_deleted_count: 0,
        projection_cache_retained_count: 0,
        projection_cache_reason: 'no_workspace_projection_cache_surface',
      };
    }
    if (!DIGEST_PATTERN.test(options.planDigest) || options.planDigest !== plan.plan_digest) {
      fail(
        'cleanup_plan_changed',
        'Cleanup plan changed or was not the exact preview; run cleanup preview again.',
      );
    }
    const staging = path.join(
      workspace.paths.kdnaDirectory,
      `.cleanup-staging-${plan.plan_digest.slice('sha256:'.length)}`,
    );
    if (fs.existsSync(staging)) {
      fail('cleanup_recovery_required', 'Cleanup staging path already exists.');
    }
    fs.mkdirSync(staging, { mode: 0o700 });
    atomicWriteFile(
      path.join(staging, 'plan.json'),
      Buffer.from(`${JSON.stringify(plan, null, 2)}\n`, 'utf8'),
      0o600,
      '.plan-',
    );
    const staged = [];
    if (execute) {
      try {
        for (const candidate of inspection.eligible) {
          const before = fs.lstatSync(candidate.absolute);
          if (before.isSymbolicLink() || !before.isFile()) {
            fail('cleanup_unsafe_path', 'Workspace cleanup candidate changed before staging.');
          }
          const bytes = safeReadRegular(
            candidate.absolute,
            256 * 1024 * 1024,
            'Workspace cleanup snapshot',
          );
          if (sha256(bytes) !== candidate.digest) {
            fail('snapshot_digest_mismatch', 'Workspace cleanup candidate changed before staging.');
          }
          const target = path.join(staging, candidate.name);
          fs.renameSync(candidate.absolute, target);
          staged.push({
            snapshot: `assets/${candidate.name}`,
            digest: candidate.digest,
          });
        }
        const recordImmediatelyBeforeDelete = safeReadRegular(
          workspace.paths.record,
          MAX_RECORD_BYTES,
          'Workspace attachment record',
        );
        if (!recordBefore.equals(recordImmediatelyBeforeDelete)) {
          fail('workspace_binding_changed', 'Workspace attachment record changed during cleanup.');
        }
      } catch (error) {
        restoreStagedSnapshots(workspace.paths, staging, staged);
        removeEmptyStaging(staging);
        throw error;
      }
    }

    let deletionError = null;
    for (const candidate of staged) {
      try {
        fs.unlinkSync(path.join(staging, path.basename(candidate.snapshot)));
        deletedDigests.push(candidate.digest);
        writeCleanupReceipt(workspace.paths, {
          document_type: 'kdna.workspace-cleanup-receipt',
          schema_version: SCHEMA_VERSION,
          status: 'IN_PROGRESS',
          plan_digest: plan.plan_digest,
          deleted_snapshot_count: deletedDigests.length,
          deleted_snapshot_digests: deletedDigests,
        });
      } catch (error) {
        deletionError = error;
        break;
      }
    }
    if (deletionError) {
      const recovery = restoreStagedSnapshots(workspace.paths, staging, staged);
      removeEmptyStaging(staging);
      const receipt = {
        document_type: 'kdna.workspace-cleanup-receipt',
        schema_version: SCHEMA_VERSION,
        status: 'PARTIAL',
        plan_digest: plan.plan_digest,
        deleted_snapshot_count: deletedDigests.length,
        deleted_snapshot_digests: deletedDigests,
        restored_snapshot_count: recovery.restored.length,
        restored_snapshot_digests: recovery.restored,
      };
      writeCleanupReceipt(workspace.paths, receipt);
      fail(
        'cleanup_partial',
        'Cleanup stopped after a partial deletion; see cleanup-last-receipt.json for exact recovery facts.',
      );
    }
    removeEmptyStaging(staging);
    fsyncDirectory(workspace.paths.assetsDirectory);
    const receipt = {
      document_type: 'kdna.workspace-cleanup-receipt',
      schema_version: SCHEMA_VERSION,
      status: 'PASS',
      plan_digest: plan.plan_digest,
      deleted_snapshot_count: deletedDigests.length,
      deleted_snapshot_digests: deletedDigests,
      restored_snapshot_count: 0,
      restored_snapshot_digests: [],
    };
    writeCleanupReceipt(workspace.paths, receipt);
    return {
      workspace_root: workspace.root,
      mode: 'execute',
      recovered_interrupted_cleanup: recovered,
      attachment_record_changed: false,
      ...plan,
      eligible_snapshot_count: inspection.eligible.length,
      deleted_snapshot_count: deletedDigests.length,
      deleted_snapshot_digests: deletedDigests,
      retained_snapshot_count: inspection.retained.length,
      retained_reason_counts: retainedReasonCounts,
      projection_cache_deleted_count: 0,
      projection_cache_retained_count: 0,
      projection_cache_reason: 'no_workspace_projection_cache_surface',
      cleanup_receipt: receipt,
    };
  });
}

function candidateFor(attachment, authorization = 'not_checked', integrity = 'not_checked') {
  return {
    attachment_id: attachment.attachment_id,
    asset_id: attachment.asset.id,
    version: attachment.asset.version,
    digest: attachment.asset.digest,
    role: attachment.role,
    authorization,
    integrity,
  };
}

function taskNamesExactAttachmentIdentifier(taskText, attachmentId) {
  const escaped = attachmentId.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escaped}(?:$|[^\\p{L}\\p{N}_])`, 'u').test(taskText);
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
  selectionPlan = null,
}) {
  const result = {
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
  if (selectionPlan !== null) result.selection_plan = selectionPlan;
  return result;
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

function decodeTaskBytes(bytes, label) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    fail('input_invalid', `${label} must contain non-empty UTF-8 text.`);
  }
  if (bytes.length > MAX_TASK_BYTES) {
    fail('input_invalid', `${label} exceeds the size limit.`);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('input_invalid', `${label} must contain valid UTF-8 text.`);
  }
}

function readTaskFile(taskFile) {
  const absolute = path.resolve(taskFile);
  return safeReadRegular(absolute, MAX_TASK_BYTES, 'Task file');
}

function selectionPlanFor({
  workspaceRoot,
  absoluteWorkspaceRoot,
  taskDigest,
  recordDigest,
  candidates,
}) {
  const candidateSetDigest = sha256(Buffer.from(JSON.stringify(candidates), 'utf8'));
  const planFacts = {
    document_type: 'kdna.workspace-selection-plan',
    schema_version: SCHEMA_VERSION,
    workspace_root: workspaceRoot,
    absolute_workspace_root: absoluteWorkspaceRoot,
    task_digest: taskDigest,
    record_digest: recordDigest,
    candidate_set_digest: candidateSetDigest,
  };
  return {
    document_type: planFacts.document_type,
    schema_version: planFacts.schema_version,
    workspace_root: planFacts.workspace_root,
    task_digest: planFacts.task_digest,
    record_digest: planFacts.record_digest,
    candidate_set_digest: planFacts.candidate_set_digest,
    plan_digest: sha256(Buffer.from(JSON.stringify(planFacts), 'utf8')),
  };
}

function resolveWorkspace(options) {
  const start = assertDirectory(options.cwd || process.cwd(), 'Working directory');
  if ((options.adapterSchema || SCHEMA_VERSION) !== SCHEMA_VERSION) {
    return blockResult('adapter_incompatible', '.', [], 'not_checked', 'not_checked');
  }
  const hasTaskFile = typeof options.taskFile === 'string';
  const hasTaskBytes = options.taskBytes !== undefined;
  if (hasTaskFile === hasTaskBytes) {
    fail('input_invalid', 'Resolve requires exactly one task file or task stdin input.');
  }
  const hasSelection = options.selectedAttachmentId !== undefined;
  const hasSelectionTaskDigest = options.selectionTaskDigest !== undefined;
  const hasSelectionPlanDigest = options.selectionPlanDigest !== undefined;
  if (
    hasSelection !== (options.selectionApproved === true) ||
    hasSelection !== hasSelectionTaskDigest ||
    (!hasSelection && hasSelectionPlanDigest)
  ) {
    fail(
      'input_invalid',
      'A one-task attachment selection requires an attachment ID, task digest, and explicit approval.',
    );
  }
  if (hasSelection && options.workspaceRoot == null) {
    fail('input_invalid', 'A one-task attachment selection requires an explicit workspace root.');
  }
  if (hasSelection && !ATTACHMENT_ID_PATTERN.test(String(options.selectedAttachmentId))) {
    fail('input_invalid', 'Selected attachment ID is invalid.');
  }
  if (
    (hasSelectionTaskDigest && !DIGEST_PATTERN.test(String(options.selectionTaskDigest))) ||
    (hasSelectionPlanDigest && !DIGEST_PATTERN.test(String(options.selectionPlanDigest)))
  ) {
    fail('input_invalid', 'Selection task and plan digests must be lowercase SHA-256 digests.');
  }
  const taskBytes = Buffer.from(hasTaskFile ? readTaskFile(options.taskFile) : options.taskBytes);
  let taskText;
  let task;
  try {
    taskText = decodeTaskBytes(taskBytes, hasTaskFile ? 'Task file' : 'Task stdin');
    task = normalizedPhrase(taskText);
  } catch (error) {
    taskBytes.fill(0);
    throw error;
  }
  if (!task) {
    taskBytes.fill(0);
    fail('input_invalid', 'Task input must contain non-empty UTF-8 text.');
  }
  const taskDigest = sha256(taskBytes);
  let workspace;
  try {
    workspace = findWorkspace(start, options.workspaceRoot);
  } catch {
    taskBytes.fill(0);
    return blockResult('attachment_schema_unsupported', '.', [], 'not_checked', 'not_checked');
  }
  if (!workspace.root) {
    taskBytes.fill(0);
    return resolutionResult({
      decision: 'skip',
      reasonCode: 'no_approved_attachment',
      workspaceRoot: '.',
      authorization: 'not_checked',
      integrity: 'not_checked',
    });
  }
  const workspaceRoot = displayWorkspaceRoot(start, workspace.root);
  let recordSnapshot;
  try {
    recordSnapshot = readRecordSnapshot(workspace.paths);
  } catch {
    taskBytes.fill(0);
    return blockResult(
      'attachment_schema_unsupported',
      workspaceRoot,
      [],
      'not_checked',
      'not_checked',
    );
  }
  const { record } = recordSnapshot;
  const finish = (baseResult) => {
    try {
      let result = baseResult;
      if (result.decision === 'ask') {
        result = resolutionResult({
          decision: result.decision,
          reasonCode: result.reason_code,
          workspaceRoot: result.workspace_root,
          selected: result.selected,
          candidates: result.candidates,
          authorization: result.authorization,
          integrity: result.integrity,
          selectionPlan: selectionPlanFor({
            workspaceRoot,
            absoluteWorkspaceRoot: workspace.root,
            taskDigest,
            recordDigest: recordSnapshot.digest,
            candidates: result.candidates,
          }),
        });
      }
      if (!hasSelection) return result;
      if (options.selectionTaskDigest !== taskDigest) {
        return blockResult(
          'selection_binding_changed',
          workspaceRoot,
          result.candidates,
          'not_checked',
          'not_checked',
        );
      }
      if (result.decision === 'block') return result;
      const selectedCandidate = result.candidates.find(
        (candidate) => candidate.attachment_id === options.selectedAttachmentId,
      );
      const exactIdentifierNamed =
        selectedCandidate !== undefined &&
        taskNamesExactAttachmentIdentifier(taskText, selectedCandidate.attachment_id);
      if (
        !selectedCandidate ||
        (!['ask', 'load'].includes(result.decision) &&
          !(result.decision === 'skip' && exactIdentifierNamed))
      ) {
        if (selectedCandidate && result.decision === 'skip' && !exactIdentifierNamed) {
          return blockResult(
            'selection_receipt_required',
            workspaceRoot,
            result.candidates,
            'not_checked',
            'not_checked',
          );
        }
        return blockResult(
          'selection_not_current_candidate',
          workspaceRoot,
          result.candidates,
          'not_checked',
          'not_checked',
        );
      }
      if (
        result.decision === 'ask' &&
        options.selectionPlanDigest === undefined &&
        !exactIdentifierNamed
      ) {
        return blockResult(
          'selection_receipt_required',
          workspaceRoot,
          result.candidates,
          'not_checked',
          'not_checked',
        );
      }
      if (
        options.selectionPlanDigest !== undefined &&
        options.selectionPlanDigest !== result.selection_plan?.plan_digest
      ) {
        return blockResult(
          'selection_binding_changed',
          workspaceRoot,
          result.candidates,
          'not_checked',
          'not_checked',
        );
      }
      const attachment = findAttachment(record, selectedCandidate.attachment_id);
      if (attachment.state !== 'enabled') {
        return blockResult(
          'selection_not_current_candidate',
          workspaceRoot,
          result.candidates,
          'not_checked',
          'not_checked',
        );
      }
      let asset;
      try {
        asset = verifyAssetReference(workspace.paths, attachment.asset);
      } catch (error) {
        const code =
          error instanceof WorkspaceAttachmentError &&
          ['snapshot_missing', 'snapshot_digest_mismatch'].includes(error.code)
            ? error.code
            : 'asset_invalid';
        return blockResult(code, workspaceRoot, [selectedCandidate], 'not_checked', 'failed');
      }
      if (asset.plan.can_load_now !== true) {
        return blockResult(
          'authorization_required',
          workspaceRoot,
          [selectedCandidate],
          'required',
          'verified',
        );
      }
      let currentRecordSnapshot;
      try {
        currentRecordSnapshot = readRecordSnapshot(workspace.paths);
      } catch {
        return blockResult(
          'selection_binding_changed',
          workspaceRoot,
          result.candidates,
          'not_checked',
          'not_checked',
        );
      }
      if (currentRecordSnapshot.digest !== recordSnapshot.digest) {
        return blockResult(
          'selection_binding_changed',
          workspaceRoot,
          result.candidates,
          'not_checked',
          'not_checked',
        );
      }
      return resolutionResult({
        decision: 'load',
        reasonCode: 'explicit_task_attachment_selection',
        workspaceRoot,
        selected: selectedCandidate,
        candidates: result.candidates,
        authorization: 'satisfied',
        integrity: 'verified',
      });
    } finally {
      taskBytes.fill(0);
      recordSnapshot.bytes.fill(0);
    }
  };
  const enabled = record.attachments.filter((attachment) => attachment.state === 'enabled');
  if (enabled.length === 0) {
    return finish(
      resolutionResult({
        decision: 'skip',
        reasonCode: 'no_approved_attachment',
        workspaceRoot,
        authorization: 'not_checked',
        integrity: 'not_checked',
      }),
    );
  }

  const evaluated = enabled.map((attachment) => {
    const positiveAssessments =
      attachment.scope.application === 'all_workspace'
        ? [{ matched: true, uncertain: false }]
        : attachment.scope.applies_to.map((term) => scopeTermAssessment(task, term));
    const negativeAssessments = attachment.scope.does_not_apply_to.map((term) =>
      scopeTermAssessment(task, term),
    );
    const negatives = negativeAssessments.some(({ matched }) => matched);
    const positives =
      attachment.scope.application === 'all_workspace'
        ? !negatives
        : positiveAssessments.some(({ matched }) => matched);
    const uncertain = [...positiveAssessments, ...negativeAssessments].some(
      ({ matched, uncertain: assessmentUncertain }) => matched && assessmentUncertain,
    );
    return {
      attachment,
      candidate: candidateFor(attachment),
      positives,
      negatives,
      uncertain,
      openWorld: attachment.scope.matching_policy === 'open_world_ask',
    };
  });
  const uncertainScope = evaluated.filter((item) => item.uncertain);
  const internallyAmbiguous = evaluated.filter(
    (item) => item.positives && item.negatives && !item.uncertain,
  );
  const positive = evaluated.filter((item) => item.positives && !item.negatives);
  const negative = evaluated.filter((item) => item.negatives && !item.positives);
  const unmatched = evaluated.filter((item) => !item.positives && !item.negatives);
  const openWorldUnmatched = unmatched.filter((item) => item.openWorld);
  const closedWorldUnmatched = unmatched.filter((item) => !item.openWorld);
  const verifyScopedCandidates = (items, { requireAuthorization = false } = {}) => {
    const verified = [];
    for (const item of items) {
      let asset;
      try {
        asset = verifyAssetReference(workspace.paths, item.attachment.asset, {
          deferPasswordAuthorization: options.deferPasswordAuthorization,
        });
      } catch (error) {
        const code =
          error instanceof WorkspaceAttachmentError &&
          ['snapshot_missing', 'snapshot_digest_mismatch'].includes(error.code)
            ? error.code
            : 'asset_invalid';
        return {
          blocked: blockResult(code, workspaceRoot, [item.candidate], 'not_checked', 'failed'),
        };
      }
      const authorization = asset.plan.can_load_now === true ? 'satisfied' : 'required';
      if (
        requireAuthorization &&
        authorization === 'required' &&
        asset.passwordAuthorizationDeferred !== true
      ) {
        return {
          blocked: blockResult(
            'authorization_required',
            workspaceRoot,
            [candidateFor(item.attachment, authorization, 'verified')],
            'required',
            'verified',
          ),
        };
      }
      verified.push({
        ...item,
        candidate: candidateFor(item.attachment, authorization, 'verified'),
      });
    }
    return { verified };
  };

  if (uncertainScope.length > 0) {
    const checked = verifyScopedCandidates(
      evaluated.filter(
        (item) =>
          (item.positives || item.negatives || (item.openWorld && !item.negatives)) &&
          !(item.negatives && !item.positives && !item.uncertain),
      ),
    );
    if (checked.blocked) return finish(checked.blocked);
    return finish(
      resolutionResult({
        decision: 'ask',
        reasonCode: 'ambiguous_scope',
        workspaceRoot,
        candidates: checked.verified.map((item) => item.candidate),
        authorization: 'not_selected',
        integrity: 'verified',
      }),
    );
  }

  if (internallyAmbiguous.length > 0) {
    const checked = verifyScopedCandidates([
      ...internallyAmbiguous,
      ...positive.filter((item) => !internallyAmbiguous.includes(item)),
      ...openWorldUnmatched,
    ]);
    if (checked.blocked) return finish(checked.blocked);
    return finish(
      resolutionResult({
        decision: 'ask',
        reasonCode: 'ambiguous_scope',
        workspaceRoot,
        candidates: checked.verified.map((item) => item.candidate),
        authorization: 'not_selected',
        integrity: 'verified',
      }),
    );
  }
  const contradictoryNegative = negative.filter((negativeItem) =>
    positive.some(
      (positiveItem) =>
        normalizedPhrase(negativeItem.attachment.role) ===
        normalizedPhrase(positiveItem.attachment.role),
    ),
  );
  if (positive.length > 1 || contradictoryNegative.length > 0) {
    const checked = verifyScopedCandidates([
      ...positive,
      ...contradictoryNegative,
      ...openWorldUnmatched,
    ]);
    if (checked.blocked) return finish(checked.blocked);
    return finish(
      resolutionResult({
        decision: 'ask',
        reasonCode: 'attachment_conflict',
        workspaceRoot,
        candidates: checked.verified.map((item) => item.candidate),
        authorization: 'not_selected',
        integrity: 'verified',
      }),
    );
  }
  if (positive.length === 1 && openWorldUnmatched.length > 0) {
    const checked = verifyScopedCandidates([...positive, ...openWorldUnmatched]);
    if (checked.blocked) return finish(checked.blocked);
    return finish(
      resolutionResult({
        decision: 'ask',
        reasonCode: 'applicability_unresolved',
        workspaceRoot,
        candidates: checked.verified.map((item) => item.candidate),
        authorization: 'not_selected',
        integrity: 'verified',
      }),
    );
  }
  if (positive.length === 1) {
    const checked = verifyScopedCandidates(positive, {
      requireAuthorization: true,
    });
    if (checked.blocked) return finish(checked.blocked);
    return finish(
      resolutionResult({
        decision: 'load',
        reasonCode: 'single_approved_attachment_clearly_applies',
        workspaceRoot,
        selected: checked.verified[0].candidate,
        candidates: [checked.verified[0].candidate],
        authorization: 'satisfied',
        integrity: 'verified',
      }),
    );
  }
  if (positive.length === 0 && openWorldUnmatched.length > 0) {
    const checked = verifyScopedCandidates(openWorldUnmatched);
    if (checked.blocked) return finish(checked.blocked);
    return finish(
      resolutionResult({
        decision: 'ask',
        reasonCode: 'applicability_unresolved',
        workspaceRoot,
        candidates: checked.verified.map((item) => item.candidate),
        authorization: 'not_selected',
        integrity: 'verified',
      }),
    );
  }
  if (positive.length === 0 && (negative.length > 0 || closedWorldUnmatched.length > 0)) {
    const reasonCode =
      negative.length > 0 && closedWorldUnmatched.length === 0
        ? 'explicitly_outside_scope'
        : negative.length === 0
          ? 'closed_world_no_match'
          : 'no_applicable_attachment';
    return finish(
      resolutionResult({
        decision: 'skip',
        reasonCode,
        workspaceRoot,
        candidates: [...negative, ...closedWorldUnmatched].map((item) => item.candidate),
        authorization: 'not_checked',
        integrity: 'not_checked',
      }),
    );
  }
  return finish(
    blockResult('attachment_schema_unsupported', workspaceRoot, [], 'not_checked', 'not_checked'),
  );
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
  cleanupWorkspaceSnapshots,
  emptyRecord,
  findWorkspace,
  inspectPreparedAsset,
  listWorkspaceAttachments,
  normalizedPhrase,
  removeWorkspaceAttachment,
  resolveWorkspace,
  rollbackWorkspaceAttachment,
  safeReadRegular,
  scopeTermMatches,
  setAttachmentState,
  sha256,
  snapshotPathForDigest,
  switchWorkspaceAttachment,
  validateRecord,
  verifyAssetReference,
};
