/**
 * RegistryResolver — KDNA asset-first registry client.
 *
 * Responsibilities:
 *   1. Resolve names: bare → @aikdna/bare, validate @scope/name format
 *   2. Route lookups to the right registry (official vs private)
 *   3. Cache registry metadata locally
 *   4. Surface scope trust info to install/publish
 *
 * Schema v3.0 (historical reference; registry is out of scope for KDNA Core)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const { assertHttpsDownloadUrl, CURL_HTTPS_ONLY_ARGS } = require('./https-download');

const USER_KDNA_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.kdna');
const REGISTRY_DIR = path.join(USER_KDNA_DIR, 'registry');
const CONFIG_FILE = path.join(USER_KDNA_DIR, 'config.json');

const DEFAULT_OFFICIAL_SCOPE = '@aikdna';
// Registry is out of scope for KDNA Core (see ADR-XXX / 00-current-truth.md).
// Production users must set KDNA_REGISTRY_URL to a valid registry endpoint.
// Default is intentionally empty to fail loudly rather than silently pointing
// at a historical private repo.
const CANONICAL_REGISTRY_URL = process.env.KDNA_REGISTRY_URL || '';
const REQUIRED_SCHEMA_VERSION = '3.0';

const VERSION_SOURCE =
  '(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)' +
  '(?:-([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?' +
  '(?:\\+([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?';
const NAME_RE = new RegExp(`^@([a-z][a-z0-9-]*)/([a-z][a-z0-9_-]*)(?:@(${VERSION_SOURCE}))?$`);
const BARE_NAME_RE = new RegExp(`^([a-z][a-z0-9_-]*)(?:@(${VERSION_SOURCE}))?$`);
const ASSET_ID_RE = /^kdna:([a-z][a-z0-9-]*):([a-z][a-z0-9_-]*)$/;

function parseExactVersion(version) {
  if (typeof version !== 'string') return null;
  const match = version.match(new RegExp(`^${VERSION_SOURCE}$`));
  if (!match) return null;
  const prerelease = match[4] ? match[4].split('.') : [];
  if (
    prerelease.some((identifier) => /^[0-9]+$/.test(identifier) && /^0[0-9]+$/.test(identifier))
  ) {
    return null;
  }
  return {
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: BigInt(match[3]),
    prerelease,
  };
}

function compareExactVersions(a, b) {
  const left = parseExactVersion(a);
  const right = parseExactVersion(b);
  if (!left || !right) return String(a).localeCompare(String(b), 'en', { numeric: true });

  for (const field of ['major', 'minor', 'patch']) {
    if (left[field] !== right[field]) return left[field] < right[field] ? -1 : 1;
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;

  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftId = left.prerelease[index];
    const rightId = right.prerelease[index];
    if (leftId === undefined) return -1;
    if (rightId === undefined) return 1;
    if (leftId === rightId) continue;
    const leftNumeric = /^[0-9]+$/.test(leftId);
    const rightNumeric = /^[0-9]+$/.test(rightId);
    if (leftNumeric && rightNumeric) return BigInt(leftId) < BigInt(rightId) ? -1 : 1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftId < rightId ? -1 : 1;
  }
  return 0;
}

function selectRegistryEntry(candidates, version = null) {
  if (version) return candidates.find((candidate) => candidate.version === version) || null;
  const nonYanked = candidates.filter((candidate) => candidate.yanked !== true);
  return (
    nonYanked
      .filter((candidate) => parseExactVersion(candidate.version))
      .sort((a, b) => compareExactVersions(b.version, a.version))[0] || null
  );
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

function parseDate(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function registryTrustIssues(registry, { now = new Date() } = {}) {
  const issues = [];
  const trust = registry?.trust || {};

  if (!registry || registry.schema_version !== REQUIRED_SCHEMA_VERSION) {
    issues.push(
      `Registry schema_version must be ${REQUIRED_SCHEMA_VERSION}, got ${JSON.stringify(registry?.schema_version)}`,
    );
  }

  if (!trust.model) issues.push('registry.trust.model is required');
  if (!trust.snapshot) issues.push('registry.trust.snapshot is required');
  if (!trust.timestamp) issues.push('registry.trust.timestamp is required');

  const snapshotVersion = trust.snapshot?.registry_version;
  if (snapshotVersion && snapshotVersion !== registry.registry_version) {
    issues.push(
      `registry.trust.snapshot.registry_version ${snapshotVersion} does not match registry_version ${registry.registry_version}`,
    );
  }

  const snapshotExpires = parseDate(trust.snapshot?.expires_at);
  const timestampExpires = parseDate(trust.timestamp?.expires_at);
  if (!snapshotExpires) issues.push('registry.trust.snapshot.expires_at must be an ISO timestamp');
  if (!timestampExpires)
    issues.push('registry.trust.timestamp.expires_at must be an ISO timestamp');
  if (snapshotExpires && snapshotExpires <= now) {
    issues.push(`registry snapshot expired at ${trust.snapshot.expires_at}`);
  }
  if (timestampExpires && timestampExpires <= now) {
    issues.push(`registry timestamp expired at ${trust.timestamp.expires_at}`);
  }

  return issues;
}

function verifyRegistrySignature(registry, rawPayload) {
  if (!CANONICAL_REGISTRY_URL) {
    return {
      verified: false,
      error:
        'Registry URL not configured. Set KDNA_REGISTRY_URL to a valid registry endpoint (registry is out of scope for KDNA Core by default).',
    };
  }
  const trust = registry?.trust;
  if (!trust) return { verified: false, error: 'No trust metadata in registry' };

  const rootKeys = (trust.root?.keys || []).filter((k) => k.scheme === 'ed25519');
  if (rootKeys.length === 0)
    return { verified: false, error: 'No Ed25519 root keys in trust metadata' };

  // Check if the registry has a signature file. The signature and payload
  // fetches are HTTPS-only with redirect downgrade disabled, same as every
  // other curl path: a cached registry must never re-enable an http: or
  // credentialed registry endpoint.
  const sigUrl = CANONICAL_REGISTRY_URL.replace(/\.json$/, '.sig');
  try {
    assertHttpsDownloadUrl(sigUrl);
  } catch (guardError) {
    return { verified: false, error: guardError.message };
  }
  let signature;
  try {
    const sigResult = execFileSync(
      'curl',
      ['-sL', ...CURL_HTTPS_ONLY_ARGS, '--max-time', '10', sigUrl],
      {
        encoding: 'utf8',
        timeout: 15000,
      },
    );
    signature = sigResult.trim();
  } catch {
    // .sig file may not exist yet (pre-signing transition)
    return { verified: false, error: 'No registry signature file found' };
  }

  if (!rawPayload) {
    try {
      assertHttpsDownloadUrl(CANONICAL_REGISTRY_URL);
    } catch (guardError) {
      return { verified: false, error: guardError.message };
    }
    try {
      rawPayload = execFileSync(
        'curl',
        ['-sL', ...CURL_HTTPS_ONLY_ARGS, '--max-time', '10', CANONICAL_REGISTRY_URL],
        {
          encoding: 'utf8',
          timeout: 15000,
        },
      );
    } catch {
      return { verified: false, error: 'Cannot fetch registry for verification' };
    }
  }

  for (const key of rootKeys) {
    try {
      if (
        crypto.verify(
          null,
          Buffer.from(rawPayload),
          crypto.createPublicKey(key.pubkey),
          Buffer.from(signature, 'hex'),
        )
      ) {
        return { verified: true, keyid: key.keyid };
      }
    } catch {
      /* try next key */
    }
  }

  return { verified: false, error: 'Signature verification failed against all root keys' };
}

function checkRegistryRevocations(registry, scope) {
  const revocations = registry?.trust?.revocations || [];
  const scopeKey = scope?.trust_pubkey || '';
  if (!scopeKey) return [];

  const active = [];
  for (const r of revocations) {
    if (r.scope && r.scope !== scopeKey) continue;
    if (r.expires_at && new Date(r.expires_at) < new Date()) continue;
    active.push(r);
  }
  return active;
}

function isEntryRevoked(registry, entry) {
  const revocations = checkRegistryRevocations(registry, entry);
  return (
    revocations.find((rev) => {
      if (rev.name && rev.name !== entry.name) return false;
      if (rev.version && rev.version !== entry.version) return false;
      if (rev.asset_digest && rev.asset_digest !== entry.asset_digest) return false;
      return rev.name || rev.asset_digest;
    }) || null
  );
}

// ─── Name parsing ───────────────────────────────────────────────────────

/**
 * Parse a name string into { scope, ident, full, version, reference }.
 * - "@aikdna/writing" → { scope: "@aikdna", ident: "writing", full: "@aikdna/writing" }
 * - "@aikdna/writing@1.2.3" → the same canonical `full` plus version "1.2.3"
 * - "writing" → expanded to default official scope → @aikdna/writing
 * - "writing@1.2.3" → @aikdna/writing pinned to version "1.2.3"
 * Returns null if invalid.
 */
function parseName(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();

  const scoped = trimmed.match(NAME_RE);
  if (scoped) {
    if (scoped[3] && !parseExactVersion(scoped[3])) return null;
    const full = `@${scoped[1]}/${scoped[2]}`;
    return {
      scope: `@${scoped[1]}`,
      ident: scoped[2],
      full,
      version: scoped[3] || null,
      reference: trimmed,
      wasShort: false,
    };
  }

  const bare = trimmed.match(BARE_NAME_RE);
  if (bare) {
    if (bare[2] && !parseExactVersion(bare[2])) return null;
    const scope = DEFAULT_OFFICIAL_SCOPE;
    const full = `${scope}/${bare[1]}`;
    return {
      scope,
      ident: bare[1],
      full,
      version: bare[2] || null,
      reference: trimmed,
      wasShort: true,
    };
  }

  return null;
}

function nameFromAssetId(assetId) {
  if (typeof assetId !== 'string') return null;
  const match = assetId.trim().match(ASSET_ID_RE);
  if (!match) return null;
  return `@${match[1]}/${match[2]}`;
}

// ─── Config (multi-registry routing) ────────────────────────────────────

function loadConfig() {
  const cfg = readJson(CONFIG_FILE) || {};
  return {
    default_scope: cfg.default_scope || DEFAULT_OFFICIAL_SCOPE,
    registries: cfg.registries || {},
  };
}

// ─── Registry source ────────────────────────────────────────────────────

class RegistrySource {
  constructor(url, cacheFile) {
    this.url = url;
    this.cacheFile = cacheFile;
  }

  fetch() {
    // HTTPS-only for both the canonical registry and custom scope
    // registries from config: the URL scheme is not a config-level trust
    // decision, and embedded credentials must never reach curl argv.
    assertHttpsDownloadUrl(this.url);
    const raw = execFileSync('curl', ['-fsSL', ...CURL_HTTPS_ONLY_ARGS, this.url], {
      encoding: 'utf8',
      timeout: 30000,
    });
    const data = JSON.parse(raw);
    writeJson(this.cacheFile, data);
    return data;
  }

  load({ allowNetwork = false, refresh = false } = {}) {
    if (!refresh) {
      const cached = readJson(this.cacheFile);
      if (cached) return cached;
    }
    if (allowNetwork) {
      try {
        return this.fetch();
      } catch {
        const cached = readJson(this.cacheFile);
        if (cached) return cached;
      }
    }
    return null;
  }
}

// ─── Resolver ───────────────────────────────────────────────────────────

class RegistryResolver {
  constructor({ allowNetwork = true, refresh = false } = {}) {
    this.allowNetwork = allowNetwork;
    this.refresh = refresh;
    this.config = loadConfig();
    this._sources = new Map();
    this._registries = new Map();
  }

  _sourceForScope(scopeName) {
    if (this._sources.has(scopeName)) return this._sources.get(scopeName);

    const cfgEntry = this.config.registries[scopeName];
    let url, cacheName;

    if (cfgEntry) {
      url = typeof cfgEntry === 'string' ? cfgEntry : cfgEntry.url;
      cacheName = `${scopeName.replace('@', '')}.json`;
    } else {
      // Default: all unknown scopes route to canonical official registry
      url = CANONICAL_REGISTRY_URL;
      cacheName = 'domains.json';
    }

    const cacheFile = path.join(REGISTRY_DIR, cacheName);
    const source = new RegistrySource(url, cacheFile);
    this._sources.set(scopeName, source);
    return source;
  }

  _loadRegistryForScope(scopeName) {
    if (this._registries.has(scopeName)) return this._registries.get(scopeName);
    const source = this._sourceForScope(scopeName);
    let data = source.load({ allowNetwork: this.allowNetwork, refresh: this.refresh });
    let trustIssues = data ? registryTrustIssues(data) : [];
    if (trustIssues.length && this.allowNetwork && !this.refresh) {
      data = source.load({ allowNetwork: true, refresh: true });
      trustIssues = data ? registryTrustIssues(data) : [];
    }
    if (trustIssues.length) {
      throw new Error(
        `Registry trust check failed:\n${trustIssues.map((i) => `- ${i}`).join('\n')}`,
      );
    }
    // Verify cryptographic signature
    const sigResult = verifyRegistrySignature(data);
    if (sigResult.error) {
      // Non-fatal: allow operation but log warning (transitional)
      console.error(`Warning: Registry signature verification: ${sigResult.error}`);
    }
    this._registries.set(scopeName, data);
    return data;
  }

  /**
   * Get a scope descriptor from its registry.
   * Returns { type, trust_pubkey, registry_url, verified } or null.
   */
  getScope(scopeName) {
    const reg = this._loadRegistryForScope(scopeName);
    if (!reg || !reg.scopes) return null;
    return reg.scopes[scopeName] || null;
  }

  /**
   * Resolve a name (bare or @scope/name) into:
   *   { parsed, scope, entry, registry }
   * Throws on any failure with a clear message.
   */
  resolve(input) {
    const parsed = parseName(input);
    if (!parsed) {
      throw new Error(
        `Invalid name "${input}". Use @scope/name (e.g. @aikdna/writing) or a bare name for the official scope.`,
      );
    }

    const registry = this._loadRegistryForScope(parsed.scope);
    if (!registry) {
      throw new Error(
        `Cannot load registry for scope ${parsed.scope}. Network unavailable and no cache.`,
      );
    }

    const scope = registry.scopes?.[parsed.scope];
    if (!scope) {
      throw new Error(`Scope ${parsed.scope} not registered in registry.`);
    }

    const candidates = (registry.domains || []).filter((d) => d.name === parsed.full);
    const entry = selectRegistryEntry(candidates, parsed.version);
    if (!entry) {
      if (parsed.version && candidates.length > 0) {
        const available = candidates.map((candidate) => candidate.version).filter(Boolean);
        throw new Error(
          `Domain ${parsed.full}@${parsed.version} not found in registry.` +
            (available.length ? ` Available versions: ${available.join(', ')}` : ''),
        );
      }
      if (candidates.length > 0) {
        throw new Error(
          `Domain ${parsed.full} has no installable release. ` +
            'Unversioned installs require a non-yanked release with a valid exact SemVer.',
        );
      }
      const sameScope = (registry.domains || [])
        .filter((d) => d.name.startsWith(parsed.scope + '/'))
        .map((d) => d.name);
      const hint = sameScope.length
        ? `\nKnown ${parsed.scope}/ domains: ${sameScope.join(', ')}`
        : '';
      throw new Error(`Domain ${parsed.full} not found in registry.${hint}`);
    }

    if (entry.yanked) {
      const reason = entry.yanked_reason ? `\nReason: ${entry.yanked_reason}` : '';
      const when = entry.yanked_at ? ` (yanked ${entry.yanked_at.slice(0, 10)})` : '';
      const replace = entry.replaced_by ? `\nTry: kdna install ${entry.replaced_by}` : '';
      throw new Error(`${entry.name}@${entry.version} has been yanked${when}.${reason}${replace}`);
    }

    const revocation = isEntryRevoked(registry, entry);
    if (revocation) {
      const reason = revocation.reason ? `\nReason: ${revocation.reason}` : '';
      const when = revocation.revoked_at ? ` (revoked ${revocation.revoked_at.slice(0, 10)})` : '';
      throw new Error(`${entry.name}@${entry.version} has been revoked${when}.${reason}`);
    }

    return { parsed, scope, entry, registry };
  }

  /**
   * List all domains across registries already loaded (does not trigger network for other scopes).
   * For now this is just the official registry's domains.
   */
  listAllDomains() {
    const reg = this._loadRegistryForScope(DEFAULT_OFFICIAL_SCOPE);
    return reg?.domains || [];
  }
}

// ─── Backwards-compatible helpers (used by remaining v0.6 code paths) ──

function loadRegistry(options = {}) {
  const resolver = new RegistryResolver({
    allowNetwork: options.allowNetwork ?? false,
    refresh: options.refresh ?? false,
  });
  return resolver.listAllDomains();
}

function fetchRegistry() {
  const source = new RegistrySource(
    CANONICAL_REGISTRY_URL,
    path.join(REGISTRY_DIR, 'domains.json'),
  );
  const data = source.fetch();
  return data.domains || [];
}

module.exports = {
  RegistryResolver,
  parseName,
  nameFromAssetId,
  REQUIRED_SCHEMA_VERSION,
  registryTrustIssues,
  isEntryRevoked,
  loadRegistry,
  fetchRegistry,
  CANONICAL_REGISTRY_URL,
  REGISTRY_CACHE: path.join(REGISTRY_DIR, 'domains.json'),
  DEFAULT_OFFICIAL_SCOPE,
  compareExactVersions,
  selectRegistryEntry,
};
