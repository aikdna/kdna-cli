'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  scanCurrentProtocolNames,
  scanPackedArtifact,
} = require('../scripts/check-current-protocol-names');

const ROOT = path.resolve(__dirname, '..');

test('shipped surfaces contain only current protocol names', () => {
  assert.deepEqual(scanCurrentProtocolNames(ROOT), []);
  assert.deepEqual(scanPackedArtifact(ROOT), []);
});

test('naming gate rejects obsolete declarations and implementations', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-protocol-names-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const obsoleteCapsuleType = ['kdna', 'context', 'capsule'].join('.');
  const duplicateRoute = ['quality', 'load'].join(' ');
  fs.writeFileSync(path.join(root, 'src', 'runner.js'), `const type = '${obsoleteCapsuleType}';\n`);
  fs.writeFileSync(path.join(root, 'README.md'), `Use ${duplicateRoute} for compatibility.\n`);

  const issues = scanCurrentProtocolNames(root);
  assert.ok(issues.some((issue) => issue.rule === 'obsolete shipped implementation'));
  assert.ok(issues.some((issue) => issue.rule === 'obsolete Capsule type'));
  assert.ok(issues.some((issue) => issue.rule === 'duplicate loading route'));
});

test('naming gate rejects unknown generation labels without a token allowlist', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-protocol-generation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  const generation = ['v', '3'].join('');
  const suffix = ['v', '9'].join('');
  fs.writeFileSync(
    path.join(root, 'src', 'protocol.js'),
    [
      `const profile = '${['kdna', 'unknown', suffix].join('-')}';`,
      `const registry = '${['Registry', generation].join(' ')}';`,
      `const detector = '${['is', 'V', '4'].join('')}';`,
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(root, 'tests', 'protocol.test.js'),
    `const note = '${[['v', '8'].join(''), 'indexes'].join(' ')}';\n`,
  );

  const issues = scanCurrentProtocolNames(root);
  assert.ok(issues.some((issue) => issue.rule === 'generation suffix on a KDNA-owned name'));
  assert.ok(issues.some((issue) => issue.rule === 'generation label after a KDNA-owned concept'));
  assert.ok(issues.some((issue) => issue.rule === 'generation label before a KDNA-owned concept'));
  assert.ok(
    issues.some((issue) => issue.rule === 'generation encoded in an implementation identifier'),
  );
});
