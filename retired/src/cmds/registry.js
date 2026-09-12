const { CANONICAL_REGISTRY_URL, REGISTRY_CACHE, fetchRegistry } = require('../registry');
const { describeDownloadFailure } = require('../https-download');
const { error, loadRegistry, EXIT } = require('./_common');
const { listInstalled, readContainer } = require('../package-store');

function cmdList(showAvailable, jsonMode = false, _locale = null) {
  if (showAvailable) {
    const domains = loadRegistry({ allowNetwork: true });
    if (!domains || !domains.length) {
      if (jsonMode) {
        console.log(JSON.stringify([]));
        process.exit(EXIT.OK);
      }
      error('No registry found.');
    }

    const installableDomains = domains.filter((d) => d.yanked !== true);

    if (jsonMode) {
      const result = installableDomains.map((d) => ({
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

    console.log('Available installable KDNA domains:');
    console.log(`Registry: ${REGISTRY_CACHE}`);
    console.log('');
    if (!installableDomains.length) {
      console.log('  No non-yanked registry entries are currently installable.');
      console.log('');
      return;
    }
    for (const d of installableDomains) {
      const name = d.name || d.id || '?';
      const installed = listInstalled().some((entry) => entry.full === name) ? '[installed]' : '';
      const dep = d.deprecated ? '[deprecated] ' : '';
      console.log(
        `  ${name.padEnd(36)} ${(d.version || '?').padEnd(8)} ${(d.type || 'domain').padEnd(8)} ${(d.status || '').padEnd(14)} ${dep}${installed}`,
      );
      if (d.description) console.log(`    ${d.description}`);
      console.log('');
    }
    return;
  }

  const installed = listInstalled();

  if (!installed.length) {
    if (jsonMode) {
      console.log(JSON.stringify([]));
      process.exit(EXIT.OK);
    }
    console.log('No KDNA assets installed.');
    console.log(`Run: kdna install <name>      # e.g. kdna install writing`);
    return;
  }

  // Build structured data for installed domains
  const domains = installed.map((entry) => {
    const { core = {}, manifest = {} } = readContainer(entry.asset_path);
    return {
      name: entry.full,
      version: manifest?.version || entry.version || core?.meta?.version || '?',
      type: 'domain',
      description: manifest?.description || core?.meta?.purpose || '',
      asset: entry.asset_path,
      asset_digest: entry.asset_digest || null,
      content_digest: entry.content_digest || null,
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
  console.log('Assets are stored under ~/.kdna/packages/.');
}

function cmdRegistry(subcommand) {
  if (subcommand !== 'refresh') {
    error('Usage: kdna registry refresh');
  }
  let domains;
  try {
    domains = fetchRegistry();
  } catch (fetchError) {
    // Sterile error: operation name + stable download category only; never
    // the registry URL, curl stderr, or local cache paths.
    error(
      `Failed to refresh registry: ${describeDownloadFailure(fetchError)}`,
      EXIT.REGISTRY_ERROR,
    );
  }
  console.log(`✓ Registry refreshed from ${CANONICAL_REGISTRY_URL}`);
  console.log(`  Cache: ${REGISTRY_CACHE}`);
  console.log(`  Domains: ${domains.length}`);
}

module.exports = {
  cmdList,
  cmdRegistry,
};
