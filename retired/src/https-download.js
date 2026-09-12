/**
 * HTTPS-only transport guard shared by every curl fetch path in the CLI
 * (install downloads, safe-archive fetches, registry metadata and registry
 * signature fetches).
 *
 * Registry metadata and CLI configuration are not a trust boundary for the
 * URL scheme or for embedded credentials: a poisoned or redirected entry
 * must never turn a download into a file:// read, a javascript:/ftp: fetch,
 * or a credential leak through process argv. Digest and signature
 * verification still run on the fetched bytes; this guard only constrains
 * how bytes are fetched.
 *
 * User-facing errors from this module are deliberately sterile. They carry
 * only a stable error category plus, when available, the curl process exit
 * code. They never echo:
 *   - the full URL, its path, query, or fragment (which may carry tokens);
 *   - embedded credentials;
 *   - curl stdout/stderr or server response bodies;
 *   - local filesystem paths or curl argv (which Node's execFileSync embeds
 *     in the raw Error#message).
 */

const { execFileSync } = require('child_process');

// Every CLI-owned curl invocation must pin the initial protocol and the
// redirect protocol to HTTPS. Without these flags `curl -L` silently
// follows an HTTPS -> HTTP/FTP downgrade redirect.
const CURL_HTTPS_ONLY_ARGS = Object.freeze(['--proto', '=https', '--proto-redir', '=https']);

// Stable download error categories surfaced to users. Classification uses
// the curl process exit code — part of curl's documented interface — never
// a parse of curl's natural-language stderr.
const DOWNLOAD_URL_REFUSED = 'DOWNLOAD_URL_REFUSED';
const DOWNLOAD_FAILED = 'DOWNLOAD_FAILED';

const CURL_EXIT_CATEGORIES = Object.freeze({
  1: 'DOWNLOAD_PROTOCOL_BLOCKED', // e.g. redirect downgrade stopped by --proto pinning
  6: 'DOWNLOAD_RESOLVE_FAILED',
  7: 'DOWNLOAD_CONNECT_FAILED',
  22: 'DOWNLOAD_HTTP_ERROR',
  28: 'DOWNLOAD_TIMEOUT',
  35: 'DOWNLOAD_TLS_FAILED',
  60: 'DOWNLOAD_TLS_CERT_FAILED',
});

function classifyCurlExit(exitCode) {
  return CURL_EXIT_CATEGORIES[exitCode] || DOWNLOAD_FAILED;
}

class DownloadError extends Error {
  constructor(category, exitCode = null, detail = null) {
    const suffix = typeof exitCode === 'number' ? ` (curl exit ${exitCode})` : '';
    super(`${category}${detail ? `: ${detail}` : ''}${suffix}`);
    this.name = 'DownloadError';
    this.category = category;
    this.exitCode = typeof exitCode === 'number' ? exitCode : null;
  }
}

function refuseDownload(detail) {
  return new DownloadError(DOWNLOAD_URL_REFUSED, null, `refusing to download: ${detail}`);
}

function assertHttpsDownloadUrl(url) {
  if (typeof url !== 'string' || !url) {
    throw refuseDownload('asset URL is missing');
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw refuseDownload('asset URL is not a valid URL');
  }
  if (parsed.protocol !== 'https:') {
    throw refuseDownload(
      `only https: URLs are allowed (got ${parsed.protocol || 'unknown scheme'})`,
    );
  }
  if (parsed.username || parsed.password) {
    throw refuseDownload('URLs with embedded credentials are not allowed');
  }
  // Query strings and fragments are where leaked tokens and tracking
  // parameters live; CLI-managed downloads never need them, so they are
  // refused before curl runs rather than redacted after the fact.
  if (parsed.search) {
    throw refuseDownload('URLs with a query string are not allowed');
  }
  if (parsed.hash) {
    throw refuseDownload('URLs with a fragment are not allowed');
  }
  return parsed;
}

/**
 * Run curl for a CLI-managed fetch and normalize every failure into a
 * DownloadError. The raw execFileSync error is never rethrown: its message
 * embeds the full argv (URL and local destination path) and its captured
 * stderr/stdout may carry server-controlled bytes.
 */
function curlFetch(args, options = {}) {
  try {
    return execFileSync('curl', args, { stdio: 'pipe', ...options });
  } catch (failure) {
    const exitCode = typeof failure?.status === 'number' ? failure.status : null;
    throw new DownloadError(classifyCurlExit(exitCode), exitCode);
  }
}

/**
 * Render any download-path failure as a sterile, user-safe string: a stable
 * category, the pre-sanitized refusal detail for rejected URLs, and at most
 * the curl exit code. Errors explicitly marked as CLI-owned (cliOwned), such
 * as safe-archive verification failures, already carry vetted messages
 * (asset coordinates / archive entry names only) and pass through. Anything
 * unrecognized collapses to DOWNLOAD_FAILED so raw subprocess messages can
 * never reach the user through this channel.
 */
function describeDownloadFailure(err) {
  if (err instanceof DownloadError || typeof err?.category === 'string') {
    return err.message;
  }
  if (err?.cliOwned === true && typeof err.message === 'string' && err.message) {
    return err.message;
  }
  return DOWNLOAD_FAILED;
}

module.exports = {
  CURL_HTTPS_ONLY_ARGS,
  DOWNLOAD_FAILED,
  DOWNLOAD_URL_REFUSED,
  DownloadError,
  assertHttpsDownloadUrl,
  curlFetch,
  describeDownloadFailure,
};
