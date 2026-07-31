'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  MAX_SECRET_BYTES,
  SecretInputError,
  decodeSecretBytes,
  readSecretPairStdin,
  readSecretStdin,
} = require('../src/secret-input');

function decodeAndAssertCleared(input, options = {}) {
  const bytes = Buffer.from(input);
  const decoded = decodeSecretBytes(bytes, options);
  assert.ok(bytes.every((byte) => byte === 0));
  return decoded;
}

function finiteReader(input, chunkSize = 3) {
  const bytes = Buffer.from(input);
  let offset = 0;
  return {
    readSync(_fd, output, outputOffset, length) {
      if (offset >= bytes.length) return 0;
      const count = Math.min(length, chunkSize, bytes.length - offset);
      bytes.copy(output, outputOffset, offset, offset + count);
      offset += count;
      return count;
    },
  };
}

test('secret decoder preserves spaces and removes at most one transport line ending', () => {
  assert.equal(decodeAndAssertCleared('  leading and trailing  \n'), '  leading and trailing  ');
  assert.equal(decodeAndAssertCleared('  leading and trailing  \r\n'), '  leading and trailing  ');
  assert.equal(decodeAndAssertCleared('  no line ending  '), '  no line ending  ');
  assert.equal(decodeAndAssertCleared('first\nsecond\n'), 'first\nsecond');
  assert.equal(decodeAndAssertCleared('first\nsecond\n\n'), 'first\nsecond\n');
  assert.equal(
    decodeAndAssertCleared(Buffer.from([0x61, 0x0d])),
    'a\r',
    'a lone CR is a password byte, not a transport terminator',
  );
});

test('secret decoder rejects empty, oversized, and invalid UTF-8 while clearing input bytes', () => {
  for (const input of [Buffer.alloc(0), Buffer.from('\n'), Buffer.from('\r\n')]) {
    const bytes = Buffer.from(input);
    assert.throws(
      () => decodeSecretBytes(bytes),
      (error) => error instanceof SecretInputError && error.code === 'secret_input_empty',
    );
    assert.ok(bytes.every((byte) => byte === 0));
  }

  const oversized = Buffer.alloc(MAX_SECRET_BYTES + 1, 0x61);
  assert.throws(
    () => decodeSecretBytes(oversized),
    (error) => error instanceof SecretInputError && error.code === 'secret_input_too_large',
  );
  assert.ok(oversized.every((byte) => byte === 0));

  const invalid = Buffer.from([0x66, 0x6f, 0x80]);
  assert.throws(
    () => decodeSecretBytes(invalid),
    (error) => error instanceof SecretInputError && error.code === 'secret_input_encoding',
  );
  assert.ok(invalid.every((byte) => byte === 0));
});

test('bounded stdin reader drains finite hostile input and never trims the logical secret', () => {
  assert.equal(
    readSecretStdin({
      fileSystem: finiteReader('  exact secret  \r\n'),
      label: 'Password',
    }),
    '  exact secret  ',
  );
  assert.throws(
    () =>
      readSecretStdin({
        fileSystem: finiteReader(Buffer.alloc(MAX_SECRET_BYTES + 3, 0x61), 1024),
        label: 'Password',
      }),
    (error) => error instanceof SecretInputError && error.code === 'secret_input_too_large',
  );
});

test('two-value recovery input preserves the complete second secret after one delimiter', () => {
  assert.deepEqual(
    readSecretPairStdin({
      fileSystem: finiteReader('recovery-code\r\n  new\npassword  \r\n', 2),
      firstLabel: 'Recovery code',
      secondLabel: 'New password',
    }),
    ['recovery-code', '  new\npassword  '],
  );
});

test('all password readers share the strict decoder and contain no stdin trim fallback', () => {
  const common = fs.readFileSync(path.join(__dirname, '..', 'src', 'cmds', '_common.js'), 'utf8');
  const foundation = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'foundation-common.js'),
    'utf8',
  );
  assert.match(common, /decodeSecretBytes/);
  assert.match(common, /stripTransportLineEnding:\s*false/);
  assert.match(common, /readSecretStdin/);
  assert.match(foundation, /readSecretStdin/);
  assert.doesNotMatch(common, /readFileSync\\(0,\s*['"]utf8['"]\\)\\.trim\\(\\)/u);
  assert.doesNotMatch(foundation, /readFileSync\\(0,\s*['"]utf8['"]\\)\\.trim\\(\\)/u);
});
