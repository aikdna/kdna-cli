const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const core = require('@aikdna/kdna-core');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_LICENSE_RUNNER = `
const fs = require('node:fs');
const { cmdLicenseActivate, cmdLicenseSync } = require('./src/cmds/license');
const request = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const command = request.command === 'activate' ? cmdLicenseActivate : cmdLicenseSync;
Promise.resolve(command(request.args)).catch((caught) => {
  const code = typeof caught?.code === 'string' ? ' [' + caught.code + ']' : '';
  process.stderr.write('Error: ' + (caught?.message || 'operation failed safely') + code + '\\n');
  process.exitCode = caught?.exitCode || 1;
});
`;

function makeIsolatedEnv(prefix = 'kdna-license-redaction-') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    HOME: home,
    KDNA_HOME: path.join(home, '.kdna'),
  };
}

function runSourceLicenseAsync(command, args, opts = {}) {
  return new Promise((resolve) => {
    const requestDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-license-source-test-'));
    const requestFile = path.join(requestDirectory, 'request.json');
    fs.writeFileSync(requestFile, JSON.stringify({ command, args }), { mode: 0o600 });
    const child = spawn(process.execPath, ['-e', SOURCE_LICENSE_RUNNER, requestFile], {
      cwd: ROOT,
      env: { ...process.env, ...(opts.env || {}) },
      stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    const childArgv = [...child.spawnargs];
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('close', (code) => {
      fs.rmSync(requestDirectory, { recursive: true, force: true });
      resolve({ ok: code === 0, code, stdout, stderr, childArgv });
    });
  });
}

async function withReflectingAccountErrorServer(fn) {
  let received = null;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      received = JSON.parse(raw);
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            code: 'DENIED',
            message: `denied request body ${raw}`,
          },
        }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    return await fn(`http://127.0.0.1:${port}`, () => received);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
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
    return await fn(`http://127.0.0.1:${port}/entitlements/activate`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('license activate rejects a credential in argv without echoing it', async () => {
  const key = 'KDNA-LIC-SHOULD-NOT-LEAK';

  const activate = await runSourceLicenseAsync('activate', [
    '@aikdna/redact',
    '--key',
    key,
    '--server',
    'https://example.invalid',
  ]);
  assert.equal(activate.code, 2);
  assert.match(activate.stderr, /not accepted in process arguments/);
  assert.doesNotMatch(activate.stderr, new RegExp(key));
  assert.equal(
    activate.childArgv.some((argument) => argument.includes(key)),
    false,
  );
});

test('license activation credential uses bounded stdin and remote errors stay sterile', async () => {
  const env = {
    ...makeIsolatedEnv('kdna-license-credential-stdin-'),
    KDNA_SECRET_STORE_BACKEND: 'memory',
    NODE_ENV: 'test',
  };
  const secret = ' leading-and-trailing-space ';
  const asset = path.join(env.HOME, 'activation-fixture.kdna');
  core.pack(path.resolve(__dirname, '..', 'fixtures', 'minimal'), asset);

  await withReflectingAccountErrorServer(async (server, received) => {
    const args = [
      '@aikdna/credential-stdin',
      '--credential-stdin',
      '--server',
      server,
      '--asset',
      asset,
      '--no-browser',
    ];
    assert.ok(!args.includes(secret));
    const activate = await runSourceLicenseAsync('activate', args, {
      env,
      input: `${secret}\n`,
    });
    assert.ok(!activate.ok, 'activation should fail on the remote denial');
    assert.equal(received().activation_credential, secret);
    assert.doesNotMatch(activate.stdout, new RegExp(secret));
    assert.doesNotMatch(activate.stderr, new RegExp(secret));
    assert.doesNotMatch(activate.stderr, /denied request body/);
    assert.match(activate.stderr, /\[DENIED\]/);
  });
});

test('license sync sterilizes output and trace errors', async () => {
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
          require_machine_binding: false,
          require_online_check: true,
          offline_valid_until: '2099-01-01T00:00:00.000Z',
          activation_server: server,
        },
        null,
        2,
      ),
    );

    const sync = await runSourceLicenseAsync('sync', ['@aikdna/redact-sync', '--json'], { env });
    assert.ok(sync.ok, `sync command should return status JSON: ${sync.stderr}`);
    assert.doesNotMatch(sync.stdout, new RegExp(key));
    assert.doesNotMatch(sync.stdout, /denied request body/);
    assert.doesNotMatch(sync.stdout, /kdna-license-redact-sync-/);
    assert.match(sync.stdout, /\[DENIED\]/);
    const syncJson = JSON.parse(sync.stdout);
    assert.equal(syncJson.synced, false);

    const traceDirectory = path.join(env.KDNA_HOME, 'traces');
    const trace = fs
      .readdirSync(traceDirectory)
      .filter((file) => file.endsWith('.jsonl'))
      .map((file) => fs.readFileSync(path.join(traceDirectory, file), 'utf8'))
      .join('');
    assert.doesNotMatch(trace, new RegExp(key));
    assert.doesNotMatch(trace, /denied request body/);
    assert.doesNotMatch(trace, /kdna-license-redact-sync-/);
    assert.match(trace, /\[DENIED\]/);
  });
});
