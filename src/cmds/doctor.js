const fs = require('fs');
const path = require('path');
const { EXIT, error } = require('./_common');
const USER_KDNA_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.kdna');
const INSTALL_DIR = path.join(USER_KDNA_DIR, 'domains');

function cmdDoctor(args) {
  const json = args.includes('--json');
  const quiet = args.includes('--quiet');

  const checks = [];

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
    checks.push({ name: 'KDNA data directory', status: 'warn', detail: `~/.kdna/ not found` });
  }

  // 4. ~/.kdna/domains/ exists and has domains
  if (fs.existsSync(INSTALL_DIR)) {
    const domains = fs
      .readdirSync(INSTALL_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .reduce((acc, scopeDir) => {
        if (scopeDir.name.startsWith('@')) {
          try {
            return acc + fs.readdirSync(path.join(INSTALL_DIR, scopeDir.name)).length;
          } catch {
            return acc;
          }
        }
        return acc + 1;
      }, 0);
    checks.push({
      name: 'Installed domains',
      status: domains > 0 ? 'ok' : 'warn',
      detail: `${domains} domain${domains !== 1 ? 's' : ''} installed`,
    });
  } else {
    checks.push({ name: 'Domains directory', status: 'warn', detail: '~/.kdna/domains/ not found' });
  }

  // 5. Identity key available
  const identityDir = path.join(USER_KDNA_DIR, 'identity');
  const identityDirOfficial = path.join(USER_KDNA_DIR, 'identity-official');
  const hasIdentity =
    (fs.existsSync(identityDir) && fs.readdirSync(identityDir).length > 0) ||
    (fs.existsSync(identityDirOfficial) && fs.readdirSync(identityDirOfficial).length > 0);
  checks.push({
    name: 'Signing identity',
    status: hasIdentity ? 'ok' : 'warn',
    detail: hasIdentity ? 'key available' : 'no identity (run: kdna identity init)',
  });

  // 6. Registry cache
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
    checks.push({ name: 'Registry cache', status: 'warn', detail: 'not cached (run: kdna registry refresh)' });
  }

  // 7. Schema files available
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

  // 8. Project .kdna/config.json
  const projectConfig = path.join(process.cwd(), '.kdna', 'config.json');
  if (fs.existsSync(projectConfig)) {
    checks.push({ name: 'Project config', status: 'ok', detail: projectConfig });
  } else {
    checks.push({ name: 'Project config', status: 'warn', detail: 'No .kdna/config.json in current project' });
  }

  // Output
  if (json) {
    const result = {
      checks: checks.map((c) => ({
        name: c.name,
        status: c.status,
        detail: c.detail,
      })),
      ok: checks.filter((c) => c.status === 'ok').length,
      warnings: checks.filter((c) => c.status === 'warn').length,
      failures: checks.filter((c) => c.status === 'fail').length,
      healthy: checks.every((c) => c.status !== 'fail'),
    };
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.healthy ? 0 : EXIT.VALIDATION_FAILED);
  }

  if (!quiet) {
    for (const c of checks) {
      const mark = c.status === 'ok' ? '✓' : c.status === 'warn' ? '⚠' : '✗';
      console.log(`${mark} ${c.name}: ${c.detail}`);
    }

    const ok = checks.filter((c) => c.status === 'ok').length;
    const warns = checks.filter((c) => c.status === 'warn').length;
    const fails = checks.filter((c) => c.status === 'fail').length;
    console.log('');
    if (fails > 0) {
      console.log(`${ok}/${checks.length} checks passed (${fails} failure${fails !== 1 ? 's' : ''}, ${warns} warning${warns !== 1 ? 's' : ''})`);
    } else if (warns > 0) {
      console.log(`${ok}/${checks.length} checks passed (${warns} warning${warns !== 1 ? 's' : ''})`);
    } else {
      console.log(`${ok}/${checks.length} checks passed`);
    }
  }

  const hasFail = checks.some((c) => c.status === 'fail');
  process.exit(hasFail ? EXIT.VALIDATION_FAILED : EXIT.OK);
}

module.exports = { cmdDoctor };
