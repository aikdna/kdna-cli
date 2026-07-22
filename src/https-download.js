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
 * Error messages deliberately never echo the offending URL, response bytes,
 * or local paths: a rejected URL may carry embedded credentials and a
 * malformed URL may contain local file paths.
 */

// Every CLI-owned curl invocation must pin the initial protocol and the
// redirect protocol to HTTPS. Without these flags `curl -L` silently
// follows an HTTPS -> HTTP/FTP downgrade redirect.
const CURL_HTTPS_ONLY_ARGS = Object.freeze(['--proto', '=https', '--proto-redir', '=https']);

function assertHttpsDownloadUrl(url) {
  if (typeof url !== 'string' || !url) {
    throw new Error('refusing to download: asset URL is missing');
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('refusing to download: asset URL is not a valid URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(
      `refusing to download: only https: URLs are allowed (got ${parsed.protocol || 'unknown scheme'})`,
    );
  }
  if (parsed.username || parsed.password) {
    throw new Error('refusing to download: URLs with embedded credentials are not allowed');
  }
  return parsed;
}

/**
 * Render a URL safe for inclusion in an error message: embedded credentials
 * are stripped, non-https: URLs (which may embed local file paths) are
 * reduced to their scheme, and unparseable input is never echoed.
 */
function redactUrlForError(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return '<invalid URL>';
  }
  if (parsed.protocol !== 'https:') {
    return `<${parsed.protocol || 'unknown-scheme'} URL>`;
  }
  parsed.username = '';
  parsed.password = '';
  return parsed.toString();
}

module.exports = {
  CURL_HTTPS_ONLY_ARGS,
  assertHttpsDownloadUrl,
  redactUrlForError,
};
