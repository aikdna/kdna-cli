const fs = require('fs');
const path = require('path');
const { error, readJson, EXIT } = require('./_common');
const {
  loadCluster,
  classifySignalsAcrossDomains,
  composeContextWithAttribution,
  detectDomainConflicts,
  generateClusterTrace,
} = require('@aikdna/kdna-core');
const { getInstalled, readContainer } = require('../package-store');

function loadInstalledDomain(domainId) {
  const full = domainId.startsWith('@') ? domainId : `@aikdna/${domainId}`;
  const installed = getInstalled(full);
  if (!installed) return null;
  const { core, patterns } = readContainer(installed.asset_path);
  if (!core || !patterns) return null;
  return { core, patterns };
}

function cmdCluster(args) {
  const { cmdClusterLint } = require('../cluster');
  const sub = args[1];
  const target = args[2];

  if (sub === 'lint') {
    if (!target) error('Usage: kdna cluster lint <path>');
    cmdClusterLint(target);
  } else if (sub === 'init') {
    const { cmdClusterInit } = require('../init');
    cmdClusterInit(target);
  } else if (sub === 'info') {
    if (!target) error('Usage: kdna cluster info <path>');
    cmdClusterInfo(target);
  } else if (sub === 'load') {
    if (!target) error('Usage: kdna cluster load <cluster.json> --input "<task>"');
    cmdClusterLoad(target, args);
  } else if (sub === 'match') {
    if (!target) error('Usage: kdna cluster match <cluster.json> --input "<task>"');
    cmdClusterMatch(target, args);
  } else if (sub === 'compose') {
    if (!target)
      error(
        'Usage: kdna cluster compose <cluster.json> --input "<task>" [--profile=compact] [--json]',
      );
    cmdClusterCompose(target, args);
  } else if (sub === 'conflicts') {
    if (!target) error('Usage: kdna cluster conflicts <cluster.json> --input "<task>" [--json]');
    cmdClusterConflicts(target, args);
  } else if (sub === 'graph') {
    if (!target) error('Usage: kdna cluster graph <cluster.json> [--format=dot|json]');
    cmdClusterGraph(target, args);
  } else if (sub === 'apply') {
    error(
      'kdna cluster apply was removed in v0.9.\n' +
        'To install a cluster (which installs all its sub-domains):\n' +
        '  kdna install @aikdna/animation',
    );
  } else {
    error(
      `Unknown cluster subcommand: ${sub || '(none)'}\n` +
        'Usage: kdna cluster lint <path>\n' +
        '       kdna cluster init <name>\n' +
        '       kdna cluster info <cluster.json>\n' +
        '       kdna cluster match <cluster.json> --input "<task>"\n' +
        '       kdna cluster load <cluster.json> --input "<task>"\n' +
        '       kdna cluster compose <cluster.json> --input "<task>"\n' +
        '       kdna cluster conflicts <cluster.json> --input "<task>"\n' +
        '       kdna cluster graph <cluster.json>',
    );
  }
}

function cmdClusterInfo(target, _format = 'human') {
  const abs = path.resolve(target);
  if (!fs.existsSync(abs)) error(`Cluster manifest not found: ${abs}`);

  const manifest = readJson(abs);
  if (!manifest) error(`Invalid cluster manifest (not valid JSON)`);
  if (!manifest.cluster_id) error(`Not a valid cluster manifest (missing cluster_id)`);

  const domainCount = (manifest.domains || []).length;
  const requiredCount = (manifest.domains || []).filter((d) => d.required !== false).length;
  const composition = manifest.composition || {};

  console.log(`${manifest.name || manifest.cluster_id}`);
  console.log(`  Cluster ID:       ${manifest.cluster_id}`);
  console.log(`  Version:          ${manifest.version || '?'}`);
  console.log(`  Type:             ${manifest.type || 'horizontal'}`);
  console.log(`  Status:           ${manifest.status || 'experimental'}`);
  console.log(`  Domains:          ${domainCount} total, ${requiredCount} required`);
  console.log(`  Strategy:         ${composition.strategy || 'fixed'}`);
  console.log(`  Max active:       ${composition.max_active_domains || 'unlimited'}`);
  console.log(`  Conflict policy:  ${composition.conflict_policy || 'surface'}`);
  console.log('');

  if (manifest.domains?.length) {
    console.log('  Domain inventory:');
    for (const d of manifest.domains) {
      const req = d.required !== false ? '(required)' : '(optional)';
      console.log(`    ${d.role.padEnd(16)} ${d.id} ${req}`);
    }
    console.log('');
  }

  if (manifest.relationships?.length) {
    console.log('  Relationships:');
    for (const r of manifest.relationships) {
      console.log(`    ${r.from} --${r.type}--> ${r.to}`);
    }
    console.log('');
  }
}

/**
 * Load a cluster: resolve domains from installed .kdna assets,
 * classify input signals, compose context with attribution, detect
 * conflicts, and emit the composed context.
 */
function cmdClusterLoad(target, args = []) {
  const abs = path.resolve(target);
  if (!fs.existsSync(abs)) error(`Cluster manifest not found: ${abs}`);

  const inputIdx = args.indexOf('--input');
  const input = inputIdx >= 0 ? args[inputIdx + 1] : '';
  if (!input) error('Usage: kdna cluster load <cluster.json> --input "<task>"');

  const manifest = readJson(abs);
  if (!manifest || !manifest.cluster_id) error('Not a valid cluster manifest');

  const domainLoader = loadInstalledDomain;

  const result = loadCluster(abs, domainLoader);
  if (result.errors.length) {
    console.error('Warnings:');
    result.errors.forEach((e) => console.error(`  - ${e}`));
  }

  // Classify signals
  const classification = classifySignalsAcrossDomains(input, result.domains);

  console.log(`Cluster: ${manifest.cluster_id}`);
  console.log(`Input:   ${input.slice(0, 100)}${input.length > 100 ? '...' : ''}`);
  console.log('');

  if (classification.excluded.length) {
    console.log(`Excluded domains (${classification.excluded.length}):`);
    classification.excluded.forEach((d) => {
      console.log(`  - ${d.id} (${d.reason})`);
    });
    console.log('');
  }

  if (!classification.selected.length) {
    console.log('No domains matched. Try a different input or check domain trigger_signals.');
    return;
  }

  console.log(`Selected domains (${classification.selected.length}):`);
  classification.selected.forEach((d) => {
    console.log(`  + ${d.id} (${d.role}) ← ${d.reason}`);
  });
  console.log('');

  // Detect conflicts
  const conflicts = detectDomainConflicts(classification.selected);
  if (conflicts.length) {
    console.log(`Conflicts detected (${conflicts.length}):`);
    conflicts.forEach((c) => {
      console.log(`  ⚠ [${c.type}] ${c.domains.join(' vs ')}: ${c.description}`);
    });
    console.log('');
  }

  // Compose context with attribution
  const { context } = composeContextWithAttribution(classification.selected);
  console.log('─'.repeat(64));
  console.log(context);
  console.log('─'.repeat(64));

  // Judgment trace
  const trace = generateClusterTrace({
    input,
    loadedDomains: result.domains,
    activeDomains: classification.selected,
    conflicts,
  });
  console.log('');
  console.log('Judgment trace:');
  console.log(JSON.stringify(trace, null, 2));
}

/**
 * Match input against cluster domains without composing full context.
 */
function cmdClusterMatch(target, args = []) {
  const abs = path.resolve(target);
  if (!fs.existsSync(abs)) error(`Cluster manifest not found: ${abs}`);

  const inputIdx = args.indexOf('--input');
  const input = inputIdx >= 0 ? args[inputIdx + 1] : '';
  if (!input) error('Usage: kdna cluster match <cluster.json> --input "<task>"');

  const manifest = readJson(abs);
  if (!manifest || !manifest.cluster_id) error('Not a valid cluster manifest');

  const domainLoader = loadInstalledDomain;

  const result = loadCluster(abs, domainLoader);
  const classification = classifySignalsAcrossDomains(input, result.domains);

  console.log(`Input: ${input.slice(0, 100)}${input.length > 100 ? '...' : ''}`);
  console.log(`Cluster: ${manifest.cluster_id} (${result.domains.length} domains loaded)`);
  console.log('');
  console.log(
    `Matched: ${classification.selected.length} | Excluded: ${classification.excluded.length}`,
  );
  console.log('');

  classification.selected.forEach((d) => {
    console.log(`  ✓ ${d.id} [${d.role}]`);
  });
  classification.excluded.forEach((d) => {
    console.log(`  ✗ ${d.id}: ${d.reason}`);
  });
}

/**
 * Compose: classify input signals, then compose context with source attribution.
 * Unlike load (which includes trace), compose focuses on the composed context.
 */
function cmdClusterCompose(target, args = []) {
  const jsonMode = args.includes('--json');
  const abs = path.resolve(target);
  if (!fs.existsSync(abs)) error(`Cluster manifest not found: ${abs}`);

  const profileIdx = args.indexOf('--profile');
  let profile = 'compact';
  if (profileIdx >= 0) {
    const val = args[profileIdx + 1];
    if (val && !val.startsWith('--')) profile = val;
  }

  const inputIdx = args.indexOf('--input');
  const input = inputIdx >= 0 ? args[inputIdx + 1] : '';
  if (!input) error('Usage: kdna cluster compose <cluster.json> --input "<task>"');

  const manifest = readJson(abs);
  if (!manifest || !manifest.cluster_id) error('Not a valid cluster manifest');

  const domains = loadClusterDomains(manifest);

  const classification = classifySignalsAcrossDomains(input, domains);
  const { context } = composeContextWithAttribution(classification.selected);

  if (jsonMode) {
    console.log(
      JSON.stringify(
        {
          cluster: manifest.cluster_id,
          input: input.slice(0, 200),
          selected: classification.selected.map((d) => ({
            id: d.id,
            role: d.role,
            reason: d.reason,
          })),
          excluded: classification.excluded.map((d) => ({
            id: d.id,
            reason: d.reason,
          })),
          context,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`Cluster: ${manifest.cluster_id}`);
  console.log(`Profile: ${profile}`);
  console.log(`Input:   ${input.slice(0, 100)}${input.length > 100 ? '...' : ''}`);
  console.log('');
  console.log(
    `Selected: ${classification.selected.length} | Excluded: ${classification.excluded.length}`,
  );
  console.log('');
  console.log('─'.repeat(64));
  console.log(context);
  console.log('─'.repeat(64));
}

/**
 * Conflicts: detect conflicts between selected domains for given input.
 */
function cmdClusterConflicts(target, args = []) {
  const jsonMode = args.includes('--json');
  const abs = path.resolve(target);
  if (!fs.existsSync(abs)) error(`Cluster manifest not found: ${abs}`);

  const inputIdx = args.indexOf('--input');
  const input = inputIdx >= 0 ? args[inputIdx + 1] : '';
  if (!input) error('Usage: kdna cluster conflicts <cluster.json> --input "<task>"');

  const manifest = readJson(abs);
  if (!manifest || !manifest.cluster_id) error('Not a valid cluster manifest');

  const domains = loadClusterDomains(manifest);
  const classification = classifySignalsAcrossDomains(input, domains);
  const conflicts = detectDomainConflicts(classification.selected);

  if (jsonMode) {
    console.log(
      JSON.stringify(
        {
          cluster: manifest.cluster_id,
          input: input.slice(0, 200),
          selected: classification.selected.map((d) => ({ id: d.id, role: d.role })),
          conflicts: conflicts.map((c) => ({
            type: c.type,
            domains: c.domains,
            description: c.description,
            severity: c.severity || 'warn',
          })),
          conflict_count: conflicts.length,
          safe: conflicts.length === 0,
        },
        null,
        2,
      ),
    );
    process.exit(conflicts.length ? EXIT.HUMAN_LOCK_REQUIRED : EXIT.OK);
  }

  console.log(`Cluster: ${manifest.cluster_id}`);
  console.log(`Input:   ${input.slice(0, 100)}${input.length > 100 ? '...' : ''}`);
  console.log(
    `Selected: ${classification.selected.length} domains | Conflicts: ${conflicts.length}`,
  );
  console.log('');

  if (!conflicts.length) {
    console.log('✓ No conflicts detected.');
    return;
  }

  for (const c of conflicts) {
    const severity = c.severity === 'error' ? '✗' : '⚠';
    console.log(`${severity} [${c.type}] ${c.domains.join(' vs ')}`);
    console.log(`  ${c.description}`);
    console.log('');
  }
}

/**
 * Graph: output the domain relationship graph from a cluster manifest.
 */
function cmdClusterGraph(target, args = []) {
  const abs = path.resolve(target);
  if (!fs.existsSync(abs)) error(`Cluster manifest not found: ${abs}`);

  const manifest = readJson(abs);
  if (!manifest || !manifest.cluster_id) error('Not a valid cluster manifest');

  const formatIdx = args.indexOf('--format');
  let format = 'dot';
  if (formatIdx >= 0) {
    const val = args[formatIdx + 1];
    if (val && ['dot', 'json'].includes(val)) format = val;
  }

  if (format === 'json') {
    const graph = {
      cluster: manifest.cluster_id,
      version: manifest.version || '?',
      type: manifest.type || 'horizontal',
      nodes: (manifest.domains || []).map((d) => ({
        id: d.id || d.role,
        role: d.role,
        required: d.required !== false,
      })),
      edges: (manifest.relationships || []).map((r) => ({
        from: r.from,
        to: r.to,
        type: r.type,
      })),
    };
    console.log(JSON.stringify(graph, null, 2));
    return;
  }

  // DOT format output
  console.log(`digraph "${manifest.cluster_id}" {`);
  console.log('  rankdir=LR;');
  console.log(`  label="${manifest.cluster_id} v${manifest.version || '?'}";`);
  console.log('  fontsize=14;');
  console.log('');

  // Nodes
  for (const d of manifest.domains || []) {
    const shape = d.role === 'primary' ? 'box' : d.role === 'critic' ? 'diamond' : 'ellipse';
    const required = d.required !== false ? ',style=filled,fillcolor="#e8f0fe"' : ',style=dashed';
    console.log(
      `  "${d.id || d.role}" [label="${d.id || d.role}\\n[${d.role}]",shape=${shape}${required}];`,
    );
  }

  // Edges
  if (manifest.relationships) {
    console.log('');
    for (const r of manifest.relationships) {
      const style =
        r.type === 'conflicts'
          ? ',style=dashed,color=red'
          : r.type === 'extends'
            ? ',style=bold'
            : '';
      console.log(`  "${r.from}" -> "${r.to}" [label="${r.type}"${style}];`);
    }
  }

  console.log('}');
}

/**
 * Shared domain loader for cluster commands.
 */
function loadClusterDomains(manifest) {
  return (manifest.domains || [])
    .map((d) => {
      const domainId = d.id;
      if (!domainId) return null;
      const loaded = loadInstalledDomain(domainId);
      if (!loaded) return null;
      return { id: domainId, role: d.role, required: d.required !== false, ...loaded };
    })
    .filter(Boolean);
}

module.exports = { cmdCluster };
