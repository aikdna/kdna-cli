// KDNA dev pack — v2 container support
// Produces KDNA Container v2 (.kdna files with CBOR payload.kdnab) from dev source directories.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cbor = require('cbor-x');

const KDNA_FILES = [
  'KDNA_Core.json', 'KDNA_Patterns.json', 'KDNA_Scenarios.json',
  'KDNA_Cases.json', 'KDNA_Reasoning.json', 'KDNA_Evolution.json',
];

function packV2(sourceDir, manifest, options = {}) {
  const abs = path.resolve(sourceDir);

  // 1. Read source files
  const judgment = {};
  for (const f of KDNA_FILES) {
    const filePath = path.join(abs, f);
    if (fs.existsSync(filePath)) {
      try { judgment[f.replace(/^KDNA_/, '').replace(/\.json$/, '').toLowerCase()] = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
      catch { /* skip unreadable */ }
    }
  }

  // 2. Build CBOR payload
  const payload = {
    kind: 'kdna.payload',
    payload_version: '2.0',
    domain: { name: manifest.name || '', version: manifest.version || '0.1.0' },
    judgment,
    profiles: {},
    integrity: {
      source_tree_digest: `sha256:${computeDirHash(abs)}`,
    },
  };
  const payloadBuf = cbor.encode(payload);

  // 3. Build manifest (v2)
  const v2Manifest = {
    ...manifest,
    format_version: '2.0',
    spec_version: '2.0',
    container: {
      type: 'kdna-container-v2',
      payload: 'payload.kdnab',
      payload_encoding: 'cbor',
      payload_schema: 'kdna-payload-v2',
      payload_digest: `sha256:${crypto.createHash('sha256').update(payloadBuf).digest('hex')}`,
    },
    runtime: {
      min_runtime_version: '0.3.0',
      load_contract: 'context-capsule-v1',
    },
  };

  return {
    entries: {
      'mimetype': 'application/vnd.aikdna.kdna+zip',
      'kdna.json': JSON.stringify(v2Manifest, null, 2),
      'payload.kdnab': payloadBuf,
    },
    manifest: v2Manifest,
    payload,
  };
}

function computeDirHash(dir) {
  const files = fs.readdirSync(dir).filter(f => fs.statSync(path.join(dir, f)).isFile()).sort();
  const hash = crypto.createHash('sha256');
  for (const f of files) {
    hash.update(f);
    hash.update(fs.readFileSync(path.join(dir, f)));
  }
  return hash.digest('hex');
}

function verifySourceIntegrity(sourceDir, expectedDigest) {
  if (!expectedDigest) return { valid: false, error: 'No expected digest provided' };
  const actual = `sha256:${computeDirHash(sourceDir)}`;
  if (actual !== expectedDigest) {
    return { valid: false, error: `Digest mismatch: expected ${expectedDigest}, got ${actual}` };
  }
  return { valid: true, digest: actual };
}

module.exports = { packV2, verifySourceIntegrity, computeDirHash };
