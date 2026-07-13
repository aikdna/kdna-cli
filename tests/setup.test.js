const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cli = path.resolve(__dirname, '..', 'src', 'cli.js');
const bundled = fs.readFileSync(
  path.resolve(__dirname, '..', 'skills', 'kdna-loader', 'SKILL.md'),
  'utf8',
);

function run(home, args) {
  return spawnSync(process.execPath, [cli, 'setup', ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, KDNA_HOME: path.join(home, '.kdna') },
  });
}

test('setup installs the bundled loader and preserves user customization by default', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-setup-'));
  try {
    fs.mkdirSync(path.join(home, '.codex'));
    const skill = path.join(home, '.codex', 'skills', 'kdna-loader', 'SKILL.md');

    const first = run(home, []);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(fs.readFileSync(skill, 'utf8'), bundled);

    const customized = `${bundled}\n<!-- local customization -->\n`;
    fs.writeFileSync(skill, customized);
    const second = run(home, []);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(fs.readFileSync(skill, 'utf8'), customized);
    assert.match(second.stdout, /Preserved customized kdna-loader/);

    const forced = run(home, ['--force']);
    assert.equal(forced.status, 0, forced.stderr);
    assert.equal(fs.readFileSync(skill, 'utf8'), bundled);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('setup --help has no filesystem side effects', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-setup-help-'));
  try {
    const result = run(home, ['--help']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage: kdna setup \[--force\]/);
    assert.equal(fs.existsSync(path.join(home, '.kdna')), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
