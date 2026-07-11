/**
 * Legacy cluster.js — delegates to the unified Cluster engine.
 *
 * All previous implementations (cmdClusterLint, cmdClusterApply) are
 * now handled by the canonical engine at src/cluster-engine.js.
 * This file exists for backward-compatible require() paths.
 */

const { validateClusterManifest } = require('./cluster-engine');

function cmdClusterLint(clusterPath) {
  const fs = require('fs');
  const path = require('path');
  const abs = path.resolve(clusterPath);
  if (!fs.existsSync(abs)) {
    console.error(`Error: Cluster file not found: ${abs}`);
    process.exit(1);
  }
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(abs, 'utf8')); }
  catch { console.error('Error: Invalid JSON'); process.exit(1); }

  const result = validateClusterManifest(manifest);
  if (!result.valid) {
    for (const e of result.errors) console.error(`  ✗ ${e}`);
    for (const w of result.warnings) console.warn(`  ⚠ ${w}`);
    console.error(`\n  ${result.errors.length} error(s), ${result.warnings.length} warning(s)`);
    process.exit(1);
  }

  const domains = manifest.domains || [];
  const primaryCount = domains.filter(d => d.role === 'primary-candidate').length;
  const advisorCount = domains.filter(d => d.role === 'advisor').length;
  console.log(`✓ KDNA Cluster valid: ${manifest.name} v${manifest.version}`);
  console.log(`  Domains: ${domains.length} (${primaryCount} primary-candidate, ${advisorCount} advisor)`);
  if (result.warnings.length) console.log(`  ${result.warnings.length} warning(s)`);
}

function cmdClusterApply(_clusterPath) {
  console.error(
    'kdna cluster apply was removed in v0.9.\n' +
    'Use "kdna cluster plan-use <manifest> --task=..." for deterministic planning.\n' +
    'Use "kdna use <asset.kdna> --runner=<runner>" for execution.',
  );
  process.exit(2);
}

module.exports = { cmdClusterLint, cmdClusterApply };
