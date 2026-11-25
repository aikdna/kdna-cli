'use strict';
// Local password protection of 0.6.0 .kdna assets. No account, no network.
// Everything cryptographic is delegated to the pinned Core/Read public subpaths;
// this module only wires requests, authorities and host callbacks.
const fs = require('node:fs');
const zlib = require('node:zlib');
const { randomUUID, createHash } = require('node:crypto');
const binding = require('../public-contract-binding.json');
let _source = null, _sections = null, _read = null, _creation = null;
const getSource = () => _source ?? (_source = require('@aikdna/kdna-core/source-sections-node'));
const getSections = () => _sections ?? (_sections = require('@aikdna/kdna-core/protected-sections-node'));
const getRead = () => _read ?? (_read = require('@aikdna/kdna-read/protected-sections-node'));
const getCreation = () => _creation ?? (_creation = require('@aikdna/kdna-core/creation-sections-node'));

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

// Non-authoritative pre-unlock manifest reader: reads ONLY unencrypted outer
// kdna.json metadata and container entry names without touching payload.kdnab.
function readUnencryptedManifestSummary(bytes) {
  try {
    const zip = zipEntries(bytes);
    if (!zip || !zip.entries.has('kdna.json')) return null;
    const raw = entryBytes(zip, 'kdna.json');
    if (!raw) return null;
    const manifest = JSON.parse(raw.toString('utf8'));
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return null;
    const locked = Boolean(manifest.protection || manifest.encryption || (manifest.payload && manifest.payload.encrypted === true));
    const asset = {
      asset_id: manifest.asset_id ?? null,
      asset_uid: manifest.asset_uid ?? null,
      asset_type: manifest.asset_type ?? null,
      asset_version: manifest.version ?? null,
      judgment_version: manifest.judgment_version ?? null,
      title: manifest.title ?? null,
      summary: manifest.summary ?? null,
      languages: Array.isArray(manifest.languages) ? manifest.languages : [],
      ...(manifest.creator ? { creator: manifest.creator } : {}),
      ...(manifest.license ? { license: manifest.license } : {}),
      ...(Array.isArray(manifest.keywords) && manifest.keywords.length ? { keywords: manifest.keywords } : {}),
      ...(manifest.created_at ? { created_at: manifest.created_at } : {}),
      ...(manifest.updated_at ? { updated_at: manifest.updated_at } : {}),
      ...(manifest.format_version ? { format_version: manifest.format_version } : {}),
    };
    const protection = locked ? {
      status: 'locked',
      profile: manifest.entitlement?.profile ?? manifest.protection?.profile ?? 'password',
      offline: manifest.entitlement?.offline ?? true,
      encrypted_entries: Array.isArray(manifest.encryption?.encrypted_entries)
        ? manifest.encryption.encrypted_entries
        : ['payload.kdnab'],
      ...(manifest.encryption?.profile ? {
        encryption: {
          profile: manifest.encryption.profile,
          ...(manifest.encryption.profile_version ? { profile_version: manifest.encryption.profile_version } : {}),
        },
      } : {}),
    } : null;
    return {
      locked,
      asset,
      protection,
      entries: [...zip.entries.keys()],
    };
  } catch { return null; }
}

// ---- password sources --------------------------------------------------------------
function normalizePasswordBytes(raw) {
  let end = raw.length;
  if (end > 0 && raw[end - 1] === 0x0a) end--;
  if (end > 0 && raw[end - 1] === 0x0d) end--;
  const out = new Uint8Array(raw.subarray(0, end));
  zero(raw);
  if (out.length === 0 || out.length > MAX_PASSWORD_BYTES) {
    zero(out);
    throw Object.assign(new Error('KDNA_PASSWORD_INVALID'), { code: 'KDNA_PASSWORD_INVALID' });
  }
  return out;
}

function readPasswordSource({ fd, file, env } = {}) {
  const present = [fd !== undefined && fd !== null, file !== undefined && file !== null, env !== undefined && env !== null].filter(Boolean).length;
  if (present !== 1) throw Object.assign(new Error('KDNA_PASSWORD_SOURCE_REQUIRED'), { code: 'KDNA_PASSWORD_SOURCE_REQUIRED' });
  if (env !== undefined && env !== null) {
    if (typeof env !== 'string' || env.length === 0) throw Object.assign(new Error('KDNA_PASSWORD_SOURCE_REQUIRED'), { code: 'KDNA_PASSWORD_SOURCE_REQUIRED' });
    if (!Object.hasOwn(process.env, env) || process.env[env] === undefined) {
      throw Object.assign(new Error('KDNA_PASSWORD_ENV_UNSET'), { code: 'KDNA_PASSWORD_ENV_UNSET' });
    }
    const raw = Buffer.from(String(process.env[env]), 'utf8');
    return normalizePasswordBytes(raw);
  }
  let raw;
  try { raw = fd !== undefined && fd !== null ? fs.readFileSync(Number(fd)) : fs.readFileSync(file); }
  catch { throw Object.assign(new Error('KDNA_PASSWORD_SOURCE_UNREADABLE'), { code: 'KDNA_PASSWORD_SOURCE_UNREADABLE' }); }
  return normalizePasswordBytes(raw);
}

function readHiddenLine(stdin, stderr, label) {
  return new Promise((resolve, reject) => {
    if (!stdin || stdin.isTTY !== true || typeof stdin.setRawMode !== 'function') {
      reject(Object.assign(new Error('KDNA_PASSWORD_TTY_REQUIRED'), { code: 'KDNA_PASSWORD_TTY_REQUIRED' }));
      return;
    }
    const wasRaw = Boolean(stdin.isRaw);
    const chars = [];
    let settled = false;
    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.removeListener('end', onEnd);
      stdin.removeListener('error', onError);
      try { stdin.setRawMode(wasRaw); } catch { /* ignore */ }
      try { stdin.pause(); } catch { /* ignore */ }
    };
    const finishError = (code) => {
      if (settled) return;
      settled = true;
      chars.length = 0;
      cleanup();
      try { stderr?.write?.('\n'); } catch { /* ignore */ }
      reject(Object.assign(new Error(code), { code }));
    };
    const finishOk = () => {
      if (settled) return;
      settled = true;
      cleanup();
      try { stderr?.write?.('\n'); } catch { /* ignore */ }
      const raw = Buffer.from(chars.join(''), 'utf8');
      chars.length = 0;
      try {
        resolve(normalizePasswordBytes(raw));
      } catch (error) {
        reject(error);
      }
    };
    const onData = (chunk) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      for (const ch of text) {
        if (ch === '\r' || ch === '\n') { finishOk(); return; }
        if (ch === '\u0003' || ch === '\u0004') { finishError('KDNA_PASSWORD_PROMPT_CANCELED'); return; }
        if (ch === '\u007f' || ch === '\b') { if (chars.length > 0) chars.pop(); continue; }
        const code = ch.codePointAt(0);
        if (code >= 0x20 || ch === '\t') chars.push(ch);
      }
    };
    const onEnd = () => finishError('KDNA_PASSWORD_PROMPT_CANCELED');
    const onError = () => finishError('KDNA_PASSWORD_SOURCE_UNREADABLE');
    try {
      stderr?.write?.(label);
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on('data', onData);
      stdin.on('end', onEnd);
      stdin.on('error', onError);
    } catch {
      finishError('KDNA_PASSWORD_TTY_REQUIRED');
    }
  });
}

async function readPasswordPrompt({
  stdin = process.stdin,
  stderr = process.stderr,
  confirm = false,
  promptText = 'Enter KDNA passphrase: ',
  confirmPromptText = 'Confirm KDNA passphrase: ',
} = {}) {
  if (!stdin || stdin.isTTY !== true || typeof stdin.setRawMode !== 'function') {
    throw Object.assign(new Error('KDNA_PASSWORD_TTY_REQUIRED'), { code: 'KDNA_PASSWORD_TTY_REQUIRED' });
  }
  const first = await readHiddenLine(stdin, stderr, promptText);
  if (!confirm) return first;
  let second;
  try {
    second = await readHiddenLine(stdin, stderr, confirmPromptText);
  } catch (error) {
    zero(first);
    throw error;
  }
  let diff = first.length ^ second.length;
  const len = Math.min(first.length, second.length);
  for (let i = 0; i < len; i++) diff |= first[i] ^ second[i];
  zero(second);
  if (diff !== 0) {
    zero(first);
    throw Object.assign(new Error('KDNA_PASSWORD_MISMATCH'), { code: 'KDNA_PASSWORD_MISMATCH' });
  }
  return first;
}

// ---- protect / unprotect -----------------------------------------------------------
async function protectAsset(plainBytes, passwordBytes, { expectedA, now } = {}) {
  try {
    if (!(plainBytes instanceof Uint8Array) || !(passwordBytes instanceof Uint8Array) || passwordBytes.length === 0) return failure('KDNA_PROTECT_INPUT_INVALID');
    if (isProtectedBytes(plainBytes)) return failure('KDNA_ALREADY_PROTECTED');
    const source = getSource();
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

async function unprotectAsset(protectedBytes, passwordBytes, { expectedA, now } = {}) {
  const clock = now || Date.now;
  try {
    if (!(protectedBytes instanceof Uint8Array) || !(passwordBytes instanceof Uint8Array) || passwordBytes.length === 0) return failure('KDNA_UNPROTECT_INPUT_INVALID');
    if (!isProtectedBytes(protectedBytes)) return failure('KDNA_NOT_PROTECTED');
    const source = getSource(), creation = getCreation();
    const A = expectedA || digestOf(protectedBytes);
    const authority = source.createNativeSourceOperationAuthority(() => true);
    const openReq = source.admitSourceOperationRequest({
      request_id: 'cli:' + randomUUID(),
      tuple: binding.tuple,
      operation: 'open_protected_source',
      expected_A: A,
      timeout_ms: 60000,
      signature_policy: NO_SIGNATURE,
    });
    if (openReq.status !== 'admitted_request') return coreFailure(openReq, 'KDNA_UNPROTECT_REQUEST_REJECTED');
    const contextId = 'ctx:' + randomUUID(), epoch = 'process:' + process.pid;
    let unlocked = null, expiresAt = null, lastMs = 0;
    const host = source.createTrustedProtectedSectionSourceHost({
      observe() {
        const at = Math.max(clock(), lastMs);
        lastMs = at;
        if (expiresAt === null) expiresAt = at + 60000;
        return {
          context_id: contextId,
          epoch,
          asset_digest: A,
          permission: 'allowed',
          scope: 'complete_source',
          current_ms: at,
          expires_at_ms: expiresAt,
          revoked: false,
        };
      },
      async deliver(bundle) {
        unlocked = bundle;
        return true;
      },
    });
    const opened = await source.withProtectedSectionSourceNode(
      protectedBytes,
      openReq.request,
      authority,
      { credential: { kind: 'password', password: new Uint8Array(passwordBytes) }, signaturePolicy: NO_SIGNATURE },
      { kind: 'local', clock },
      host,
    );
    if (opened.status !== 'source_delivered' || !unlocked) return coreFailure(opened, 'KDNA_UNPROTECT_FAILED');
    const cleanManifest = structuredClone(unlocked.manifest);
    for (const k of ['format_version', 'payload', 'representation_profile', 'representation_metadata', 'representation_origin', 'encryption', 'entitlement']) {
      delete cleanManifest[k];
    }
    if (cleanManifest.access === 'licensed') delete cleanManifest.access;
    if (cleanManifest.runtime && Array.isArray(cleanManifest.runtime.mandatory_entries)) {
      cleanManifest.runtime = {
        ...cleanManifest.runtime,
        mandatory_entries: cleanManifest.runtime.mandatory_entries.filter(n => n !== 'payload.kdnab' && !n.startsWith('sections/')),
      };
    }
    const members = (unlocked.original_members ?? [])
      .filter(m => typeof m?.name === 'string' && m.name.startsWith('attachments/'))
      .map(m => ({ name: m.name, type: m.type, mode: m.mode, bytes: new Uint8Array(m.bytes) }));
    const createReq = creation.admitNativeCreationRequest({
      request_id: 'cli:' + randomUUID(),
      tuple: binding.tuple,
      operation: 'create_public_asset',
      timeout_ms: 60000,
    });
    if (createReq.status !== 'admitted_request') return coreFailure(createReq, 'KDNA_UNPROTECT_CREATE_REJECTED');
    const produced = await creation.createSectionAssetNode(
      { manifest: cleanManifest, payload: structuredClone(unlocked.payload), members },
      createReq.request,
      creation.createNativeCreationAuthority(() => true),
    );
    if (produced.status !== 'produced') return coreFailure(produced, 'KDNA_UNPROTECT_PACK_FAILED');
    return { status: 'produced', bytes: produced.bytes, evidence: produced.evidence, source_A: A };
  } catch { return failure('KDNA_UNPROTECT_UNAVAILABLE'); }
}

// ---- admit + read ------------------------------------------------------------------
function wholeRequest() {
  return getSections().admitProtectedPayloadRequest({ request_id: 'cli:' + randomUUID(), tuple: binding.tuple, budget_bytes: 1048576, mode: 'whole_asset', selection: null, handle: null });
}
async function admitProtectedWithPassword(bytes, passwordBytes, { now } = {}) {
  const clock = now || Date.now;
  const sections = getSections();
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
  const sections = getSections(), read = getRead();
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

module.exports = {
  protectAsset,
  unprotectAsset,
  admitProtectedWithPassword,
  readProtected,
  isProtectedBytes,
  readUnencryptedManifestSummary,
  readPasswordSource,
  readPasswordPrompt,
  POLICY_ID,
};
