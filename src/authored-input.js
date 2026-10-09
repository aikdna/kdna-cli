'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const INPUT_LIMIT = 20 * 1024 * 1024;
const ASSET_LIMIT = 25 * 1024 * 1024;
const MEMBER_LIMIT = 8 * 1024 * 1024;
const TOTAL_LIMIT = 12 * 1024 * 1024;
const invalid = () => { throw new Error('KDNA_AUTHORED_INPUT_INVALID'); };

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

function keys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) invalid();
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
  const bytes = await readBoundedFile(file, INPUT_LIMIT, 'KDNA_AUTHORED_INPUT_INVALID');
  const authored = parseJsonBytes(bytes);
  keys(authored, ['manifest', 'payload', 'members']);
  if (!Array.isArray(authored.members) || authored.members.length > 128) invalid();
  let total = 0;
  const members = authored.members.map(member => {
    keys(member, ['name', 'type', 'mode', 'bytes_base64']);
    if (typeof member.name !== 'string' || member.type !== 'file' || !Number.isInteger(member.mode)
      || member.mode < 0 || member.mode > 65535 || typeof member.bytes_base64 !== 'string') invalid();
    const encoded = member.bytes_base64;
    if (encoded.length > 4 * Math.ceil(MEMBER_LIMIT / 3) || encoded.length % 4 !== 0) invalid();
    const body = Buffer.from(encoded, 'base64');
    total += body.length;
    if (body.toString('base64') !== encoded || body.length > MEMBER_LIMIT || total > TOTAL_LIMIT) invalid();
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
