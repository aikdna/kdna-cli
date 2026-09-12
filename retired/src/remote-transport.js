/**
 * Fail-closed transport policy for remote projection, entitlement, and
 * provider APIs.
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

class RemoteTransportError extends Error {
  constructor(code, message, status = null) {
    super(message);
    this.name = 'RemoteTransportError';
    this.code = code;
    this.status = Number.isInteger(status) ? status : null;
  }
}

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

function canonicalLlmBaseUrl(value) {
  assertVisibleAsciiUrl(value);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('provider base URL must be absolute');
  }
  if (
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname.includes('%') ||
    parsed.pathname
      .split('/')
      .some(
        (segment, index) =>
          segment === '.' ||
          segment === '..' ||
          (index > 0 && segment === '' && parsed.pathname !== '/'),
      )
  ) {
    throw new Error('provider base URL contains an unsupported component');
  }
  assertSecureProtocol(parsed);

  const canonical = parsed.pathname === '/' ? parsed.origin : `${parsed.origin}${parsed.pathname}`;
  if (value !== canonical || (parsed.pathname !== '/' && parsed.pathname.endsWith('/'))) {
    throw new Error('provider base URL is not canonical');
  }
  return parsed;
}

function llmProviderEndpoint(value, provider) {
  const parsed = canonicalLlmBaseUrl(value);
  const basePath = parsed.pathname === '/' ? '' : parsed.pathname;
  if (provider === 'anthropic') return `${parsed.origin}${basePath}/v1/messages`;
  if (provider === 'openai') {
    const apiPath = basePath.endsWith('/v1') ? basePath : `${basePath}/v1`;
    return `${parsed.origin}${apiPath}/chat/completions`;
  }
  throw new Error('provider is not supported');
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

function assertCanonicalRemoteRequestUrl(value) {
  assertVisibleAsciiUrl(value);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('remote request URL must be absolute');
  }
  if (
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname.includes('%') ||
    value !== `${parsed.origin}${parsed.pathname}` ||
    parsed.pathname
      .split('/')
      .some(
        (segment, index) =>
          segment === '.' ||
          segment === '..' ||
          (index > 0 && segment === '' && parsed.pathname !== '/'),
      )
  ) {
    throw new Error('remote request URL is not canonical');
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
    try {
      await response.body?.cancel();
    } catch {
      // Response bytes never cross the transport boundary.
    }
    throw new Error('remote response is not canonical JSON');
  }
  const contentLength = response.headers.get('content-length');
  if (
    contentLength !== null &&
    (!/^(0|[1-9]\d*)$/.test(contentLength) || Number(contentLength) > MAX_REMOTE_RESPONSE_BYTES)
  ) {
    try {
      await response.body?.cancel();
    } catch {
      // Response bytes never cross the transport boundary.
    }
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

async function postBoundedRemoteJson({ url, headers, body, timeoutMs = 120000 }) {
  try {
    assertCanonicalRemoteRequestUrl(url);
  } catch {
    throw new RemoteTransportError(
      'REMOTE_URL_REFUSED',
      'Remote provider URL was refused [REMOTE_URL_REFUSED].',
    );
  }
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new RemoteTransportError(
      'REMOTE_TRANSPORT_FAILED',
      'Remote provider request failed [REMOTE_TRANSPORT_FAILED].',
    );
  }

  if (!response.ok) {
    try {
      await response.body?.cancel();
    } catch {
      // Response bytes never cross the transport boundary.
    }
    throw new RemoteTransportError(
      'REMOTE_HTTP_ERROR',
      `Remote provider rejected the request [REMOTE_HTTP_ERROR] (HTTP ${response.status}).`,
      response.status,
    );
  }

  try {
    return await readBoundedFetchJson(response);
  } catch {
    throw new RemoteTransportError(
      'REMOTE_RESPONSE_INVALID',
      'Remote provider returned an invalid response [REMOTE_RESPONSE_INVALID].',
    );
  }
}

module.exports = {
  MAX_REMOTE_RESPONSE_BYTES,
  RemoteTransportError,
  accountApiEndpoint,
  assertAccountApiRequestUrl,
  assertCanonicalRemoteRequestUrl,
  canonicalLlmBaseUrl,
  canonicalContractUrl,
  isExactLoopback,
  legacyActivationEndpoint,
  llmProviderEndpoint,
  postBoundedRemoteJson,
  readBoundedFetchJson,
  remoteProjectionEndpoint,
  safeRemoteCode,
  safeVerificationUrl,
};
