'use strict';
const { parseJsonBytes, readBoundedFile } = require('./authored-input.js');
const EDIT_LIMIT = 20 * 1024 * 1024;
const invalid = diagnostic => {
  const err = new Error('KDNA_SOURCE_EDITS_INVALID');
  if (diagnostic) err.diagnostic = diagnostic;
  throw err;
};
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// This is an editing transport, not a Source request or a replacement archive.
// Original resources are reopened and retained by the native Source producer.
async function readSourceEdits(file, assertActive = () => {}) {
  let edits;
  try {
    const bytes = await readBoundedFile(file, EDIT_LIMIT, 'KDNA_SOURCE_EDITS_INVALID', assertActive);
    assertActive();
    edits = parseJsonBytes(bytes);
  } catch {
    assertActive();
    invalid();
  }
  if (!record(edits)) invalid();
  if (edits.status === 'source_opened' && record(edits.edits)) {
    edits = edits.edits;
  }
  if (Object.keys(edits).length !== 2
    || !Object.hasOwn(edits, 'manifest') || !Object.hasOwn(edits, 'payload')
    || !record(edits.manifest) || !record(edits.payload)) invalid();
  return edits;
}

// Container-level helpers that let `source-pack` revise a released public asset
// whose container carries an unsigned `checksums.json` manifest.
//
// `checksums.json` pins the byte length and digest of every runtime entry. A
// revision necessarily rewrites `kdna.json` and the section packs, so the old
// manifest can never match the revised entries. When no signature covers the
// container, the checksums carry no authorship claim: they are a derived
// integrity index, and the honest revision is to drop the stale index, pack the
// edits, then derive a fresh index from the new entries with Core's own
// producer. A signed container is never rewritten here; its checksums are part
// of what the signature attests, so the caller must fail closed.
//
// Only Stored ZIP containers (the 0.6.0 container form) are handled. Entries
// are copied verbatim, so the stripped container is byte-identical to the same
// container written without `checksums.json`.

const CHECKSUMS_ENTRY = 'checksums.json';
const SIGNATURE_ENTRY = 'signature.kdsig';
const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

function asBuffer(bytes) {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function findEocd(buf) {
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i--) if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  return -1;
}

// Returns the ordered entry table of a Stored ZIP, or null when the bytes are
// not a container this module can rewrite safely (multi-disk, ZIP64, data
// descriptors, compressed entries, overlapping or truncated records).
function readStoredContainer(bytes) {
  const buf = asBuffer(bytes);
  const eocd = findEocd(buf);
  if (eocd < 0) return null;
  if (buf.readUInt16LE(eocd + 4) !== 0 || buf.readUInt16LE(eocd + 6) !== 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  if (count !== buf.readUInt16LE(eocd + 8) || count === 0xffff) return null;
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || cdOffset + cdSize !== eocd) return null;
  const comment = buf.subarray(eocd + 22, eocd + 22 + buf.readUInt16LE(eocd + 20));
  const entries = [];
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== CENTRAL_SIG) return null;
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const centralEnd = p + 46 + nlen + xlen + clen;
    if (centralEnd > eocd) return null;
    if (method !== 0 || (flags & 0x0008) !== 0 || csize !== usize || csize === 0xffffffff || local === 0xffffffff) return null;
    if (local + 30 > cdOffset || buf.readUInt32LE(local) !== LOCAL_SIG) return null;
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const localEnd = dataStart + csize;
    if (localEnd > cdOffset) return null;
    entries.push({
      name: buf.toString('utf8', p + 46, p + 46 + nlen),
      central: buf.subarray(p, centralEnd),
      local: buf.subarray(local, localEnd),
      data: buf.subarray(dataStart, localEnd),
    });
    p = centralEnd;
  }
  if (p !== eocd) return null;
  return { entries, comment };
}

// Rebuilds the container without the named entry. Local records and central
// records are copied byte for byte; only the central-directory local offsets
// and the end record are recomputed.
function withoutEntry(container, name) {
  const kept = container.entries.filter(e => e.name !== name);
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of kept) {
    const central = Buffer.from(entry.central);
    central.writeUInt32LE(offset, 42);
    locals.push(entry.local);
    centrals.push(central);
    offset += entry.local.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(kept.length, 8);
  eocd.writeUInt16LE(kept.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(container.comment.length, 20);
  return new Uint8Array(Buffer.concat([...locals, cd, eocd, container.comment]));
}

function manifestDeclaresSignature(container) {
  const manifestEntry = container.entries.find(e => e.name === 'kdna.json');
  if (!manifestEntry) return false;
  let manifest;
  try { manifest = JSON.parse(manifestEntry.data.toString('utf8')); } catch { return true; }
  if (!manifest || typeof manifest !== 'object') return true;
  const declares = value => value && typeof value === 'object'
    && Object.keys(value).some(key => /signature|signing|signed_by/i.test(key));
  return declares(manifest) || declares(manifest.integrity);
}

// Classifies a source container for revision:
//   { kind: 'plain' }                       no checksums.json, pack as-is
//   { kind: 'refreshable', stripped }       unsigned checksums.json, strip then re-derive
//   { kind: 'signed' }                      a signature covers the container, refuse
//   { kind: 'unsupported' }                 checksums.json present but container shape not rewritable
function classifySourceContainer(bytes) {
  const container = readStoredContainer(bytes);
  if (!container) {
    return { kind: 'plain' };
  }
  const names = container.entries.map(e => e.name);
  const hasSignature = names.some(n => n === SIGNATURE_ENTRY || n.endsWith('.kdsig')) || manifestDeclaresSignature(container);
  if (!names.includes(CHECKSUMS_ENTRY)) return hasSignature ? { kind: 'signed' } : { kind: 'plain' };
  if (hasSignature) return { kind: 'signed' };
  if (names.filter(n => n === CHECKSUMS_ENTRY).length !== 1) return { kind: 'unsupported' };
  return { kind: 'refreshable', stripped: withoutEntry(container, CHECKSUMS_ENTRY) };
}

function containerHasEntry(bytes, name) {
  const container = readStoredContainer(bytes);
  return Boolean(container && container.entries.some(e => e.name === name));
}

module.exports = { readSourceEdits, CHECKSUMS_ENTRY, SIGNATURE_ENTRY, readStoredContainer, withoutEntry, classifySourceContainer, containerHasEntry };
