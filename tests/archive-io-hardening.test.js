'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const core = require('@aikdna/kdna-core');
const cbor = require('cbor-x');
const { downloadVersion: downloadForDiff, loadJudgment } = require('../src/diff');
const { downloadVersion: downloadForChangelog } = require('../src/cmds/changelog');
const { assetDigest } = require('../src/package-store');
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

function buildStoredZip(entries, options = {}) {
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
  const orderedCentral = options.centralOrder
    ? options.centralOrder.map((index) => centralChunks[index])
    : centralChunks;
  return Buffer.concat([...localChunks, ...orderedCentral, eocd]);
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
  fs.cpSync(path.join(__dirname, '..', 'fixtures', 'judgment'), source, {
    recursive: true,
  });
  fs.mkdirSync(path.join(source, 'attachments'));
  fs.writeFileSync(path.join(source, 'attachments', '判断-é.txt'), 'portable UTF-8 entry');
  const archive = path.join(tmp, 'valid.kdna');
  core.pack(source, archive);
  return archive;
}

function makeHistoricalArchive(output, version, axiomText, options = {}) {
  const entries = [
    { name: 'mimetype', data: 'application/vnd.aikdna.kdna+zip' },
    {
      name: 'KDNA_Core.json',
      method: 8,
      data: JSON.stringify({
        axioms: [{ id: 'judgment-core', one_sentence: axiomText }],
        ontology: options.ontology || [],
        stances: [],
      }),
    },
    {
      name: 'KDNA_Patterns.json',
      method: 8,
      data: JSON.stringify({
        misunderstandings: [],
        terminology: { banned_terms: options.bannedTerms || [] },
      }),
    },
    {
      name: 'kdna.json',
      method: 8,
      data: JSON.stringify({
        name: options.name || '@aikdna/archive-history',
        version: options.manifestVersion || version,
        judgment_version: options.manifestVersion || version,
      }),
    },
  ];
  fs.writeFileSync(output, buildStoredZip(entries));
  return output;
}

function makeRuntimeArchive(root, name, version, axiomText, options = {}) {
  const source = path.join(root, `runtime-source-${version}-${path.basename(name)}`);
  fs.cpSync(path.join(__dirname, '..', 'fixtures', 'judgment'), source, {
    recursive: true,
  });
  const manifestPath = path.join(source, 'kdna.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const [scope, ident] = name.split('/');
  manifest.asset_id = `kdna:${scope.slice(1)}:${ident}`;
  delete manifest.name;
  manifest.version = version;
  manifest.judgment_version = version;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(
    path.join(source, 'payload.kdnab'),
    cbor.encode({
      profile: 'kdna.payload.judgment',
      profile_version: '0.1.0',
      core: {
        highest_question: `Question ${version}`,
        axioms: [{ id: 'judgment-core', one_sentence: axiomText }],
        boundaries: [],
        ontology: options.ontology || [],
        stances: options.stances || [],
      },
      patterns: [],
      scenarios: [],
      cases: [],
      reasoning: { self_check: [], failure_modes: [] },
    }),
  );
  fs.writeFileSync(
    path.join(source, 'checksums.json'),
    JSON.stringify(core.buildChecksums(source), null, 2) + '\n',
  );
  const output = path.join(root, `runtime-${version}-${path.basename(name)}.kdna`);
  core.pack(source, output);
  return output;
}

function writeRegistry(home, entries) {
  const registryDir = path.join(home, '.kdna', 'registry');
  fs.mkdirSync(registryDir, { recursive: true });
  fs.writeFileSync(
    path.join(registryDir, 'domains.json'),
    JSON.stringify({
      schema_version: '3.0',
      registry_version: '3.0.0-archive-test',
      trust: {
        model: 'kdna.registry.snapshot',
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
}

function writeRegistryHome(entries) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-archive-registry-'));
  writeRegistry(home, entries);
  return home;
}

function registryEntry(name, version, archive, options = {}) {
  return {
    name,
    type: 'domain',
    version,
    status: 'experimental',
    access: 'open',
    // Downloads are HTTPS-only. Fixtures are served through the curl shim
    // below, which maps this host back to the local archive bytes.
    asset_url: `${FIXTURE_DOWNLOAD_ORIGIN}/${path.basename(archive)}`,
    asset_digest: options.assetDigest || assetDigest(archive),
    signature: 'ed25519:test',
    release_status: 'published_signed',
  };
}

const FIXTURE_DOWNLOAD_ORIGIN = 'https://fixture.invalid';

// A PATH shim for `curl`: the CLI's download path only accepts https: URLs,
// so end-to-end tests route https://fixture.invalid/<name> requests to the
// local fixture directory named by KDNA_ARCHIVE_FIXTURE_DIR. Any other URL
// fails the way a network error would.
let curlShimDirectory = null;
function curlShimDir() {
  if (curlShimDirectory) return curlShimDirectory;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-curl-shim-'));
  const script = `#!/bin/sh
out=""
url=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-o" ]; then out="$arg"; fi
  prev="$arg"
  url="$arg"
done
case "$url" in
  ${FIXTURE_DOWNLOAD_ORIGIN}/*)
    name="\${url##*/}"
    src="$KDNA_ARCHIVE_FIXTURE_DIR/$name"
    if [ -f "$src" ]; then
      /bin/cp "$src" "$out"
      exit $?
    fi
    ;;
esac
echo "curl shim: cannot fetch $url" >&2
exit 22
`;
  fs.writeFileSync(path.join(dir, 'curl'), script, { mode: 0o755 });
  curlShimDirectory = dir;
  return dir;
}

function runCli(args, env) {
  const needsShim = env && env.KDNA_ARCHIVE_FIXTURE_DIR;
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env,
      KDNA_REGISTRY_URL: '',
      ...(needsShim ? { PATH: `${curlShimDir()}:${process.env.PATH}` } : {}),
    },
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
    fs.cpSync(path.join(__dirname, '..', 'fixtures', 'judgment'), source, {
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

    const centralOrderBypass = path.join(tmp, 'central-order-bypass.kdna');
    fs.writeFileSync(
      centralOrderBypass,
      buildStoredZip(
        [
          { name: 'kdna.json', data: '{}' },
          { name: 'mimetype', data: core.MIMETYPE },
          { name: 'payload.kdnab', data: '{}' },
        ],
        { centralOrder: [1, 0, 2] },
      ),
    );
    assert.throws(
      () => extractKdnaArchive(centralOrderBypass, path.join(tmp, 'central-order-out')),
      /first physical local entry at offset 0/,
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
    assert.equal(fs.existsSync(path.join(runtimeDestination, 'payload.kdnab')), true);
    assert.equal(fs.existsSync(path.join(runtimeDestination, 'KDNA_Core.json')), false);

    const generatedArchive = makeHistoricalArchive(
      path.join(tmp, 'historical.kdna'),
      '1.2.3',
      'Historical authoring judgment',
    );
    const generatedDestination = path.join(tmp, 'historical-out');
    extractKdnaArchive(generatedArchive, generatedDestination);
    assert.equal(fs.existsSync(path.join(generatedDestination, 'payload.kdnab')), false);
    assert.equal(fs.existsSync(path.join(generatedDestination, 'KDNA_Core.json')), true);
    assert.equal(fs.existsSync(path.join(generatedDestination, 'KDNA_Patterns.json')), true);
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
  assert.throws(
    () =>
      downloadForDiff(
        { ...mismatched, version: '1.0.0', asset_digest: undefined },
        '1.0.0',
        '/unused/digest',
        options,
      ),
    /no canonical asset_digest/,
  );
  const wrongResolvedIdentity = {
    ...mismatched,
    name: '@aikdna/wrong-registry-entry',
    version: '1.0.0',
    asset_digest: `sha256:${'0'.repeat(64)}`,
  };
  for (const downloadVersion of [downloadForDiff, downloadForChangelog]) {
    assert.throws(
      () =>
        downloadVersion(wrongResolvedIdentity, '1.0.0', '/unused/identity', {
          ...options,
          expectedName: '@aikdna/archive-history',
        }),
      /registry identity mismatch/,
    );
  }
  assert.equal(downloadCalled, false);
});

test('registry downloads bind bytes, manifest identity, and manifest version before use', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-registry-binding-'));
  try {
    const name = '@aikdna/archive-history';
    const sameUrl = makeHistoricalArchive(
      path.join(tmp, 'same-url.kdna'),
      '1.0.0',
      'Original bytes',
    );
    const originalDigest = assetDigest(sameUrl);
    const replacement = makeHistoricalArchive(
      path.join(tmp, 'replacement.kdna'),
      '1.0.0',
      'Replaced bytes',
    );
    fs.copyFileSync(replacement, sameUrl);
    assert.throws(
      () =>
        downloadForDiff(
          {
            name,
            version: '1.0.0',
            asset_url: 'https://invalid.example/same-url.kdna',
            asset_digest: originalDigest,
          },
          '1.0.0',
          path.join(tmp, 'same-url-out'),
          { downloadFile: copyDownloader(sameUrl) },
        ),
      /do not match registry asset_digest/,
    );

    const valid = makeHistoricalArchive(
      path.join(tmp, 'valid-binding.kdna'),
      '1.0.0',
      'Valid binding',
    );
    assert.throws(
      () =>
        downloadForChangelog(
          {
            name,
            version: '1.0.0',
            asset_url: 'https://invalid.example/valid-binding.kdna',
            asset_digest: `sha256:${'0'.repeat(64)}`,
          },
          '1.0.0',
          path.join(tmp, 'fake-digest-out'),
          { downloadFile: copyDownloader(valid) },
        ),
      /do not match registry asset_digest/,
    );

    const wrongIdentity = makeHistoricalArchive(
      path.join(tmp, 'wrong-identity.kdna'),
      '1.0.0',
      'Wrong identity',
      { name: '@aikdna/not-the-registry-name' },
    );
    assert.throws(
      () =>
        downloadForDiff(
          {
            name,
            version: '1.0.0',
            asset_url: 'https://invalid.example/wrong-identity.kdna',
            asset_digest: assetDigest(wrongIdentity),
          },
          '1.0.0',
          path.join(tmp, 'wrong-identity-out'),
          { downloadFile: copyDownloader(wrongIdentity) },
        ),
      /identity does not match registry entry/,
    );

    const wrongVersion = makeHistoricalArchive(
      path.join(tmp, 'wrong-version.kdna'),
      '1.0.0',
      'Wrong version',
      { manifestVersion: '9.9.9' },
    );
    assert.throws(
      () =>
        downloadForChangelog(
          {
            name,
            version: '1.0.0',
            asset_url: 'https://invalid.example/wrong-version.kdna',
            asset_digest: assetDigest(wrongVersion),
          },
          '1.0.0',
          path.join(tmp, 'wrong-version-out'),
          { downloadFile: copyDownloader(wrongVersion) },
        ),
      /version does not match registry entry/,
    );

    for (const destination of [
      'same-url-out',
      'fake-digest-out',
      'wrong-identity-out',
      'wrong-version-out',
    ]) {
      assert.equal(fs.existsSync(path.join(tmp, destination)), false);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('diff archive download accepts a valid KDNA and cleans its temporary download', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-diff-download-'));
  try {
    const archive = makeValidArchive(tmp);
    const destination = path.join(tmp, 'diff-out');
    const downloads = [];
    downloadForDiff(
      {
        name: '@example/content-review',
        version: '1.0.0',
        asset_url: 'https://invalid.example/asset-1.0.0.kdna',
        asset_digest: assetDigest(archive),
      },
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
          {
            name: '@example/content-review',
            version: '1.0.0',
            asset_url: 'https://invalid.example/asset-1.0.0.kdna',
            asset_digest: assetDigest(archive),
          },
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
      {
        name: '@example/content-review',
        version: '1.0.0',
        asset_url: 'https://invalid.example/asset.kdna',
        asset_digest: assetDigest(validArchive),
      },
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
          {
            name: '@example/content-review',
            version: '1.0.0',
            asset_url: 'https://invalid.example/asset.kdna',
            asset_digest: assetDigest(malicious),
          },
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

test('diff and changelog read real semantic changes from two exact runtime payloads', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-exact-version-'));
  let home;
  try {
    const name = '@aikdna/runtime-history';
    const ontology = (id, oneSentence) => ({
      id,
      one_sentence: oneSentence,
      essence: `${oneSentence} essence`,
      boundary: `${oneSentence} boundary`,
      trigger_signal: `${oneSentence} trigger`,
    });
    const oldArchive = makeRuntimeArchive(tmp, name, '1.0.0', 'Old runtime judgment', {
      ontology: [
        ontology('removed-concept', 'Removed runtime concept'),
        ontology('changed-concept', 'Old runtime concept'),
      ],
    });
    const newArchive = makeRuntimeArchive(tmp, name, '2.0.0', 'New runtime judgment', {
      ontology: [
        ontology('changed-concept', 'New runtime concept'),
        ontology('added-concept', 'Added runtime concept'),
      ],
    });
    const directRuntimeJudgment = loadJudgment(oldArchive);
    assert.equal(directRuntimeJudgment.version, '1.0.0');
    assert.equal(
      directRuntimeJudgment.axioms['judgment-core']?.one_sentence,
      'Old runtime judgment',
    );
    home = writeRegistryHome([
      registryEntry(name, '1.0.0', oldArchive),
      registryEntry(name, '2.0.0', newArchive),
    ]);
    const commandTmp = path.join(tmp, 'command-tmp');
    fs.mkdirSync(commandTmp);
    const env = { HOME: home, TMPDIR: commandTmp, KDNA_ARCHIVE_FIXTURE_DIR: tmp };

    const diff = runCli(['quality', 'diff', `${name}@1.0.0`, `${name}@2.0.0`, '--json'], env);
    assert.equal(diff.status, 0, diff.stderr);
    const diffOutput = JSON.parse(diff.stdout);
    assert.equal(diffOutput.old_version, '1.0.0');
    assert.equal(diffOutput.new_version, '2.0.0');
    assert.ok(diffOutput.changed_axioms[0], diff.stdout);
    assert.equal(diffOutput.changed_axioms[0].id, 'judgment-core');
    assert.deepEqual(diffOutput.changes.ontology.removed, ['removed-concept']);
    assert.deepEqual(diffOutput.changes.ontology.changed, ['changed-concept']);
    assert.deepEqual(diffOutput.changes.ontology.added, ['added-concept']);
    assert.equal(
      diffOutput.changes.ontology.changed_details[0].before.one_sentence,
      'Old runtime concept',
    );
    assert.equal(
      diffOutput.changes.ontology.changed_details[0].after.one_sentence,
      'New runtime concept',
    );
    assert.equal(diffOutput.recommended_version_bump, 'major');

    for (const references of [
      ['runtime-history@1.0.0', 'runtime-history@2.0.0'],
      ['runtime-history@1.0.0', `${name}@2.0.0`],
    ]) {
      const canonicalized = runCli(['quality', 'diff', ...references, '--json'], env);
      assert.equal(canonicalized.status, 0, canonicalized.stderr);
      const canonicalizedOutput = JSON.parse(canonicalized.stdout);
      assert.equal(canonicalizedOutput.domain, name);
      assert.equal(canonicalizedOutput.changed_axioms[0].id, 'judgment-core');
    }

    const changelog = runCli(
      ['changelog', name, '--from', '1.0.0', '--to', '2.0.0', '--json'],
      env,
    );
    assert.equal(changelog.status, 0, changelog.stderr);
    const changelogOutput = JSON.parse(changelog.stdout);
    assert.equal(changelogOutput.from, '1.0.0');
    assert.equal(changelogOutput.to, '2.0.0');
    assert.equal(changelogOutput.changes.axioms['judgment-core'].status, 'changed');
    assert.equal(changelogOutput.changes.ontology['removed-concept'].status, 'removed');
    assert.equal(changelogOutput.recommended_version_bump, 'major');
    assert.deepEqual(fs.readdirSync(commandTmp), []);
  } finally {
    if (home) fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('diff canonicalizes bare registry names but still rejects mismatched identities', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-bare-identity-'));
  let home;
  try {
    const name = '@aikdna/bare-identity';
    const oldArchive = makeHistoricalArchive(
      path.join(tmp, 'bare-identity-1.0.0.kdna'),
      '1.0.0',
      'Old judgment',
      { name },
    );
    const wrongArchive = makeHistoricalArchive(
      path.join(tmp, 'bare-identity-2.0.0.kdna'),
      '2.0.0',
      'New judgment',
      { name: '@aikdna/not-bare-identity' },
    );
    const otherName = '@aikdna/other-identity';
    const otherArchive = makeHistoricalArchive(
      path.join(tmp, 'other-identity-2.0.0.kdna'),
      '2.0.0',
      'Other judgment',
      { name: otherName },
    );
    home = writeRegistryHome([
      registryEntry(name, '1.0.0', oldArchive),
      registryEntry(name, '2.0.0', wrongArchive),
      registryEntry(otherName, '2.0.0', otherArchive),
    ]);
    const commandTmp = path.join(tmp, 'command-tmp');
    fs.mkdirSync(commandTmp);
    const env = { HOME: home, TMPDIR: commandTmp, KDNA_ARCHIVE_FIXTURE_DIR: tmp };

    const wrongAsset = runCli(
      ['quality', 'diff', 'bare-identity@1.0.0', 'bare-identity@2.0.0', '--json'],
      env,
    );
    assert.notEqual(wrongAsset.status, 0);
    assert.match(
      wrongAsset.stderr,
      /identity does not match registry entry @aikdna\/bare-identity/,
    );

    const differentDomain = runCli(
      ['quality', 'diff', 'bare-identity@1.0.0', `${otherName}@2.0.0`, '--json'],
      env,
    );
    assert.notEqual(differentDomain.status, 0);
    assert.match(differentDomain.stderr, /Comparing across different domains is not supported/);
    assert.deepEqual(fs.readdirSync(commandTmp), []);
  } finally {
    if (home) fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('single-argument diff uses the verified installed asset without resolving its old registry entry', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-installed-diff-'));
  let home;
  try {
    const name = '@aikdna/installed-history';
    const oldArchive = makeRuntimeArchive(tmp, name, '1.0.0', 'Installed old judgment');
    const newArchive = makeRuntimeArchive(tmp, name, '2.0.0', 'Registry new judgment');
    home = writeRegistryHome([registryEntry(name, '2.0.0', newArchive)]);
    const commandTmp = path.join(tmp, 'command-tmp');
    const project = path.join(tmp, 'project');
    fs.mkdirSync(commandTmp);
    fs.mkdirSync(project);
    const env = {
      HOME: home,
      KDNA_HOME: path.join(home, '.kdna'),
      KDNA_PROJECT_ROOT: project,
      TMPDIR: commandTmp,
      KDNA_ARCHIVE_FIXTURE_DIR: tmp,
    };

    const install = runCli(['install', oldArchive, '--yes', '--json', '--allow-unverified'], env);
    assert.equal(install.status, 0, install.stderr);
    const installed = JSON.parse(install.stdout);

    // The registry contains only the newer asset. A successful comparison proves
    // the older asset came from the installed package, not a stale registry record.
    const diff = runCli(['quality', 'diff', name, '--json'], env);
    assert.equal(diff.status, 0, diff.stderr);
    const output = JSON.parse(diff.stdout);
    assert.equal(output.old_version, '1.0.0');
    assert.equal(output.new_version, '2.0.0');
    assert.equal(output.changed_axioms[0].id, 'judgment-core');
    assert.deepEqual(fs.readdirSync(commandTmp), []);

    fs.appendFileSync(installed.path, 'tamper');
    const tampered = runCli(['quality', 'diff', name, '--json'], env);
    assert.notEqual(tampered.status, 0, tampered.stderr);
    assert.match(tampered.stderr, /failed integrity/i);
    assert.deepEqual(fs.readdirSync(commandTmp), []);
  } finally {
    if (home) fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('changelog counts ontology and banned-term changes and reserves no-change for semantic zero', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-changelog-semantics-'));
  let home;
  try {
    const name = '@aikdna/changelog-semantics';
    const oldArchive = makeHistoricalArchive(
      path.join(tmp, 'changelog-1.0.0.kdna'),
      '1.0.0',
      'Stable axiom',
      {
        name,
        ontology: [
          { id: 'removed-concept', concept: 'Removed concept' },
          { id: 'changed-concept', concept: 'Old concept meaning' },
        ],
        bannedTerms: [
          { term: 'removed-term', reason: 'Old prohibition' },
          { term: 'changed-term', reason: 'Old reason' },
        ],
      },
    );
    const newArchive = makeHistoricalArchive(
      path.join(tmp, 'changelog-2.0.0.kdna'),
      '2.0.0',
      'Stable axiom',
      {
        name,
        ontology: [
          { id: 'changed-concept', concept: 'New concept meaning' },
          { id: 'added-concept', concept: 'Added concept' },
        ],
        bannedTerms: [
          { term: 'changed-term', reason: 'New reason' },
          { term: 'added-term', reason: 'New prohibition' },
        ],
      },
    );
    const sameA = makeHistoricalArchive(
      path.join(tmp, 'changelog-3.0.0.kdna'),
      '3.0.0',
      'Identical semantic judgment',
      { name },
    );
    const sameB = makeHistoricalArchive(
      path.join(tmp, 'changelog-4.0.0.kdna'),
      '4.0.0',
      'Identical semantic judgment',
      { name },
    );
    const minorA = makeHistoricalArchive(
      path.join(tmp, 'changelog-5.0.0.kdna'),
      '5.0.0',
      'Stable axiom',
      {
        name,
        ontology: [{ id: 'kept-concept', concept: 'Old concept meaning' }],
        bannedTerms: [{ term: 'kept-term', reason: 'Old prohibition' }],
      },
    );
    const minorB = makeHistoricalArchive(
      path.join(tmp, 'changelog-6.0.0.kdna'),
      '6.0.0',
      'Stable axiom',
      {
        name,
        ontology: [
          { id: 'kept-concept', concept: 'New concept meaning' },
          { id: 'added-concept', concept: 'Added concept' },
        ],
        bannedTerms: [
          { term: 'kept-term', reason: 'New prohibition' },
          { term: 'added-term', reason: 'Added prohibition' },
        ],
      },
    );
    home = writeRegistryHome([
      registryEntry(name, '1.0.0', oldArchive),
      registryEntry(name, '2.0.0', newArchive),
      registryEntry(name, '3.0.0', sameA),
      registryEntry(name, '4.0.0', sameB),
      registryEntry(name, '5.0.0', minorA),
      registryEntry(name, '6.0.0', minorB),
    ]);
    const commandTmp = path.join(tmp, 'command-tmp');
    fs.mkdirSync(commandTmp);
    const env = { HOME: home, TMPDIR: commandTmp, KDNA_ARCHIVE_FIXTURE_DIR: tmp };

    const changed = runCli(['changelog', name, '--from', '1.0.0', '--to', '2.0.0', '--json'], env);
    assert.equal(changed.status, 0, changed.stderr);
    const output = JSON.parse(changed.stdout);
    assert.equal(output.changes.ontology['removed-concept'].status, 'removed');
    assert.equal(output.changes.ontology['changed-concept'].status, 'changed');
    assert.equal(output.changes.ontology['added-concept'].status, 'added');
    assert.deepEqual(output.changes.banned_terms.removed, ['removed-term']);
    assert.deepEqual(output.changes.banned_terms.changed, ['changed-term']);
    assert.deepEqual(output.changes.banned_terms.added, ['added-term']);
    assert.equal(output.recommended_version_bump, 'major');

    const qualityDiff = runCli(
      ['quality', 'diff', `${name}@1.0.0`, `${name}@2.0.0`, '--json'],
      env,
    );
    assert.equal(qualityDiff.status, 0, qualityDiff.stderr);
    const qualityOutput = JSON.parse(qualityDiff.stdout);
    assert.deepEqual(qualityOutput.changes.ontology.removed, ['removed-concept']);
    assert.deepEqual(qualityOutput.changes.ontology.changed, ['changed-concept']);
    assert.deepEqual(qualityOutput.changes.ontology.added, ['added-concept']);
    assert.deepEqual(qualityOutput.changes.banned_terms.removed, ['removed-term']);
    assert.deepEqual(qualityOutput.changes.banned_terms.changed, ['changed-term']);
    assert.deepEqual(qualityOutput.changes.banned_terms.added, ['added-term']);
    assert.equal(qualityOutput.recommended_version_bump, 'major');

    for (const command of [
      ['quality', 'diff', `${name}@5.0.0`, `${name}@6.0.0`, '--json'],
      ['changelog', name, '--from', '5.0.0', '--to', '6.0.0', '--json'],
    ]) {
      const result = runCli(command, env);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).recommended_version_bump, 'minor');
    }

    const unchanged = runCli(['changelog', name, '--from', '3.0.0', '--to', '4.0.0'], env);
    assert.equal(unchanged.status, 0, unchanged.stderr);
    assert.match(unchanged.stdout, /No judgment changes detected\./);
    assert.doesNotMatch(unchanged.stdout, /Recommended version bump/);
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
      registryEntry('@aikdna/archive-history', '1.0.0', oldArchive),
      registryEntry('@aikdna/archive-history', '2.0.0', missingArchive, {
        assetDigest: `sha256:${'f'.repeat(64)}`,
      }),
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
      const result = runCli(args, {
        HOME: home,
        TMPDIR: commandTmp,
        KDNA_ARCHIVE_FIXTURE_DIR: tmp,
      });
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
