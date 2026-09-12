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
  const obsoleteProjectionRoute = ['/', 'v1', '/project'].join('');
  fs.writeFileSync(path.join(root, 'src', 'runner.js'), `const type = '${obsoleteCapsuleType}';\n`);
  fs.writeFileSync(
    path.join(root, 'README.md'),
    `Use ${duplicateRoute} for compatibility at ${obsoleteProjectionRoute}.\n`,
  );
  fs.writeFileSync(
    path.join(root, 'CONTRIBUTING.md'),
    `Do not restore ${['v', '3'].join('')} support.\n`,
  );

  const issues = scanCurrentProtocolNames(root);
  assert.ok(issues.some((issue) => issue.rule === 'obsolete shipped implementation'));
  assert.ok(issues.some((issue) => issue.rule === 'obsolete Capsule type'));
  assert.ok(issues.some((issue) => issue.rule === 'duplicate loading route'));
  assert.ok(issues.some((issue) => issue.rule === 'obsolete remote projection route'));
  assert.ok(issues.some((issue) => issue.rule === 'generation label before a KDNA-owned concept'));
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
      `const placeholder = '<${['v', '2'].join('')}>';`,
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(root, 'tests', 'protocol.test.js'),
    [
      `const singularAfter = '${['index', ['v', '8'].join('')].join(' ')}';`,
      `const pluralAfter = '${['indexes', ['v', '7'].join('')].join(' ')}';`,
      `const singularBefore = '${[['v', '6'].join(''), 'index'].join(' ')}';`,
      `const record = '${['record', ['v', '5'].join('')].join(' ')}';`,
      `const fixture = '${[['v', '4'].join(''), 'fixture'].join(' ')}';`,
    ].join('\n'),
  );

  const issues = scanCurrentProtocolNames(root);
  assert.ok(issues.some((issue) => issue.rule === 'generation suffix on a KDNA-owned name'));
  assert.ok(
    issues.filter((issue) => issue.rule === 'generation label after a KDNA-owned concept').length >=
      3,
  );
  assert.ok(
    issues.filter((issue) => issue.rule === 'generation label before a KDNA-owned concept')
      .length >= 2,
  );
  assert.ok(
    issues.some((issue) => issue.rule === 'generation encoded in an implementation identifier'),
  );
  assert.ok(issues.some((issue) => issue.rule === 'generation-style version placeholder'));
});

test('naming gate rejects explicit responsibility generations in text and paths', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-protocol-semantic-generation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const unicodeHyphen = String.fromCodePoint(0x2010);
  const generations = [
    ['Runtime', 'contract', '7'].join(' '),
    [['Runtime', 'Contract'].join(' '), '(7)'].join(' '),
    ['Agent', 'Host', '4'].join('+'),
    ['Judgment', 'Trace', '9'].join('/'),
    ['Runtime', 'Capsule', '3'].join(unicodeHyphen),
    ['Runtime', 'Contract', '7'].join(''),
    [['Runtime', 'Contract'].join(''), '7'].join('/'),
    ['Capsule', '7'].join(''),
    ['Agent', 'Host', '4'].join(''),
    ['Judgment', 'Trace', '9'].join(''),
    ['Runtime', 'Contract', 'V', '7'].join(''),
    ['Judgment', 'Trace', 'V', '9'].join(''),
    ['Agent', 'Host', 'V', '4'].join(''),
    ['Capsule', 'V', '3'].join(''),
    [['Runtime', 'contract'].join(' '), ['v', ['0', '1', '0'].join('.')].join('')].join(' '),
  ];
  fs.writeFileSync(path.join(root, 'README.md'), `${generations.join('\n')}\n`);
  const generatedPaths = [
    ['runtime', 'contract', '7'],
    ['runtime', 'contract', ['v', '7'].join('')],
    ['agent', 'host', '4'],
    ['judgment', 'trace', '9'],
  ];
  for (const segments of generatedPaths) {
    const file = path.join(root, 'src', ...segments);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'module.exports = {};\n');
  }

  const issues = scanCurrentProtocolNames(root).filter(
    (issue) => issue.rule === 'generation on a KDNA responsibility',
  );
  assert.equal(issues.filter((issue) => issue.file === 'README.md').length, generations.length);
  for (const segments of generatedPaths) {
    const relative = path.posix.join('src', ...segments);
    assert.ok(issues.some((issue) => issue.file === relative && issue.line === null));
  }
});

test('naming gate accepts counts, natural coordinates, and third-party action releases', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-protocol-allowed-versions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
  const coordinate = ['0', '1', '0'].join('.');
  fs.writeFileSync(
    path.join(root, 'README.md'),
    [
      `Runtime contract ${coordinate}`,
      `Runtime Capsule ${coordinate}`,
      `Agent Host ${coordinate}`,
      `Judgment Trace ${coordinate}`,
      'Runtime contract: 7 required fields',
      'Runtime contract has 7',
      ['Trace', 'Event', '7'].join(''),
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(root, '.github', 'workflows', 'ci.yml'),
    `steps:\n  - uses: actions/setup-node@${['v', '6'].join('')}\n`,
  );

  assert.deepEqual(scanCurrentProtocolNames(root), []);
});

test('source naming gate rejects an injected generation while exact package allowlist excludes it', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-protocol-packed-path-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(root, 'package.json'));
  fs.copyFileSync(
    path.join(ROOT, 'scripts', 'download-trusted-npm.js'),
    path.join(root, 'scripts', 'download-trusted-npm.js'),
  );
  const injectedSegments = ['templates', 'agent', 'host', ['v', '4'].join('')];
  const injectedFile = path.join(root, ...injectedSegments);
  fs.mkdirSync(path.dirname(injectedFile), { recursive: true });
  fs.writeFileSync(injectedFile, 'packed path probe\n');

  const expected = path.posix.join(...injectedSegments);
  const sourceIssues = scanCurrentProtocolNames(root);
  assert.ok(
    sourceIssues.some(
      (issue) =>
        issue.file === expected &&
        issue.line === null &&
        issue.rule === 'generation on a KDNA responsibility',
    ),
  );
  assert.deepEqual(scanPackedArtifact(root), []);
});
