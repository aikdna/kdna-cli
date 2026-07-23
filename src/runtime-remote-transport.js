'use strict';

const MAX_REMOTE_URL_BYTES = 2048;
const MAX_REMOTE_RESPONSE_BYTES = 1024 * 1024;

function isExactLoopback(hostname) {
  return hostname === '127.0.0.1' || hostname === '[::1]';
}

function remoteProjectionEndpoint(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > MAX_REMOTE_URL_BYTES ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return (
        character === '\\' ||
        character === '?' ||
        character === '#' ||
        codePoint < 0x21 ||
        codePoint > 0x7e
      );
    })
  ) {
    throw new Error('remote URL is not canonical visible ASCII');
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('remote URL must be absolute');
  }
  if (
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.protocol !== 'https:' &&
      !(parsed.protocol === 'http:' && isExactLoopback(parsed.hostname)))
  ) {
    throw new Error('remote URL must be canonical HTTPS or exact loopback HTTP');
  }

  const endpoint = `${parsed.origin}/project`;
  if (![parsed.origin, `${parsed.origin}/`, endpoint].includes(value)) {
    throw new Error('remote URL must be an origin or the exact /project endpoint');
  }
  return endpoint;
}

function safeRemoteCode(value) {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value)
    ? value
    : 'REMOTE_REQUEST_REJECTED';
}

async function readBoundedFetchJson(response) {
  const contentType = response.headers.get('content-type') || '';
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType)) {
    await response.body?.cancel().catch(() => {});
    throw new Error('remote response is not canonical JSON');
  }

  const contentLength = response.headers.get('content-length');
  if (
    contentLength !== null &&
    (!/^(0|[1-9]\d*)$/u.test(contentLength) || Number(contentLength) > MAX_REMOTE_RESPONSE_BYTES)
  ) {
    await response.body?.cancel().catch(() => {});
    throw new Error('remote response size is invalid');
  }
  if (!response.body) throw new Error('remote response has no body');

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REMOTE_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('remote response is too large');
      }
      chunks.push(Buffer.from(value));
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total));
    const payload = JSON.parse(text);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('remote response must be a JSON object');
    }
    return payload;
  } finally {
    reader.releaseLock();
  }
}

module.exports = {
  MAX_REMOTE_RESPONSE_BYTES,
  readBoundedFetchJson,
  remoteProjectionEndpoint,
  safeRemoteCode,
};
