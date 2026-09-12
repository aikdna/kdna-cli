'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const CLI = path.resolve(__dirname, '..', 'src', 'cli.js');
const BUNDLED_SKILL = path.resolve(__dirname, '..', 'skills', 'kdna-loader', 'SKILL.md');
const PACKAGE_VERSION = require('../package.json').version;

test('doctor reports the bundled loader skill with its actual SemVer coordinate', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-doctor-skill-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const skillDir = path.join(home, '.codex', 'skills', 'kdna-loader');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.copyFileSync(BUNDLED_SKILL, path.join(skillDir, 'SKILL.md'));

  const result = spawnSync(process.execPath, [CLI, 'doctor', '--agents', '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      KDNA_HOME: path.join(home, '.kdna'),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  const codex = report.checks.find((check) => check.agent === 'Codex');
  assert.ok(codex, 'Codex integration check must be present');
  assert.equal(codex.status, 'ok');
  assert.equal(codex.skillInstalled, true);
  assert.equal(codex.skillVersion, PACKAGE_VERSION);
  assert.match(codex.skillVersion, /^\d+\.\d+\.\d+$/);
  assert.equal(codex.detail, `kdna-loader installed (${PACKAGE_VERSION})`);
});
