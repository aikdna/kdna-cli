'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  WorkspaceAttachmentError,
  attachWorkspace,
  listWorkspaceAttachments,
  removeWorkspaceAttachment,
  resolveWorkspace,
  rollbackWorkspaceAttachment,
  setAttachmentState,
  switchWorkspaceAttachment,
} = require('../workspace-attachments');

const VALUE_FLAGS = new Set([
  '--cwd',
  '--role',
  '--applies-to',
  '--does-not-apply-to',
  '--task-file',
  '--adapter-schema',
]);

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
    process.stderr.write(`Attachment preview:\n${JSON.stringify(preview, null, 2)}\n`);
    if (yes) return true;
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new WorkspaceAttachmentError(
        'approval_required',
        'Non-interactive attachment approval requires --yes.',
      );
    }
    process.stderr.write('Approve this exact asset for the workspace? [y/N] ');
    return readConfirmation();
  };
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function mutationOutput(operation, cwd, result) {
  const output = {
    operation,
    workspace_root: displayRoot(cwd, result.workspace_root),
  };
  if (result.attachment) output.attachment = result.attachment;
  if (result.removed) output.removed = result.removed;
  printJson(output);
}

function cmdAttach(args) {
  const parsed = parseArgs(
    args,
    new Set(['--cwd', '--role', '--applies-to', '--does-not-apply-to', '--yes']),
  );
  if (parsed.positional.length !== 1) {
    inputError(
      'Usage: kdna attach <file.kdna> [--cwd <workspace>] [--role <text>] [--applies-to <text>] [--does-not-apply-to <text>] [--yes]',
    );
  }
  const cwd = parsed.one('--cwd', process.cwd());
  const result = attachWorkspace({
    sourcePath: parsed.positional[0],
    cwd,
    role: parsed.one('--role'),
    appliesTo: parsed.many('--applies-to'),
    doesNotApplyTo: parsed.many('--does-not-apply-to'),
    approve: approvalCallback(parsed.has('--yes')),
  });
  mutationOutput('attach', cwd, result);
}

function cmdAttachments(args) {
  const parsed = parseArgs(args, new Set(['--cwd']));
  if (parsed.positional.length !== 0) {
    inputError('Usage: kdna attachments [--cwd <workspace>]');
  }
  const cwd = parsed.one('--cwd', process.cwd());
  const result = listWorkspaceAttachments(cwd);
  if (!result.record) {
    printJson(null);
    return;
  }
  printJson(result.record);
}

function cmdResolve(args) {
  const parsed = parseArgs(args, new Set(['--cwd', '--task-file', '--adapter-schema']));
  if (parsed.positional.length !== 0) {
    inputError('Usage: kdna resolve --cwd <workspace> --task-file <file> [--adapter-schema 0.1.0]');
  }
  const cwd = parsed.one('--cwd');
  const taskFile = parsed.one('--task-file');
  if (!cwd || !taskFile) {
    inputError('Usage: kdna resolve --cwd <workspace> --task-file <file> [--adapter-schema 0.1.0]');
  }
  printJson(
    resolveWorkspace({
      cwd,
      taskFile,
      adapterSchema: parsed.one('--adapter-schema'),
    }),
  );
}

function cmdSetState(args, state) {
  const parsed = parseArgs(args, new Set(['--cwd']));
  if (parsed.positional.length !== 1) {
    inputError(
      `Usage: kdna ${state === 'enabled' ? 'enable' : 'disable'} <attachment-id> [--cwd <workspace>]`,
    );
  }
  const cwd = parsed.one('--cwd', process.cwd());
  const result = setAttachmentState({
    cwd,
    attachmentId: parsed.positional[0],
    state,
  });
  mutationOutput(state === 'enabled' ? 'enable' : 'disable', cwd, result);
}

function cmdSwitch(args) {
  const parsed = parseArgs(args, new Set(['--cwd', '--yes']));
  if (parsed.positional.length !== 2) {
    inputError('Usage: kdna switch <attachment-id> <file.kdna> [--cwd <workspace>] [--yes]');
  }
  const cwd = parsed.one('--cwd', process.cwd());
  const result = switchWorkspaceAttachment({
    cwd,
    attachmentId: parsed.positional[0],
    sourcePath: parsed.positional[1],
    approve: approvalCallback(parsed.has('--yes')),
  });
  mutationOutput('switch', cwd, result);
}

function cmdRollback(args) {
  const parsed = parseArgs(args, new Set(['--cwd']));
  if (parsed.positional.length !== 1) {
    inputError('Usage: kdna rollback <attachment-id> [--cwd <workspace>]');
  }
  const cwd = parsed.one('--cwd', process.cwd());
  const result = rollbackWorkspaceAttachment({ cwd, attachmentId: parsed.positional[0] });
  mutationOutput('rollback', cwd, result);
}

function cmdRemove(args) {
  const parsed = parseArgs(args, new Set(['--cwd']));
  if (parsed.positional.length !== 1) {
    inputError('Usage: kdna remove <attachment-id> [--cwd <workspace>]');
  }
  const cwd = parsed.one('--cwd', process.cwd());
  const result = removeWorkspaceAttachment({ cwd, attachmentId: parsed.positional[0] });
  mutationOutput('remove', cwd, result);
}

module.exports = {
  WorkspaceAttachmentError,
  WorkspaceCommandInputError,
  cmdAttach,
  cmdAttachments,
  cmdRemove,
  cmdResolve,
  cmdRollback,
  cmdSetState,
  cmdSwitch,
};
