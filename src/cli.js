#!/usr/bin/env node
'use strict';

const commandPolicy = require('../release-surface/cli-command-allowlist.json');
const packageJson = require('../package.json');
const {
  cmdInspect,
  cmdLoad,
  cmdPack,
  cmdPlanLoad,
  cmdUnpack,
  cmdValidate,
} = require('./cmds/asset-io');
const { cmdDemo } = require('./cmds/demo');
const {
  WorkspaceAttachmentError,
  WorkspaceCommandInputError,
  cmdAttach,
  cmdAttachments,
  cmdRemove,
  cmdResolve,
  cmdRollback,
  cmdSetState,
  cmdSwitch,
} = require('./cmds/workspace-attachments');
const { CliError, EXIT, error } = require('./foundation-common');

function showHelp() {
  const lines = [`kdna v${packageJson.version} — KDNA runtime CLI`, ''];
  for (const entry of commandPolicy.commands) {
    if (entry.command === 'help' || entry.command === 'version') continue;
    lines.push(`  ${entry.usage.padEnd(48)} ${entry.purpose}`);
  }
  lines.push('', '  help         Display this exact command allowlist.');
  lines.push('  version      Display the CLI package version.');
  process.stdout.write(`${lines.join('\n')}\n`);
}

function runWorkspaceCommand(command, args) {
  try {
    return command(args);
  } catch (commandError) {
    if (
      commandError instanceof WorkspaceAttachmentError ||
      commandError instanceof WorkspaceCommandInputError
    ) {
      error(commandError.message, EXIT.INPUT_ERROR);
    }
    throw commandError;
  }
}

const handlers = Object.freeze({
  attach: (args) => runWorkspaceCommand(cmdAttach, args),
  attachments: (args) => runWorkspaceCommand(cmdAttachments, args),
  resolve: (args) => runWorkspaceCommand(cmdResolve, args),
  disable: (args) =>
    runWorkspaceCommand((commandArgs) => cmdSetState(commandArgs, 'disabled'), args),
  enable: (args) => runWorkspaceCommand((commandArgs) => cmdSetState(commandArgs, 'enabled'), args),
  switch: (args) => runWorkspaceCommand(cmdSwitch, args),
  rollback: (args) => runWorkspaceCommand(cmdRollback, args),
  remove: (args) => runWorkspaceCommand(cmdRemove, args),
  inspect: cmdInspect,
  validate: cmdValidate,
  'plan-load': cmdPlanLoad,
  load: cmdLoad,
  pack: cmdPack,
  unpack: cmdUnpack,
  demo: cmdDemo,
  help: (args) => {
    if (args.length !== 0) {
      error('help does not accept a command argument.', EXIT.INPUT_ERROR);
    }
    showHelp();
  },
  version: (args) => {
    if (args.length !== 0) error('version does not accept arguments.', EXIT.INPUT_ERROR);
    process.stdout.write(`${packageJson.version}\n`);
  },
});

function assertClosedCommandPolicy() {
  const approved = commandPolicy.commands.map((entry) => entry.command);
  if (new Set(approved).size !== approved.length) {
    throw new Error('command allowlist contains a duplicate');
  }
  const routed = Object.keys(handlers);
  if (
    approved.length !== routed.length ||
    approved.some((command) => !Object.hasOwn(handlers, command)) ||
    routed.some((command) => !approved.includes(command))
  ) {
    throw new Error('command router and approved allowlist differ');
  }
}

async function main(argv) {
  assertClosedCommandPolicy();
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    if (argv.length > 1) error('help option does not accept arguments.', EXIT.INPUT_ERROR);
    showHelp();
    return;
  }
  if (argv[0] === '--version' || argv[0] === '-v') {
    if (argv.length > 1) error('version option does not accept arguments.', EXIT.INPUT_ERROR);
    process.stdout.write(`${packageJson.version}\n`);
    return;
  }

  const [command, ...args] = argv;
  const handler = handlers[command];
  if (!handler) {
    error(
      `${commandPolicy.rejection.message_prefix} ${command}`,
      commandPolicy.rejection.exit_code,
    );
  }
  await handler(args);
}

main(process.argv.slice(2)).catch((caught) => {
  if (caught instanceof CliError) {
    process.stderr.write(`Error: ${caught.message}\n`);
    process.exitCode = caught.exitCode;
    return;
  }
  const code =
    caught && typeof caught.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(caught.code)
      ? ` [${caught.code}]`
      : '';
  process.stderr.write(`Error: operation failed safely${code}.\n`);
  process.exitCode = EXIT.VALIDATION_FAILED;
});
