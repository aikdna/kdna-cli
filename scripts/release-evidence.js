'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const zlib = require('node:zlib');
const { COMMIT_RE, EXPECTED_PACKAGE_NAME, STABLE_VERSION_RE } = require('./release-policy');

const REQUIRED_PACK_FILES = Object.freeze([
  'package.json',
  'src/cli.js',
  'src/runtime-contract.js',
  'src/agent-host-capabilities.js',
  'src/agent-host-process.js',
  'src/cmds/_kdna-eval.js',
  'src/cmds/plan-use.js',
  'src/cmds/use.js',
  'validators/kdna-lint.js',
  'validators/kdna-validate.js',
  'skills/kdna-loader/SKILL.md',
  'schema/manifest.schema.json',
  'schema/payload-profile.schema.json',
  'schema/load-contract.schema.json',
  'schema/trace.schema.json',
  'fixtures/minimal/kdna.json',
  'fixtures/minimal/payload.kdnab',
  'fixtures/judgment/kdna.json',
  'fixtures/judgment/payload.kdnab',
]);
const ALLOWED_PACK_ROOTS = Object.freeze([
  'fixtures/',
  'schema/',
  'skills/',
  'src/',
  'templates/',
  'validators/',
]);
const ALLOWED_PACK_FILES = new Set([
  'LICENSE',
  'NOTICE',
  'README.md',
  'SECURITY.md',
  'package.json',
]);
const FORBIDDEN_PACK_FILES = new Set(['src/loader.js', 'src/runner.js', 'src/verify.js']);
const FORBIDDEN_COORDINATION_FILES = new Set(['agents.md', 'worklog.md']);
const SENSITIVE_PACK_NAME_PATTERNS = Object.freeze([
  /(?:^|[-_.])(private|internal|confidential)(?:[-_.]|$)/i,
  /(?:^|[-_.])launch[-_.]?plan(?:[-_.]|$)/i,
  /(?:^|[-_.])(credentials?|tokens?)(?:[-_.]|$)/i,
  /^\.env(?:\.|$)/i,
  /\.(?:pem|key|p12|pfx)$/i,
]);
const SENSITIVE_DATA_NAME_PATTERN = /(?:^|[-_.])secrets?(?:[-_.]|$)/i;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isCanonicalSha512Integrity(value) {
  if (typeof value !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(value)) return false;
  const encoded = value.slice('sha512-'.length);
  const digest = Buffer.from(encoded, 'base64');
  return digest.length === 64 && digest.toString('base64') === encoded;
}

function parseJsonDocument(text, label) {
  assert(typeof text === 'string' && text.trim().length > 0, `${label} must not be empty`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} must be one complete JSON document`);
  }
}

function parseTarNumber(field) {
  if (field[0] & 0x80) {
    const bytes = Buffer.from(field);
    bytes[0] &= 0x7f;
    let value = 0n;
    for (const byte of bytes) value = value * 256n + BigInt(byte);
    assert(value <= BigInt(Number.MAX_SAFE_INTEGER), 'tar entry size exceeds the safe range');
    return Number(value);
  }
  const text = field.toString('ascii').replace(/\0.*$/, '').trim();
  assert(/^[0-7]*$/.test(text), 'tar header contains an invalid numeric field');
  return text === '' ? 0 : Number.parseInt(text, 8);
}

function parsePax(buffer) {
  const values = {};
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    assert(space > offset, 'invalid PAX record length');
    const lengthText = buffer.subarray(offset, space).toString('ascii');
    assert(/^[1-9]\d*$/.test(lengthText), 'invalid PAX record length');
    const length = Number(lengthText);
    assert(
      Number.isSafeInteger(length) && offset + length <= buffer.length,
      'truncated PAX record',
    );
    const record = buffer.subarray(space + 1, offset + length - 1).toString('utf8');
    assert(buffer[offset + length - 1] === 0x0a, 'PAX record must end with a newline');
    const equals = record.indexOf('=');
    assert(equals > 0, 'invalid PAX record');
    values[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return values;
}

function parseTarFiles(tarball) {
  const archive = zlib.gunzipSync(tarball);
  const files = [];
  let offset = 0;
  let pax = {};
  let longName = null;
  let sawEnd = false;

  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      sawEnd = true;
      break;
    }

    const storedChecksum = parseTarNumber(header.subarray(148, 156));
    let computedChecksum = 0;
    for (let index = 0; index < header.length; index += 1) {
      computedChecksum += index >= 148 && index < 156 ? 0x20 : header[index];
    }
    assert(storedChecksum === computedChecksum, 'tar header checksum mismatch');

    const size = parseTarNumber(header.subarray(124, 136));
    const type = String.fromCharCode(header[156] || 0x30);
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const headerName = prefix ? `${prefix}/${name}` : name;
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    assert(dataEnd <= archive.length, 'truncated tar entry');
    const data = archive.subarray(dataStart, dataEnd);

    if (type === 'x') {
      pax = parsePax(data);
    } else if (type === 'L') {
      longName = data.toString('utf8').replace(/\0.*$/, '');
    } else {
      const effectiveName = pax.path || longName || headerName;
      const effectiveSize = pax.size === undefined ? size : Number(pax.size);
      assert(Number.isSafeInteger(effectiveSize) && effectiveSize >= 0, 'invalid PAX file size');
      if (type === '0' || type === '\0') {
        assert(effectiveName.startsWith('package/'), 'packed file must be rooted under package/');
        const packagePath = effectiveName.slice('package/'.length);
        assert(
          packagePath &&
            !packagePath.startsWith('/') &&
            !packagePath.split('/').some((segment) => segment === '..' || segment === ''),
          'unsafe packed path',
        );
        files.push({ path: packagePath, size: effectiveSize });
      }
      pax = {};
      longName = null;
    }

    offset = dataStart + Math.ceil(size / 512) * 512;
  }

  assert(sawEnd, 'tar archive is missing its zero-block terminator');
  files.sort((left, right) => left.path.localeCompare(right.path));
  const unique = new Set(files.map((file) => file.path));
  assert(unique.size === files.length, 'tar archive contains duplicate file paths');
  return files;
}

function validatePackedFilePolicy(files) {
  assert(Array.isArray(files) && files.length > 0, 'packed file list must not be empty');
  const paths = new Set(files.map((file) => file.path));
  for (const required of REQUIRED_PACK_FILES) {
    assert(paths.has(required), `required packed file is missing: ${required}`);
  }
  for (const file of files) {
    const allowed =
      ALLOWED_PACK_FILES.has(file.path) ||
      ALLOWED_PACK_ROOTS.some((prefix) => file.path.startsWith(prefix));
    assert(allowed, `unexpected packed file: ${file.path}`);
    assert(!FORBIDDEN_PACK_FILES.has(file.path), `retired implementation was packed: ${file.path}`);
    const basename = path.posix.basename(file.path);
    assert(
      !FORBIDDEN_COORDINATION_FILES.has(basename.toLowerCase()),
      `private coordination file was packed: ${file.path}`,
    );
    assert(
      !SENSITIVE_PACK_NAME_PATTERNS.some((pattern) => pattern.test(basename)) &&
        !(
          path.posix.extname(basename).toLowerCase() !== '.js' &&
          SENSITIVE_DATA_NAME_PATTERN.test(basename)
        ),
      `sensitive-category file was packed: ${file.path}`,
    );
    assert(!file.path.endsWith('.tgz'), `nested package artifact was packed: ${file.path}`);
    assert(!file.path.includes('.DS_Store'), `local metadata was packed: ${file.path}`);
  }
  return files;
}

function validatePackReport({ reportText, tarball, pkg, source }) {
  assert(pkg.name === EXPECTED_PACKAGE_NAME, `package name must be ${EXPECTED_PACKAGE_NAME}`);
  assert(STABLE_VERSION_RE.test(pkg.version), 'package version must be stable canonical SemVer');
  assert(source.ref === `refs/tags/${pkg.version}`, 'source ref must be the canonical version tag');
  assert(COMMIT_RE.test(source.commit || ''), 'source commit must be 40-character lowercase hex');

  const reports = parseJsonDocument(reportText, 'npm pack output');
  assert(
    Array.isArray(reports) && reports.length === 1,
    'npm pack must report exactly one artifact',
  );
  const report = reports[0];
  assert(
    report && typeof report === 'object' && !Array.isArray(report),
    'npm pack report is invalid',
  );
  assert(report.name === pkg.name && report.version === pkg.version, 'npm pack identity mismatch');
  assert(
    typeof report.filename === 'string' && path.basename(report.filename) === report.filename,
    'unsafe pack filename',
  );
  assert(Buffer.isBuffer(tarball) && tarball.length > 0, 'packed tarball is empty');

  const shasum = crypto.createHash('sha1').update(tarball).digest('hex');
  const integrity = `sha512-${crypto.createHash('sha512').update(tarball).digest('base64')}`;
  assert(/^[0-9a-f]{40}$/.test(shasum), 'computed shasum is not canonical SHA-1');
  assert(report.shasum === shasum, 'npm pack shasum does not match the tarball bytes');
  assert(report.integrity === integrity, 'npm pack integrity does not match the tarball bytes');
  assert(report.size === tarball.length, 'npm pack size does not match the tarball bytes');

  const files = parseTarFiles(tarball);
  validatePackedFilePolicy(files);
  const reportedFiles = Array.isArray(report.files)
    ? report.files
        .map((file) => ({ path: file.path, size: file.size }))
        .sort((a, b) => a.path.localeCompare(b.path))
    : null;
  assert(reportedFiles !== null, 'npm pack must report its files');
  assert(
    JSON.stringify(reportedFiles) === JSON.stringify(files),
    'npm pack file report does not match the tarball',
  );
  const unpackedSize = files.reduce((total, file) => total + file.size, 0);
  assert(report.entryCount === files.length, 'npm pack entry count does not match the tarball');
  assert(report.unpackedSize === unpackedSize, 'npm pack unpacked size does not match the tarball');

  return Object.freeze({
    schema: 'kdna.cli.release-evidence',
    version: '1.0',
    source: { ref: source.ref, commit: source.commit },
    package: { name: pkg.name, version: pkg.version },
    artifact: {
      filename: report.filename,
      integrity,
      shasum,
      packed_size: tarball.length,
      unpacked_size: unpackedSize,
      file_count: files.length,
      files,
    },
  });
}

function validateReleaseEvidence(evidence) {
  assert(
    evidence && typeof evidence === 'object' && !Array.isArray(evidence),
    'release evidence must be an object',
  );
  assert(
    evidence.schema === 'kdna.cli.release-evidence' && evidence.version === '1.0',
    'release evidence schema mismatch',
  );
  assert(
    evidence.package && evidence.package.name === EXPECTED_PACKAGE_NAME,
    'release evidence package mismatch',
  );
  assert(
    STABLE_VERSION_RE.test(evidence.package.version || ''),
    'release evidence version is invalid',
  );
  assert(
    evidence.source && evidence.source.ref === `refs/tags/${evidence.package.version}`,
    'release evidence ref mismatch',
  );
  assert(COMMIT_RE.test(evidence.source.commit || ''), 'release evidence commit is invalid');
  const artifact = evidence.artifact;
  assert(
    artifact && isCanonicalSha512Integrity(artifact.integrity),
    'release evidence integrity is invalid',
  );
  assert(/^[0-9a-f]{40}$/.test(artifact.shasum || ''), 'release evidence shasum is invalid');
  assert(
    Number.isSafeInteger(artifact.packed_size) && artifact.packed_size > 0,
    'release evidence packed size is invalid',
  );
  assert(
    Number.isSafeInteger(artifact.unpacked_size) && artifact.unpacked_size > 0,
    'release evidence unpacked size is invalid',
  );
  assert(
    Number.isSafeInteger(artifact.file_count) && artifact.file_count > 0,
    'release evidence file count is invalid',
  );
  assert(
    Array.isArray(artifact.files) && artifact.files.length === artifact.file_count,
    'release evidence files mismatch',
  );
  return evidence;
}

function validateEvidenceArtifact(rawEvidence, tarball) {
  const evidence = validateReleaseEvidence(rawEvidence);
  assert(Buffer.isBuffer(tarball) && tarball.length > 0, 'verified release artifact is empty');
  const shasum = crypto.createHash('sha1').update(tarball).digest('hex');
  const integrity = `sha512-${crypto.createHash('sha512').update(tarball).digest('base64')}`;
  assert(
    tarball.length === evidence.artifact.packed_size,
    'verified artifact packed size mismatch',
  );
  assert(shasum === evidence.artifact.shasum, 'verified artifact shasum mismatch');
  assert(integrity === evidence.artifact.integrity, 'verified artifact integrity mismatch');
  const files = parseTarFiles(tarball);
  validatePackedFilePolicy(files);
  assert(
    JSON.stringify(files) === JSON.stringify(evidence.artifact.files),
    'verified artifact files mismatch',
  );
  assert(files.length === evidence.artifact.file_count, 'verified artifact file count mismatch');
  const unpackedSize = files.reduce((total, file) => total + file.size, 0);
  assert(
    unpackedSize === evidence.artifact.unpacked_size,
    'verified artifact unpacked size mismatch',
  );
  return evidence;
}

module.exports = {
  parseJsonDocument,
  parseTarFiles,
  validatePackedFilePolicy,
  validatePackReport,
  validateEvidenceArtifact,
  validateReleaseEvidence,
};
