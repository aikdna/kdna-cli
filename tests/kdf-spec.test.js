/**
 * kdf-spec.test.js — KDF constants and validateParameters
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { KDF_PARAMS, validateParameters } = require('../src/kdf-spec');

test('KDF_PARAMS: all three profiles are defined', () => {
  assert.ok(KDF_PARAMS['kdna-password-protected-v1'], 'argon2id profile missing');
  assert.ok(KDF_PARAMS['kdna-licensed-entry-v1'], 'hkdf profile missing');
  assert.ok(KDF_PARAMS['kdna-identity-backup-v1'], 'pbkdf2 profile missing');
});

test('KDF_PARAMS: password-protected profile has required fields', () => {
  const p = KDF_PARAMS['kdna-password-protected-v1'];
  assert.equal(p.algorithm, 'Argon2id');
  assert.equal(p.memoryCostKiB, 65536);
  assert.equal(p.hashLength, 32);
  assert.equal(p.saltLength, 32);
});

test('KDF_PARAMS: licensed-entry profile has required fields', () => {
  const p = KDF_PARAMS['kdna-licensed-entry-v1'];
  assert.equal(p.algorithm, 'HKDF-SHA256');
  assert.equal(p.keyLength, 32);
  assert.equal(p.wrapAlgorithm, 'AES-256-KW');
});

test('KDF_PARAMS: identity-backup profile has required fields', () => {
  const p = KDF_PARAMS['kdna-identity-backup-v1'];
  assert.equal(p.algorithm, 'PBKDF2-SHA256');
  assert.equal(p.iterations, 100000);
  assert.equal(p.encryption, 'AES-256-CBC');
});

test('validateParameters: returns params for known profile', () => {
  const p = validateParameters('kdna-password-protected-v1');
  assert.equal(p.algorithm, 'Argon2id');
});

test('validateParameters: throws for unknown profile', () => {
  assert.throws(() => validateParameters('unknown-profile'), /Unknown KDF profile/);
});

test('validateParameters: error message lists valid profiles', () => {
  try {
    validateParameters('typo');
  } catch (e) {
    assert.match(e.message, /kdna-password-protected-v1/);
    assert.match(e.message, /kdna-licensed-entry-v1/);
    assert.match(e.message, /kdna-identity-backup-v1/);
  }
});
