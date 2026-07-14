'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const zlib = require('node:zlib');
const core = require('@aikdna/kdna-core');
const { downloadVersion: downloadForDiff, loadJudgment } = require('../src/diff');
const { downloadVersion: downloadForChangelog } = require('../src/cmds/changelog');
const { extractKdnaArchive } = require('../src/safe-archive');

const cli = path.join(__dirname, '..', 'src', 'cli.js');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function zipExtra(id, data = Buffer.alloc(0)) {
  const extra = Buffer.alloc(4 + data.length);
  extra.writeUInt16LE(id, 0);
  extra.writeUInt16LE(data.length, 2);
  data.copy(extra, 4);
  return extra;
}

function buildStoredZip(entries) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.isBuffer(entry.name) ? entry.name : Buffer.from(entry.name, 'utf8');
    const localName = entry.localName
      ? Buffer.isBuffer(entry.localName)
        ? entry.localName
        : Buffer.from(entry.localName, 'utf8')
      : name;
    const data = Buffer.from(entry.data || '');
    const extra = entry.extra || Buffer.alloc(0);
    const localExtra = entry.localExtra || extra;
    const flags = entry.flags || 0;
    const method = entry.method || 0;
    const compressed = method === 8 ? zlib.deflateRawSync(data) : data;
    const crc = entry.crc ?? crc32(data);
    const compressedSize = entry.compressedSize ?? compressed.length;
    const uncompressedSize = entry.uncompressedSize ?? data.length;

    const local = Buffer.alloc(30 + localName.length + localExtra.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressedSize, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(localName.length, 26);
    local.writeUInt16LE(localExtra.length, 28);
    localName.copy(local, 30);
    localExtra.copy(local, 30 + localName.length);
    localChunks.push(local, compressed);

    const central = Buffer.alloc(46 + name.length + extra.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(entry.versionMadeBy || 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressedSize, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE((entry.externalAttributes || 0) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    extra.copy(central, 46 + name.length);
    centralChunks.push(central);
    offset += local.length + compressed.length;
  }

  const centralOffset = offset;
  const centralSize = centralChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([...localChunks, ...centralChunks, eocd]);
}

function maliciousArchive(entry) {
  return buildStoredZip([
    { name: 'mimetype', data: core.MIMETYPE },
    { name: 'kdna.json', data: '{}' },
    { name: 'payload.kdnab', data: '{}' },
    entry,
  ]);
}

function makeValidArchive(tmp) {
  const source = path.join(tmp, 'source');
  fs.cpSync(path.join(__dirname, '..', 'fixtures', 'v1-judgment'), source, {
    recursive: true,
  });
  fs.mkdirSync(path.join(source, 'attachments'));
  fs.writeFileSync(path.join(source, 'attachments', '判断-é.txt'), 'portable UTF-8 entry');
  const archive = path.join(tmp, 'valid.kdna');
  core.pack(source, archive);
  return archive;
}

function makeHistoricalArchive(output, version, axiomText) {
  const entries = [
    { name: 'mimetype', data: 'application/vnd.aikdna.kdna+zip' },
    {
      name: 'KDNA_Core.json',
      method: 8,
      data: JSON.stringify({
        axioms: [{ id: 'judgment-core', one_sentence: axiomText }],
        ontology: [],
        stances: [],
      }),
    },
    {
      name: 'KDNA_Patterns.json',
      method: 8,
      data: JSON.stringify({ misunderstandings: [], terminology: { banned_terms: [] } }),
    },
    {
      name: 'kdna.json',
      method: 8,
      data: JSON.stringify({ version, judgment_version: version }),
    },
  ];
  fs.writeFileSync(output, buildStoredZip(entries));
  return output;
}

function writeRegistryHome(entries) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-archive-registry-'));
  const registryDir = path.join(home, '.kdna', 'registry');
  fs.mkdirSync(registryDir, { recursive: true });
  fs.writeFileSync(
    path.join(registryDir, 'domains.json'),
    JSON.stringify({
      schema_version: '3.0',
      registry_version: '3.0.0-archive-test',
      trust: {
        model: 'kdna-registry-v1',
        snapshot: {
          registry_version: '3.0.0-archive-test',
          generated_at: '2026-07-15T00:00:00Z',
          expires_at: '2099-01-01T00:00:00Z',
        },
        timestamp: {
          generated_at: '2026-07-15T00:00:00Z',
          expires_at: '2099-01-01T00:00:00Z',
        },
        revocations: [],
      },
      scopes: {
        '@aikdna': {
          type: 'official',
          trust_pubkey: 'ed25519:test',
          verified: true,
        },
      },
      domains: entries,
    }),
  );
  return home;
}

function registryEntry(version, archive) {
  return {
    name: '@aikdna/archive-history',
    type: 'domain',
    version,
    status: 'experimental',
    access: 'open',
    asset_url: pathToFileURL(archive).href,
    asset_digest: `sha256:${version
      .replaceAll(/[^0-9]/g, '')
      .padEnd(64, '0')
      .slice(0, 64)}`,
    signature: 'ed25519:test',
    release_status: 'published_signed',
  };
}

function runCli(args, env) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env, KDNA_REGISTRY_URL: '' },
  });
}

function copyDownloader(source, observedPaths = []) {
  return (_url, output) => {
    observedPaths.push(output);
    fs.copyFileSync(source, output);
  };
}

test('domain unpack accepts shell-significant file names without a shell', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-domain-unpack-'));
  try {
    const source = path.join(tmp, 'source');
    fs.cpSync(path.join(__dirname, '..', 'fixtures', 'v1-judgment'), source, {
      recursive: true,
    });
    const assetPath = path.join(tmp, 'asset-"quoted"-$(printf ignored).kdna');
    core.pack(source, assetPath);

    const result = spawnSync(process.execPath, [cli, 'domain', 'unpack', assetPath], {
      cwd: tmp,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const outputDir = assetPath.slice(0, -'.kdna'.length);
    assert.equal(fs.readFileSync(path.join(outputDir, 'mimetype'), 'utf8'), core.MIMETYPE);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('domain unpack rejects a corrupt container without command evaluation or partial output', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-domain-corrupt-'));
  try {
    const assetPath = path.join(tmp, 'broken-$(touch should-not-exist).kdna');
    fs.writeFileSync(assetPath, 'not a zip');

    const result = spawnSync(process.execPath, [cli, 'domain', 'unpack', assetPath], {
      cwd: tmp,
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(path.join(tmp, 'should-not-exist')), false);
    assert.equal(fs.existsSync(assetPath.slice(0, -'.kdna'.length)), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('downloaded archive preflight rejects path, encoding, collision, and file-type variants', () => {
  const cases = [
    ['parent traversal', { name: '../escape' }],
    ['absolute path', { name: '/absolute' }],
    ['Windows drive path', { name: 'C:/escape' }],
    ['backslash traversal', { name: 'attachments\\..\\escape' }],
    ['encoded traversal', { name: 'attachments/%2e%2e%2fescape' }],
    ['non-NFC name', { name: 'attachments/e\u0301.txt' }],
    ['invalid UTF-8', { name: Buffer.from([0xff]) }],
    ['reserved platform name', { name: 'attachments/CON' }],
    ['platform-ambiguous suffix', { name: 'attachments/file.' }],
    [
      'symbolic link mode',
      {
        name: 'attachments/link',
        versionMadeBy: (3 << 8) | 20,
        externalAttributes: 0o120777 << 16,
      },
    ],
    [
      'directory mode',
      {
        name: 'attachments/directory',
        versionMadeBy: (3 << 8) | 20,
        externalAttributes: 0o040755 << 16,
      },
    ],
    [
      'device mode',
      {
        name: 'attachments/device',
        versionMadeBy: (3 << 8) | 20,
        externalAttributes: 0o060600 << 16,
      },
    ],
    [
      'symlink or hardlink-capable Unix metadata',
      { name: 'attachments/link', extra: zipExtra(0x756e) },
    ],
    ['central/local name mismatch', { name: 'attachments/one', localName: 'attachments/two' }],
  ];

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-archive-negative-'));
  try {
    for (const [label, entry] of cases) {
      const slug = label.replaceAll(/[^A-Za-z0-9]+/g, '-');
      const archive = path.join(tmp, `${slug}.kdna`);
      const destination = path.join(tmp, `${slug}-out`);
      fs.writeFileSync(archive, maliciousArchive(entry));
      assert.throws(() => extractKdnaArchive(archive, destination), /unsafe KDNA archive/, label);
      assert.equal(fs.existsSync(destination), false, label);
    }

    const collisionArchive = path.join(tmp, 'collision.kdna');
    fs.writeFileSync(
      collisionArchive,
      buildStoredZip([
        { name: 'mimetype', data: core.MIMETYPE },
        { name: 'kdna.json', data: '{}' },
        { name: 'payload.kdnab', data: '{}' },
        { name: 'attachments/File.txt' },
        { name: 'attachments/file.txt' },
      ]),
    );
    assert.throws(
      () => extractKdnaArchive(collisionArchive, path.join(tmp, 'collision-out')),
      /platform-colliding entry name/,
    );

    const hierarchyCollision = path.join(tmp, 'hierarchy-collision.kdna');
    fs.writeFileSync(
      hierarchyCollision,
      buildStoredZip([
        { name: 'mimetype', data: core.MIMETYPE },
        { name: 'kdna.json', data: '{}' },
        { name: 'payload.kdnab', data: '{}' },
        { name: 'attachments/node', data: 'file' },
        { name: 'attachments/node/child', data: 'child' },
      ]),
    );
    assert.throws(
      () => extractKdnaArchive(hierarchyCollision, path.join(tmp, 'hierarchy-out')),
      /path conflicts with an ordinary file/,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('downloaded archive verifies actual CRC32, size, and compression limits before writes', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-archive-integrity-'));
  try {
    for (const method of [0, 8]) {
      const data = Buffer.from(`method-${method}-integrity`);
      const archive = path.join(tmp, `bad-crc-${method}.kdna`);
      fs.writeFileSync(
        archive,
        maliciousArchive({
          name: `attachments/bad-crc-${method}.txt`,
          method,
          data,
          crc: (crc32(data) + 1) >>> 0,
        }),
      );
      const destination = path.join(tmp, `bad-crc-${method}-out`);
      assert.throws(
        () => extractKdnaArchive(archive, destination),
        /CRC32 does not match its bytes/,
      );
      assert.equal(fs.existsSync(destination), false);
    }

    const badSize = path.join(tmp, 'bad-size.kdna');
    fs.writeFileSync(
      badSize,
      maliciousArchive({
        name: 'attachments/bad-size.txt',
        method: 8,
        data: 'actual bytes',
        uncompressedSize: Buffer.byteLength('actual bytes') + 1,
      }),
    );
    assert.throws(
      () => extractKdnaArchive(badSize, path.join(tmp, 'bad-size-out')),
      /uncompressed size does not match its bytes/,
    );

    const badRatio = path.join(tmp, 'bad-ratio.kdna');
    fs.writeFileSync(
      badRatio,
      maliciousArchive({
        name: 'attachments/bad-ratio.txt',
        method: 8,
        data: 'tiny',
        uncompressedSize: 1024 * 1024,
      }),
    );
    assert.throws(
      () => extractKdnaArchive(badRatio, path.join(tmp, 'bad-ratio-out')),
      /compression-ratio limit/,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('safe extraction supports current runtime and historical authoring archives', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-archive-compatibility-'));
  try {
    const runtimeArchive = makeValidArchive(tmp);
    const runtimeDestination = path.join(tmp, 'runtime-out');
    extractKdnaArchive(runtimeArchive, runtimeDestination);
    assert.equal(fs.readFileSync(path.join(runtimeDestination, 'mimetype'), 'utf8'), core.MIMETYPE);

    const conformanceArchive = path.resolve(
      __dirname,
      '..',
      '..',
      'kdna',
      'fixtures',
      'test_conformance.kdna',
    );
    const conformanceDestination = path.join(tmp, 'conformance-out');
    extractKdnaArchive(conformanceArchive, conformanceDestination);
    assert.equal(fs.existsSync(path.join(conformanceDestination, 'KDNA_Core.json')), true);
    assert.equal(fs.existsSync(path.join(conformanceDestination, 'KDNA_Patterns.json')), true);

    const generatedArchive = makeHistoricalArchive(
      path.join(tmp, 'historical.kdna'),
      '1.2.3',
      'Historical authoring judgment',
    );
    const generatedDestination = path.join(tmp, 'historical-out');
    extractKdnaArchive(generatedArchive, generatedDestination);
    const judgment = loadJudgment(generatedDestination);
    assert.equal(judgment.version, '1.2.3');
    assert.equal(judgment.axioms['judgment-core'].one_sentence, 'Historical authoring judgment');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('diff and changelog fail closed when a registry entry version does not match', () => {
  let downloadCalled = false;
  const options = {
    downloadFile() {
      downloadCalled = true;
    },
  };
  const mismatched = {
    name: '@aikdna/archive-history',
    version: '2.0.0',
    asset_url: 'https://invalid.example/2.0.0.kdna',
  };
  assert.throws(
    () => downloadForDiff(mismatched, '1.0.0', '/unused/diff', options),
    /registry version mismatch/,
  );
  assert.throws(
    () => downloadForChangelog(mismatched, '1.0.0', '/unused/changelog', options),
    /registry version mismatch/,
  );
  assert.equal(downloadCalled, false);
});

test('diff archive download accepts a valid KDNA and cleans its temporary download', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-diff-download-'));
  try {
    const archive = makeValidArchive(tmp);
    const destination = path.join(tmp, 'diff-out');
    const downloads = [];
    downloadForDiff(
      { version: '1.0.0', asset_url: 'https://invalid.example/asset-1.0.0.kdna' },
      '1.0.0',
      destination,
      { downloadFile: copyDownloader(archive, downloads) },
    );
    assert.equal(fs.readFileSync(path.join(destination, 'mimetype'), 'utf8'), core.MIMETYPE);
    assert.equal(downloads.length, 1);
    assert.equal(fs.existsSync(downloads[0]), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('diff archive download rejects traversal without creating its destination', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-diff-traversal-'));
  try {
    const archive = path.join(tmp, 'traversal.kdna');
    fs.writeFileSync(archive, maliciousArchive({ name: '../outside' }));
    const destination = path.join(tmp, 'diff-out');
    const downloads = [];
    assert.throws(
      () =>
        downloadForDiff(
          { version: '1.0.0', asset_url: 'https://invalid.example/asset-1.0.0.kdna' },
          '1.0.0',
          destination,
          { downloadFile: copyDownloader(archive, downloads) },
        ),
      /unsafe KDNA archive/,
    );
    assert.equal(fs.existsSync(destination), false);
    assert.equal(fs.existsSync(path.join(tmp, 'outside')), false);
    assert.equal(downloads.length, 1);
    assert.equal(fs.existsSync(downloads[0]), false);
    assert.deepEqual(
      fs.readdirSync(tmp).filter((name) => name.startsWith('.diff-out.extract-')),
      [],
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('changelog archive download accepts valid KDNA and rejects link metadata', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-changelog-download-'));
  try {
    const validArchive = makeValidArchive(tmp);
    const validDestination = path.join(tmp, 'changelog-valid');
    downloadForChangelog(
      { version: '1.0.0', asset_url: 'https://invalid.example/asset.kdna' },
      '1.0.0',
      validDestination,
      { downloadFile: copyDownloader(validArchive) },
    );
    assert.equal(fs.readFileSync(path.join(validDestination, 'mimetype'), 'utf8'), core.MIMETYPE);

    const malicious = path.join(tmp, 'link.kdna');
    fs.writeFileSync(
      malicious,
      maliciousArchive({
        name: 'attachments/link',
        versionMadeBy: (3 << 8) | 20,
        externalAttributes: 0o120777 << 16,
      }),
    );
    const rejectedDestination = path.join(tmp, 'changelog-rejected');
    assert.throws(
      () =>
        downloadForChangelog(
          { version: '1.0.0', asset_url: 'https://invalid.example/asset.kdna' },
          '1.0.0',
          rejectedDestination,
          { downloadFile: copyDownloader(malicious) },
        ),
      /entry is not an ordinary file/,
    );
    assert.equal(fs.existsSync(rejectedDestination), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('diff and changelog resolve and compare two exact registry versions', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-exact-version-'));
  let home;
  try {
    const oldArchive = makeHistoricalArchive(
      path.join(tmp, 'archive-1.0.0.kdna'),
      '1.0.0',
      'Old judgment',
    );
    const newArchive = makeHistoricalArchive(
      path.join(tmp, 'archive-2.0.0.kdna'),
      '2.0.0',
      'New judgment',
    );
    home = writeRegistryHome([
      registryEntry('1.0.0', oldArchive),
      registryEntry('2.0.0', newArchive),
    ]);
    const commandTmp = path.join(tmp, 'command-tmp');
    fs.mkdirSync(commandTmp);
    const env = { HOME: home, TMPDIR: commandTmp };

    const diff = runCli(
      [
        'quality',
        'diff',
        '@aikdna/archive-history@1.0.0',
        '@aikdna/archive-history@2.0.0',
        '--json',
      ],
      env,
    );
    assert.equal(diff.status, 0, diff.stderr);
    const diffOutput = JSON.parse(diff.stdout);
    assert.equal(diffOutput.old_version, '1.0.0');
    assert.equal(diffOutput.new_version, '2.0.0');
    assert.equal(diffOutput.changed_axioms[0].id, 'judgment-core');

    const changelog = runCli(
      ['changelog', '@aikdna/archive-history', '--from', '1.0.0', '--to', '2.0.0', '--json'],
      env,
    );
    assert.equal(changelog.status, 0, changelog.stderr);
    const changelogOutput = JSON.parse(changelog.stdout);
    assert.equal(changelogOutput.from, '1.0.0');
    assert.equal(changelogOutput.to, '2.0.0');
    assert.equal(changelogOutput.changes.axioms['judgment-core'].status, 'changed');
    assert.deepEqual(fs.readdirSync(commandTmp), []);
  } finally {
    if (home) fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('diff and changelog report download failures as provider errors and clean temporary files', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-provider-error-'));
  let home;
  try {
    const oldArchive = makeHistoricalArchive(
      path.join(tmp, 'archive-1.0.0.kdna'),
      '1.0.0',
      'Old judgment',
    );
    const missingArchive = path.join(tmp, 'missing-2.0.0.kdna');
    home = writeRegistryHome([
      registryEntry('1.0.0', oldArchive),
      registryEntry('2.0.0', missingArchive),
    ]);
    for (const [label, args] of [
      [
        'diff',
        ['quality', 'diff', '@aikdna/archive-history@1.0.0', '@aikdna/archive-history@2.0.0'],
      ],
      ['changelog', ['changelog', '@aikdna/archive-history', '--from', '1.0.0', '--to', '2.0.0']],
    ]) {
      const commandTmp = path.join(tmp, `${label}-tmp`);
      fs.mkdirSync(commandTmp);
      const result = runCli(args, { HOME: home, TMPDIR: commandTmp });
      assert.equal(result.status, 6, `${label}: ${result.stderr}`);
      assert.match(result.stderr, /Failed to download @aikdna\/archive-history@2\.0\.0/);
      assert.deepEqual(fs.readdirSync(commandTmp), [], label);
    }
  } finally {
    if (home) fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('archive I/O paths do not use shell command execution', () => {
  for (const relative of [
    'src/capsule-verify.js',
    'src/cmds/domain.js',
    'src/diff.js',
    'src/cmds/changelog.js',
    'src/safe-archive.js',
  ]) {
    const source = fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
    assert.doesNotMatch(source, /\bexecSync\s*\(/, relative);
    assert.doesNotMatch(source, /\bshell\s*:\s*true\b/, relative);
  }

  for (const relative of ['src/diff.js', 'src/cmds/changelog.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
    assert.doesNotMatch(source, /\bunzip\b|extractall\s*\(/, relative);
    assert.match(source, /safe-archive/, relative);
  }
});
