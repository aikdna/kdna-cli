const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { machineFingerprint } = require('../src/cmds/license');

const CLI = path.resolve(__dirname, '..', 'src', 'cli.js');

function makeIsolatedEnv(prefix = 'kdna-license-redaction-') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    HOME: home,
    KDNA_HOME: path.join(home, '.kdna'),
  };
}

function runAsync(args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      cwd: opts.cwd || process.cwd(),
      env: { ...process.env, ...(opts.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('close', (code) => {
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}

async function withReflectingActivationErrorServer(key, fn) {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: false,
          error: {
            code: 'DENIED',
            message: `denied request body ${raw} for key ${key}`,
          },
        }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    return await fn(`http://127.0.0.1:${port}/v1/entitlements/activate`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('license activate redacts license_key from activation server errors', async () => {
  const env = makeIsolatedEnv('kdna-license-redact-activate-');
  const key = 'KDNA-LIC-SHOULD-NOT-LEAK';

  await withReflectingActivationErrorServer(key, async (server) => {
    const activate = await runAsync(
      ['license', 'activate', '@aikdna/redact', '--key', key, '--server', server],
      { env },
    );
    assert.ok(!activate.ok, 'activation should fail');
    assert.doesNotMatch(activate.stderr, new RegExp(key));
    assert.match(activate.stderr, /redacted-license-key/);
  });
});

test('license sync redacts license_key from output and trace errors', async () => {
  const env = makeIsolatedEnv('kdna-license-redact-sync-');
  const key = 'KDNA-LIC-SYNC-SHOULD-NOT-LEAK';
  const licenseDir = path.join(env.KDNA_HOME, 'licenses');
  fs.mkdirSync(licenseDir, { recursive: true });

  await withReflectingActivationErrorServer(key, async (server) => {
    fs.writeFileSync(
      path.join(licenseDir, 'aikdna-redact-sync.json'),
      JSON.stringify(
        {
          version: '1.0',
          domain: '@aikdna/redact-sync',
          license_id: 'lic_redact_sync',
          license_key: key,
          status: 'active',
          require_machine_binding: true,
          machine_fingerprint: machineFingerprint(),
          require_online_check: true,
          offline_valid_until: '2099-01-01T00:00:00.000Z',
          activation_server: server,
        },
        null,
        2,
      ),
    );

    const sync = await runAsync(['license', 'sync', '@aikdna/redact-sync', '--json'], { env });
    assert.ok(sync.ok, `sync command should return status JSON: ${sync.stderr}`);
    assert.doesNotMatch(sync.stdout, new RegExp(key));
    assert.match(sync.stdout, /redacted-license-key/);
    const syncJson = JSON.parse(sync.stdout);
    assert.equal(syncJson.synced, false);

    const trace = await runAsync(['trace', '--json'], { env });
    assert.ok(trace.ok, `trace failed: ${trace.stderr}`);
    assert.doesNotMatch(trace.stdout, new RegExp(key));
    assert.match(trace.stdout, /redacted-license-key/);
  });
});
