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
const internalCli = path.join(__dirname, 'helpers', 'invoke-internal-command.js');

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

function runInternal(args, env) {
  const needsShim = env && env.KDNA_ARCHIVE_FIXTURE_DIR;
  return spawnSync(process.execPath, [internalCli, ...args], {
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
