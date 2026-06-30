/**
 * common-utils.test.js — _common.js utility functions
 *
 * Tests the shared helpers used across all CLI commands:
 * quiet mode, JSON read/write, EXIT codes, selfCheckText,
 * and readJson error handling.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const {
  EXIT,
  setQuiet, isQuiet,
  setExitCodeOnly, isExitCodeOnly,
  readJson, writeJson,
  selfCheckText, isYesNoSelfCheck,
} = require('../src/cmds/_common');

// ─── EXIT codes ─────────────────────────────────────────────────────────────

test('EXIT: has expected numeric codes', () => {
  assert.equal(typeof EXIT.OK,          'number');
  assert.equal(typeof EXIT.VALIDATION_FAILED, 'number');
  assert.equal(typeof EXIT.INPUT_ERROR, 'number');
  assert.equal(EXIT.OK, 0);
  assert.notEqual(EXIT.VALIDATION_FAILED, 0);
});

// ─── quiet mode ──────────────────────────────────────────────────────────────

test('setQuiet / isQuiet: round-trips correctly', () => {
  const original = isQuiet();
  setQuiet(true);
  assert.equal(isQuiet(), true);
  setQuiet(false);
  assert.equal(isQuiet(), false);
  setQuiet(original);  // restore
});

test('setExitCodeOnly / isExitCodeOnly: round-trips correctly', () => {
  const original = isExitCodeOnly();
  setExitCodeOnly(true);
  assert.equal(isExitCodeOnly(), true);
  setExitCodeOnly(false);
  assert.equal(isExitCodeOnly(), false);
  setExitCodeOnly(original);
});

// ─── readJson / writeJson ────────────────────────────────────────────────────

test('writeJson + readJson: round-trip for plain object', () => {
  const tmp = path.join(os.tmpdir(), `kdna-test-${Date.now()}.json`);
  try {
    const payload = { foo: 'bar', n: 42, arr: [1, 2, 3] };
    writeJson(tmp, payload);
    const result = readJson(tmp);
    assert.deepEqual(result, payload);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

test('readJson: returns null for missing file', () => {
  const missing = path.join(os.tmpdir(), `kdna-nonexistent-${Date.now()}.json`);
  const result = readJson(missing);
  assert.equal(result, null);
});

test('readJson: returns null for malformed JSON', () => {
  const tmp = path.join(os.tmpdir(), `kdna-bad-${Date.now()}.json`);
  try {
    fs.writeFileSync(tmp, '{ not valid json !!');
    const result = readJson(tmp);
    assert.equal(result, null);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

// ─── selfCheckText / isYesNoSelfCheck ────────────────────────────────────────

test('selfCheckText: returns string for string input', () => {
  const result = selfCheckText('Is the output correct?');
  assert.equal(typeof result, 'string');
  assert.match(result, /correct/i);
});

test('selfCheckText: handles object with text field', () => {
  const result = selfCheckText({ question: 'Did it work?', type: 'yes_no' });
  assert.equal(typeof result, 'string');
  assert.match(result, /Did it work/);
});

test('isYesNoSelfCheck: detects yes_no type', () => {
  assert.equal(isYesNoSelfCheck({ type: 'yes_no', question: 'Did it work?' }), true);
  assert.equal(isYesNoSelfCheck({ question: 'info only', type: 'open_end' }), false);
  assert.equal(isYesNoSelfCheck('Is this correct?'),  true);  // question mark  // strings are yes/no by default
  assert.equal(isYesNoSelfCheck(null),                             false);
});
