'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const INPUT_LIMIT = 20 * 1024 * 1024;
const ASSET_LIMIT = 25 * 1024 * 1024;
const MEMBER_LIMIT = 8 * 1024 * 1024;
const TOTAL_LIMIT = 12 * 1024 * 1024;
// Every transport failure carries the same stable code. Where the reader can
// name the exact field and reason without guessing, it attaches a `diagnostic`
// so the CLI can point at the input position instead of only refusing it.
const invalid = (diagnostic) => {
  const error = new Error('KDNA_AUTHORED_INPUT_INVALID');
  if (diagnostic) error.diagnostic = diagnostic;
  throw error;
};

// JSON.parse alone discards duplicate properties before Core can see them.
// This transport reader checks decoded keys, finite numbers and Unicode first.
function parseJsonBytes(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  let i = 0;
  const space = () => { while (/[\x20\t\r\n]/.test(text[i] || '\0')) i++; };
  function string() {
    const start = i++;
    while (i < text.length) {
      if (text[i] === '\\') { i += 2; continue; }
      if (text[i++] !== '"') continue;
      const value = JSON.parse(text.slice(start, i));
      for (let n = 0; n < value.length; n++) {
        const c = value.charCodeAt(n);
        if (c >= 0xd800 && c <= 0xdbff) {
          const next = value.charCodeAt(++n);
          if (!(next >= 0xdc00 && next <= 0xdfff)) invalid();
        } else if (c >= 0xdc00 && c <= 0xdfff) invalid();
      }
      return value;
    }
    invalid();
  }
  function value(depth) {
    if (depth > 128) invalid();
    space();
    if (text[i] === '"') return string();
    if (text[i] === '{') {
      i++; space();
      const result = {}, keys = new Set();
      if (text[i] === '}') { i++; return result; }
      for (;;) {
        space(); if (text[i] !== '"') invalid();
        const key = string(); if (keys.has(key)) invalid(); keys.add(key);
        space(); if (text[i++] !== ':') invalid();
        Object.defineProperty(result, key, { value: value(depth + 1), enumerable: true, writable: true, configurable: true });
        space(); const end = text[i++];
        if (end === '}') return result;
        if (end !== ',') invalid();
      }
    }
    if (text[i] === '[') {
      i++; space(); const result = [];
      if (text[i] === ']') { i++; return result; }
      for (;;) {
        result.push(value(depth + 1)); space(); const end = text[i++];
        if (end === ']') return result;
        if (end !== ',') invalid();
      }
    }
    for (const [literal, parsed] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(literal, i)) { i += literal.length; return parsed; }
    }
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(i));
    if (!match) invalid();
    i += match[0].length; const parsed = Number(match[0]);
    if (!Number.isFinite(parsed)) invalid();
    return parsed;
  }
  const result = value(0); space(); if (i !== text.length) invalid();
  return result;
}

function keys(value, expected, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalid({ field, reason: 'not_an_object', expected: 'object' });
  }
  const missing = expected.filter(key => !Object.hasOwn(value, key));
  const unexpected = Object.keys(value).filter(key => !expected.includes(key));
  if (missing.length || unexpected.length) {
    invalid({ field, reason: 'key_set', missing, unexpected, expected });
  }
}

async function readBoundedFile(file, limit, code, assertActive = () => {}) {
  // Do not wait for a FIFO writer before verifying the opened descriptor.
  assertActive();
  let handle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW || 0));
    assertActive();
    const stat = await handle.stat();
    assertActive();
    if (!stat.isFile() || stat.size > limit) throw new Error(code);
    // Bound actual reads too: the file may grow after stat().
    const parts = []; let size = 0;
    for (;;) {
      assertActive();
      const part = Buffer.alloc(Math.min(65536, limit + 1 - size));
      const { bytesRead } = await handle.read(part);
      assertActive();
      if (!bytesRead) break;
      size += bytesRead; if (size > limit) throw new Error(code);
      parts.push(part.subarray(0, bytesRead));
    }
    return Buffer.concat(parts, size);
  } catch { throw new Error(code); }
  finally { if (handle) await handle.close(); }
}

async function readAssetBytes(file, assertActive = () => {}) {
  return readBoundedFile(file, ASSET_LIMIT, 'KDNA_ASSET_INPUT_INVALID', assertActive);
}

async function readAuthoredInput(file) {
  let bytes;
  try {
    bytes = await readBoundedFile(file, INPUT_LIMIT, 'KDNA_AUTHORED_INPUT_INVALID');
  } catch {
    // The reader cannot separate "cannot be opened" from "over the transport
    // limit" here; it reports only what it knows.
    invalid({ field: null, reason: 'unreadable_or_over_limit', limit_bytes: INPUT_LIMIT });
  }
  let authored;
  try {
    authored = parseJsonBytes(bytes);
  } catch (error) {
    invalid(error?.diagnostic ?? { field: '/', reason: 'not_json', expected: 'one UTF-8 JSON object' });
  }
  keys(authored, ['manifest', 'payload', 'members'], '/');
  if (!Array.isArray(authored.members)) {
    invalid({
      field: '/members',
      reason: authored.members === null ? 'null' : 'not_array',
      expected: 'array of attachment descriptors',
    });
  }
  if (authored.members.length > 128) {
    invalid({ field: '/members', reason: 'too_many', limit: 128, actual: authored.members.length });
  }
  let total = 0;
  const members = authored.members.map((member, index) => {
    const at = '/members/' + index;
    keys(member, ['name', 'type', 'mode', 'bytes_base64'], at);
    if (typeof member.name !== 'string') invalid({ field: at + '/name', reason: 'wrong_type', expected: 'string' });
    if (member.type !== 'file') invalid({ field: at + '/type', reason: 'wrong_value', expected: 'file', actual: member.type });
    if (!Number.isInteger(member.mode) || member.mode < 0 || member.mode > 65535) {
      invalid({ field: at + '/mode', reason: 'wrong_value', expected: 'integer 0..65535', actual: member.mode });
    }
    if (typeof member.bytes_base64 !== 'string') {
      invalid({ field: at + '/bytes_base64', reason: 'wrong_type', expected: 'canonical base64 string' });
    }
    const encoded = member.bytes_base64;
    if (encoded.length > 4 * Math.ceil(MEMBER_LIMIT / 3) || encoded.length % 4 !== 0) {
      invalid({ field: at + '/bytes_base64', reason: 'over_limit_or_not_padded', limit_bytes: MEMBER_LIMIT });
    }
    let body;
    try {
      body = Buffer.from(encoded, 'base64');
    } catch {
      invalid({ field: at + '/bytes_base64', reason: 'not_base64' });
    }
    total += body.length;
    if (body.toString('base64') !== encoded) {
      invalid({ field: at + '/bytes_base64', reason: 'not_canonical_base64' });
    }
    if (body.length > MEMBER_LIMIT) {
      invalid({ field: at + '/bytes_base64', reason: 'over_limit', limit_bytes: MEMBER_LIMIT, actual: body.length });
    }
    if (total > TOTAL_LIMIT) {
      invalid({ field: '/members', reason: 'over_limit', limit_bytes: TOTAL_LIMIT, actual: total });
    }
    return { name: member.name, type: member.type, mode: member.mode, bytes: new Uint8Array(body) };
  });
  return { manifest: authored.manifest, payload: authored.payload, members };
}

async function saveNewAsset(file, bytes, assertActive = () => {}) {
  const temporary = path.join(path.dirname(file), '.kdna-save-' + randomUUID());
  let handle, owned = false, published = false;
  try {
    assertActive();
    handle = await fs.open(temporary, 'wx', 0o600); owned = true;
    await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
    assertActive();
    // link() commits the complete file atomically and never replaces a target.
    await fs.link(temporary, file); published = true;
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('KDNA_OUTPUT_EXISTS');
    throw new Error('KDNA_SAVE_FAILED');
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    if (owned) {
      try { await fs.unlink(temporary); }
      catch { if (published) return { cleanup: 'temporary_retained' }; }
    }
  }
  return { cleanup: 'complete' };
}

module.exports = { parseJsonBytes, readAuthoredInput, readAssetBytes, readBoundedFile, saveNewAsset };
