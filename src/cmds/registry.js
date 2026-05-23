const fs = require('fs');
const path = require('path');
const { CANONICAL_REGISTRY_URL, REGISTRY_CACHE, fetchRegistry } = require('../registry');
const { error, readJson, loadRegistry, INSTALL_DIR, EXIT } = require('./_common');

function cmdList(showAvailable, jsonMode = false) {
  if (showAvailable) {
    const domains = loadRegistry({ allowNetwork: true });
    if (!domains || !domains.length) {
      if (jsonMode) {
        console.log(JSON.stringify([]));
        process.exit(EXIT.OK);
      }
      error('No registry found.');
    }

    if (jsonMode) {
      const result = domains.map((d) => ({
        name: d.name || d.id || null,
        version: d.version || null,
        type: d.type || 'domain',
        status: d.status || null,
        description: d.description || null,
        yanked: d.yanked || false,
        deprecated: d.deprecated || false,
      }));
      console.log(JSON.stringify(result));
      process.exit(EXIT.OK);
    }

    console.log('Available KDNA domains:');
    console.log(`Registry: ${REGISTRY_CACHE}`);
    console.log('');
    for (const d of domains) {
      const name = d.name || d.id || '?';
      const [scope, ident] = name.includes('/') ? name.split('/') : [null, name];
      const installedPath = scope ? path.join(INSTALL_DIR, scope, ident) : null;
      const installed = installedPath && fs.existsSync(installedPath) ? '[installed]' : '';
      const yanked = d.yanked ? '[yanked] ' : '';
      const dep = d.deprecated ? '[deprecated] ' : '';
      console.log(
        `  ${name.padEnd(36)} ${(d.version || '?').padEnd(8)} ${(d.type || 'domain').padEnd(8)} ${(d.status || '').padEnd(14)} ${yanked}${dep}${installed}`,
      );
      if (d.description) console.log(`    ${d.description}`);
      console.log('');
    }
    return;
  }

  if (!fs.existsSync(INSTALL_DIR)) {
    if (jsonMode) {
      console.log(JSON.stringify([]));
      process.exit(EXIT.OK);
    }
    console.log('No domains installed.');
    console.log(`Installation directory: ${INSTALL_DIR}`);
    return;
  }

  // v0.7 layout: ~/.kdna/domains/@scope/name/
  const scopes = fs.readdirSync(INSTALL_DIR).filter((d) => {
    if (!d.startsWith('@')) return false;
    try {
      return fs.statSync(path.join(INSTALL_DIR, d)).isDirectory();
    } catch {
      return false;
    }
  });

  const installed = [];
  for (const scope of scopes) {
    const sd = path.join(INSTALL_DIR, scope);
    for (const ident of fs.readdirSync(sd)) {
      if (ident.startsWith('.')) continue;
      const full = path.join(sd, ident);
      try {
        if (!fs.statSync(full).isDirectory()) continue;
      } catch {
        continue;
      }
      installed.push({ scope, ident, full });
    }
  }

  // Detect and warn about legacy (un-scoped) installs
  if (!jsonMode) {
    const legacy = fs.readdirSync(INSTALL_DIR).filter((d) => {
      if (d.startsWith('@') || d.startsWith('.')) return false;
      try {
        return fs.statSync(path.join(INSTALL_DIR, d)).isDirectory();
      } catch {
        return false;
      }
    });
    if (legacy.length) {
      console.log('⚠ Legacy (un-scoped) directories detected — please remove + re-install:');
      legacy.forEach((d) => console.log(`    ~/.kdna/domains/${d}/`));
      console.log('');
    }
  }

  if (!installed.length) {
    if (jsonMode) {
      console.log(JSON.stringify([]));
      process.exit(EXIT.OK);
    }
    console.log('No v0.7 domains installed.');
    console.log(`Run: kdna install <name>      # e.g. kdna install writing`);
    return;
  }

  // Build structured data for installed domains
  const domains = installed.map(({ scope, ident, full }) => {
    const core = readJson(path.join(full, 'KDNA_Core.json'));
    const manifest = readJson(path.join(full, 'kdna.json'));
    const cluster = readJson(path.join(full, 'cluster.json'));
    return {
      name: `${scope}/${ident}`,
      version: manifest?.version || manifest?._source?.version || core?.meta?.version || '?',
      type: cluster ? 'cluster' : 'domain',
      description: manifest?.description || core?.meta?.purpose || '',
    };
  });

  if (jsonMode) {
    console.log(JSON.stringify(domains));
    process.exit(EXIT.OK);
  }

  console.log('Installed KDNA domains:');
  console.log('');
  for (const d of domains) {
    const kind = d.type === 'cluster' ? '[cluster]' : '';
    console.log(`  ${d.name.padEnd(36)} v${d.version} ${kind}`);
    if (d.description) console.log(`    ${d.description}`);
  }
  console.log('');
  console.log(`Location: ${INSTALL_DIR}`);
}

function cmdRegistry(subcommand) {
  if (subcommand !== 'refresh') {
    error('Usage: kdna registry refresh');
  }
  const domains = fetchRegistry();
  console.log(`✓ Registry refreshed from ${CANONICAL_REGISTRY_URL}`);
  console.log(`  Cache: ${REGISTRY_CACHE}`);
  console.log(`  Domains: ${domains.length}`);
}

module.exports = {
  cmdList,
  cmdRegistry,
};
