'use strict';
/*
 * Reverse cases for scripts/check-packaged-readme.js.
 *
 * The gate exists because the README inside a published tarball is immutable
 * while the publication state it described is not: this package's served 0.43.0
 * tarball carries a README that names 0.42.0 as the published coordinate and
 * calls 0.43.0 an unpublished next candidate. Each refused pattern gets a case
 * here, the exact served text is kept as a regression fixture, and the
 * published path is exercised against synthetic archives so the archive member
 * is really extracted rather than assumed.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const {
  STATE_CLAIM_PATTERNS,
  checkPublished,
  checkSource,
  evaluatePackagedReadme,
  readPackedMember,
} = require('../scripts/check-packaged-readme.js');

const root = path.resolve(__dirname, '..');
const readText = (file) => fs.readFileSync(file, 'utf8');

// The README bytes the registry served inside @aikdna/kdna-cli@0.43.0. Kept
// verbatim as the regression fixture for this gate.
const PUBLISHED_CLI_0_43_0_README = [
  '# KDNA CLI 0.43.0',
  '',
  '`0.42.0` is published on `latest` with exact Core `0.37.6` and Read `0.13.0`. Earlier `native-preview` releases retain their own artifacts and locks. The current source carries the next candidate `0.43.0` with exact Core `0.37.7` and Read `0.13.1`; it is not yet published, and until its own release and registry verification complete this page keeps naming the published combination.',
  '',
  '| Operation | Current candidate command | Explicit permission |',
  '',
].join('\n');

function tarEntry(name, text) {
  const body = Buffer.from(text, 'utf8');
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'utf8');
  header.write('0000000\0', 108, 8, 'utf8');
  header.write('0000000\0', 116, 8, 'utf8');
  header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'utf8');
  header.write('00000000000\0', 136, 12, 'utf8');
  header.write('        ', 148, 8, 'utf8');
  header.write('0', 156, 1, 'utf8');
  header.write('ustar\0' + '00', 257, 8, 'utf8');
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([header, body, padding]);
}

function packedTarball(members) {
  return zlib.gzipSync(
    Buffer.concat([...members.map(([name, text]) => tarEntry(name, text)), Buffer.alloc(1024)]),
  );
}

test('the in-repository packaged README names its own version and states no publication status', () => {
  assert.deepEqual(checkSource(root, readText), []);
});

test('the tarball text actually served for CLI 0.43.0 is rejected', () => {
  const findings = evaluatePackagedReadme({
    readme: PUBLISHED_CLI_0_43_0_README,
    version: '0.43.0',
    label: 'fixture',
  });
  assert.deepEqual(
    findings.filter((finding) => finding.rule === 'identity'),
    [],
    'the served text does name its own version; the defect is the state claim',
  );
  for (const phrase of [
    'latest',
    'not yet published',
    'next candidate',
    'Current candidate',
    'carries the next',
    'published on',
  ]) {
    assert.ok(
      findings.some(
        (finding) => finding.rule === 'publication-state' && finding.detail.includes(phrase),
      ),
      `the gate must refuse "${phrase}"`,
    );
  }
});

for (const [pattern, reason] of STATE_CLAIM_PATTERNS) {
  test(`refuses a packaged README that states "${pattern.source}"`, () => {
    const literal = pattern.source.replaceAll('\\b', '');
    const readme = `# Sample\n\nPackage \`1.2.3\`.\n\nOne sentence states ${literal} here.\n`;
    const findings = evaluatePackagedReadme({ readme, version: '1.2.3', label: 'sample' });
    assert.deepEqual(findings, [
      {
        rule: 'publication-state',
        label: 'sample',
        detail: `states "${literal}": ${reason}`,
      },
    ]);
  });
}

test('refuses a packaged README that never names its own version', () => {
  const findings = evaluatePackagedReadme({
    readme: '# KDNA CLI\n\nThe 0.42.0 archive remains installable.\n',
    version: '0.43.0',
    label: 'README.md',
  });
  assert.deepEqual(findings, [
    {
      rule: 'identity',
      label: 'README.md',
      detail: 'does not name its own version 0.43.0',
    },
  ]);
});

test('a longer number does not satisfy the identity rule', () => {
  const findings = evaluatePackagedReadme({
    readme: 'Coordinates `10.43.0` and `0.43.01` are different numbers.\n',
    version: '0.43.0',
    label: 'README.md',
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'identity');
});

test('the packed README member is extracted from the real archive layout', () => {
  const archive = packedTarball([
    ['package/package.json', '{"name":"@aikdna/kdna-cli","version":"0.43.0"}'],
    ['package/README.md', '# KDNA CLI 0.43.0\n'],
    ['package/NOTICE', 'notice\n'],
  ]);
  const bytes = readPackedMember(zlib.gunzipSync(archive), 'package/README.md');
  assert.equal(bytes, '# KDNA CLI 0.43.0\n');
  assert.equal(readPackedMember(zlib.gunzipSync(archive), 'package/CHANGELOG.md'), null);
});

test('published mode reads the served tarball it is given', async () => {
  const responses = new Map([
    [
      'https://registry.npmjs.org/@aikdna%2Fkdna-cli',
      Buffer.from(
        JSON.stringify({
          'dist-tags': { latest: '0.43.0' },
          versions: { '0.43.0': { dist: { tarball: 'https://registry.test/cli-0.43.0.tgz' } } },
        }),
      ),
    ],
    [
      'https://registry.test/cli-0.43.0.tgz',
      packedTarball([['package/README.md', '# KDNA CLI 0.43.0\n\nPackage `0.43.0`.\n']]),
    ],
  ]);
  const clean = await checkPublished(root, readText, {
    fetchBytes: async (url) => responses.get(url),
  });
  assert.equal(clean.served, '0.43.0');
  assert.deepEqual(clean.findings, []);

  const stale = await checkPublished(root, readText, {
    fetchBytes: async (url) =>
      url.endsWith('.tgz')
        ? packedTarball([['package/README.md', PUBLISHED_CLI_0_43_0_README]])
        : responses.get(url),
  });
  assert.equal(stale.findings.filter((finding) => finding.rule === 'publication-state').length, 6);

  const unreadable = await checkPublished(root, readText, {
    fetchBytes: async () => {
      throw new Error('HTTP 404');
    },
  });
  assert.deepEqual(unreadable.findings, [
    { rule: 'published', label: '@aikdna/kdna-cli', detail: 'unreadable: HTTP 404' },
  ]);
});
