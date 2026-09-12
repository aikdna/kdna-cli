/**
 * kdf-spec.test.js — KDF constants and validateParameters
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const core = require('@aikdna/kdna-core');
const { KDF_PARAMS, validateParameters } = require('../src/kdf-spec');

test('KDF_PARAMS: only current Preview profiles are defined', () => {
  assert.ok(KDF_PARAMS[core.PASSWORD_PROTECTED_PROFILE], 'argon2id profile missing');
  assert.ok(KDF_PARAMS[core.LICENSED_ENTRY_PROFILE], 'hkdf profile missing');
  assert.deepEqual(
    Object.keys(KDF_PARAMS).sort(),
    [core.PASSWORD_PROTECTED_PROFILE, core.LICENSED_ENTRY_PROFILE].sort(),
  );
});

test('KDF_PARAMS: password-protected profile has required fields', () => {
  const p = KDF_PARAMS[core.PASSWORD_PROTECTED_PROFILE];
  assert.equal(p.algorithm, 'Argon2id');
  assert.equal(p.memoryCostKiB, 65536);
  assert.equal(p.hashLength, 32);
  assert.equal(p.saltLength, 32);
});

test('KDF_PARAMS: licensed-entry profile has required fields', () => {
  const p = KDF_PARAMS[core.LICENSED_ENTRY_PROFILE];
  assert.equal(p.algorithm, 'HKDF-SHA256');
  assert.equal(p.keyLength, 32);
  assert.equal(p.wrapAlgorithm, 'AES-256-KW');
});

test('validateParameters: returns params for known profile', () => {
  const p = validateParameters(core.PASSWORD_PROTECTED_PROFILE);
  assert.equal(p.algorithm, 'Argon2id');
});

test('validateParameters: throws for unknown profile', () => {
  assert.throws(() => validateParameters('unknown-profile'), /Unknown KDF profile/);
});

test('validateParameters: error message lists valid profiles', () => {
  try {
    validateParameters('typo');
  } catch (e) {
    assert.match(e.message, new RegExp(core.PASSWORD_PROTECTED_PROFILE.replaceAll('.', '\\.')));
    assert.match(e.message, new RegExp(core.LICENSED_ENTRY_PROFILE.replaceAll('.', '\\.')));
    assert.doesNotMatch(e.message, /identity-backup|PBKDF2|AES-256-CBC/);
  }
});
