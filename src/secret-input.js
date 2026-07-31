'use strict';

const fs = require('node:fs');
const { TextDecoder } = require('node:util');

const MAX_SECRET_BYTES = 16 * 1024;
const READ_BUFFER_BYTES = 4 * 1024;

class SecretInputError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SecretInputError';
    this.code = code;
  }
}

function secretError(code, message) {
  throw new SecretInputError(code, message);
}

function stripOneTransportLineEnding(bytes) {
  let end = bytes.length;
  if (end > 0 && bytes[end - 1] === 0x0a) {
    end -= 1;
    if (end > 0 && bytes[end - 1] === 0x0d) end -= 1;
  }
  return bytes.subarray(0, end);
}

function decodeSecretBytes(
  bytes,
  { label = 'Secret', stripTransportLineEnding = true, maximum = MAX_SECRET_BYTES } = {},
) {
  if (!Buffer.isBuffer(bytes)) {
    secretError('secret_input_invalid', `${label} input is invalid.`);
  }
  try {
    const logical = stripTransportLineEnding ? stripOneTransportLineEnding(bytes) : bytes;
    if (logical.length === 0) {
      secretError('secret_input_empty', `${label} input is empty.`);
    }
    if (logical.length > maximum) {
      secretError('secret_input_too_large', `${label} input exceeds the size limit.`);
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(logical);
    } catch (decodeError) {
      if (decodeError instanceof SecretInputError) throw decodeError;
      secretError('secret_input_encoding', `${label} input must be strict UTF-8.`);
    }
  } finally {
    bytes.fill(0);
  }
}

function readBoundedStdinBytes({
  fd = 0,
  maximum = MAX_SECRET_BYTES + 2,
  fileSystem = fs,
  label = 'Secret',
} = {}) {
  const chunks = [];
  const readBuffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
  let total = 0;
  let exceeded = false;
  try {
    while (true) {
      const count = fileSystem.readSync(fd, readBuffer, 0, readBuffer.length);
      if (count === 0) break;
      if (exceeded || total + count > maximum) {
        exceeded = true;
        continue;
      }
      total += count;
      chunks.push(Buffer.from(readBuffer.subarray(0, count)));
    }
    if (exceeded) {
      secretError('secret_input_too_large', `${label} input exceeds the size limit.`);
    }
    return Buffer.concat(chunks, total);
  } finally {
    readBuffer.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
}

function readSecretStdin(options = {}) {
  const maximum = options.maximum || MAX_SECRET_BYTES;
  let bytes;
  try {
    bytes = readBoundedStdinBytes({
      ...options,
      maximum: maximum + 2,
    });
    return decodeSecretBytes(bytes, {
      label: options.label || 'Secret',
      maximum,
      stripTransportLineEnding: true,
    });
  } catch (error) {
    if (bytes) bytes.fill(0);
    if (error instanceof SecretInputError) throw error;
    secretError(
      'secret_input_read_failed',
      `${options.label || 'Secret'} input could not be read.`,
    );
  }
}

function readSecretPairStdin({
  firstLabel = 'First secret',
  secondLabel = 'Second secret',
  maximum = MAX_SECRET_BYTES,
  ...options
} = {}) {
  let bytes;
  try {
    bytes = readBoundedStdinBytes({
      ...options,
      maximum: maximum * 2 + 4,
      label: 'Secret pair',
    });
    const decoded = decodeSecretBytes(bytes, {
      label: 'Secret pair',
      maximum: maximum * 2 + 1,
      stripTransportLineEnding: true,
    });
    const separator = decoded.indexOf('\n');
    if (separator < 0) {
      secretError(
        'secret_input_invalid',
        `${firstLabel} and ${secondLabel} require two newline-delimited values.`,
      );
    }
    const first = decoded.slice(0, separator).replace(/\r$/u, '');
    const second = decoded.slice(separator + 1);
    if (first.length === 0) secretError('secret_input_empty', `${firstLabel} input is empty.`);
    if (second.length === 0) secretError('secret_input_empty', `${secondLabel} input is empty.`);
    if (Buffer.byteLength(first, 'utf8') > maximum) {
      secretError('secret_input_too_large', `${firstLabel} input exceeds the size limit.`);
    }
    if (Buffer.byteLength(second, 'utf8') > maximum) {
      secretError('secret_input_too_large', `${secondLabel} input exceeds the size limit.`);
    }
    return [first, second];
  } catch (error) {
    if (bytes) bytes.fill(0);
    if (error instanceof SecretInputError) throw error;
    secretError('secret_input_read_failed', 'Secret pair input could not be read.');
  }
}

module.exports = {
  MAX_SECRET_BYTES,
  SecretInputError,
  decodeSecretBytes,
  readSecretPairStdin,
  readSecretStdin,
};
