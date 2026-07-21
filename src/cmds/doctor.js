const fs = require('fs');
const path = require('path');
const { EXIT } = require('./_common');
const USER_KDNA_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.kdna');
const core = require('@aikdna/kdna-core');
const {
  installedIntegrity,
  listInstalled,
  resolveAsset,
  verifyAsset,
} = require('../package-store');
const BUNDLED_SKILL_VERSION = require('../../package.json').version;

const AGENTS = [
  { name: 'OpenCode', dir: path.join(process.env.HOME || '', '.agents'), skillsDir: 'skills' },
  { name: 'Codex', dir: path.join(process.env.HOME || '', '.codex'), skillsDir: 'skills' },
  { name: 'Claude Code', dir: path.join(process.env.HOME || '', '.claude'), skillsDir: 'skills' },
  { name: 'Cursor', dir: path.join(process.env.HOME || '', '.cursor'), skillsDir: 'skills' },
  {
    name: 'Gemini Antigravity',
    dir: path.join(process.env.HOME || '', '.gemini', 'antigravity'),
    skillsDir: 'skills',
  },
];

// The supported adapter contract starts from one exact user-approved asset.
// Do not use a discovery command as the version marker: that would make the
// old global-store behavior appear current merely because it is documented.
const CURRENT_SKILL_MARKER = 'Do not discover, install, auto-select, or silently apply assets.';
function checkAgentSkill(agent) {
  const skillPath = path.join(agent.dir, agent.skillsDir, 'kdna-loader', 'SKILL.md');
  if (!fs.existsSync(skillPath)) return { installed: false, version: null, path: skillPath };

  try {
    const content = fs.readFileSync(skillPath, 'utf8');
    const isCurrent = content.includes(CURRENT_SKILL_MARKER);
    return {
      installed: true,
      version: isCurrent ? BUNDLED_SKILL_VERSION : 'outdated',
      path: skillPath,
    };
  } catch {
    return { installed: false, version: null, path: skillPath };
  }
}

function diagnoseInstalledAsset(entry) {
  const reference = `${entry.full || entry.name}@${entry.version || 'unknown'}`;
  const base = {
    asset: reference,
    state: 'invalid',
    canLoadNow: false,
    issueCodes: [],
  };

  const integrity = installedIntegrity(entry);
  if (!integrity.valid) {
    return {
      ...base,
      issueCodes: ['KDNA_INSTALLED_INTEGRITY_INVALID'],
      issueCount: integrity.problems.length,
    };
  }

  try {
    core.inspect(entry.asset_path);
    const validation = verifyAsset(entry.asset_path);
    if (validation?.ok !== true) {
      return {
        ...base,
        issueCodes: ['KDNA_ASSET_VALIDATION_FAILED'],
        issueCount: Array.isArray(validation?.errors) ? validation.errors.length : 1,
      };
    }

    const plan = core.planLoad(entry.asset_path, {
      resolveAsset: (name) => resolveAsset(name)?.asset_path || null,
    });
    const issueCodes = Array.isArray(plan?.issues)
      ? plan.issues.map((issue) => issue?.code).filter(Boolean)
      : [];
    const valid = plan?.checks?.overall_valid === true && plan?.state !== 'invalid';
    return {
      ...base,
      state: valid ? plan.state : 'invalid',
      canLoadNow: valid && plan.can_load_now === true,
      issueCodes: valid ? issueCodes : ['KDNA_LOAD_PLAN_INVALID', ...issueCodes],
      issueCount: valid ? issueCodes.length : Math.max(1, issueCodes.length),
    };
  } catch {
    return {
      ...base,
      issueCodes: ['KDNA_ASSET_DIAGNOSTIC_FAILED'],
      issueCount: 1,
    };
  }
}

function cmdDoctor(args) {
  const json = args.includes('--json');
  const quiet = args.includes('--quiet');
  const agentsOnly = args.includes('--agents');
  const domainsOnly = args.includes('--domains');

  const checks = [];

  if (!agentsOnly) {
    // 1. Node.js version
    const nodeVersion = process.version;
    const major = parseInt(nodeVersion.slice(1).split('.')[0], 10);
    checks.push({
      name: 'Node.js',
      status: major >= 18 ? 'ok' : 'fail',
      detail: `${nodeVersion} (${major >= 18 ? '>=18 required' : 'requires >=18'})`,
    });

    // 2. @aikdna/kdna-core available
    let coreVersion = null;
    try {
      const corePkg = require.resolve('@aikdna/kdna-core/package.json');
      coreVersion = JSON.parse(fs.readFileSync(corePkg, 'utf8')).version;
      checks.push({ name: '@aikdna/kdna-core', status: 'ok', detail: `v${coreVersion}` });
    } catch {
      checks.push({ name: '@aikdna/kdna-core', status: 'fail', detail: 'not installed' });
    }

    // 3. ~/.kdna/ exists
    if (fs.existsSync(USER_KDNA_DIR)) {
      checks.push({ name: 'KDNA data directory', status: 'ok', detail: USER_KDNA_DIR });
    } else {
      checks.push({ name: 'KDNA data directory', status: 'warn', detail: '~/.kdna/ not found' });
    }

    // 4. Audit the authoritative index even when an asset lives outside the
    // conventional packages directory. An index entry is a runtime claim and
    // must never disappear from Doctor merely because that directory is absent.
    const installed = listInstalled();
    const assets = installed.map(diagnoseInstalledAsset);
    const domains = assets.length;
    const ready = assets.filter((asset) => asset.canLoadNow).length;
    const invalid = assets.filter((asset) => asset.state === 'invalid').length;
    const needsAction = domains - ready - invalid;
    checks.push({
      name: 'Installed assets',
      status: invalid > 0 ? 'fail' : needsAction > 0 ? 'warn' : domains > 0 ? 'ok' : 'info',
      detail:
        `${domains} .kdna asset${domains !== 1 ? 's' : ''} installed; ` +
        `${ready} ready, ${needsAction} need action, ${invalid} invalid` +
        (domains === 0 ? ' (run: kdna install <asset> to get started)' : ''),
      assets,
    });
  }

  if (!domainsOnly) {
    // 5. Agent integration check
    for (const agent of AGENTS) {
      const agentDirExists = fs.existsSync(agent.dir);
      const skill = agentDirExists
        ? checkAgentSkill(agent)
        : { installed: false, version: null, path: null };

      let status, detail;
      if (!agentDirExists) {
        status = 'warn';
        detail = 'agent not detected';
      } else if (skill.installed && skill.version === BUNDLED_SKILL_VERSION) {
        status = 'ok';
        detail = `kdna-loader installed (${skill.version})`;
      } else if (skill.installed && skill.version === 'outdated') {
        status = 'warn';
        detail = 'kdna-loader outdated (run kdna setup --force)';
      } else {
        status = 'warn';
        detail = 'kdna-loader not installed (run kdna setup)';
      }

      checks.push({
        name: `Agent: ${agent.name}`,
        status,
        detail,
        agent: agent.name,
        skillInstalled: skill.installed,
        skillVersion: skill.version,
        skillPath: skill.path,
      });
    }
  }

  if (!agentsOnly && !domainsOnly) {
    // 6. Identity key available
    const identityDir = path.join(USER_KDNA_DIR, 'identity');
    const identityDirOfficial = path.join(USER_KDNA_DIR, 'identity-official');
    const hasIdentity =
      (fs.existsSync(identityDir) && fs.readdirSync(identityDir).length > 0) ||
      (fs.existsSync(identityDirOfficial) && fs.readdirSync(identityDirOfficial).length > 0);
    checks.push({
      name: 'Signing identity',
      status: hasIdentity ? 'ok' : 'info',
      detail: hasIdentity
        ? 'key available'
        : 'no identity (run: kdna identity init to enable signing)',
    });

    // 7. Registry cache
    const registryCache = path.join(USER_KDNA_DIR, 'registry-cache.json');
    if (fs.existsSync(registryCache)) {
      try {
        const stat = fs.statSync(registryCache);
        const ageMs = Date.now() - stat.mtimeMs;
        const ageH = Math.round(ageMs / 3600000);
        const fresh = ageH < 24;
        checks.push({
          name: 'Registry cache',
          status: fresh ? 'ok' : 'warn',
          detail: `updated ${ageH < 1 ? '<1h' : ageH + 'h'} ago`,
        });
      } catch {
        checks.push({ name: 'Registry cache', status: 'warn', detail: 'cannot read cache' });
      }
    } else {
      checks.push({
        name: 'Registry cache',
        status: 'info',
        detail: 'not cached (registry is optional for single-asset use)',
      });
    }

    // 8. Schema files available
    let schemaCount = 0;
    try {
      const schemaDir = path.join(
        path.dirname(require.resolve('@aikdna/kdna-core/package.json')),
        'schema',
      );
      schemaCount = fs.readdirSync(schemaDir).filter((f) => f.endsWith('.schema.json')).length;
      checks.push({
        name: 'Schema files',
        status: schemaCount >= 6 ? 'ok' : 'warn',
        detail: `${schemaCount} schemas`,
      });
    } catch {
      checks.push({ name: 'Schema files', status: 'fail', detail: 'not found' });
    }

    // 9. Project .kdna/config.json
    const projectConfig = path.join(process.cwd(), '.kdna', 'config.json');
    if (fs.existsSync(projectConfig)) {
      checks.push({ name: 'Project config', status: 'ok', detail: projectConfig });
    } else {
      checks.push({
        name: 'Project config',
        status: 'info',
        detail: 'No .kdna/config.json in current project (not required for basic use)',
      });
    }
  }

  // ── Output ───────────────────────────────────────────────────────

  if (json) {
    const result = {
      checks: checks.map((c) => ({
        name: c.name,
        status: c.status,
        detail: c.detail,
        ...(c.assets && { assets: c.assets }),
        ...(c.agent && {
          agent: c.agent,
          skillInstalled: c.skillInstalled,
          skillVersion: c.skillVersion,
        }),
      })),
      ok: checks.filter((c) => c.status === 'ok').length,
      info: checks.filter((c) => c.status === 'info').length,
      warnings: checks.filter((c) => c.status === 'warn').length,
      failures: checks.filter((c) => c.status === 'fail').length,
      healthy: checks.every((c) => c.status !== 'fail'),
    };
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.healthy ? 0 : EXIT.VALIDATION_FAILED);
  }

  if (!quiet) {
    for (const c of checks) {
      const mark =
        c.status === 'ok' ? '✓' : c.status === 'warn' ? '⚠' : c.status === 'info' ? 'ℹ' : '✗';
      console.log(`${mark} ${c.name}: ${c.detail}`);
    }

    const ok = checks.filter((c) => c.status === 'ok').length;
    const infos = checks.filter((c) => c.status === 'info').length;
    const warns = checks.filter((c) => c.status === 'warn').length;
    const fails = checks.filter((c) => c.status === 'fail').length;
    console.log('');
    if (fails > 0) {
      console.log(
        `${ok}/${checks.length} checks passed (${fails} failure${fails !== 1 ? 's' : ''}, ${warns} warning${warns !== 1 ? 's' : ''})`,
      );
    } else if (warns > 0) {
      console.log(
        `${ok}/${checks.length} checks passed (${warns} warning${warns !== 1 ? 's' : ''}${
          infos > 0 ? `, ${infos} info item${infos !== 1 ? 's' : ''}` : ''
        })`,
      );
    } else {
      console.log(
        `${ok}/${checks.length} checks passed${
          infos > 0
            ? ` (${infos} info item${infos !== 1 ? 's' : ''} — all normal for a fresh install)`
            : ''
        }`,
      );
    }
  }

  const hasFail = checks.some((c) => c.status === 'fail');
  process.exit(hasFail ? EXIT.VALIDATION_FAILED : EXIT.OK);
}

module.exports = { cmdDoctor };
