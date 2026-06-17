const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const cliBin = path.join(__dirname, '..', 'src', 'cli.js');

function run(args) {
  return spawnSync(process.execPath, [cliBin, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('demo minimal creates fixture in empty dir', () => {
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'kdna-demo-'));
  const target = path.join(tmp, 'minimal');
  const r = run(['demo', 'minimal', target]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(target, 'mimetype')));
  assert.ok(fs.existsSync(path.join(target, 'kdna.json')));
  assert.ok(fs.existsSync(path.join(target, 'payload.kdnab')));
  assert.ok(fs.existsSync(path.join(target, 'checksums.json')));
  assert.match(r.stdout, /Next:/);
  assert.match(r.stdout, /kdna inspect/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('demo minimal with existing non-empty dir fails without --force', () => {
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'kdna-demo-'));
  const target = path.join(tmp, 'minimal');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'test.txt'), 'x');
  const r = run(['demo', 'minimal', target]);
  assert.notEqual(r.status, 0, 'should fail on existing non-empty dir');
  assert.match(r.stderr, /already exists/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('demo minimal with --force overwrites existing non-empty dir', () => {
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'kdna-demo-'));
  const target = path.join(tmp, 'minimal');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'test.txt'), 'x');
  const r = run(['demo', 'minimal', target, '--force']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(target, 'mimetype')));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('demo minimal fixture validates with v1 route', () => {
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'kdna-demo-'));
  const target = path.join(tmp, 'minimal');
  run(['demo', 'minimal', target]);
  const r = run(['validate', target]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.overall_valid, true);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('demo minimal fixture packs deterministically', () => {
  const crypto = require('node:crypto');
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'kdna-demo-'));
  const target = path.join(tmp, 'minimal');
  run(['demo', 'minimal', target]);
  const a = path.join(tmp, 'a.kdna');
  const b = path.join(tmp, 'b.kdna');
  run(['pack', target, a]);
  run(['pack', target, b]);
  const ha = crypto.createHash('sha256').update(fs.readFileSync(a)).digest('hex');
  const hb = crypto.createHash('sha256').update(fs.readFileSync(b)).digest('hex');
  assert.equal(ha, hb);
  assert.equal(ha, 'dad166e23c5c13be1f9d11829d102498a20ed11e7664ce427cc56bee4d38f59e');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('demo minimal works from /tmp', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'kdna-demo-'));
  const r = run(['demo', 'minimal', dir]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(dir, 'mimetype')));
  fs.rmSync(dir, { recursive: true, force: true });
});
