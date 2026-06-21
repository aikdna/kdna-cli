/**
 * Smoke tests for v0.12+ commands: doctor, trace, history, license, compare report.
 *
 * Run: node --test tests/v012-commands.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { machineFingerprint } = require('../src/cmds/license');

const CLI = path.resolve(__dirname, '..', 'src', 'cli.js');

function run(args, opts = {}) {
  try {
    return {
      ok: true,
      code: 0,
      stdout: execFileSync('node', [CLI, ...args], {
        encoding: 'utf8',
        timeout: 30000,
        env: { ...process.env, ...(opts.env || {}) },
        cwd: opts.cwd || process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    };
  } catch (e) {
    return {
      ok: false,
      code: e.status,
      stdout: (e.stdout || '').toString(),
      stderr: (e.stderr || '').toString(),
    };
  }
}

function ensureWritingInstalled() {
  const indexPath = path.join(os.homedir(), '.kdna', 'index.json');
  if (!fs.existsSync(indexPath)) return false;
  try {
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    const asset = index.packages?.['@aikdna/writing']?.asset_path;
    return !!asset && fs.existsSync(asset);
  } catch {
    return false;
  }
}

const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-test-'));

function makeIsolatedEnv(prefix = 'kdna-test-home-') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    HOME: home,
    KDNA_HOME: path.join(home, '.kdna'),
  };
}

function ensureIdentity(env) {
  const keyPath = path.join(env.KDNA_HOME, 'identity', 'kdna.key');
  if (fs.existsSync(keyPath)) return;
  const r = run(['identity', 'init'], { env });
  assert.ok(r.ok, `identity init failed: ${r.stderr || r.stdout}`);
}

// ─── kdna help — v0.12+ commands ──────────────────────────────────────

test('legacy help mentions doctor', () => {
  const r = run(['help', 'legacy']);
  assert.ok(r.ok, `help failed: ${r.stderr}`);
  assert.match(r.stdout, /doctor/);
});

test('legacy help mentions trace', () => {
  const r = run(['help', 'legacy']);
  assert.match(r.stdout, /trace/);
});

test('legacy help mentions history', () => {
  const r = run(['help', 'legacy']);
  assert.match(r.stdout, /history/);
});

test('legacy help mentions license', () => {
  const r = run(['help', 'legacy']);
  assert.match(r.stdout, /\blicense\b/);
});

// ─── kdna doctor ───────────────────────────────────────────────────────

test('kdna doctor exits 0', () => {
  const r = run(['doctor']);
  assert.ok(r.ok, `doctor failed: ${r.stderr || r.stdout}`);
});

test('kdna doctor --agents outputs agent names', () => {
  const r = run(['doctor', '--agents']);
  assert.ok(r.ok, `doctor --agents failed: ${r.stderr || r.stdout}`);
  assert.match(r.stdout, /OpenCode|Codex|Claude|Cursor|Gemini/);
});

test('kdna doctor --agents --json returns parseable JSON', () => {
  const r = run(['doctor', '--agents', '--json']);
  assert.ok(r.ok);
  const parsed = JSON.parse(r.stdout);
  assert.ok(Array.isArray(parsed.checks), 'checks should be array');
  assert.ok(
    parsed.checks.some((c) => c.agent),
    'at least one agent check',
  );
  assert.ok(
    parsed.checks.some((c) => c.skillInstalled !== undefined),
    'skillInstalled field present',
  );
});

test('kdna doctor --json reports healthy', () => {
  const r = run(['doctor', '--json']);
  assert.ok(r.ok);
  const parsed = JSON.parse(r.stdout);
  assert.ok('healthy' in parsed);
  assert.ok('ok' in parsed);
  assert.ok('failures' in parsed);
});

test('kdna doctor --domains reports installed .kdna assets', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-doctor-home-'));
  const kdnaHome = path.join(home, '.kdna');
  const assetPath = path.join(
    kdnaHome,
    'packages',
    '@aikdna',
    'writing',
    '0.1.0',
    'writing-0.1.0.kdna',
  );
  fs.mkdirSync(path.dirname(assetPath), { recursive: true });
  fs.writeFileSync(assetPath, 'placeholder');
  fs.writeFileSync(
    path.join(kdnaHome, 'index.json'),
    JSON.stringify({ version: 1, packages: { '@aikdna/writing': { asset_path: assetPath } } }),
  );

  const r = run(['doctor', '--domains', '--json'], {
    env: { HOME: home, KDNA_HOME: kdnaHome },
  });
  assert.ok(r.ok, `doctor --domains failed: ${r.stderr || r.stdout}`);

  const parsed = JSON.parse(r.stdout);
  const installed = parsed.checks.find((check) => check.name === 'Installed assets');
  assert.equal(installed.detail, '1 .kdna asset installed');
});

// ─── kdna trace ────────────────────────────────────────────────────────

test('kdna trace exits 0 with no entries', () => {
  const r = run(['trace', '--clear']);
  assert.ok(r.ok, `trace --clear failed: ${r.stderr}`);
  const r2 = run(['trace']);
  assert.ok(r2.ok, `trace read failed: ${r2.stderr}`);
  assert.match(r2.stdout, /No trace entries|entries total/);
});

test('kdna trace --json returns valid JSON array', () => {
  const r = run(['trace', '--json']);
  assert.ok(r.ok);
  const parsed = JSON.parse(r.stdout);
  assert.ok('entries' in parsed);
  assert.ok(Array.isArray(parsed.entries));
  assert.ok('count' in parsed);
});

test('kdna trace generates entry on kdna load', { skip: !ensureWritingInstalled() }, () => {
  run(['trace', '--clear']);
  const load = run(['load', '@aikdna/writing', '--as=json']);
  assert.ok(load.ok, `load failed: ${load.stderr}`);
  const trace = run(['trace', '--json']);
  assert.ok(trace.ok);
  const parsed = JSON.parse(trace.stdout);
  assert.ok(parsed.entries.length >= 1, 'should have at least one trace entry');
  const entry = parsed.entries[0];
  assert.equal(entry.domain, '@aikdna/writing');
  assert.ok(entry.timestamp);
});

test('kdna trace --export writes file', () => {
  const outPath = path.join(TMPDIR, 'trace-export.json');
  const r = run(['trace', '--export', outPath]);
  assert.ok(r.ok, `trace --export failed: ${r.stderr}`);
  const data = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.ok('entries' in data);
  fs.unlinkSync(outPath);
});

// ─── kdna history ──────────────────────────────────────────────────────

test('kdna history exits 0', () => {
  const r = run(['history']);
  assert.ok(r.ok, `history failed: ${r.stderr}`);
});

test('kdna history --stats outputs domain counts', { skip: !ensureWritingInstalled() }, () => {
  const r = run(['history', '--stats']);
  assert.ok(r.ok, `history --stats failed: ${r.stderr}`);
  assert.match(r.stdout, /Total KDNA loads/);
  assert.match(r.stdout, /By domain/);
});

test('kdna history --json returns parseable', () => {
  const r = run(['history', '--json']);
  assert.ok(r.ok);
  const parsed = JSON.parse(r.stdout);
  assert.ok('entries' in parsed);
  assert.ok('total' in parsed);
});

// ─── kdna license ──────────────────────────────────────────────────────

test('kdna license generate requires domain', () => {
  const r = run(['license', 'generate']);
  assert.ok(!r.ok);
  assert.match(r.stderr, /Usage/);
});

test('kdna license generate creates valid JSON', () => {
  const env = makeIsolatedEnv();
  ensureIdentity(env);
  const outPath = path.join(TMPDIR, 'test-license.json');
  const r = run(
    ['license', 'generate', '@aikdna/test', '--to', 'test@test.com', '--save', outPath],
    { env },
  );
  assert.ok(r.ok, `license generate failed: ${r.stderr}`);
  const lic = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.equal(lic.domain, '@aikdna/test');
  assert.equal(lic.issued_to, 'test@test.com');
  assert.ok(lic.license_id);
  assert.ok(lic.signature);
  assert.ok(lic.signature.startsWith('ed25519:'));
  fs.unlinkSync(outPath);
});

test('kdna license bind adds machine fingerprint', () => {
  const env = makeIsolatedEnv();
  ensureIdentity(env);
  const outPath = path.join(TMPDIR, 'test-lic-bind.json');
  run(['license', 'generate', '@aikdna/test', '--to', 't@t.com', '--save', outPath], { env });
  const r = run(['license', 'bind', outPath], { env });
  assert.ok(r.ok, `license bind failed: ${r.stderr}`);
  const lic = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.ok(lic.machine_fingerprint);
  assert.ok(lic.bound_at);
  assert.ok(lic.signature); // re-signed after binding
  fs.unlinkSync(outPath);
});

test('kdna license verify reports valid', () => {
  const env = makeIsolatedEnv();
  ensureIdentity(env);
  const outPath = path.join(TMPDIR, 'test-lic-verify.json');
  run(['license', 'generate', '@aikdna/test', '--to', 't@t.com', '--save', outPath], { env });
  run(['license', 'bind', outPath], { env });
  const r = run(['license', 'verify', outPath], { env });
  assert.ok(r.ok, `license verify should pass: ${r.stderr}`);
  assert.match(r.stdout, /License valid/);
  fs.unlinkSync(outPath);
});

test('kdna license verify --json returns parseable', () => {
  const env = makeIsolatedEnv();
  ensureIdentity(env);
  const outPath = path.join(TMPDIR, 'test-lic-vj.json');
  run(['license', 'generate', '@aikdna/test', '--to', 't@t.com', '--save', outPath], { env });
  run(['license', 'bind', outPath], { env });
  const r = run(['license', 'verify', '--json', outPath], { env });
  assert.ok(r.ok);
  const parsed = JSON.parse(r.stdout);
  assert.ok('license_id' in parsed);
  assert.ok('valid' in parsed);
  assert.equal(parsed.valid, true);
  fs.unlinkSync(outPath);
});

test('kdna license install registers to ~/.kdna/licenses/', () => {
  const env = makeIsolatedEnv('kdna-license-home-');
  const kdnaHome = env.KDNA_HOME;
  ensureIdentity(env);
  const outPath = path.join(TMPDIR, 'test-lic-install.json');
  run(['license', 'generate', '@aikdna/test', '--to', 't@t.com', '--save', outPath], { env });
  run(['license', 'bind', outPath], { env });
  const r = run(['license', 'install', outPath], { env });
  assert.ok(r.ok, `license install failed: ${r.stderr}`);
  assert.match(r.stdout, /License installed/);
  // Verify file exists
  const licDir = path.join(kdnaHome, 'licenses');
  const installed = path.join(licDir, 'aikdna-test.json');
  assert.ok(fs.existsSync(installed), 'license file should exist');
  const status = run(['license', 'status', '@aikdna/test', '--json'], { env });
  assert.ok(status.ok, `license status failed: ${status.stderr}`);
  const parsed = JSON.parse(status.stdout);
  assert.equal(parsed.domain, '@aikdna/test');
  assert.equal(parsed.valid, true);
  assert.equal(parsed.machine_bound, true);
  assert.ok(!JSON.stringify(parsed).includes('license_key'));
  fs.unlinkSync(installed);
  fs.unlinkSync(outPath);
});

test('kdna license activate and sync enforce entitlement revocation', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-license-activate-home-'));
  const kdnaHome = path.join(home, '.kdna');
  const env = { HOME: home, KDNA_HOME: kdnaHome };
  const key = 'KDNA-LIC-ACTIVATE-TEST';
  const serverPath = path.join(TMPDIR, 'activation-source.json');
  fs.writeFileSync(
    serverPath,
    JSON.stringify(
      {
        activations: [
          {
            domain: '@aikdna/pro',
            license_key: key,
            license_id: 'lic_activate_test',
            issued_to: 'buyer@example.com',
            require_machine_binding: true,
            require_online_check: true,
            offline_grace_days: 3,
            status: 'active',
          },
        ],
      },
      null,
      2,
    ),
  );

  const activate = run(
    [
      'license',
      'activate',
      '@aikdna/pro',
      '--key',
      key,
      '--server',
      `file://${serverPath}`,
      '--json',
    ],
    { env },
  );
  assert.ok(activate.ok, `license activate failed: ${activate.stderr}`);
  const activated = JSON.parse(activate.stdout);
  assert.equal(activated.domain, '@aikdna/pro');
  assert.equal(activated.valid, true);
  assert.ok(!activate.stdout.includes(key));

  const status = run(['license', 'status', '@aikdna/pro', '--json'], { env });
  assert.ok(status.ok, `license status failed: ${status.stderr}`);
  const statusJson = JSON.parse(status.stdout);
  assert.equal(statusJson.license_id, 'lic_activate_test');
  assert.equal(statusJson.valid, true);

  fs.writeFileSync(
    serverPath,
    JSON.stringify(
      {
        activations: [
          {
            domain: '@aikdna/pro',
            license_key: key,
            license_id: 'lic_activate_test',
            issued_to: 'buyer@example.com',
            require_machine_binding: true,
            require_online_check: true,
            offline_grace_days: 3,
            status: 'revoked',
            revoked: true,
          },
        ],
      },
      null,
      2,
    ),
  );
  const sync = run(
    ['license', 'sync', '@aikdna/pro', '--server', `file://${serverPath}`, '--json'],
    { env },
  );
  assert.ok(sync.ok, `license sync failed: ${sync.stderr}`);
  const synced = JSON.parse(sync.stdout);
  assert.equal(synced.synced, true);
  assert.equal(synced.valid, false);
  assert.ok(synced.issues.includes('License has been revoked'));
  assert.ok(!sync.stdout.includes(key));

  const trace = run(['trace', '--json'], { env });
  assert.ok(trace.ok, `trace failed: ${trace.stderr}`);
  const traceJson = JSON.parse(trace.stdout);
  const licenseEvents = traceJson.entries.filter((entry) => entry.event === 'license');
  assert.ok(
    licenseEvents.some(
      (entry) => entry.action === 'activate' && entry.license_id === 'lic_activate_test',
    ),
    `expected activation trace, got ${trace.stdout}`,
  );
  assert.ok(
    licenseEvents.some(
      (entry) => entry.action === 'sync' && entry.revoked === true && entry.valid === false,
    ),
    `expected revoked sync trace, got ${trace.stdout}`,
  );
  assert.ok(!trace.stdout.includes(key));

  const expiredPath = path.join(kdnaHome, 'licenses', 'aikdna-expired.json');
  fs.writeFileSync(
    expiredPath,
    JSON.stringify(
      {
        version: '1.0',
        domain: '@aikdna/expired',
        license_id: 'lic_expired_grace',
        license_key: 'KDNA-LIC-EXPIRED',
        status: 'active',
        require_machine_binding: true,
        machine_fingerprint: machineFingerprint(),
        require_online_check: true,
        offline_valid_until: '2000-01-01T00:00:00.000Z',
      },
      null,
      2,
    ),
  );
  const expired = run(['license', 'status', '@aikdna/expired', '--json'], { env });
  assert.ok(expired.ok, `expired license status failed: ${expired.stderr}`);
  const expiredJson = JSON.parse(expired.stdout);
  assert.equal(expiredJson.valid, false);
  assert.ok(expiredJson.issues.includes('License offline grace has expired'));
});

test('kdna license without subcommand shows usage', () => {
  const r = run(['license']);
  assert.ok(!r.ok);
  assert.match(r.stderr, /Usage/);
});

// ─── kdna compare report ───────────────────────────────────────────────

test('kdna compare --report-md requires --input', () => {
  const r = run(['compare', '@aikdna/writing', '--report-md']);
  assert.ok(!r.ok);
  assert.match(r.stderr, /--input/);
});

test('kdna compare --report-json requires --input', () => {
  const r = run(['compare', '@aikdna/writing', '--report-json']);
  assert.ok(!r.ok);
  assert.match(r.stderr, /--input/);
});

// ─── Cleanup ───────────────────────────────────────────────────────────

test('cleanup trace data', () => {
  run(['trace', '--clear']);
  const r = run(['trace', '--json']);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.entries.length, 0);
});

// Clean temp files
process.on('exit', () => {
  fs.rmSync(TMPDIR, { recursive: true, force: true });
});
