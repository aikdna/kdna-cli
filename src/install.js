/**
 * KDNA Install — v0.7 .kdna-first installer.
 *
 * Sources (priority order):
 *   kdna install <bare>                     → @aikdna/<bare>, from registry
 *   kdna install @scope/name                → from registry (any scope)
 *   kdna install @scope/name@1.2.3          → version pinned (TODO post-v0.7.0)
 *   kdna install ./file.kdna                → local .kdna file
 *
 * Removed in v0.7 (breaking): github:user/repo, --from-git, cluster:github:...,
 * tarball/SSH fallbacks. Install is now strictly .kdna-driven from the registry.
 *
 * Schema v3.0 (historical reference; registry is out of scope for KDNA Core v1)
 */

const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');
const { RegistryResolver, parseName } = require('./registry');
const { EXIT, error } = require('./cmds/_common');
const PATHS = require('./paths');
const {
  installAsset,
  getInstalled,
  listInstalled,
  removeInstalled,
  sha256File,
  readContainer,
  readContainerJson,
  readContainerEntry,
  verifyAsset,
} = require('./package-store');

const USER_KDNA_DIR = PATHS.root;
const INSTALL_DIR = PATHS.packages;

// Agent skill directories (search order)
const AGENT_SKILL_DIRS = [
  path.join(process.env.HOME || '', '.agents', 'skills'),
  path.join(process.env.HOME || '', '.claude', 'skills'),
  path.join(process.env.HOME || '', '.codex', 'skills'),
  path.join(process.env.HOME || '', '.cursor', 'skills'),
  path.join(process.env.HOME || '', '.gemini', 'antigravity', 'skills'),
];

/**
 * Ensure the kdna-loader skill is installed in ALL detected agent directories.
 * Without this, installed KDNA domains are invisible to agents.
 */
function ensureLoaderSkill() {
  const alreadyInstalled = [];
  const toInstall = [];
  const toUpdate = []; // present but outdated (pre-v2.1)

  // v2.1 marker — present in current SKILL.md, absent in old one
  const V2_1_MARKER = 'applies_when';

  for (const dir of AGENT_SKILL_DIRS) {
    const skillFile = path.join(dir, 'kdna-loader', 'SKILL.md');
    if (fs.existsSync(skillFile)) {
      let isCurrent = false;
      try {
        const content = fs.readFileSync(skillFile, 'utf8');
        isCurrent = content.includes(V2_1_MARKER);
      } catch {
        /* unreadable — treat as missing */
      }
      if (isCurrent) alreadyInstalled.push(dir);
      else toUpdate.push(dir);
    } else {
      toInstall.push(dir);
    }
  }

  // If all up-to-date, nothing to do
  if (toInstall.length === 0 && toUpdate.length === 0) return;

  // Notify which are current
  if (alreadyInstalled.length > 0) {
    console.log(
      `  ✓ kdna-loader (v2.1) found in: ${alreadyInstalled.map((d) => path.basename(path.dirname(d))).join(', ')}`,
    );
  }

  // Install + update share the same target list
  const targets = [...toInstall, ...toUpdate];
  const verb =
    toUpdate.length && !toInstall.length
      ? 'Updating'
      : toInstall.length && !toUpdate.length
        ? 'Installing'
        : 'Installing/updating';
  console.log(`  ${verb} kdna-loader skill (v2.1)...`);

  let installed = 0;
  const sources = [];

  // Source 1: download from kdna-skills repo (single source of truth, v0.7.4+).
  // This must come FIRST so we don't ship stale local copies to users.
  sources.push({
    type: 'remote',
    url: 'https://raw.githubusercontent.com/aikdna/kdna-skills/main/kdna-loader/SKILL.md',
  });

  // Source 2: offline fallback — KDNA repo local checkout, only used if the
  // CDN is unreachable. The npm-published tarball does NOT include SKILL.md
  // files anymore (they live solely in kdna-skills).
  const localTemplate = path.resolve(__dirname, '..', 'skills', 'kdna-loader', 'SKILL.md');
  if (fs.existsSync(localTemplate)) {
    sources.push({ type: 'local', path: localTemplate });
  }

  for (const dir of targets) {
    const skillDir = path.join(dir, 'kdna-loader');
    for (const src of sources) {
      try {
        fs.mkdirSync(skillDir, { recursive: true });
        if (src.type === 'local') {
          fs.copyFileSync(src.path, path.join(skillDir, 'SKILL.md'));
        } else {
          execSync(`curl -fsSL -o "${path.join(skillDir, 'SKILL.md')}" "${src.url}"`, {
            stdio: 'pipe',
            timeout: 10000,
          });
        }
        installed++;
        break; // Move to next agent dir
      } catch {
        // Try next source
      }
    }
  }

  if (installed > 0) {
    console.log(
      `   ✓ kdna-loader installed/updated in ${installed} agent director${installed > 1 ? 'ies' : 'y'}`,
    );
  }

  if (installed < targets.length) {
    console.log(
      `   ⚠ Could not install to ${targets.length - installed} agent director${targets.length - installed > 1 ? 'ies' : 'y'}.`,
    );
    console.log('   Run: kdna setup --force');
  }

  if (installed === 0 && alreadyInstalled.length === 0) {
    console.log('   ⚠ Could not install kdna-loader anywhere.');
    console.log('   Run: kdna setup');
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// ─── Audit Log ───────────────────────────────────────────────────────

function auditLog(action, details) {
  try {
    const logDir = path.join(USER_KDNA_DIR, 'logs');
    ensureDir(logDir);
    const logFile = path.join(logDir, 'audit.log');
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      action,
      ...details,
    });
    fs.appendFileSync(logFile, entry + '\n');
  } catch {
    /* audit is best-effort, never block on it */
  }
}

// ─── Source parsing ─────────────────────────────────────────────────────

function parseSource(input) {
  // Local file (.kdna)
  if (
    input.endsWith('.kdna') &&
    (input.startsWith('./') ||
      input.startsWith('/') ||
      input.startsWith('~/') ||
      fs.existsSync(input))
  ) {
    const resolved = path.resolve(input.replace(/^~/, process.env.HOME || ''));
    if (!fs.existsSync(resolved)) error(`Local file not found: ${resolved}`);
    return { type: 'local-file', path: resolved };
  }

  if (input.startsWith('./') || input.startsWith('/') || input.startsWith('~/')) {
    const resolved = path.resolve(input.replace(/^~/, process.env.HOME || ''));
    if (!fs.existsSync(resolved)) error(`Local path not found: ${resolved}`);
    if (fs.statSync(resolved).isDirectory()) {
      error(
        `Directory install is not supported. KDNA installs .kdna assets only.\n` +
          `Use: kdna dev pack ${resolved} --output <dir>, then kdna install <file.kdna>`,
        EXIT.INPUT_ERROR,
      );
    }
    error(`Not a .kdna file: ${resolved}`, EXIT.INPUT_ERROR);
  }

  // Registry name (bare or @scope/name)
  const parsed = parseName(input);
  if (!parsed) {
    error(
      `Cannot parse "${input}". Use:\n` +
        `  kdna install <name>             # @aikdna/<name>\n` +
        `  kdna install @scope/name        # any scope\n` +
        `  kdna install ./file.kdna        # local .kdna file`,
    );
  }
  return { type: 'registry', parsed };
}

// ─── Download helpers ──────────────────────────────────────────────────

function downloadFile(url, dest) {
  ensureDir(path.dirname(dest));
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      execFileSync('curl', ['-fsSL', '--retry', '2', '--retry-delay', '1', '-o', dest, url], {
        timeout: 90000,
        stdio: 'pipe',
      });
      return;
    } catch (e) {
      lastErr = e;
      if (attempt < 3) {
        // brief pause between attempts
        try {
          execFileSync('sleep', ['1'], { stdio: 'ignore' });
        } catch {
          /* ignore */
        }
      }
    }
  }
  const stderr = lastErr?.stderr?.toString().trim() || lastErr?.message || 'unknown';
  throw new Error(`download failed after 3 attempts: ${stderr}`);
}

// ─── Signature verification ────────────────────────────────────────────

function verifySignature({ assetPath, scope, entry, lenient = true }) {
  const manifest = readContainerJson(assetPath, 'kdna.json');
  if (!manifest) {
    if (lenient) {
      console.warn('  ⚠ No kdna.json — cannot verify signature.');
      return;
    }
    error('No kdna.json in package — cannot verify signature.', EXIT.TRUST_FAILED);
  }

  const trustKey = scope.trust_pubkey;
  if (!entry.signature || !manifest.signature) {
    error(`${entry.name}: registry and .kdna manifest signatures are required.`, EXIT.TRUST_FAILED);
  }

  // Author pubkey fingerprint must match scope trust_pubkey
  if (manifest.author?.pubkey !== trustKey) {
    error(
      `${entry.name}: author.pubkey does not match scope trust key. Refusing to install.`,
      EXIT.TRUST_FAILED,
    );
  }

  // Full Ed25519 verify (requires public_key_pem embedded in the package)
  if (!manifest.author?.public_key_pem) {
    error(
      `${entry.name}: manifest author.public_key_pem is required for Ed25519 verification.`,
      EXIT.TRUST_FAILED,
    );
  }

  const result = verifyAsset(assetPath, { requireSignature: true });
  for (const e of result.errors || []) {
    if (e.includes('signature') || e.includes('public_key') || e.includes('fingerprint')) {
      error(`${entry.name}: ${e}. Refusing to install.`, EXIT.TRUST_FAILED);
    }
  }
  if (!result.signature_valid) {
    error(
      `${entry.name}: Ed25519 signature INVALID. Package may be tampered. Refusing.`,
      EXIT.TRUST_FAILED,
    );
  }
  console.log('  ✓ Signature OK (Ed25519 verified)');
}

// ─── Status confirmation (interactive) ─────────────────────────────────

function confirmStatus(entry, yes) {
  const status = entry.status || 'experimental';
  if (yes || (status !== 'experimental' && status !== 'draft')) return true;

  console.log(`  ${entry.name} is ${status} — judgment quality is not yet verified.`);
  console.log(`  Pass --yes to skip this prompt.`);
  try {
    const buf = Buffer.alloc(1);
    process.stdout.write('Continue? [y/N] ');
    fs.readSync(0, buf, 0, 1);
    return buf.toString().trim().toLowerCase() === 'y';
  } catch {
    return false;
  }
}

// ─── Cleanup stale temps ───────────────────────────────────────────────

function cleanStaleTemps() {
  ensureDir(INSTALL_DIR);
}

// ─── Main install ──────────────────────────────────────────────────────

function cmdInstallExtended(input, args = []) {
  ensureDir(INSTALL_DIR);
  cleanStaleTemps();

  // Auto-install loader skill if missing (without it, agents can't see installed domains)
  ensureLoaderSkill();

  const yes = args.includes('--yes');
  const jsonMode = args.includes('--json');
  const trusted = args.includes('--trusted');
  const source = parseSource(input);

  switch (source.type) {
    case 'registry':
      return installFromRegistry(source.parsed, yes, jsonMode);
    case 'local-file':
      return installFromLocalFile(source.path, yes, jsonMode, trusted);
  }
}

function scopedNameError(sourceLabel, declared) {
  return (
    `Invalid domain name in ${sourceLabel}: "${declared || '?'}"\n\n` +
    `KDNA v0.7+ requires scoped domain names.\n` +
    `Expected format: @scope/name\n` +
    `Example: @aikdna/my_domain\n\n` +
    `Fix:\n` +
    `- update kdna.json name to "@aikdna/my_domain"\n` +
    `- or initialize a new scoped domain, then copy your content into it`
  );
}

function installFromRegistry(parsed, yes, jsonMode = false) {
  const resolver = new RegistryResolver({ allowNetwork: true });
  let scope, entry;
  try {
    ({ scope, entry } = resolver.resolve(parsed.full));
  } catch (e) {
    error(e.message, EXIT.REGISTRY_ERROR);
  }

  if (parsed.wasShort) {
    if (!jsonMode) console.log(`  Resolved "${parsed.ident}" → ${entry.name}`);
  }

  if (entry.deprecated) {
    if (!jsonMode) {
      console.warn(
        `  ⚠ ${entry.name} is deprecated.${entry.replaced_by ? ` Use ${entry.replaced_by} instead.` : ''}`,
      );
    }
  }
  if (entry.access && entry.access !== 'open') {
    error(
      `${entry.name} requires "${entry.access}" access. Not installable via CLI yet.`,
      EXIT.POLICY_VIOLATION,
    );
  }

  if (entry.type === 'cluster') {
    return installCluster(entry, resolver, yes, jsonMode);
  }

  if (!entry.asset_url) {
    error(
      `${entry.name}@${entry.version} has no asset_url in registry.\n` +
        `release_status: ${entry.release_status || 'unknown'}\n` +
        `(Registry v3 publishes canonical .kdna assets through asset_url only.)`,
      EXIT.REGISTRY_ERROR,
    );
  }
  if (!entry.asset_digest) {
    error(`${entry.name}@${entry.version} has no asset_digest in registry.`, EXIT.REGISTRY_ERROR);
  }

  if (!confirmStatus(entry, yes)) {
    console.log('Installation cancelled.');
    process.exit(0);
  }

  installSingleFromUrl({ entry, scope }, jsonMode);
}

function installSingleFromUrl({ entry, scope }, jsonMode = false) {
  const ident = entry.name.split('/')[1];
  const tmpDir = path.join(USER_KDNA_DIR, 'cache', 'downloads');
  const tmpFile = path.join(tmpDir, `.${ident}-${Date.now()}.kdna.tmp`);
  const assetUrl = entry.asset_url;

  if (!jsonMode) console.log(`  Downloading ${entry.name}@${entry.version}...`);
  ensureDir(tmpDir);
  try {
    downloadFile(assetUrl, tmpFile);
  } catch {
    error(`Failed to download ${assetUrl}`, EXIT.REGISTRY_ERROR);
  }

  // asset digest check
  const actual = sha256File(tmpFile);
  const expectedDigest = entry.asset_digest;
  const actualDigest = `sha256:${actual}`;
  if (expectedDigest && actualDigest !== expectedDigest) {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      /* ignore */
    }
    error(
      `asset digest mismatch for ${entry.name}: expected ${expectedDigest}, got ${actualDigest}`,
    );
  }
  if (!jsonMode) console.log(`  ✓ asset digest verified`);

  verifySignature({ assetPath: tmpFile, scope, entry, lenient: true });

  auditLog('install', { name: entry.name, version: entry.version, source: 'registry' });
  const installed = installAsset({
    sourcePath: tmpFile,
    name: entry.name,
    version: entry.version,
    source: {
      type: 'registry',
      name: entry.name,
      version: entry.version,
      asset_url: assetUrl,
      asset_digest: expectedDigest,
    },
  });
  try {
    fs.unlinkSync(tmpFile);
  } catch {
    /* ignore */
  }

  if (jsonMode) {
    console.log(
      JSON.stringify({
        name: entry.name,
        version: entry.version,
        installed: true,
        path: installed.asset_path,
        type: entry.type || 'domain',
      }),
    );
  } else {
    console.log(`✓ Installed ${entry.name}@${entry.version}`);
    console.log(`  Asset: ${installed.asset_path}`);
  }
}

function installCluster(clusterEntry, resolver, _yes, jsonMode = false) {
  const subdomains = clusterEntry.cluster?.domains || [];
  if (!subdomains.length) {
    error(`Cluster ${clusterEntry.name} has no sub-domains listed.`);
  }

  if (!jsonMode) console.log(`Cluster ${clusterEntry.name} → ${subdomains.length} sub-domains`);

  for (const sub of subdomains) {
    try {
      const resolved = resolver.resolve(sub);
      if (!resolved.entry.asset_url) {
        if (!jsonMode) console.warn(`  ⚠ ${sub}: no asset_url (skipping)`);
        continue;
      }
      if (!jsonMode) console.log('');
      installSingleFromUrl({ entry: resolved.entry, scope: resolved.scope }, jsonMode);
    } catch (e) {
      if (!jsonMode) console.warn(`  ⚠ ${sub}: ${e.message.split('\n')[0]}`);
    }
  }

  if (jsonMode) {
    console.log(
      JSON.stringify({
        name: clusterEntry.name,
        version: clusterEntry.version,
        type: 'cluster',
        installed: true,
        subdomains: subdomains.length,
      }),
    );
  } else {
    console.log('');
    console.log(`✓ Cluster ${clusterEntry.name} installed`);
  }
}

function installFromLocalFile(filePath, yes, jsonMode = false, trusted = false) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) error(`Not a file: ${abs}`);
  if (!abs.endsWith('.kdna')) error(`Not a .kdna asset: ${abs}`, EXIT.INPUT_ERROR);

  const manifest = readContainerJson(abs, 'kdna.json');
  const declared = manifest?.name;
  if (!declared || !/^@[a-z][a-z0-9-]*\/[a-z][a-z0-9_]*$/.test(declared)) {
    error(scopedNameError('package kdna.json.name', declared), EXIT.INPUT_ERROR);
  }

  // ── Trust checks for local install ──────────────────────────
  const trustLevel = { label: 'local_unverified', issues: [] };

  // Check mimetype (plain text, not JSON)
  try {
    const mimeEntry = readContainerEntry(abs, 'mimetype');
    const hasMimetype =
      mimeEntry && mimeEntry.toString().trim() === 'application/vnd.aikdna.kdna+zip';
    if (!hasMimetype) trustLevel.issues.push('missing or incorrect mimetype');
  } catch {
    trustLevel.issues.push('no mimetype entry');
  }

  // Check for KDNA_Core.json (may be encrypted — skip if unreadable)
  try {
    const hasCore = readContainerJson(abs, 'KDNA_Core.json');
    if (!hasCore) trustLevel.issues.push('missing KDNA_Core.json');
  } catch {
    trustLevel.issues.push('KDNA_Core.json unreadable (may be encrypted)');
  }

  // Check content_digest
  if (!manifest.content_digest) trustLevel.issues.push('no content_digest');

  // Check authoring provenance
  if (!manifest.authoring?.created_by) {
    trustLevel.issues.push('no authoring provenance (not Studio-compiled)');
  } else if (manifest.authoring.created_by === 'manual-dev-source') {
    trustLevel.issues.push('created by manual dev source (not Studio-compiled)');
  }

  // Try signature verification if present
  if (manifest.signature) {
    try {
      const sigResult = verifyAsset(abs, { requireSignature: true });
      if (sigResult.signature_valid) {
        trustLevel.label = 'local_signature_verified';
        trustLevel.issues = trustLevel.issues.filter((i) => !i.includes('not Studio-compiled'));
      } else {
        trustLevel.issues.push('signature present but failed verification');
      }
    } catch {
      trustLevel.issues.push('signature verification failed');
    }
  }

  // Legacy --trusted mode: signature/provenance evidence must be present and verified.
  if (trusted && trustLevel.issues.length > 0) {
    const reasons = trustLevel.issues.map((i) => `  - ${i}`).join('\n');
    error(
      `Signature/provenance verification failed for local .kdna asset:\n${reasons}\n\n` +
        `Use 'kdna install <file.kdna>' without --trusted to install anyway (unverified local asset).`,
      EXIT.TRUST_FAILED,
    );
  }
  // Signature is required for legacy --trusted mode.
  if (trusted && !manifest.signature) {
    error(
      '--trusted requires a signed .kdna asset. This asset has no signature.\n' +
        'Use Studio compile/export with --sign, or install without --trusted.',
      EXIT.TRUST_FAILED,
    );
  }
  // For tested+ quality_badge, require Studio-compatible authoring provenance.
  const highTrustBadges = new Set(['tested', 'validated', 'expert_reviewed', 'production_ready']);
  if (
    trusted &&
    highTrustBadges.has(manifest.quality_badge) &&
    (!manifest.authoring?.compiler || !manifest.authoring?.compiler_version)
  ) {
    error(
      `--trusted requires Studio-compatible authoring provenance for quality_badge "${manifest.quality_badge}".\n` +
        'This asset lacks compiler provenance. Re-publish through Studio pipeline.',
      EXIT.TRUST_FAILED,
    );
  }

  if (!jsonMode) {
    if (trustLevel.label === 'local_signature_verified') {
      console.log(`  Verification: ${trustLevel.label}`);
    } else {
      console.warn(`  Verification: ${trustLevel.label} — ${trustLevel.issues.join('; ')}`);
    }
  }

  auditLog('install', {
    name: declared,
    version: manifest.version,
    source: 'local-file',
    path: abs,
  });
  const installed = installAsset({
    sourcePath: abs,
    name: declared,
    version: manifest.version,
    source: { type: 'local-file', path: abs },
  });

  if (jsonMode) {
    console.log(
      JSON.stringify({
        name: declared,
        installed: true,
        path: installed.asset_path,
        receipt_path: installed.receipt_path,
        asset_digest: installed.asset_digest,
        content_digest: installed.content_digest,
        source: 'local-file',
        source_path: abs,
      }),
    );
  } else {
    console.log(`✓ Installed ${declared} from local .kdna asset`);
    console.log(`  Asset: ${installed.asset_path}`);
  }
}

// ─── Remove ─────────────────────────────────────────────────────────────

function cmdRemove(input) {
  const parsed = parseName(input);
  if (!parsed) error(`Invalid name "${input}". Use @scope/name or bare name.`);
  auditLog('remove', { name: parsed.full });
  if (!removeInstalled(parsed.full)) {
    console.log(`${parsed.full} is not installed.`);
    return;
  }
  console.log(`✓ Removed ${parsed.full}`);
}

// ─── Info ───────────────────────────────────────────────────────────────

function cmdInfo(input, jsonMode = false) {
  const parsed = parseName(input);
  if (!parsed) error(`Invalid name "${input}".`, EXIT.INPUT_ERROR);
  const installed = getInstalled(parsed.full);
  if (!installed) error(`${parsed.full} is not installed.`, EXIT.INPUT_ERROR);

  const container = readContainer(installed.asset_path);
  const manifest = container.manifest || {};
  const core = container.core || {};
  const pat = container.patterns || {};
  const source = installed.source || {};

  // ─── Judgment surface (computed for both modes) ────────────────────
  const axiomCount = (core?.axioms || []).length;
  const ontologyCount = (core?.ontology || []).length;
  const stanceCount = (core?.stances || []).length;
  const misCount = (pat?.misunderstandings || []).length;
  const selfCheckCount = (pat?.self_check || []).length;

  // ─── v2.1 governance score ─────────────────────────────────────────
  let governance = null;
  if (axiomCount > 0) {
    const withApplies = (core?.axioms || []).filter(
      (a) => Array.isArray(a.applies_when) && a.applies_when.length,
    ).length;
    const withDoesNotApply = (core?.axioms || []).filter(
      (a) => Array.isArray(a.does_not_apply_when) && a.does_not_apply_when.length,
    ).length;
    const withFailureRisk = (core?.axioms || []).filter((a) => a.failure_risk).length;
    const pct = Math.round(
      ((withApplies + withDoesNotApply + withFailureRisk) / (axiomCount * 3)) * 100,
    );
    governance = { withApplies, withDoesNotApply, withFailureRisk, coverage: pct };
  }

  // ─── Eval cases ────────────────────────────────────────────────────
  const evalInfo = null;

  // ─── Known risks ───────────────────────────────────────────────────
  const risks = [];
  if (core?.axioms) {
    for (const a of core.axioms) {
      if (a.failure_risk) risks.push({ source: a.id, text: a.failure_risk });
    }
  }

  // ─── Files ─────────────────────────────────────────────────────────
  const expected = [
    'KDNA_Core.json',
    'KDNA_Patterns.json',
    'KDNA_Scenarios.json',
    'KDNA_Cases.json',
    'KDNA_Reasoning.json',
    'KDNA_Evolution.json',
  ];
  const present = expected.filter((f) => container.files.includes(f));

  // ─── JSON mode: emit structured output only, then exit ─────────────
  if (jsonMode) {
    const result = {
      name: parsed.full,
      version: manifest?.version || core?.meta?.version || '?',
      judgment_version: manifest?.judgment_version || null,
      status: manifest?.status || '?',
      license: manifest?.license?.type || '?',
      author: manifest?.author?.name || '?',
      pubkey: manifest?.author?.pubkey || null,
      has_pem: !!manifest?.author?.public_key_pem,
      source_url: source.asset_url || null,
      asset_digest: installed.asset_digest || source.asset_digest || null,
      content_digest: installed.content_digest || null,
      receipt_path: installed.receipt_path || null,
      installed_at: installed.installed_at || null,
      path: installed.asset_path,
      axioms: axiomCount,
      ontology: ontologyCount,
      stances: stanceCount,
      misunderstandings: misCount,
      self_checks: selfCheckCount,
      governance,
      evals: evalInfo,
      risks: risks.slice(0, 10),
      files: { present: present.length, total: expected.length, list: present },
    };
    console.log(JSON.stringify(result));
    process.exit(EXIT.OK);
  }

  // ─── Header ─────────────────────────────────────────────────────
  console.log('═'.repeat(64));
  console.log(`  ${parsed.full}`);
  console.log('═'.repeat(64));
  console.log(`  Version:           ${manifest?.version || core?.meta?.version || '?'}`);
  if (manifest?.judgment_version) {
    console.log(`  Judgment version:  ${manifest.judgment_version}`);
  }
  console.log(`  Status:            ${manifest?.status || '?'}`);
  console.log(`  License:           ${manifest?.license?.type || '?'}`);
  console.log(`  Author:            ${manifest?.author?.name || '?'}`);

  // ─── Identity & trust ──────────────────────────────────────────
  console.log('');
  console.log('  ── Identity & trust ──');
  if (manifest?.author?.pubkey) {
    console.log(`  Author pubkey:     ${manifest.author.pubkey.slice(0, 28)}…`);
  }
  if (manifest?.author?.public_key_pem) {
    console.log(`  Embedded PEM:      yes (full Ed25519 verify available)`);
  } else {
    console.log(`  Embedded PEM:      no`);
  }
  if (source.asset_url) {
    console.log(`  Source URL:        ${source.asset_url}`);
  }
  if (installed.asset_digest)
    console.log(`  Asset digest:      ${installed.asset_digest.slice(0, 39)}…`);
  if (installed.content_digest)
    console.log(`  Content digest:    ${installed.content_digest.slice(0, 39)}…`);
  if (installed.receipt_path) console.log(`  Receipt:           ${installed.receipt_path}`);
  console.log(`  Installed:         ${installed.installed_at || '?'}`);
  console.log(`  Asset:             ${installed.asset_path}`);

  // ─── Judgment surface ──────────────────────────────────────────
  console.log('');
  console.log('  ── Judgment surface ──');
  console.log(`  Axioms:            ${axiomCount}`);
  console.log(`  Ontology:          ${ontologyCount}`);
  console.log(`  Stances:           ${stanceCount}`);
  console.log(`  Misunderstandings: ${misCount}`);
  console.log(`  Self-checks:       ${selfCheckCount}`);

  // ─── v2.1 governance score ─────────────────────────────────────
  if (governance) {
    console.log('');
    console.log('  ── v2.1 governance ──');
    console.log(`  axioms with applies_when:      ${governance.withApplies}/${axiomCount}`);
    console.log(`  axioms with does_not_apply:    ${governance.withDoesNotApply}/${axiomCount}`);
    console.log(`  axioms with failure_risk:      ${governance.withFailureRisk}/${axiomCount}`);
    console.log(`  governance coverage:           ${governance.coverage}%`);
  }

  // ─── Eval cases ────────────────────────────────────────────────
  if (evalInfo) {
    console.log('');
    console.log('  ── Eval cases ──');
    console.log(`  Files:             ${evalInfo.files}`);
    console.log(`  Total cases:       ${evalInfo.totalCases}`);
  }

  // ─── Known risks ───────────────────────────────────────────────
  if (risks.length) {
    console.log('');
    console.log('  ── Known failure risks ──');
    for (const r of risks.slice(0, 4)) {
      const short = r.text.length > 110 ? r.text.slice(0, 107) + '…' : r.text;
      console.log(`  ⚠ [${r.source}]`);
      console.log(`    ${short}`);
    }
    if (risks.length > 4) console.log(`  (+ ${risks.length - 4} more — see KDNA_Core.json)`);
  }

  // ─── Files ─────────────────────────────────────────────────────
  console.log('');
  console.log(`  Files: ${present.length}/${expected.length} (${present.join(', ') || 'none'})`);

  console.log('');
  console.log(`  Run 'kdna verify ${parsed.full}' for full structure/trust/judgment scoring.`);
}

// ─── Update ─────────────────────────────────────────────────────────────

function cmdUpdate(input) {
  const parsed = parseName(input);
  if (!parsed) error(`Invalid name "${input}".`);
  const installed = getInstalled(parsed.full);
  if (!installed) {
    console.log(`${parsed.full} not installed. Run: kdna install ${input}`);
    return;
  }
  const installedVersion = installed.version || '?';

  const resolver = new RegistryResolver({ allowNetwork: true, refresh: true });
  let entry;
  try {
    ({ entry } = resolver.resolve(parsed.full));
  } catch (e) {
    error(e.message, EXIT.REGISTRY_ERROR);
  }

  if (entry.version === installedVersion) {
    console.log(`${parsed.full}@${installedVersion} is up to date.`);
    return;
  }
  console.log(`Updating ${parsed.full}: ${installedVersion} → ${entry.version}`);
  cmdInstallExtended(parsed.full, ['--yes']);
}

function cmdUpdateAll() {
  const installed = listInstalled();
  if (!installed.length) {
    console.log('No installs.');
    return;
  }
  for (const entry of installed) {
    try {
      cmdUpdate(entry.full);
    } catch (e) {
      console.warn(`  ⚠ ${entry.full}: ${e.message.split('\n')[0]}`);
    }
  }
}

module.exports = {
  cmdInstallExtended,
  cmdRemove,
  cmdInfo,
  cmdUpdate,
  cmdUpdateAll,
  INSTALL_DIR,
};
