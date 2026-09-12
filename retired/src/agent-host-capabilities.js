'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_REGISTRATION_BYTES = 64 * 1024;

function ownKeysExactly(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return JSON.stringify(actual) === JSON.stringify([...expected].sort());
}

function snapshotRegularFile(filePath, maxBytes = MAX_REGISTRATION_BYTES, fileSystem = fs) {
  const absolute = path.resolve(filePath);
  const noFollow = fileSystem.constants.O_NOFOLLOW || 0;
  let descriptor;
  try {
    const pathStat = fileSystem.lstatSync(absolute);
    if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
      throw new Error('Capability registration must be a regular non-symlink file.');
    }
    descriptor = fileSystem.openSync(absolute, fileSystem.constants.O_RDONLY | noFollow);
    const before = fileSystem.fstatSync(descriptor);
    if (!before.isFile()) throw new Error('Capability registration must be a regular file.');
    if (
      pathStat.dev === undefined ||
      pathStat.ino === undefined ||
      before.dev === undefined ||
      before.ino === undefined ||
      pathStat.dev !== before.dev ||
      pathStat.ino !== before.ino
    ) {
      throw new Error('Capability registration changed before it was opened.');
    }
    if (before.size <= 0 || before.size > maxBytes) {
      throw new Error(`Capability registration must be between 1 and ${maxBytes} bytes.`);
    }
    const bytes = fileSystem.readFileSync(descriptor);
    const after = fileSystem.fstatSync(descriptor);
    if (
      bytes.length !== before.size ||
      bytes.length > maxBytes ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error('Capability registration changed while it was being read.');
    }
    return bytes;
  } finally {
    if (descriptor !== undefined) fileSystem.closeSync(descriptor);
  }
}

function createAgentHostCapabilityRegistry(core) {
  if (!core || typeof core.parseRuntimeContractJson !== 'function') {
    throw new Error('KDNA Core Runtime contract parser is required.');
  }
  const registrations = new Map();

  function selectorKey(command, args) {
    return JSON.stringify([command, args]);
  }

  return {
    registerProcessFile(filePath, selection) {
      const bytes = snapshotRegularFile(filePath);
      const value = core.parseRuntimeContractJson(bytes, {
        maxBytes: MAX_REGISTRATION_BYTES,
        maxDepth: 16,
      });
      if (!ownKeysExactly(value, ['type', 'protocol_version', 'process', 'capabilities'])) {
        throw new Error('Capability registration has an invalid top-level shape.');
      }
      if (
        value.type !== 'kdna.cli.agent-host-registration' ||
        value.protocol_version !== '0.1.0' ||
        !ownKeysExactly(value.process, ['command', 'args']) ||
        typeof value.process.command !== 'string' ||
        value.process.command.length === 0 ||
        !Array.isArray(value.process.args) ||
        value.process.args.some((arg) => typeof arg !== 'string')
      ) {
        throw new Error('Capability registration process binding is invalid.');
      }
      if (
        value.process.command !== selection.command ||
        JSON.stringify(value.process.args) !== JSON.stringify(selection.args)
      ) {
        throw new Error('Capability registration does not match the selected process Host.');
      }
      if (value.capabilities?.capability_basis !== 'registered_descriptor') {
        throw new Error('A registration file must contain registered_descriptor capabilities.');
      }
      const key = selectorKey(selection.command, selection.args);
      registrations.set(key, globalThis.structuredClone(value.capabilities));
      return globalThis.structuredClone(value.capabilities);
    },

    resolveProcess(selection) {
      const value = registrations.get(selectorKey(selection.command, selection.args));
      if (!value) {
        throw new Error('No capability registration matches the selected process Host.');
      }
      return globalThis.structuredClone(value);
    },
  };
}

module.exports = {
  MAX_REGISTRATION_BYTES,
  createAgentHostCapabilityRegistry,
  snapshotRegularFile,
};
