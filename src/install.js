/**
 * KDNA Install — v0.7 .kdna-first installer.
 *
 * Sources (priority order):
 *   kdna install <bare>                     → @aikdna/<bare>, from registry
 *   kdna install @scope/name                → from registry (any scope)
 *   kdna install @scope/name@1.2.3          → exact registry version
 *   kdna install ./file.kdna                → local .kdna file
 *
 * Removed in v0.7 (breaking): github:user/repo, --from-git, cluster:github:...,
 * tarball/SSH fallbacks. Install is now strictly .kdna-driven from the registry.
 *
 * Registry metadata is adapter-local and out of scope for KDNA Core.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const core = require('@aikdna/kdna-core');
const {
  RegistryResolver,
  nameFromAssetId,
  parseName,
  compareExactVersions,
} = require('./registry');
const { EXIT, error, assertHttpsDownloadUrl } = require('./cmds/_common');
const PATHS = require('./paths');
const {
  installAsset,
  getInstalled,
  listInstalled,
  removeInstalled,
  sha256File,
  readContainer,
  readContainerJson,
  assertInstalledIntegrity,
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
  const toUpdate = [];
  const localTemplate = path.resolve(__dirname, '..', 'skills', 'kdna-loader', 'SKILL.md');
  const bundled = fs.existsSync(localTemplate) ? fs.readFileSync(localTemplate, 'utf8') : null;

  for (const dir of AGENT_SKILL_DIRS) {
    if (!fs.existsSync(path.dirname(dir))) continue;
    const skillFile = path.join(dir, 'kdna-loader', 'SKILL.md');
    if (fs.existsSync(skillFile)) {
      let isCurrent = false;
      try {
        const content = fs.readFileSync(skillFile, 'utf8');
        isCurrent = bundled !== null && content === bundled;
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
      `  ✓ Current bundled kdna-loader found in: ${alreadyInstalled.map((d) => path.basename(path.dirname(d))).join(', ')}`,
    );
  }

  if (toUpdate.length > 0) {
    console.log(
      `   ⚠ Preserving ${toUpdate.length} customized or outdated kdna-loader cop${toUpdate.length > 1 ? 'ies' : 'y'}. Run kdna setup --force to replace.`,
    );
  }

  const targets = toInstall;
  if (targets.length === 0) return;
  console.log('  Installing bundled kdna-loader skill...');

  let installed = 0;
  for (const dir of targets) {
    const skillDir = path.join(dir, 'kdna-loader');
    try {
      if (fs.existsSync(localTemplate)) {
        fs.mkdirSync(skillDir, { recursive: true });
        fs.copyFileSync(localTemplate, path.join(skillDir, 'SKILL.md'));
        installed++;
      }
    } catch {
      // Report aggregate failures below.
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
          `Use: kdna pack ${resolved} <output.kdna>, then kdna install <file.kdna>`,
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

function printActiveVersionKeptHint(installed, full, jsonMode) {
  if (jsonMode || !installed?.active_version_kept) return;
  const kept = installed.active_version_kept;
  console.log(`  Active version unchanged: ${full} stays on ${kept}.`);
  console.log(
    `  To switch: kdna remove ${full}@${kept} (the newest remaining version becomes active),`,
  );
  console.log(`  or pin a version explicitly where one is accepted: ${full}@<version>.`);
}

function downloadFile(url, dest) {
  // HTTPS-only: registry metadata must never redirect the installer to
  // file:/ftp:/javascript: URLs. Digest verification below still applies.
  assertHttpsDownloadUrl(url);
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
  if (args.includes('--trusted')) {
    error('Asset signatures are outside the current Preview contract.', EXIT.INPUT_ERROR);
  }
  const allowUnverified = args.includes('--allow-unverified');
  const local = args.includes('--local');
  const source = parseSource(input);

  switch (source.type) {
    case 'registry':
      return installFromRegistry(source.parsed, yes, jsonMode, local);
    case 'local-file':
      return installFromLocalFile(source.path, yes, jsonMode, local, allowUnverified);
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

function installNameFromManifest(manifest) {
  return manifest.name || nameFromAssetId(manifest.asset_id) || null;
}

function validationIssues(result) {
  if (!result || result.overall_valid === true) return [];
  if (Array.isArray(result.problems) && result.problems.length > 0) {
    return result.problems.map((problem) => String(problem));
  }
  return ['format_valid', 'schema_valid', 'payload_valid', 'checksums_valid', 'load_contract_valid']
    .filter((field) => result[field] === false)
    .map((field) => `${field}=false`);
}

function assessLocalFormat(assetPath) {
  if (typeof core.validate !== 'function') {
    return { label: 'local_unverified', issues: ['core validate API unavailable'] };
  }
  try {
    const result = core.validate(assetPath);
    const issues = validationIssues(result);
    if (issues.length === 0) {
      return { label: 'local_format_valid', issues: [] };
    }
    return { label: 'local_unverified', issues };
  } catch (e) {
    return { label: 'local_unverified', issues: [`format validation failed: ${e.message}`] };
  }
}

function installFromRegistry(parsed, yes, jsonMode = false, local = false) {
  const resolver = new RegistryResolver({ allowNetwork: true });
  let entry;
  try {
    ({ entry } = resolver.resolve(parsed.reference || parsed.full));
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
  if (entry.access && entry.access !== 'public') {
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
        `(Current registry metadata publishes canonical .kdna assets through asset_url only.)`,
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

  installSingleFromUrl({ entry }, jsonMode, local);
}

function installSingleFromUrl({ entry }, jsonMode = false, local = false) {
  const ident = entry.name.split('/')[1];
  const tmpDir = path.join(USER_KDNA_DIR, 'cache', 'downloads');
  const tmpFile = path.join(tmpDir, `.${ident}-${Date.now()}.kdna.tmp`);
  const assetUrl = entry.asset_url;

  if (!jsonMode) console.log(`  Downloading ${entry.name}@${entry.version}...`);
  ensureDir(tmpDir);
  try {
    downloadFile(assetUrl, tmpFile);
  } catch (downloadError) {
    error(`Failed to download ${assetUrl}: ${downloadError.message}`, EXIT.REGISTRY_ERROR);
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

  auditLog('install', { name: entry.name, version: entry.version, source: 'registry' });
  const installed = installAsset({
    sourcePath: tmpFile,
    name: entry.name,
    version: entry.version,
    local,
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
    printActiveVersionKeptHint(installed, entry.name, jsonMode);
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
      installSingleFromUrl({ entry: resolved.entry }, jsonMode);
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

function installFromLocalFile(
  filePath,
  yes,
  jsonMode = false,
  local = false,
  allowUnverified = false,
) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) error(`Not a file: ${abs}`);
  if (!abs.endsWith('.kdna')) error(`Not a .kdna asset: ${abs}`, EXIT.INPUT_ERROR);

  const manifest = readContainerJson(abs, 'kdna.json');
  const declared = installNameFromManifest(manifest || {});
  if (!declared || !parseName(declared)) {
    error(scopedNameError('package kdna.json.name', declared), EXIT.INPUT_ERROR);
  }

  // ── Local install verification ──────────────────────────────
  const trustLevel = assessLocalFormat(abs);

  if (trustLevel.issues.length > 0 && !allowUnverified) {
    const reasons = trustLevel.issues.map((issue) => `  - ${issue}`).join('\n');
    error(
      `Local asset validation failed; refusing to install:\n${reasons}\n\n` +
        'Fix the asset, or use --allow-unverified only for an explicit development workflow.',
      EXIT.VALIDATION_FAILED,
    );
  }

  if (!jsonMode) {
    if (trustLevel.issues.length === 0) {
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
    local,
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
        verification: {
          status: trustLevel.label,
          valid: trustLevel.issues.length === 0,
          issues: trustLevel.issues,
          allow_unverified: allowUnverified,
        },
        source: 'local-file',
        source_path: abs,
      }),
    );
  } else {
    console.log(`✓ Installed ${declared} from local .kdna asset`);
    console.log(`  Asset: ${installed.asset_path}`);
    printActiveVersionKeptHint(installed, declared, jsonMode);
  }
}

// ─── Remove ─────────────────────────────────────────────────────────────

function cmdRemove(input) {
  const parsed = parseName(input);
  if (!parsed) error(`Invalid name "${input}". Use @scope/name or bare name.`);
  const reference = parsed.version ? `${parsed.full}@${parsed.version}` : parsed.full;
  auditLog('remove', { name: parsed.full, version: parsed.version || null });
  if (!removeInstalled(reference)) {
    console.log(`${reference} is not installed.`);
    return;
  }
  console.log(`✓ Removed ${reference}`);
}

// ─── List ───────────────────────────────────────────────────────────────

// Human-facing list of installed KDNA packages. Distinct from
// `kdna available` (which is agent-facing discovery metadata).
// This command answers the "what is installed on this machine" question.
function cmdList(args = []) {
  const jsonMode = args.includes('--json');
  const installed = listInstalled({ allVersions: true });

  if (jsonMode) {
    const out = installed.map((entry) => ({
      name: entry.full,
      version: entry.version || null,
      judgment_version: entry.judgment_version || null,
      access: entry.access || 'public',
      asset_path: entry.asset_path,
      asset_digest: entry.asset_digest || null,
      content_digest: entry.content_digest || null,
      active: entry.active === true,
      tier: entry.tier,
      installed_at: entry.installed_at || null,
    }));
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return;
  }

  if (!installed.length) {
    console.log('No KDNA packages installed.');
    console.log('Install with: kdna install <name>');
    return;
  }
  console.log(`${installed.length} installed KDNA package(s):`);
  for (const entry of installed) {
    const access = entry.access || 'public';
    console.log('');
    console.log(
      `  ${entry.full}  v${entry.version || '?'}  [${access}]${entry.active ? ' [active]' : ''}`,
    );
    if (entry.judgment_version) {
      console.log(`    judgment_version: ${entry.judgment_version}`);
    }
    if (entry.asset_path) {
      console.log(`    asset: ${entry.asset_path}`);
    }
    if (entry.installed_at) {
      console.log(`    installed_at: ${entry.installed_at}`);
    }
  }
}

// ─── Info ───────────────────────────────────────────────────────────────

function cmdInfo(input, jsonMode = false) {
  const parsed = parseName(input);
  if (!parsed) error(`Invalid name "${input}".`, EXIT.INPUT_ERROR);
  const installed = getInstalled(parsed.reference || parsed.full);
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

  // ─── Authoring governance coverage ─────────────────────────────────
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
  console.log('  ── Integrity & source ──');
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

  // ─── Authoring governance coverage ─────────────────────────────
  if (governance) {
    console.log('');
    console.log('  ── Authoring governance coverage ──');
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
  console.log(`  Run 'kdna validate ${installed.asset_path}' for current format validation.`);
}

// ─── Update ─────────────────────────────────────────────────────────────

function cmdUpdate(input, options = {}) {
  const parsed = parseName(input);
  if (!parsed) error(`Invalid name "${input}".`);
  const findInstalled = options.getInstalled || getInstalled;
  const installed = findInstalled(parsed.reference || parsed.full);
  if (!installed) {
    console.log(`${parsed.full} not installed. Run: kdna install ${input}`);
    return;
  }
  const installedVersion = installed.version || '?';
  try {
    assertInstalledIntegrity(installed, `${parsed.full}@${installedVersion}`);
  } catch (integrityError) {
    error(integrityError.message, EXIT.VALIDATION_FAILED);
  }

  const resolver = options.resolver || new RegistryResolver({ allowNetwork: true, refresh: true });
  let entry;
  try {
    ({ entry } = resolver.resolve(parsed.reference || parsed.full));
  } catch (e) {
    error(e.message, EXIT.REGISTRY_ERROR);
  }

  const versionOrder = compareExactVersions(entry.version, installedVersion);
  if (versionOrder === 0) {
    console.log(`${parsed.full}@${installedVersion} is up to date.`);
    return;
  }
  if (versionOrder < 0) {
    console.log(
      `${parsed.full}@${installedVersion} is newer than registry release ${entry.version}; no change.`,
    );
    return;
  }
  console.log(`Updating ${parsed.full}: ${installedVersion} → ${entry.version}`);
  const install = options.install || cmdInstallExtended;
  const installArgs = ['--yes'];
  if (installed.tier === 'project') installArgs.push('--local');
  install(`${entry.name}@${entry.version}`, installArgs);
}

function runUpdateSubprocess(name) {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'cli.js'), 'update', name], {
    encoding: 'utf8',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    ok: result.status === 0,
    code: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || result.error?.message || '',
  };
}

function cmdUpdateAll(options = {}) {
  const installed = options.installed || listInstalled();
  const runUpdate = options.runUpdate || runUpdateSubprocess;
  if (!installed.length) {
    console.log('No installs.');
    return { total: 0, succeeded: 0, failed: 0, results: [] };
  }
  const results = [];
  for (const entry of installed) {
    let result;
    try {
      result = runUpdate(entry.full);
    } catch (error) {
      result = {
        ok: false,
        code: 1,
        stdout: '',
        stderr: error?.message || String(error),
      };
    }
    if (result.stdout) process.stdout.write(result.stdout);
    if (!result.ok) {
      const message = String(result.stderr || `exit ${result.code}`)
        .trim()
        .split('\n')[0];
      console.warn(`  ⚠ ${entry.full}: ${message}`);
    }
    results.push({ name: entry.full, ok: result.ok, code: result.code });
  }
  const failed = results.filter((result) => !result.ok).length;
  const summary = {
    total: results.length,
    succeeded: results.length - failed,
    failed,
    results,
  };
  console.log(
    `Update summary: ${summary.succeeded}/${summary.total} completed, ${summary.failed} failed.`,
  );
  if (failed > 0 && options.setExitCode !== false) {
    process.exitCode = 1;
  }
  return summary;
}

module.exports = {
  cmdInstallExtended,
  cmdRemove,
  cmdList,
  cmdInfo,
  cmdUpdate,
  cmdUpdateAll,
  runUpdateSubprocess,
  INSTALL_DIR,
};
