'use strict';

const fs = require('node:fs');

const EXIT = Object.freeze({
  OK: 0,
  VALIDATION_FAILED: 1,
  INPUT_ERROR: 2,
  TRUST_FAILED: 3,
  JUDGMENT_QUALITY_FAILED: 4,
  PROVIDER_ERROR: 6,
});

class CliError extends Error {
  constructor(message, exitCode = EXIT.VALIDATION_FAILED) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

function error(message, exitCode = EXIT.VALIDATION_FAILED) {
  throw new CliError(message, exitCode);
}

function rejectPasswordArgv(args) {
  if (args.includes('--password') || args.some((argument) => argument.startsWith('--password='))) {
    error(
      '--password is not supported because it exposes secrets in process arguments. ' +
        'Use --password-stdin.',
      EXIT.INPUT_ERROR,
    );
  }
}

function resolvePassword(args) {
  rejectPasswordArgv(args);
  if (!args.includes('--password-stdin')) return undefined;
  if (process.stdin.isTTY) {
    error('--password-stdin requires the password to be piped in on stdin.', EXIT.INPUT_ERROR);
  }
  try {
    const password = fs.readFileSync(0, 'utf8').trim();
    if (!password) error('Password input is empty.', EXIT.INPUT_ERROR);
    return password;
  } catch (readError) {
    if (readError instanceof CliError) throw readError;
    error('Could not read password from stdin.', EXIT.INPUT_ERROR);
  }
}

function parseCommandArgs(args, { booleans = [], values = [] } = {}) {
  const booleanNames = new Set(booleans);
  const valueNames = new Set(values);
  const seenBooleans = new Set();
  const seenValues = new Map();
  const positional = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith('--')) {
      positional.push(argument);
      continue;
    }

    const equals = argument.indexOf('=');
    const name = equals === -1 ? argument : argument.slice(0, equals);
    if (booleanNames.has(name)) {
      if (equals !== -1) error(`${name} does not accept a value.`, EXIT.INPUT_ERROR);
      if (seenBooleans.has(name)) error(`${name} may be supplied only once.`, EXIT.INPUT_ERROR);
      seenBooleans.add(name);
      continue;
    }
    if (!valueNames.has(name)) error(`Unknown option: ${name}`, EXIT.INPUT_ERROR);
    if (seenValues.has(name)) error(`${name} may be supplied only once.`, EXIT.INPUT_ERROR);

    const value = equals === -1 ? args[index + 1] : argument.slice(equals + 1);
    if (equals === -1) index += 1;
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
      error(`${name} requires a value.`, EXIT.INPUT_ERROR);
    }
    seenValues.set(name, value);
  }

  return {
    positional,
    has: (name) => seenBooleans.has(name),
    value: (name, fallback = null) => seenValues.get(name) ?? fallback,
  };
}

module.exports = {
  CliError,
  EXIT,
  error,
  parseCommandArgs,
  rejectPasswordArgv,
  resolvePassword,
};
