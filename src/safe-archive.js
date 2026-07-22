'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TextDecoder } = require('node:util');
const zlib = require('node:zlib');
const { nameFromAssetId } = require('./registry');
const { assertHttpsDownloadUrl, CURL_HTTPS_ONLY_ARGS, curlFetch } = require('./https-download');

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_EOCD_SEARCH = 65557;
// Network safety policy for the legacy `kdna quality diff` and `kdna changelog`
// download surface. These are extraction limits, not general KDNA format limits.
const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
const MAX_ENTRIES = 128;
const MAX_ENTRY_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 12 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 100;
const ALLOWED_FLAGS = 0x0800; // UTF-8 names. Core also emits zero for UTF-8 names.
const ALLOWED_METHODS = new Set([0, 8]);
const REJECTED_EXTRA_FIELDS = new Set([
  0x0001, // ZIP64: this parser intentionally supports only classic ZIP bounds.
  0x000d, // PKWARE Unix: can carry link/device metadata.
  0x7075, // Info-ZIP Unicode path override.
  0x756e, // ASi Unix: can carry symlink metadata.
  0x9901, // WinZip AES: changes data interpretation.
]);
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const KDNA_MIMETYPES = new Set(['application/vnd.kdna.asset', 'application/vnd.aikdna.kdna+zip']);
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

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

function fail(message) {
  const err = new Error(`unsafe KDNA archive: ${message}`);
  // CLI-owned, vetted message: asset coordinates and archive entry names
  // only — never local paths, URLs, curl output, or server bytes. Safe to
  // surface to users via describeDownloadFailure.
  err.cliOwned = true;
  throw err;
}

function ensureRange(buffer, offset, length, label) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) {
    fail(`invalid ${label} bounds`);
  }
  if (offset > buffer.length || length > buffer.length - offset) {
    fail(`truncated ${label}`);
  }
}

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function decodeEntryName(bytes) {
  let name;
  try {
    name = utf8Decoder.decode(bytes);
  } catch {
    fail('entry name is not valid UTF-8');
  }
  if (!name) fail('entry name is empty');
  if (name !== name.normalize('NFC')) fail(`entry name is not NFC-normalized: ${name}`);
  if (name !== name.normalize('NFKC')) fail(`entry name uses compatibility characters: ${name}`);
  if (
    [...name].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint < 0x20 || codePoint === 0x7f;
    })
  ) {
    fail('entry name contains control characters');
  }
  if (name.includes('\\')) fail(`entry name uses a backslash separator: ${name}`);
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) fail(`entry name is absolute: ${name}`);
  if (/%(?:00|2e|2f|5c)/i.test(name)) fail(`entry name uses encoded path controls: ${name}`);

  const components = name.split('/');
  if (components.some((component) => !component || component === '.' || component === '..')) {
    fail(`entry name has an unsafe path component: ${name}`);
  }
  for (const component of components) {
    if (component.includes(':')) fail(`entry name uses a platform path delimiter: ${name}`);
    if (/[. ]$/u.test(component)) fail(`entry name has a platform-ambiguous suffix: ${name}`);
    if (WINDOWS_RESERVED.test(component)) fail(`entry name uses a reserved platform name: ${name}`);
  }
  return name;
}

function validateExtraFields(buffer, offset, length, label) {
  ensureRange(buffer, offset, length, label);
  const end = offset + length;
  let cursor = offset;
  while (cursor < end) {
    if (end - cursor < 4) fail(`truncated ${label}`);
    const id = buffer.readUInt16LE(cursor);
    const size = buffer.readUInt16LE(cursor + 2);
    cursor += 4;
    if (size > end - cursor) fail(`truncated ${label}`);
    if (REJECTED_EXTRA_FIELDS.has(id)) {
      fail(`${label} uses unsupported metadata 0x${id.toString(16).padStart(4, '0')}`);
    }
    cursor += size;
  }
}

function validateFileType(name, versionMadeBy, externalAttributes) {
  const platform = versionMadeBy >>> 8;
  if (platform === 3) {
    const mode = externalAttributes >>> 16;
    const type = mode & 0o170000;
    if (type !== 0 && type !== 0o100000) {
      fail(`entry is not an ordinary file: ${name}`);
    }
  } else if ((externalAttributes & 0x10) !== 0) {
    fail(`entry is a directory: ${name}`);
  }
}

function findEocd(buffer) {
  const start = Math.max(0, buffer.length - MAX_EOCD_SEARCH);
  for (let offset = buffer.length - 22; offset >= start; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== EOCD_SIGNATURE) continue;
    ensureRange(buffer, offset, 22, 'end-of-central-directory record');
    const commentLength = buffer.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === buffer.length) return offset;
  }
  fail('missing or malformed end-of-central-directory record');
}

/**
 * Strictly validate all ZIP metadata and actual entry bytes before extraction.
 */
function preflightKdnaArchive(archivePath) {
  const archiveStat = fs.lstatSync(archivePath);
  if (!archiveStat.isFile()) fail('downloaded archive is not an ordinary file');
  if (archiveStat.size > MAX_ARCHIVE_BYTES) fail('downloaded archive exceeds the size limit');
  const buffer = fs.readFileSync(archivePath);
  const eocdOffset = findEocd(buffer);
  const diskNumber = buffer.readUInt16LE(eocdOffset + 4);
  const centralDisk = buffer.readUInt16LE(eocdOffset + 6);
  const entriesOnDisk = buffer.readUInt16LE(eocdOffset + 8);
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralSize = buffer.readUInt32LE(eocdOffset + 12);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);

  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
    fail('multi-disk ZIP archives are not supported');
  }
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    fail('ZIP64 archives are not supported');
  }
  if (entryCount > MAX_ENTRIES) fail('archive has too many entries');
  ensureRange(buffer, centralOffset, centralSize, 'central directory');
  if (centralOffset + centralSize !== eocdOffset) {
    fail('central-directory bounds are inconsistent');
  }

  const names = new Set();
  const portableNames = new Set();
  const localRanges = [];
  const descriptors = [];
  let cursor = centralOffset;

  for (let index = 0; index < entryCount; index += 1) {
    ensureRange(buffer, cursor, 46, 'central-directory entry');
    if (buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      fail(`bad central-directory entry at index ${index}`);
    }

    const versionMadeBy = buffer.readUInt16LE(cursor + 4);
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const diskStart = buffer.readUInt16LE(cursor + 34);
    const externalAttributes = buffer.readUInt32LE(cursor + 38);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const entryLength = 46 + nameLength + extraLength + commentLength;
    ensureRange(buffer, cursor, entryLength, 'central-directory entry');

    if ((flags & ~ALLOWED_FLAGS) !== 0)
      fail(`entry uses unsupported ZIP flags: 0x${flags.toString(16)}`);
    if (!ALLOWED_METHODS.has(method)) fail(`entry uses unsupported compression method: ${method}`);
    if (diskStart !== 0) fail('entry refers to another ZIP disk');
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localOffset === 0xffffffff
    ) {
      fail('ZIP64 entry metadata is not supported');
    }

    const nameBytes = buffer.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = decodeEntryName(nameBytes);
    const portableName = name.toLocaleLowerCase('en-US');
    if (names.has(name)) fail(`duplicate entry name: ${name}`);
    if (portableNames.has(portableName)) fail(`platform-colliding entry name: ${name}`);
    names.add(name);
    portableNames.add(portableName);
    validateFileType(name, versionMadeBy, externalAttributes);
    validateExtraFields(
      buffer,
      cursor + 46 + nameLength,
      extraLength,
      `central extra field for ${name}`,
    );

    ensureRange(buffer, localOffset, 30, `local header for ${name}`);
    if (buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      fail(`bad local header for ${name}`);
    }
    const localFlags = buffer.readUInt16LE(localOffset + 6);
    const localMethod = buffer.readUInt16LE(localOffset + 8);
    const localCrc = buffer.readUInt32LE(localOffset + 14);
    const localCompressedSize = buffer.readUInt32LE(localOffset + 18);
    const localUncompressedSize = buffer.readUInt32LE(localOffset + 22);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const localHeaderLength = 30 + localNameLength + localExtraLength;
    ensureRange(buffer, localOffset, localHeaderLength, `local header for ${name}`);
    const localNameBytes = buffer.subarray(localOffset + 30, localOffset + 30 + localNameLength);
    decodeEntryName(localNameBytes);
    if (!localNameBytes.equals(nameBytes)) fail(`central/local entry names differ for ${name}`);
    if (
      localFlags !== flags ||
      localMethod !== method ||
      localCrc !== crc ||
      localCompressedSize !== compressedSize ||
      localUncompressedSize !== uncompressedSize
    ) {
      fail(`central/local metadata differs for ${name}`);
    }
    validateExtraFields(
      buffer,
      localOffset + 30 + localNameLength,
      localExtraLength,
      `local extra field for ${name}`,
    );

    const dataStart = localOffset + localHeaderLength;
    ensureRange(buffer, dataStart, compressedSize, `compressed data for ${name}`);
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > centralOffset) fail(`entry data overlaps the central directory: ${name}`);
    localRanges.push({ start: localOffset, end: dataEnd, name });
    descriptors.push({
      name,
      method,
      crc,
      compressedSize,
      uncompressedSize,
      localOffset,
      compressed: buffer.subarray(dataStart, dataEnd),
    });
    cursor += entryLength;
  }

  if (cursor !== centralOffset + centralSize) fail('central-directory entry count is inconsistent');
  localRanges.sort((left, right) => left.start - right.start);
  for (let index = 1; index < localRanges.length; index += 1) {
    if (localRanges[index].start < localRanges[index - 1].end) {
      fail(
        `overlapping local entries: ${localRanges[index - 1].name} and ${localRanges[index].name}`,
      );
    }
  }

  for (const name of names) {
    const components = name.split('/');
    for (let length = 1; length < components.length; length += 1) {
      const prefix = components.slice(0, length).join('/').toLocaleLowerCase('en-US');
      if (portableNames.has(prefix)) {
        fail(`entry path conflicts with an ordinary file: ${name}`);
      }
    }
  }

  const physicalFirst = descriptors.find(
    (descriptor) => descriptor.localOffset === localRanges[0]?.start,
  );
  if (
    !physicalFirst ||
    physicalFirst.localOffset !== 0 ||
    physicalFirst.name !== 'mimetype' ||
    physicalFirst.method !== 0
  ) {
    fail('first physical local entry at offset 0 must be an uncompressed mimetype file');
  }

  let declaredTotal = 0;
  for (const descriptor of descriptors) {
    if (descriptor.uncompressedSize > MAX_ENTRY_BYTES) {
      fail(`entry exceeds the uncompressed size limit: ${descriptor.name}`);
    }
    if (descriptor.method === 0 && descriptor.compressedSize !== descriptor.uncompressedSize) {
      fail(`stored entry has inconsistent sizes: ${descriptor.name}`);
    }
    if (
      descriptor.uncompressedSize > 0 &&
      (descriptor.compressedSize === 0 ||
        descriptor.uncompressedSize / descriptor.compressedSize > MAX_COMPRESSION_RATIO)
    ) {
      fail(`entry exceeds the compression-ratio limit: ${descriptor.name}`);
    }
    declaredTotal += descriptor.uncompressedSize;
    if (declaredTotal > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      fail('archive exceeds the total uncompressed size limit');
    }
  }

  const entries = [];
  let actualTotal = 0;
  for (const descriptor of descriptors) {
    let data;
    try {
      data =
        descriptor.method === 0
          ? Buffer.from(descriptor.compressed)
          : zlib.inflateRawSync(descriptor.compressed, { maxOutputLength: MAX_ENTRY_BYTES });
    } catch {
      fail(`entry cannot be safely decompressed: ${descriptor.name}`);
    }
    if (data.length !== descriptor.uncompressedSize) {
      fail(`entry uncompressed size does not match its bytes: ${descriptor.name}`);
    }
    actualTotal += data.length;
    if (actualTotal > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      fail('archive exceeds the total uncompressed size limit');
    }
    if (crc32(data) !== descriptor.crc) {
      fail(`entry CRC32 does not match its bytes: ${descriptor.name}`);
    }
    entries.push({ name: descriptor.name, data });
  }

  const mimetypeEntry = entries.find((entry) => entry.name === 'mimetype');
  const mimetype = mimetypeEntry.data.toString('utf8');
  if (!KDNA_MIMETYPES.has(mimetype)) fail(`unsupported KDNA mimetype: ${mimetype}`);

  return {
    entries,
    mimetype,
    archiveDigest: `sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`,
  };
}

function verifyRegistryBinding(verified, expected) {
  if (!expected || typeof expected !== 'object') {
    fail('diff/changelog registry download is missing expected identity metadata');
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(expected.assetDigest || '')) {
    fail('diff/changelog registry asset_digest is missing or not canonical');
  }
  if (verified.archiveDigest !== expected.assetDigest) {
    fail(
      `downloaded bytes do not match registry asset_digest for ${expected.name || 'unknown'}@${expected.version || 'unknown'}`,
    );
  }
  if (typeof expected.name !== 'string' || typeof expected.version !== 'string') {
    fail('diff/changelog registry download is missing expected name or version');
  }

  const manifestEntry = verified.entries.find((entry) => entry.name === 'kdna.json');
  if (!manifestEntry) fail('downloaded KDNA archive has no kdna.json manifest');
  let manifest;
  try {
    manifest = JSON.parse(manifestEntry.data.toString('utf8'));
  } catch {
    fail('downloaded KDNA archive has an invalid kdna.json manifest');
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    fail('downloaded KDNA archive manifest is not a JSON object');
  }

  const identities = [];
  if (typeof manifest.name === 'string' && manifest.name.length > 0) identities.push(manifest.name);
  if (manifest.asset_id !== undefined) {
    const assetName = nameFromAssetId(manifest.asset_id);
    if (!assetName) fail('downloaded KDNA manifest has an invalid asset_id');
    const separator = assetName.indexOf('/');
    const canonicalAssetId = `kdna:${assetName.slice(1, separator)}:${assetName.slice(separator + 1)}`;
    if (manifest.asset_id !== canonicalAssetId) {
      fail('downloaded KDNA manifest asset_id is not canonical');
    }
    identities.push(assetName);
  }
  if (identities.length === 0) fail('downloaded KDNA manifest has no name or asset_id');
  if (identities.some((identity) => identity !== expected.name)) {
    fail(
      `downloaded KDNA identity does not match registry entry ${expected.name}: ${identities.join(', ')}`,
    );
  }
  if (manifest.version !== expected.version) {
    fail(
      `downloaded KDNA version does not match registry entry ${expected.version}: ${manifest.version || 'none'}`,
    );
  }
  return manifest;
}

function assertOrdinaryTree(root) {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) fail(`extracted tree contains a symbolic link: ${entry.name}`);
      if (stat.isDirectory()) {
        pending.push(absolute);
      } else if (!stat.isFile() || stat.nlink !== 1) {
        fail(`extracted tree contains a non-ordinary file: ${entry.name}`);
      }
    }
  }
}

function extractKdnaArchive(archivePath, destination, options = {}) {
  const absoluteDestination = path.resolve(destination);
  const verified = preflightKdnaArchive(archivePath);
  if (options.expected) verifyRegistryBinding(verified, options.expected);
  if (typeof options.onVerifiedArchive === 'function') {
    options.onVerifiedArchive(archivePath, verified);
  }
  if (fs.existsSync(absoluteDestination)) {
    // Never echo the local destination path in a user-facing error.
    const err = new Error('refusing to replace an existing extraction destination');
    err.cliOwned = true;
    throw err;
  }

  const parent = path.dirname(absoluteDestination);
  let staging = null;
  try {
    fs.mkdirSync(parent, { recursive: true });
    staging = fs.mkdtempSync(path.join(parent, `.${path.basename(absoluteDestination)}.extract-`));
    for (const entry of verified.entries) {
      const output = path.join(staging, entry.name);
      const relative = path.relative(staging, output);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        fail(`entry escapes the extraction root: ${entry.name}`);
      }
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, entry.data, { flag: 'wx', mode: 0o600 });
    }
    assertOrdinaryTree(staging);
    fs.renameSync(staging, absoluteDestination);
    staging = null;
    return absoluteDestination;
  } catch (error) {
    if (staging) fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function curlDownload(url, outputPath) {
  assertHttpsDownloadUrl(url);
  // curlFetch normalizes failures into a sterile DownloadError: callers
  // never see curl stderr/stdout, the URL, or the local output path.
  curlFetch(['-fsSL', ...CURL_HTTPS_ONLY_ARGS, '--retry', '2', '-o', outputPath, url], {
    timeout: 60000,
  });
}

function downloadAndExtractKdna(url, destination, options = {}) {
  // HTTPS-only, enforced before any downloader (including injected ones)
  // runs: the archive fetch path must never resolve file:/ftp:/javascript:
  // URLs. Digest/signature verification of the bytes is unchanged.
  assertHttpsDownloadUrl(url);
  const downloadFile = options.downloadFile || curlDownload;
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-download-'));
  const archivePath = path.join(temporaryDirectory, 'asset.kdna');
  try {
    downloadFile(url, archivePath);
    return extractKdnaArchive(archivePath, destination, options);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

module.exports = {
  downloadAndExtractKdna,
  extractKdnaArchive,
  preflightKdnaArchive,
  verifyRegistryBinding,
};
