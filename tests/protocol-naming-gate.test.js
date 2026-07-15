'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { scanCurrentProtocolNames } = require('../scripts/check-current-protocol-names');

const ROOT = path.resolve(__dirname, '..');

test('shipped surfaces contain only current protocol names', () => {
  assert.deepEqual(scanCurrentProtocolNames(ROOT), []);
});

test('naming gate rejects obsolete declarations and implementations', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-protocol-names-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'runner.js'), "const type = 'kdna.context.capsule';\n");
  fs.writeFileSync(path.join(root, 'README.md'), 'Use quality load for compatibility.\n');

  const issues = scanCurrentProtocolNames(root);
  assert.ok(issues.some((issue) => issue.rule === 'obsolete shipped implementation'));
  assert.ok(issues.some((issue) => issue.rule === 'obsolete Capsule type'));
  assert.ok(issues.some((issue) => issue.rule === 'duplicate loading route'));
});
