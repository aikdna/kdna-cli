'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const {
  WorkspaceAttachmentError,
  MAX_TASK_BYTES,
  SCHEMA_VERSION,
  attachWorkspace,
  cleanupWorkspaceSnapshots,
  listWorkspaceAttachments,
  removeWorkspaceAttachment,
  resolveWorkspace,
  rollbackWorkspaceAttachment,
  setAttachmentState,
  switchWorkspaceAttachment,
} = require('../workspace-attachments');

const VALUE_FLAGS = new Set([
  '--cwd',
  '--workspace-root',
  '--role',
  '--applies-to',
  '--does-not-apply-to',
  '--task-file',
  '--adapter-schema',
  '--plan-digest',
  '--select-attachment',
  '--selection-task-digest',
  '--selection-plan-digest',
  '--consent-digest',
]);
const MAX_TRANSIENT_READ_RETRIES = 1000;
const READ_RETRY_STATE = new Int32Array(new SharedArrayBuffer(4));

class WorkspaceCommandInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WorkspaceCommandInputError';
  }
}

function inputError(message) {
  throw new WorkspaceCommandInputError(message);
}

function parseArgs(args, allowedFlags) {
  const values = new Map();
  const booleans = new Set();
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith('--')) {
      positional.push(argument);
      continue;
    }
    const equals = argument.indexOf('=');
    const name = equals === -1 ? argument : argument.slice(0, equals);
    if (!allowedFlags.has(name)) inputError(`Unknown option: ${name}`);
    if (!VALUE_FLAGS.has(name)) {
      if (equals !== -1) inputError(`${name} does not accept a value.`);
      booleans.add(name);
      continue;
    }
    const value = equals === -1 ? args[index + 1] : argument.slice(equals + 1);
    if (equals === -1) index += 1;
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
      inputError(`${name} requires a value.`);
    }
    const current = values.get(name) || [];
    current.push(value);
    values.set(name, current);
  }
  return {
    positional,
    has: (name) => booleans.has(name),
    one: (name, fallback = null) => {
      const found = values.get(name) || [];
      if (found.length > 1 && !['--applies-to', '--does-not-apply-to'].includes(name)) {
        inputError(`${name} may be supplied only once.`);
      }
      return found.length === 0 ? fallback : found[0];
    },
    many: (name) => values.get(name) || [],
  };
}

function displayRoot(requestedCwd, resolvedRoot) {
  if (!resolvedRoot) return null;
  const start = path.resolve(requestedCwd || process.cwd());
  return (path.relative(start, resolvedRoot) || '.').split(path.sep).join('/');
}

function readConfirmation() {
  const buffer = Buffer.alloc(1);
  let answer = '';
  while (true) {
    const count = fs.readSync(process.stdin.fd, buffer, 0, 1);
    if (count === 0 || buffer[0] === 0x0a || buffer[0] === 0x0d) break;
    if (buffer[0] === 0x03) return false;
    answer += buffer.toString('utf8', 0, count);
    if (answer.length > 16) return false;
  }
  return /^(?:y|yes)$/iu.test(answer.trim());
}

function approvalCallback(yes) {
  return (preview) => {
    if (yes) return true;
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new WorkspaceAttachmentError(
        'approval_required',
        'Non-interactive attachment approval requires --yes.',
      );
    }
    process.stderr.write(`Attachment preview:\n${JSON.stringify(preview, null, 2)}\n`);
    process.stderr.write('Approve this exact asset for the workspace? [y/N] ');
    return readConfirmation();
  };
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function readBoundedStdin(maximum, label) {
  const chunks = [];
  let total = 0;
  let exceeded = false;
  const buffer = Buffer.allocUnsafe(16 * 1024);
  try {
    while (true) {
      let count;
      let retries = 0;
      while (true) {
        try {
          count = fs.readSync(process.stdin.fd, buffer, 0, buffer.length);
          break;
        } catch (readError) {
          if (readError?.code !== 'EAGAIN' || retries >= MAX_TRANSIENT_READ_RETRIES) {
            throw readError;
          }
          retries += 1;
          Atomics.wait(READ_RETRY_STATE, 0, 0, 1);
        }
      }
      if (count === 0) break;
      if (exceeded || total + count > maximum) {
        exceeded = true;
        continue;
      }
      total += count;
      chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
    if (exceeded) inputError(`${label} exceeds the size limit.`);
    if (total === 0) inputError(`${label} must not be empty.`);
    return Buffer.concat(chunks, total);
  } finally {
    buffer.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
}

function readAttachmentInput() {
  const bytes = readBoundedStdin(MAX_TASK_BYTES, 'Attachment stdin');
  try {
    let value;
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      inputError('Attachment stdin must be strict UTF-8 JSON.');
    }
    const keys =
      value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort() : [];
    const allowedKeys = new Set([
      'role',
      'applies_to',
      'does_not_apply_to',
      'scope_mode',
      'matching_policy',
    ]);
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      keys.some((key) => !allowedKeys.has(key)) ||
      !keys.includes('role') ||
      !keys.includes('applies_to') ||
      !keys.includes('does_not_apply_to') ||
      typeof value.role !== 'string' ||
      !Array.isArray(value.applies_to) ||
      !Array.isArray(value.does_not_apply_to) ||
      (value.scope_mode !== undefined &&
        !['task_hints', 'all_workspace'].includes(value.scope_mode)) ||
      (value.matching_policy !== undefined &&
        !['open_world_ask', 'closed_world_skip'].includes(value.matching_policy))
    ) {
      inputError(
        'Attachment stdin must contain role, applies_to, does_not_apply_to, and optional scope_mode/matching_policy.',
      );
    }
    if (value.scope_mode === 'all_workspace' && value.matching_policy !== undefined) {
      inputError('All-workspace scope does not accept a task-hint matching policy.');
    }
    return value;
  } finally {
    bytes.fill(0);
  }
}

function mutationOutput(operation, cwd, result) {
  const output = {
    operation,
    workspace_root: displayRoot(cwd, result.workspace_root),
  };
  if (result.attachment) output.attachment = result.attachment;
  if (result.attachment_removed !== undefined) {
    output.attachment_removed = result.attachment_removed;
  }
  if (result.removed_attachment) output.removed_attachment = result.removed_attachment;
  if (result.snapshot_retained !== undefined) output.snapshot_retained = result.snapshot_retained;
  if (result.retained_snapshot_count !== undefined) {
    output.retained_snapshot_count = result.retained_snapshot_count;
  }
  if (result.retained_snapshot_reason) {
    output.retained_snapshot_reason = result.retained_snapshot_reason;
  }
  if (result.unknown_storage_entry_count !== undefined) {
    output.unknown_storage_entry_count = result.unknown_storage_entry_count;
  }
  if (result.blocked_storage_entry_count !== undefined) {
    output.blocked_storage_entry_count = result.blocked_storage_entry_count;
  }
  printJson(output);
}

function cmdAttach(args) {
  const parsed = parseArgs(
    args,
    new Set([
      '--cwd',
      '--role',
      '--applies-to',
      '--does-not-apply-to',
      '--all-workspace',
      '--closed-world-scope',
      '--attachment-stdin',
      '--yes',
      '--preview',
      '--scope-user-approved',
      '--consent-digest',
    ]),
  );
  if (parsed.positional.length !== 1) {
    inputError(
      'Usage: kdna attach <file.kdna> [--cwd <workspace>] (--attachment-stdin | [--role <text>] (--applies-to <text>... [--closed-world-scope] | --all-workspace) [--does-not-apply-to <text>...]) [--preview | (--yes (--scope-user-approved | --consent-digest <sha256:...>))]',
    );
  }
  const attachmentStdin = parsed.has('--attachment-stdin');
  const argumentRole = parsed.one('--role');
  const argumentAppliesTo = parsed.many('--applies-to');
  const argumentDoesNotApplyTo = parsed.many('--does-not-apply-to');
  const allWorkspace = parsed.has('--all-workspace');
  const closedWorldScope = parsed.has('--closed-world-scope');
  if (
    attachmentStdin &&
    (argumentRole !== null ||
      argumentAppliesTo.length > 0 ||
      argumentDoesNotApplyTo.length > 0 ||
      allWorkspace ||
      closedWorldScope)
  ) {
    inputError('Attachment stdin and role/scope argv options are mutually exclusive.');
  }
  if (allWorkspace && closedWorldScope) {
    inputError('--all-workspace and --closed-world-scope are mutually exclusive.');
  }
  const attachmentInput = attachmentStdin
    ? readAttachmentInput()
    : {
        role: argumentRole,
        applies_to: argumentAppliesTo,
        does_not_apply_to: argumentDoesNotApplyTo,
        scope_mode: allWorkspace ? 'all_workspace' : 'task_hints',
        matching_policy: closedWorldScope ? 'closed_world_skip' : 'open_world_ask',
      };
  const previewOnly = parsed.has('--preview');
  const yes = parsed.has('--yes');
  const scopeUserApproved = parsed.has('--scope-user-approved');
  const consentDigest = parsed.one('--consent-digest');
  if (
    (previewOnly && (yes || scopeUserApproved || consentDigest !== null)) ||
    (yes && scopeUserApproved === Boolean(consentDigest)) ||
    (!yes && (scopeUserApproved || consentDigest !== null))
  ) {
    inputError(
      'Attach requires either --preview, interactive confirmation, --yes --scope-user-approved, or --yes --consent-digest <preview digest>.',
    );
  }
  if (consentDigest !== null && !/^sha256:[0-9a-f]{64}$/u.test(consentDigest)) {
    inputError('--consent-digest must be a lowercase SHA-256 digest.');
  }
  const cwd = parsed.one('--cwd', process.cwd());
  const result = attachWorkspace({
    sourcePath: parsed.positional[0],
    cwd,
    role: attachmentInput.role,
    appliesTo: attachmentInput.applies_to,
    doesNotApplyTo: attachmentInput.does_not_apply_to,
    scopeApplication: attachmentInput.scope_mode || 'task_hints',
    matchingPolicy: attachmentInput.matching_policy || 'open_world_ask',
    scopeApproval: scopeUserApproved ? 'user_explicit' : 'preview_confirmed',
    previewOnly,
    expectedConsentDigest: consentDigest === null ? undefined : consentDigest,
    approve: approvalCallback(yes),
  });
  if (previewOnly) {
    printJson({
      operation: 'attach',
      mode: 'preview',
      workspace_root: displayRoot(cwd, result.workspace_root),
      confirmation_required: true,
      preview: result.preview,
    });
    return;
  }
  mutationOutput('attach', cwd, result);
}

function cmdAttachments(args) {
  const parsed = parseArgs(args, new Set(['--cwd', '--workspace-root']));
  if (parsed.positional.length !== 0) {
    inputError('Usage: kdna attachments [--cwd <start>] [--workspace-root <boundary>]');
  }
  const cwd = parsed.one('--cwd', process.cwd());
  const workspaceRoot = parsed.one('--workspace-root');
  const result = listWorkspaceAttachments(cwd, workspaceRoot);
  if (!result.record) {
    printJson(null);
    return;
  }
  printJson(result.record);
}

function cmdResolve(args) {
  const parsed = parseArgs(
    args,
    new Set([
      '--cwd',
      '--workspace-root',
      '--task-file',
      '--task-stdin',
      '--adapter-schema',
      '--select-attachment',
      '--selection-task-digest',
      '--selection-plan-digest',
      '--selection-approved',
      '--defer-password-authorization',
    ]),
  );
  if (parsed.positional.length !== 0) {
    inputError(
      `Usage: kdna resolve --cwd <start> [--workspace-root <boundary>] (--task-stdin | --task-file <file>) [--adapter-schema ${SCHEMA_VERSION}] [--select-attachment <id> --selection-task-digest <sha256:...> [--selection-plan-digest <sha256:...>] --selection-approved] [--defer-password-authorization]`,
    );
  }
  const cwd = parsed.one('--cwd');
  const taskFile = parsed.one('--task-file');
  const taskStdin = parsed.has('--task-stdin');
  if (!cwd || Boolean(taskFile) === taskStdin) {
    inputError('Resolve requires exactly one of --task-stdin or --task-file.');
  }
  let taskBytes;
  if (taskStdin) {
    taskBytes = readBoundedStdin(MAX_TASK_BYTES, 'Task stdin');
  }
  try {
    printJson(
      resolveWorkspace({
        cwd,
        workspaceRoot: parsed.one('--workspace-root'),
        taskFile,
        taskBytes,
        adapterSchema: parsed.one('--adapter-schema'),
        selectedAttachmentId: parsed.one('--select-attachment') || undefined,
        selectionTaskDigest: parsed.one('--selection-task-digest') || undefined,
        selectionPlanDigest: parsed.one('--selection-plan-digest') || undefined,
        selectionApproved: parsed.has('--selection-approved'),
        deferPasswordAuthorization: parsed.has('--defer-password-authorization'),
      }),
    );
  } finally {
    taskBytes?.fill(0);
  }
}

function cmdSetState(args, state) {
  const parsed = parseArgs(args, new Set(['--cwd', '--workspace-root']));
  if (parsed.positional.length !== 1) {
    inputError(
      `Usage: kdna ${state === 'enabled' ? 'enable' : 'disable'} <attachment-id> [--cwd <start>] [--workspace-root <boundary>]`,
    );
  }
  const cwd = parsed.one('--cwd', process.cwd());
  const result = setAttachmentState({
    cwd,
    workspaceRoot: parsed.one('--workspace-root'),
    attachmentId: parsed.positional[0],
    state,
  });
  mutationOutput(state === 'enabled' ? 'enable' : 'disable', cwd, result);
}

function cmdSwitch(args) {
  const parsed = parseArgs(
    args,
    new Set([
      '--cwd',
      '--workspace-root',
      '--role',
      '--applies-to',
      '--does-not-apply-to',
      '--all-workspace',
      '--closed-world-scope',
      '--attachment-stdin',
      '--retain-scope',
      '--preview',
      '--yes',
      '--scope-user-approved',
      '--consent-digest',
    ]),
  );
  if (parsed.positional.length !== 2) {
    inputError(
      'Usage: kdna switch <attachment-id> <file.kdna> [--cwd <start>] [--workspace-root <boundary>] (--retain-scope | --attachment-stdin | [--role <text>] (--applies-to <text>... [--closed-world-scope] | --all-workspace) [--does-not-apply-to <text>...]) [--preview | (--yes (--scope-user-approved | --consent-digest <sha256:...>))]',
    );
  }
  const attachmentStdin = parsed.has('--attachment-stdin');
  const retainScope = parsed.has('--retain-scope');
  const argumentRole = parsed.one('--role');
  const argumentAppliesTo = parsed.many('--applies-to');
  const argumentDoesNotApplyTo = parsed.many('--does-not-apply-to');
  const allWorkspace = parsed.has('--all-workspace');
  const closedWorldScope = parsed.has('--closed-world-scope');
  if (allWorkspace && closedWorldScope) {
    inputError('--all-workspace and --closed-world-scope are mutually exclusive.');
  }
  const hasArgumentPolicy =
    argumentRole !== null ||
    argumentAppliesTo.length > 0 ||
    argumentDoesNotApplyTo.length > 0 ||
    allWorkspace ||
    closedWorldScope;
  if (Number(attachmentStdin) + Number(retainScope) + Number(hasArgumentPolicy) !== 1) {
    inputError(
      'Switch requires exactly one reviewed policy source: --retain-scope, --attachment-stdin, or role/scope argv options.',
    );
  }
  const attachmentInput = attachmentStdin
    ? readAttachmentInput()
    : {
        role: argumentRole,
        applies_to: argumentAppliesTo,
        does_not_apply_to: argumentDoesNotApplyTo,
        scope_mode: allWorkspace ? 'all_workspace' : 'task_hints',
        matching_policy: closedWorldScope ? 'closed_world_skip' : 'open_world_ask',
      };
  const previewOnly = parsed.has('--preview');
  const yes = parsed.has('--yes');
  const scopeUserApproved = parsed.has('--scope-user-approved');
  const consentDigest = parsed.one('--consent-digest');
  if (
    (previewOnly && (yes || scopeUserApproved || consentDigest !== null)) ||
    (yes && scopeUserApproved === Boolean(consentDigest)) ||
    (!yes && (scopeUserApproved || consentDigest !== null))
  ) {
    inputError(
      'Switch requires either --preview, interactive confirmation, --yes --scope-user-approved, or --yes --consent-digest <preview digest>.',
    );
  }
  if (consentDigest !== null && !/^sha256:[0-9a-f]{64}$/u.test(consentDigest)) {
    inputError('--consent-digest must be a lowercase SHA-256 digest.');
  }
  const cwd = parsed.one('--cwd', process.cwd());
  const result = switchWorkspaceAttachment({
    cwd,
    workspaceRoot: parsed.one('--workspace-root'),
    attachmentId: parsed.positional[0],
    sourcePath: parsed.positional[1],
    role: attachmentInput.role,
    appliesTo: attachmentInput.applies_to,
    doesNotApplyTo: attachmentInput.does_not_apply_to,
    scopeApplication: attachmentInput.scope_mode || 'task_hints',
    matchingPolicy: attachmentInput.matching_policy || 'open_world_ask',
    retainPolicy: retainScope,
    scopeApproval: scopeUserApproved ? 'user_explicit' : 'preview_confirmed',
    previewOnly,
    expectedConsentDigest: consentDigest === null ? undefined : consentDigest,
    approve: approvalCallback(yes),
  });
  if (previewOnly) {
    printJson({
      operation: 'switch',
      mode: 'preview',
      workspace_root: displayRoot(cwd, result.workspace_root),
      confirmation_required: true,
      preview: result.preview,
    });
    return;
  }
  mutationOutput('switch', cwd, result);
}

function cmdRollback(args) {
  const parsed = parseArgs(args, new Set(['--cwd', '--workspace-root']));
  if (parsed.positional.length !== 1) {
    inputError(
      'Usage: kdna rollback <attachment-id> [--cwd <start>] [--workspace-root <boundary>]',
    );
  }
  const cwd = parsed.one('--cwd', process.cwd());
  const result = rollbackWorkspaceAttachment({
    cwd,
    workspaceRoot: parsed.one('--workspace-root'),
    attachmentId: parsed.positional[0],
  });
  mutationOutput('rollback', cwd, result);
}

function cmdRemove(args) {
  const parsed = parseArgs(args, new Set(['--cwd', '--workspace-root']));
  if (parsed.positional.length !== 1) {
    inputError('Usage: kdna remove <attachment-id> [--cwd <start>] [--workspace-root <boundary>]');
  }
  const cwd = parsed.one('--cwd', process.cwd());
  const result = removeWorkspaceAttachment({
    cwd,
    workspaceRoot: parsed.one('--workspace-root'),
    attachmentId: parsed.positional[0],
  });
  mutationOutput('remove', cwd, result);
}

function cmdCleanup(args) {
  const parsed = parseArgs(args, new Set(['--cwd', '--workspace-root', '--plan-digest', '--yes']));
  if (parsed.positional.length !== 0) {
    inputError(
      'Usage: kdna cleanup [--cwd <start>] [--workspace-root <boundary>] [--plan-digest <sha256:...> --yes]',
    );
  }
  const cwd = parsed.one('--cwd', process.cwd());
  const planDigest = parsed.one('--plan-digest');
  if (parsed.has('--yes') !== Boolean(planDigest)) {
    inputError('Cleanup execution requires both --plan-digest and --yes.');
  }
  const result = cleanupWorkspaceSnapshots({
    cwd,
    workspaceRoot: parsed.one('--workspace-root'),
    planDigest,
  });
  printJson({
    operation: 'cleanup',
    workspace_root: displayRoot(cwd, result.workspace_root),
    mode: result.mode,
    confirmation_required: result.mode === 'preview' && result.eligible_snapshot_count > 0,
    plan_digest: result.plan_digest,
    record_digest: result.record_digest,
    eligible_snapshots: result.eligible_snapshots,
    attachment_record_changed: result.attachment_record_changed,
    eligible_snapshot_count: result.eligible_snapshot_count,
    deleted_snapshot_count: result.deleted_snapshot_count,
    deleted_snapshot_digests: result.deleted_snapshot_digests,
    retained_snapshot_count: result.retained_snapshot_count,
    retained_reason_counts: result.retained_reason_counts,
    projection_cache_deleted_count: result.projection_cache_deleted_count,
    projection_cache_retained_count: result.projection_cache_retained_count,
    projection_cache_reason: result.projection_cache_reason,
  });
}

module.exports = {
  WorkspaceAttachmentError,
  WorkspaceCommandInputError,
  cmdAttach,
  cmdAttachments,
  cmdCleanup,
  cmdRemove,
  cmdResolve,
  cmdRollback,
  cmdSetState,
  cmdSwitch,
};
