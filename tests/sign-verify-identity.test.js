'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const CLI = path.resolve(__dirname, '..', 'src', 'cli.js');

function run(args, env) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
    timeout: 30_000,
  });
}

function isolatedEnvironment() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-identity-preview-'));
  return {
    temporary,
    env: {
      KDNA_IDENTITY_DIR: path.join(temporary, 'keys'),
      KDNA_OLD_IDENTITY_DIR: path.join(temporary, 'legacy-keys'),
      KDNA_HOME: path.join(temporary, 'home'),
    },
  };
}

test('identity init and show retain the supported public identity surface', () => {
  const { temporary, env } = isolatedEnvironment();
  try {
    const initialized = run(['identity', 'init'], env);
    assert.equal(initialized.status, 0, initialized.stderr);
    const privateKey = path.join(env.KDNA_IDENTITY_DIR, 'ed25519.key');
    const publicKey = path.join(env.KDNA_IDENTITY_DIR, 'ed25519.pub');
    assert.equal(fs.statSync(privateKey).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(publicKey), true);

    const shown = run(['identity', 'show', '--json'], env);
    assert.equal(shown.status, 0, shown.stderr);
    const result = JSON.parse(shown.stdout);
    assert.equal(result.algorithm, 'ed25519');
    assert.match(result.pubkey_hex, /^[0-9a-f]{64}$/);
    assert.equal(Buffer.from(result.pubkey_base64, 'base64').length, 32);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('asset sign verify revoke and revocation commands are outside the Preview', () => {
  const { temporary, env } = isolatedEnvironment();
  try {
    const asset = path.join(temporary, 'asset.kdna');
    fs.writeFileSync(asset, 'not used');
    for (const command of ['sign', 'verify', 'revoke', 'revocation']) {
      const result = run([command, asset], env);
      assert.notEqual(result.status, 0, `${command} unexpectedly remained routable`);
    }
    assert.equal(fs.existsSync(`${asset}.ed25519.sig`), false);
    assert.equal(fs.existsSync(`${asset}.signatures`), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('legacy identity backup and import commands are outside the Preview', () => {
  const { temporary, env } = isolatedEnvironment();
  try {
    assert.equal(run(['identity', 'init'], env).status, 0);
    for (const args of [
      ['identity', 'export', '--out', path.join(temporary, 'backup')],
      ['identity', 'import', path.join(temporary, 'backup')],
    ]) {
      const result = run(args, env);
      assert.notEqual(result.status, 0, `${args.join(' ')} unexpectedly remained routable`);
    }
    assert.equal(fs.existsSync(path.join(temporary, 'backup')), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
