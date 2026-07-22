/**
 * Fail-closed transport policy for remote projection and entitlement APIs.
 *
 * These paths carry task/context, authorization material, or both. External
 * services therefore require HTTPS. Plain HTTP is accepted only for the
 * exact numeric loopback hosts 127.0.0.1 and [::1]; localhost, LAN addresses,
 * and arbitrary hostnames are never development exceptions.
 *
 * Base URLs are deliberately contractual rather than URL-join inputs. Each
 * caller supplies the small set of exact paths it admits, and credentials,
 * query strings, fragments, non-visible ASCII, parser normalization, and
 * every other path are rejected before a request is created.
 */

'use strict';

const MAX_REMOTE_URL_BYTES = 2048;
const MAX_REMOTE_RESPONSE_BYTES = 1024 * 1024;

function isExactLoopback(hostname) {
  return hostname === '127.0.0.1' || hostname === '[::1]';
}

function assertVisibleAsciiUrl(value, { allowQuery = false } = {}) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > MAX_REMOTE_URL_BYTES ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return (
        character === '\\' ||
        character === '#' ||
        (!allowQuery && character === '?') ||
        codePoint < 0x21 ||
        codePoint > 0x7e
      );
    })
  ) {
    throw new Error('remote URL is not a canonical visible-ASCII URL');
  }
}

function assertSecureProtocol(parsed) {
  if (
    parsed.protocol !== 'https:' &&
    !(parsed.protocol === 'http:' && isExactLoopback(parsed.hostname))
  ) {
    throw new Error('remote URL must use HTTPS except for an exact loopback HTTP origin');
  }
}

function canonicalContractUrl(value, allowedPaths) {
  assertVisibleAsciiUrl(value);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('remote URL must be absolute');
  }
  if (!parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('remote URL contains credentials, query, fragment, or no hostname');
  }
  assertSecureProtocol(parsed);

  const accepted = new Set();
  for (const contractPath of allowedPaths) {
    if (contractPath === '') {
      accepted.add(parsed.origin);
      accepted.add(`${parsed.origin}/`);
    } else {
      accepted.add(`${parsed.origin}${contractPath}`);
    }
  }
  if (!accepted.has(value)) {
    throw new Error('remote URL is not an exact admitted endpoint');
  }
  return parsed;
}

function remoteProjectionEndpoint(value) {
  const parsed = canonicalContractUrl(value, ['', '/project']);
  return `${parsed.origin}/project`;
}

function legacyActivationEndpoint(value) {
  const parsed = canonicalContractUrl(value, ['', '/entitlements/activate']);
  return `${parsed.origin}/entitlements/activate`;
}

function accountApiEndpoint(server, resource) {
  const parsed = canonicalContractUrl(server, ['', '/api', '/api/']);
  if (
    typeof resource !== 'string' ||
    resource.length === 0 ||
    resource.length > 1024 ||
    resource.startsWith('/') ||
    resource.endsWith('/') ||
    resource.includes('\\') ||
    resource.includes('?') ||
    resource.includes('#') ||
    resource
      .split('/')
      .some(
        (segment) =>
          segment === '' ||
          segment === '.' ||
          segment === '..' ||
          !/^[A-Za-z0-9._~%:-]+$/.test(segment),
      )
  ) {
    throw new Error('account API resource is not canonical');
  }
  return `${parsed.origin}/api/v1/${resource}`;
}

function assertAccountApiRequestUrl(value) {
  assertVisibleAsciiUrl(value);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('account API endpoint must be absolute');
  }
  if (
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    value !== `${parsed.origin}${parsed.pathname}` ||
    !parsed.pathname.startsWith('/api/v1/') ||
    parsed.pathname
      .slice('/api/v1/'.length)
      .split('/')
      .some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error('account API endpoint is not canonical');
  }
  assertSecureProtocol(parsed);
  return value;
}

function safeVerificationUrl(value) {
  assertVisibleAsciiUrl(value, { allowQuery: true });
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('device verification URI must be absolute');
  }
  if (!parsed.hostname || parsed.username || parsed.password || parsed.hash) {
    throw new Error('device verification URI is not safe');
  }
  assertSecureProtocol(parsed);
  if (value !== parsed.href && value !== parsed.origin) {
    throw new Error('device verification URI is not canonical');
  }
  return parsed.href;
}

function safeRemoteCode(value, fallback = 'REMOTE_REQUEST_REJECTED') {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : fallback;
}

async function readBoundedFetchJson(response) {
  const contentType = response.headers.get('content-type') || '';
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) {
    throw new Error('remote response is not canonical JSON');
  }
  const contentLength = response.headers.get('content-length');
  if (
    contentLength !== null &&
    (!/^(0|[1-9]\d*)$/.test(contentLength) || Number(contentLength) > MAX_REMOTE_RESPONSE_BYTES)
  ) {
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
  accountApiEndpoint,
  assertAccountApiRequestUrl,
  canonicalContractUrl,
  isExactLoopback,
  legacyActivationEndpoint,
  readBoundedFetchJson,
  remoteProjectionEndpoint,
  safeRemoteCode,
  safeVerificationUrl,
};
