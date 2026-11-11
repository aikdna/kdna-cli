'use strict';
// Local password protection of 0.6.0 .kdna assets. No account, no network.
// Everything cryptographic is delegated to the pinned Core/Read public subpaths;
// this module only wires requests, authorities and host callbacks.
const fs = require('node:fs');
const zlib = require('node:zlib');
const { randomUUID, createHash } = require('node:crypto');
const binding = require('../public-contract-binding.json');
const source = require('@aikdna/kdna-core/source-sections-node');
const sections = require('@aikdna/kdna-core/protected-sections-node');
const read = require('@aikdna/kdna-read/protected-sections-node');

const POLICY_ID = 'kdna-cli:explicit-local-read-consent';
const NO_SIGNATURE = Object.freeze({ requireSignature: false, expectedPublicKeyHex: null });
const MAX_PASSWORD_BYTES = 4096;

function digestOf(bytes) { return 'sha256:' + createHash('sha256').update(bytes).digest('hex'); }
function failure(code, extra) { return { status: 'failed', code, ...extra }; }
function zero(bytes) { if (bytes instanceof Uint8Array) bytes.fill(0); }

// Reduce any Core failure to a stable {status:'failed', code} without echoing
// secrets. Core diagnostics carry codes, never the password.
function coreFailure(result, fallback) {
  const d = result && (result.diagnostic || (result.core && result.core.diagnostics && result.core.diagnostics[0]) || result.diagnostic_code);
  const code = (d && (d.code || d.reason)) || (result && (result.code || result.reason)) || fallback;
  return failure(String(code), { core_status: result && result.status });
}

// ---- protected container detection -------------------------------------------------
function zipEntries(bytes) {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const min = Math.max(0, buf.length - 65557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    out.set(buf.toString('utf8', p + 46, p + 46 + nlen), { method, csize, local });
    p += 46 + nlen + xlen + clen;
  }
  return { buf, entries: out };
}
function entryBytes(zip, name) {
  const e = zip.entries.get(name);
  if (!e || zip.buf.readUInt32LE(e.local) !== 0x04034b50) return null;
  const start = e.local + 30 + zip.buf.readUInt16LE(e.local + 26) + zip.buf.readUInt16LE(e.local + 28);
  const raw = zip.buf.subarray(start, start + e.csize);
  return e.method === 0 ? raw : e.method === 8 ? zlib.inflateRawSync(raw) : null;
}
// Cheap, non-authoritative detection: manifest declares protection/encryption.
function isProtectedBytes(bytes) {
  try {
    const zip = zipEntries(bytes);
    if (!zip || !zip.entries.has('kdna.json')) return false;
    const manifest = JSON.parse(entryBytes(zip, 'kdna.json').toString('utf8'));
    return Boolean(manifest && (manifest.protection || (manifest.payload && manifest.payload.encrypted === true)));
  } catch { return false; }
}

// ---- password sources --------------------------------------------------------------
function readPasswordSource({ fd, file } = {}) {
  if ((fd === undefined || fd === null) === (file === undefined || file === null)) throw Object.assign(new Error('KDNA_PASSWORD_SOURCE_REQUIRED'), { code: 'KDNA_PASSWORD_SOURCE_REQUIRED' });
  let raw;
  try { raw = fd !== undefined && fd !== null ? fs.readFileSync(Number(fd)) : fs.readFileSync(file); }
  catch { throw Object.assign(new Error('KDNA_PASSWORD_SOURCE_UNREADABLE'), { code: 'KDNA_PASSWORD_SOURCE_UNREADABLE' }); }
  let end = raw.length;
  if (end > 0 && raw[end - 1] === 0x0a) end--;
  if (end > 0 && raw[end - 1] === 0x0d) end--;
  const out = new Uint8Array(raw.subarray(0, end));
  zero(raw);
  if (out.length === 0 || out.length > MAX_PASSWORD_BYTES) throw Object.assign(new Error('KDNA_PASSWORD_INVALID'), { code: 'KDNA_PASSWORD_INVALID' });
  return out;
}

// ---- protect -----------------------------------------------------------------------
async function protectAsset(plainBytes, passwordBytes, { expectedA, now } = {}) {
  try {
    if (!(plainBytes instanceof Uint8Array) || !(passwordBytes instanceof Uint8Array) || passwordBytes.length === 0) return failure('KDNA_PROTECT_INPUT_INVALID');
    if (isProtectedBytes(plainBytes)) return failure('KDNA_ALREADY_PROTECTED');
    const A = expectedA || digestOf(plainBytes);
    const authority = source.createNativeSourceOperationAuthority(() => true);
    const open = source.admitSourceOperationRequest({ request_id: 'cli:' + randomUUID(), tuple: binding.tuple, operation: 'open_source', expected_A: A, timeout_ms: 60000, signature_policy: NO_SIGNATURE });
    if (open.status !== 'admitted_request') return coreFailure(open, 'KDNA_PROTECT_REQUEST_REJECTED');
    const opened = await source.openSectionSourceNode(plainBytes, open.request, authority);
    if (opened.status !== 'source_opened') return coreFailure(opened, 'KDNA_PROTECT_SOURCE_REJECTED');
    const assetUid = opened.source.manifest.asset_uid;
    const prot = source.admitSourceOperationRequest({ request_id: 'cli:' + randomUUID(), tuple: binding.tuple, operation: 'protect_source', expected_A: A, timeout_ms: 60000, signature_policy: NO_SIGNATURE });
    if (prot.status !== 'admitted_request') return coreFailure(prot, 'KDNA_PROTECT_REQUEST_REJECTED');
    const options = { kind: 'password', asset_uid: assetUid, entitlement: { profile: 'password', offline: true },
      slots: [{ slot: 'primary', kdf_profile: 'scrypt-sha256' }], checksums: true, signature: 'none' };
    const result = await source.protectSectionSourceNode(plainBytes, prot.request, authority, options,
      () => ({ passwords: [{ slot: 'primary', password: new Uint8Array(passwordBytes) }] }));
    if (result.status !== 'produced') return coreFailure(result, 'KDNA_PROTECT_FAILED');
    return result;
  } catch { return failure('KDNA_PROTECT_UNAVAILABLE'); }
}

// ---- admit + read ------------------------------------------------------------------
function wholeRequest() {
  return sections.admitProtectedPayloadRequest({ request_id: 'cli:' + randomUUID(), tuple: binding.tuple, budget_bytes: 1048576, mode: 'whole_asset', selection: null, handle: null });
}
async function admitProtectedWithPassword(bytes, passwordBytes, { now } = {}) {
  const clock = now || Date.now;
  let operation = null;
  try {
    if (!(bytes instanceof Uint8Array) || !(passwordBytes instanceof Uint8Array) || passwordBytes.length === 0) return failure('KDNA_PROTECTED_INPUT_INVALID');
    const request = wholeRequest();
    if (request.channel !== 'admitted_request') return failure('KDNA_PROTECTED_REQUEST_REJECTED');
    const authority = sections.createProtectedPayloadReadAuthority(() => true);
    const admission = await sections.admitProtectedSectionNode(bytes, request.request, authority,
      { credential: { kind: 'password', password: new Uint8Array(passwordBytes) }, signaturePolicy: NO_SIGNATURE }, { kind: 'local', clock });
    if (admission.status !== 'accepted') return coreFailure(admission, 'KDNA_PROTECTED_ADMISSION_FAILED');
    operation = admission.operation;
    const view = sections.inspectProtectedPayloadSnapshot(admission.snapshot);
    if (!view) { sections.disposeProtectedSectionOperation(operation); return failure('READ_SNAPSHOT_UNATTESTED'); }
    let disposed = false;
    return { status: 'accepted', view, snapshot: admission.snapshot, operation, receipt: admission.receipt, clock,
      dispose() { if (!disposed) { disposed = true; try { sections.disposeProtectedSectionOperation(operation); } catch { /* already released */ } } } };
  } catch {
    if (operation) { try { sections.disposeProtectedSectionOperation(operation); } catch { /* ignore */ } }
    return failure('KDNA_PROTECTED_UNAVAILABLE');
  }
}

// request: {mode, budget_bytes?, selection?: {asset_id, asset_version, judgment_ids}, handle?}
async function readProtected(admitted, request = {}) {
  if (!admitted || admitted.status !== 'accepted') return failure('KDNA_PROTECTED_NOT_ADMITTED');
  const clock = admitted.clock || Date.now;
  const authority = sections.createProtectedPayloadReadAuthority(() => true);
  let delivered = null;
  try {
    const bound = sections.bindProtectedPayloadRequest(admitted.operation, {
      request_id: 'cli:' + randomUUID(), tuple: binding.tuple, budget_bytes: request.budget_bytes || 1048576,
      mode: request.mode || 'whole_asset', selection: ['whole_asset', 'catalog'].includes(request.mode || 'whole_asset') ? null : request.selection,
      handle: request.handle || null });
    if (bound.channel !== 'admitted_request') return bound;
    const observe = context => {
      const at = clock(), b = context.binding;
      return { host_id: 'kdna-cli:local', host_epoch: 'process:' + process.pid, decision_id: 'decision:' + context.request.request_id,
        request_id: context.request.request_id, snapshot_id: b.snapshot_id, A: b.A, C: b.C, E: b.E, scope: context.projection_scope.slice(),
        issued_at: at, expires_at: at + 60000, decision: 'allow', policy_id: POLICY_ID, operation_id: b.operation_id,
        capture_id: b.capture_id, request_digest: b.request_digest, read_intent_digest: b.read_intent_digest, tuple: b.tuple, asset: b.asset, current_ms: at };
    };
    const host = read.createTrustedProtectedPayloadHost({
      observe, async deliver(result, prepared) {
        // Core requires the transport commit to happen inside the delivery callback.
        delivered = { result };
        const commit = await read.commitProtectedSectionTransport(admitted.operation, prepared, { observeScope: observe, commit: () => true });
        delivered.commit = commit;
        return commit.status === 'committed';
      } });
    const outcome = await read.readProtectedSectionNode(admitted.operation, bound.request, authority, host);
    if (outcome.status === 'request_failed') return outcome.result;
    if (outcome.status !== 'read_result' || !delivered) return coreFailure(outcome, 'KDNA_PROTECTED_READ_FAILED');
    return delivered.result;
  } catch { return failure('KDNA_PROTECTED_UNAVAILABLE'); }
}

module.exports = { protectAsset, admitProtectedWithPassword, readProtected, isProtectedBytes, readPasswordSource, POLICY_ID };
