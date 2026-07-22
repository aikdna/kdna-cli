#!/usr/bin/env node
'use strict';

// Test-only driver for modules that remain maintained but intentionally left
// the public CLI dispatcher. This file is excluded from the npm package.

const { cmdAvailable, cmdMatch } = require('../../src/agent');
const {
  cmdInstallExtended,
  cmdList,
  cmdRemove,
  cmdUpdate,
  cmdUpdateAll,
} = require('../../src/install');
const { cmdSetup } = require('../../src/cmds/setup');

const args = process.argv.slice(2);
const command = args[0];
const commandArgs = args.slice(1);

switch (command) {
  case 'available':
    cmdAvailable(commandArgs);
    break;
  case 'match': {
    const task = commandArgs.find((argument) => !argument.startsWith('--')) || '';
    cmdMatch(task, commandArgs);
    break;
  }
  case 'install': {
    const input = commandArgs.find((argument) => !argument.startsWith('--')) || '';
    cmdInstallExtended(input, commandArgs);
    break;
  }
  case 'remove': {
    const input = commandArgs.find((argument) => !argument.startsWith('--')) || '';
    if (!input) {
      process.stderr.write('Error: Usage: kdna remove <@scope/name[@version]>\n');
      process.exitCode = 2;
      break;
    }
    cmdRemove(input);
    break;
  }
  case 'update': {
    if (commandArgs.includes('--all')) cmdUpdateAll();
    else {
      const input = commandArgs.find((argument) => !argument.startsWith('--')) || '';
      cmdUpdate(input);
    }
    break;
  }
  case 'list':
    cmdList(commandArgs);
    break;
  case 'setup':
    cmdSetup(commandArgs);
    break;
  default:
    process.stderr.write(`Unknown internal test command: ${command || ''}\n`);
    process.exitCode = 2;
}
