/**
 * critical-2-remote-mode-client.test.js — CLI client for kdna-remote-server
 *
 * Verifies the CRITICAL-2 fix: kdna load now correctly handles
 * access: "remote" assets by routing to a configured
 * kdna-remote-server instead of failing with
 * KDNA_AUTH_REMOTE_RUNTIME_REQUIRED.
 *
 * Why a separate process for the fake server:
 *   In macOS sandboxed environments (and some Node.js
 *   versions), a spawnSync subprocess cannot reach an HTTP
 *   server bound to 127.0.0.1 in the parent test process
 *   (the connection is filtered as if the child were in a
 *   different network namespace). Running the fake server in
 *   its own process makes the loopback work the same way it
 *   does for a real kdna-remote-server deployment.
 *
 * Tests:
 *   1. --remote-server <url> flag is read and used
 *   2. KDNA_REMOTE_SERVER env var is read and used
 *   3. access: "remote" + no remote server → clear error
 *   4. kdna load on a remote asset POSTs to the server with
 *      the right request body (kdna_id, task, mode, context)
 *   5. The server's projection response is printed
 *   6. The server's error response is mapped to a CLI error
 *   7. Task verb default is "review"; --task overrides it
 *   8. The request URL normalization accepts both
 *      --remote-server https://example.com (→ /v1/project)
 *      and --remote-server https://example.com/v1/project
 *   9. Packaged access: "remote" .kdna files route to the server too
 *
 * Run: node --test tests/critical-2-remote-mode-client.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');

const CLI = path.resolve(__dirname, '..', 'src', 'cli.js');

/**
 * Spawn a fake remote server in a separate process using
 * `spawn` (async). Returns a promise that resolves with a
 * `stop` function and the URL.
 *
 * Protocol:
 *   - server writes "ready\n" to FAKE_REMOTE_READY when listening
 *   - server writes JSON of the last request body to
 *     FAKE_REMOTE_LAST_REQUEST after each request
 *   - FAKE_REMOTE_CONFIG (JSON) controls the response shape and
 *     status code
 */
async function startFakeRemoteServer(opts = {}) {
  const port = await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
    srv.on('error', reject);
  });

  const readyPath = path.join(os.tmpdir(), `kdna-fake-remote-ready-${process.pid}-${Date.now()}`);
  const lastRequestPath = path.join(
    os.tmpdir(),
    `kdna-fake-remote-last-${process.pid}-${Date.now()}`,
  );
  const cfg = JSON.stringify({
    response: opts.response || {
      task_projection: { highest_question: 'mocked' },
      projection_policy: 'remote',
      trace_id: 'mocked-trace',
      asset_id: 'mocked',
      asset_version: '1.0.0',
    },
    statusCode: opts.statusCode || 200,
  });

  const script = `
    const http = require('http');
    const fs = require('fs');
    const port = ${port};
    const cfg = JSON.parse(process.env.FAKE_REMOTE_CONFIG || '{}');
    const statusCode = cfg.statusCode || 200;
    const response = cfg.response || {};
    const lastRequestPath = process.env.FAKE_REMOTE_LAST_REQUEST;
    const readyPath = process.env.FAKE_REMOTE_READY;
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          fs.writeFileSync(lastRequestPath, JSON.stringify({
            url: req.url, method: req.method, body: body ? JSON.parse(body) : null,
          }));
        } catch (_) { /* ignore */ }
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      });
    });
    server.listen(port, '127.0.0.1', () => {
      fs.writeFileSync(readyPath, 'ready');
    });
  `;

  const proc = spawn(process.execPath, ['-e', script], {
    env: {
      ...process.env,
      FAKE_REMOTE_CONFIG: cfg,
      FAKE_REMOTE_READY: readyPath,
      FAKE_REMOTE_LAST_REQUEST: lastRequestPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.on('error', () => {}); // suppress EPIPE on stderr

  // Wait for the ready signal (or process exit, in which case reject).
  const start = Date.now();
  while (Date.now() - start < 5000) {
    if (fs.existsSync(readyPath)) break;
    if (proc.exitCode !== null) {
      throw new Error(`fake server exited early with code ${proc.exitCode}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  if (!fs.existsSync(readyPath)) {
    proc.kill('SIGKILL');
    throw new Error('fake server did not become ready within 5s');
  }
  // Clean up the ready marker so it doesn't accumulate.
  try {
    fs.unlinkSync(readyPath);
  } catch (_) {
    /* ignore */
  }

  return {
    proc,
    port,
    url: `http://127.0.0.1:${port}/v1/project`,
    lastRequestPath,
    async stop() {
      proc.kill('SIGKILL');
      await new Promise((resolve) => {
        proc.on('exit', resolve);
        setTimeout(resolve, 1000);
      });
    },
  };
}

function readLastRequest(server) {
  if (!fs.existsSync(server.lastRequestPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(server.lastRequestPath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function makeRemoteFixture(tmpDir) {
  const dir = path.join(tmpDir, 'asset');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mimetype'), 'application/vnd.kdna.asset');
  const core = require('@aikdna/kdna-core');
  const manifest = {
    kdna_version: '1.0',
    asset_id: 'kdna:test:remote',
    asset_uid: 'urn:uuid:00000000-0000-4000-8000-aaaaaaaaaaaa',
    asset_type: 'domain',
    title: 'Remote Test',
    version: '1.0.0',
    judgment_version: '1.0.0',
    created_at: '2026-06-28T00:00:00.000Z',
    updated_at: '2026-06-28T00:00:00.000Z',
    creator: { name: 'Test', id: 'test' },
    compatibility: { min_loader_version: '1.0.0', profile: 'judgment-profile-v1' },
    payload: { path: 'payload.kdnab', encoding: 'json', encrypted: false },
    access: 'remote',
    runtime: { endpoint: 'http://localhost/v1/project' },
  };
  const payload = {
    profile: 'judgment-profile-v1',
    core: {
      highest_question: 'Q?',
      axioms: [{ id: 'ax1', one_sentence: 'Test.' }],
      boundaries: [],
      risk_model: {},
    },
    patterns: [],
    scenarios: [],
    cases: [],
    reasoning: { self_checks: [], failure_modes: [] },
    evolution: { changelog: [], version_notes: [] },
  };
  fs.writeFileSync(path.join(dir, 'kdna.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'payload.kdnab'), JSON.stringify(payload) + '\n');
  fs.writeFileSync(
    path.join(dir, 'checksums.json'),
    JSON.stringify(core.buildChecksums(dir), null, 2) + '\n',
  );
  return dir;
}

function packFixture(dir, outPath) {
  const core = require('@aikdna/kdna-core');
  core.pack(dir, outPath);
  return outPath;
}

function run(args, opts = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: opts.cwd || process.cwd(),
    env: { ...process.env, ...(opts.env || {}) },
    timeout: 30_000,
  });
}

// ─── A: --remote-server flag is read and used ───────────────────────────

test('CRITICAL-2: --remote-server <url> flag is used as the projection endpoint', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-crit2-'));
  const env = { KDNA_IDENTITY_DIR: path.join(tmp, 'keys') };
  let server;
  try {
    server = await startFakeRemoteServer();
    const dir = makeRemoteFixture(tmp);
    const r = run(['load', dir, '--as=json', '--remote-server', server.url], { env });
    assert.equal(r.status, 0, `load failed: ${r.stderr}`);
    const last = readLastRequest(server);
    assert.ok(last, 'fake server should have received a request');
    assert.equal(last.url, '/v1/project');
    assert.equal(last.method, 'POST');
  } finally {
    if (server) await server.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── B: KDNA_REMOTE_SERVER env var is used ─────────────────────────────

test('CRITICAL-2: KDNA_REMOTE_SERVER env var is used as the projection endpoint', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-crit2-'));
  let server;
  try {
    server = await startFakeRemoteServer();
    const dir = makeRemoteFixture(tmp);
    const r = run(['load', dir, '--as=json'], {
      env: {
        ...process.env,
        KDNA_REMOTE_SERVER: server.url,
        KDNA_IDENTITY_DIR: path.join(tmp, 'keys'),
      },
    });
    assert.equal(r.status, 0, `load failed: ${r.stderr}`);
    const last = readLastRequest(server);
    assert.ok(last, 'fake server should have received a request');
    assert.equal(last.url, '/v1/project');
  } finally {
    if (server) await server.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── C: access: remote + no remote server → clear error ──────────────

test('CRITICAL-2: access:remote with no --remote-server returns a clear error', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-crit2-'));
  const env = { KDNA_IDENTITY_DIR: path.join(tmp, 'keys') };
  try {
    const dir = makeRemoteFixture(tmp);
    const r = run(['load', dir, '--as=json'], { env });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /access: "remote"/);
    assert.match(r.stderr, /--remote-server|KDNA_REMOTE_SERVER/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── D: kdna load POSTs the right request body ─────────────────────────

test('CRITICAL-2: request body has kdna_id, task, mode, context fields', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-crit2-'));
  let server;
  try {
    server = await startFakeRemoteServer();
    const dir = makeRemoteFixture(tmp);
    const r = run(
      [
        'load',
        dir,
        '--as=json',
        '--remote-server',
        server.url,
        '--task',
        'decide',
        '--mode',
        'explore',
        '--context',
        'pre-publish review',
      ],
      { env: { KDNA_IDENTITY_DIR: path.join(tmp, 'keys') } },
    );
    assert.equal(r.status, 0, `load failed: ${r.stderr}`);
    const last = readLastRequest(server);
    assert.ok(last, 'fake server should have received a request');
    assert.equal(last.body.kdna_id, 'urn:uuid:00000000-0000-4000-8000-aaaaaaaaaaaa');
    assert.equal(last.body.task, 'decide');
    assert.equal(last.body.mode, 'explore');
    assert.equal(last.body.context, 'pre-publish review');
  } finally {
    if (server) await server.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── E: the projection response is printed ─────────────────────────────

test('CRITICAL-2: --as=json output contains the server response + request metadata', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-crit2-'));
  let server;
  try {
    server = await startFakeRemoteServer({
      response: {
        task_projection: { highest_question: 'mocked Q' },
        projection_policy: 'remote',
        trace_id: 'mocked-trace',
        asset_id: 'mocked-asset',
        asset_version: '9.9.9',
      },
    });
    const dir = makeRemoteFixture(tmp);
    const r = run(['load', dir, '--as=json', '--remote-server', server.url], {
      env: { KDNA_IDENTITY_DIR: path.join(tmp, 'keys') },
    });
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.remote_server, server.url);
    assert.equal(out.request.kdna_id, 'urn:uuid:00000000-0000-4000-8000-aaaaaaaaaaaa');
    assert.equal(out.request.task, 'review'); // default
    assert.equal(out.response.task_projection.highest_question, 'mocked Q');
    assert.equal(out.response.trace_id, 'mocked-trace');
  } finally {
    if (server) await server.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── F: the projection response is rendered as prompt text ─────────────

test('CRITICAL-2: --as=prompt output is a human-readable projection', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-crit2-'));
  let server;
  try {
    server = await startFakeRemoteServer({
      response: {
        task_projection: {
          highest_question: 'What should I do?',
          diagnosis_focus: ['Focus point 1', 'Focus point 2'],
          constraints: ['Constraint A'],
          self_check: ['Self-check X'],
        },
        projection_policy: 'remote',
        trace_id: 'trace-1',
        asset_id: 'asset-1',
        asset_version: '1.0.0',
      },
    });
    const dir = makeRemoteFixture(tmp);
    const r = run(['load', dir, '--as=prompt', '--remote-server', server.url, '--task', 'review'], {
      env: { KDNA_IDENTITY_DIR: path.join(tmp, 'keys') },
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /# kdna-remote projection/);
    assert.match(r.stdout, /What should I do\?/);
    assert.match(r.stdout, /Focus point 1/);
    assert.match(r.stdout, /Constraint A/);
    assert.match(r.stdout, /Self-check X/);
  } finally {
    if (server) await server.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── G: server error is mapped to a CLI error ─────────────────────────

test('CRITICAL-2: server error response (non-2xx) is mapped to a CLI error', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-crit2-'));
  let server;
  try {
    server = await startFakeRemoteServer({
      statusCode: 403,
      response: { ok: false, error: { code: 'ENTITLEMENT_DENIED', message: 'license not valid' } },
    });
    const dir = makeRemoteFixture(tmp);
    const r = run(['load', dir, '--as=json', '--remote-server', server.url], {
      env: { KDNA_IDENTITY_DIR: path.join(tmp, 'keys') },
    });
    assert.notEqual(r.status, 0, 'server error must produce non-zero exit');
    assert.match(r.stderr, /ENTITLEMENT_DENIED/);
    assert.match(r.stderr, /license not valid/);
  } finally {
    if (server) await server.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── H: URL normalization ────────────────────────────────────────────

test('CRITICAL-2: --remote-server URL is normalized (with or without /v1/project suffix)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-crit2-'));
  let server;
  try {
    server = await startFakeRemoteServer();
    const dir = makeRemoteFixture(tmp);
    // Pass the URL WITHOUT /v1/project — CLI should append it.
    const baseUrl = server.url.replace('/v1/project', '');
    const r = run(['load', dir, '--as=json', '--remote-server', baseUrl], {
      env: { KDNA_IDENTITY_DIR: path.join(tmp, 'keys') },
    });
    assert.equal(r.status, 0, `load failed: ${r.stderr}`);
    const last = readLastRequest(server);
    assert.ok(last);
    assert.equal(last.url, '/v1/project');
  } finally {
    if (server) await server.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── I: non-remote asset with --remote-server is still loaded locally ─

test('CRITICAL-2: public asset is loaded normally even when --remote-server is set', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-crit2-'));
  let server;
  try {
    server = await startFakeRemoteServer();
    // Use the public v1-minimal fixture (no access: "remote" field)
    const dir = path.resolve(__dirname, '..', 'fixtures', 'v1-minimal');
    const r = run(['load', dir, '--as=json', '--remote-server', server.url], {
      env: { KDNA_IDENTITY_DIR: path.join(tmp, 'keys') },
    });
    // The public asset loads successfully via the normal path.
    // The fake server is NOT called.
    assert.equal(r.status, 0, `load failed: ${r.stderr}`);
    const last = readLastRequest(server);
    assert.equal(last, null, 'fake server should NOT be called for a public asset');
  } finally {
    if (server) await server.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── J: packaged remote .kdna also routes to remote server ────────────

test('CRITICAL-2: packaged access:remote .kdna routes to remote server', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-crit2-'));
  let server;
  try {
    server = await startFakeRemoteServer();
    const dir = makeRemoteFixture(tmp);
    const kdnaPath = packFixture(dir, path.join(tmp, 'remote-test.kdna'));
    const r = run(['load', kdnaPath, '--as=json', '--remote-server', server.url], {
      env: { KDNA_IDENTITY_DIR: path.join(tmp, 'keys') },
    });
    assert.equal(r.status, 0, `load failed: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.remote_server, server.url);
    assert.equal(out.request.kdna_id, 'urn:uuid:00000000-0000-4000-8000-aaaaaaaaaaaa');
    const last = readLastRequest(server);
    assert.ok(last, 'fake server should have received a request');
    assert.equal(last.body.kdna_id, 'urn:uuid:00000000-0000-4000-8000-aaaaaaaaaaaa');
  } finally {
    if (server) await server.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
