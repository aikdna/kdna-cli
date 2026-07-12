/**
 * kdna cluster — Unified Cluster commands backed by the canonical engine.
 *
 * Replaces three parallel implementations with ONE.
 *
 * Commands:
 *   kdna cluster validate <kdna.cluster.json>        Validate manifest
 *   kdna cluster plan-use <kdna.cluster.json>        Generate ConsumptionPlan
 *   kdna cluster info <kdna.cluster.json>            Inspect manifest
 *   kdna cluster conflicts <kdna.cluster.json>       Detect conflicts
 *   kdna cluster migrate <legacy.json>               Migrate to canonical format
 */

const fs = require('node:fs');
const path = require('node:path');
const { error, EXIT, readJson, writeJson } = require('./_common');
const {
  validateClusterManifest,
  generateClusterPlan,
  generateClusterTrace,
  migrateToCanonical,
  detectConflicts,
  arbitratePrimary,
  resolveCandidates,
  selectAdvisors,
} = require('../cluster-engine');

function cmdCluster(args) {
  const sub = args[0];
  const target = args[1];

  if (!sub || args.includes('--help') || args.includes('-h')) {
    process.stderr.write(
      'Usage: kdna cluster <command> [options]\n\n' +
        'Commands:\n' +
        '  kdna cluster validate <kdna.cluster.json>      Validate cluster manifest\n' +
        '  kdna cluster info <kdna.cluster.json>           Inspect cluster\n' +
        '  kdna cluster plan-use <kdna.cluster.json>       Generate ConsumptionPlan\n' +
        '       --task=<text>    Task description\n' +
        '       --as=json|md     Output format\n' +
        '  kdna cluster conflicts <kdna.cluster.json>      Detect conflicts\n' +
        '       --task=<text>    Task to test\n' +
        '  kdna cluster migrate <legacy.json>              Migrate legacy → canonical\n' +
        '       --from=<format>  legacy-packages|schema-b-domains\n' +
        '       --out=<path>     Output path\n\n' +
        'Legacy compatibility aliases (delegate to new engine):\n' +
        '  kdna cluster lint <path>     → alias for validate\n' +
        '  kdna cluster init <name>     → scaffold from canonical template\n',
    );
    if (args.includes('--help') || args.includes('-h')) process.exit(0);
    process.exit(EXIT.INPUT_ERROR);
  }

  switch (sub) {
    case 'validate':
    case 'lint':
      cmdClusterValidate(target);
      break;
    case 'info':
      cmdClusterInfo(target);
      break;
    case 'plan-use':
      cmdClusterPlanUse(target, args.slice(2));
      break;
    case 'conflicts':
      cmdClusterConflicts(target, args.slice(2));
      break;
    case 'migrate':
      cmdClusterMigrate(target, args.slice(2));
      break;
    case 'init': {
      const { cmdClusterInit } = require('../init');
      cmdClusterInit(target);
      break;
    }
    case 'load':
    case 'match':
    case 'compose':
    case 'graph':
      process.stderr.write(
        `kdna cluster ${sub} has been replaced by the unified Cluster engine.\n` +
          `Use "kdna cluster plan-use <manifest> --task=..." for deterministic planning.\n` +
          `Use "kdna cluster conflicts <manifest> --task=..." for conflict detection.\n`,
      );
      return process.exit(EXIT.INPUT_ERROR);
    case 'apply':
      process.stderr.write(
        'kdna cluster apply was removed in v0.9.\n' +
          'To install a cluster (which installs all its sub-domains):\n' +
          '  kdna install @aikdna/animation\n',
      );
      return process.exit(EXIT.INPUT_ERROR);
    default:
      error(`Unknown cluster subcommand: ${sub || '(none)'}`, EXIT.INPUT_ERROR);
  }
}

function loadManifest(absPath) {
  if (!fs.existsSync(absPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(absPath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function cmdClusterValidate(target) {
  if (!target) error('Usage: kdna cluster validate <kdna.cluster.json>', EXIT.INPUT_ERROR);
  const abs = path.resolve(target);
  const manifest = loadManifest(abs);
  if (!manifest) error(`Not found or invalid JSON: ${target}`, EXIT.INPUT_ERROR);

  const result = validateClusterManifest(manifest);

  console.log(
    JSON.stringify(
      {
        valid: result.valid,
        cluster_id: manifest.cluster_id || 'unknown',
        name: manifest.name || 'unknown',
        version: manifest.version || '?',
        errors: result.errors,
        warnings: result.warnings,
        domain_count: (manifest.domains || []).length,
        primary_candidates: (manifest.domains || []).filter((d) => d.role === 'primary-candidate')
          .length,
        advisors: (manifest.domains || []).filter((d) => d.role === 'advisor').length,
      },
      null,
      2,
    ),
  );

  if (!result.valid) process.exit(EXIT.VALIDATION_FAILED);
}

function cmdClusterInfo(target) {
  if (!target) error('Usage: kdna cluster info <kdna.cluster.json>', EXIT.INPUT_ERROR);
  const abs = path.resolve(target);
  const manifest = loadManifest(abs);
  if (!manifest) error(`Not found: ${target}`, EXIT.INPUT_ERROR);
  if (!manifest.cluster_id)
    error('Not a valid cluster manifest (missing cluster_id)', EXIT.INPUT_ERROR);

  const domainCount = (manifest.domains || []).length;
  const requiredCount = (manifest.domains || []).filter((d) => d.required !== false).length;
  const composition = manifest.composition || {};

  console.log(`${manifest.name || manifest.cluster_id}`);
  console.log(
    `  Format:           ${manifest.format || 'kdna-cluster'} v${manifest.format_version || '?'}`,
  );
  console.log(`  Cluster ID:       ${manifest.cluster_id}`);
  console.log(`  Version:          ${manifest.version || '?'}`);
  console.log(`  Type:             ${manifest.type || 'horizontal'}`);
  console.log(`  Status:           ${manifest.status || 'draft'}`);
  console.log(`  Domains:          ${domainCount} total, ${requiredCount} required`);
  console.log(`  Strategy:         ${composition.strategy || 'signal_based'}`);
  console.log(`  Max active:       ${composition.max_active_domains || 'unlimited'}`);
  console.log(`  Conflict policy:  ${composition.conflict_policy || 'surface'}`);
  console.log('');

  if (manifest.domains?.length) {
    console.log('  Domain inventory:');
    for (const d of manifest.domains) {
      const req = d.required !== false ? '(required)' : '(optional)';
      const exp = d.role === 'constraint' || d.role === 'critic' ? ' [experimental]' : '';
      console.log(`    ${(d.role || '?').padEnd(18)} ${d.id} ${req}${exp}`);
    }
    console.log('');
  }

  if (manifest.relationships?.length) {
    console.log('  Relationships:');
    for (const r of manifest.relationships) {
      console.log(`    ${r.from} --${r.type}--> ${r.to}  ${r.description || ''}`);
    }
    console.log('');
  }

  if (manifest.budget) {
    console.log('  Budget:');
    console.log(`    Profile: ${manifest.budget.profile || 'interactive'}`);
    if (manifest.budget.max_tokens) console.log(`    Max tokens: ${manifest.budget.max_tokens}`);
    if (manifest.budget.max_assets) console.log(`    Max assets: ${manifest.budget.max_assets}`);
    console.log('');
  }

  const validation = validateClusterManifest(manifest);
  if (!validation.valid) {
    console.log('  ⚠ Validation issues:');
    for (const e of validation.errors) console.log(`    ✗ ${e}`);
    for (const w of validation.warnings) console.log(`    ⚠ ${w}`);
  } else {
    console.log('  ✓ Manifest valid');
  }
}

function cmdClusterPlanUse(target, args) {
  if (!target)
    error('Usage: kdna cluster plan-use <kdna.cluster.json> --task="..."', EXIT.INPUT_ERROR);
  const abs = path.resolve(target);
  const manifest = loadManifest(abs);
  if (!manifest) error(`Not found: ${target}`, EXIT.INPUT_ERROR);

  // Validate first
  const validation = validateClusterManifest(manifest);
  if (!validation.valid) {
    error(
      `Cluster manifest invalid:\n${validation.errors.map((e) => `  - ${e}`).join('\n')}`,
      EXIT.VALIDATION_FAILED,
    );
  }

  // Parse flags
  const getFlag = (name) => {
    const eqIdx = args.findIndex((a) => a === name + '=' || a.startsWith(name + '='));
    if (eqIdx >= 0) return args[eqIdx].split('=').slice(1).join('=');
    const idx = args.indexOf(name);
    return idx >= 0 && args[idx + 1] && !args[idx + 1].startsWith('--') ? args[idx + 1] : null;
  };

  const task = getFlag('--task') || '';
  const as = getFlag('--as') || 'json';
  const taskFamily = getFlag('--task-family') || 'general';
  const budgetProfile = getFlag('--budget') || manifest.budget?.profile || 'interactive';
  const shape = getFlag('--shape') || 'compact';

  if (!task) error('--task is required for cluster plan-use', EXIT.INPUT_ERROR);

  const plan = generateClusterPlan(manifest, task, { taskFamily, budgetProfile, shape });

  if (as === 'json') {
    console.log(JSON.stringify(plan, null, 2));
  } else if (as === 'md') {
    let md = `# Cluster Consumption Plan\n\n`;
    md += `**Plan ID:** ${plan.plan_id}\n`;
    md += `**Cluster:** ${manifest.cluster_id} v${manifest.version}\n`;
    md += `**Mode:** cluster\n\n`;
    md += `## Task\n\n${plan.task.summary}\n\n`;
    if (plan.selection) {
      md += `## Selection\n\n`;
      md += `### Primary\n- **${plan.selection.primary.asset_id}** (${plan.selection.primary.selection_reason})\n\n`;
      if (plan.selection.advisors.length) {
        md += `### Advisors (${plan.selection.advisors.length})\n`;
        for (const a of plan.selection.advisors) {
          md += `- **${a.asset_id}**: ${a.contribution_hypothesis}\n`;
        }
        md += '\n';
      }
      if (plan.selection.rejected.length) {
        md += `### Rejected (${plan.selection.rejected.length})\n`;
        for (const r of plan.selection.rejected) {
          md += `- ${r.asset_id}: ${r.rejection_reason || r.reason}\n`;
        }
        md += '\n';
      }
    }
    md += `## Budget\n- Profile: ${plan.budget.profile}\n- Assets: ${plan.budget.assets_consumed}/${plan.budget.max_assets}\n`;
    if (plan.conflicts?.length) {
      md += `\n## Conflicts\n`;
      for (const c of plan.conflicts) {
        md += `- [${c.severity || 'warn'}] ${c.type}: ${c.description}\n`;
      }
    }
    console.log(md);
  }
}

function cmdClusterConflicts(target, args) {
  if (!target)
    error('Usage: kdna cluster conflicts <kdna.cluster.json> --task="..."', EXIT.INPUT_ERROR);
  const abs = path.resolve(target);
  const manifest = loadManifest(abs);
  if (!manifest) error(`Not found: ${target}`, EXIT.INPUT_ERROR);

  const getFlag = (name) => {
    const eqIdx = args.findIndex((a) => a === name + '=' || a.startsWith(name + '='));
    if (eqIdx >= 0) return args[eqIdx].split('=').slice(1).join('=');
    const idx = args.indexOf(name);
    return idx >= 0 && args[idx + 1] && !args[idx + 1].startsWith('--') ? args[idx + 1] : null;
  };

  const task = getFlag('--task') || '';

  // Resolve and detect
  const resolution = resolveCandidates(manifest, task);
  const primaryResult = arbitratePrimary(resolution, manifest);
  const advisorResult = selectAdvisors(resolution, primaryResult, manifest, task);
  const conflicts = detectConflicts(primaryResult.primary, advisorResult.advisors, manifest);

  console.log(
    JSON.stringify(
      {
        cluster: manifest.cluster_id,
        task: (task || '').slice(0, 200),
        primary: primaryResult.primary?.asset_id || null,
        advisors: advisorResult.advisors.map((a) => a.asset_id),
        conflicts,
        conflict_count: conflicts.length,
        blocking_count: conflicts.filter((c) => c.severity === 'error').length,
        safe: conflicts.filter((c) => c.severity === 'error').length === 0,
      },
      null,
      2,
    ),
  );
}

function cmdClusterMigrate(target, args) {
  if (!target)
    error(
      'Usage: kdna cluster migrate <legacy.json> --from=<format> [--out=<path>]',
      EXIT.INPUT_ERROR,
    );

  const getFlag = (name) => {
    const eqIdx = args.findIndex((a) => a === name + '=' || a.startsWith(name + '='));
    if (eqIdx >= 0) return args[eqIdx].split('=').slice(1).join('=');
    const idx = args.indexOf(name);
    return idx >= 0 && args[idx + 1] && !args[idx + 1].startsWith('--') ? args[idx + 1] : null;
  };

  const sourceFormat = getFlag('--from') || 'legacy-packages';
  const outPath = getFlag('--out');
  const targetAbs = path.resolve(target);

  if (!fs.existsSync(targetAbs)) error(`File not found: ${target}`, EXIT.INPUT_ERROR);

  let legacy;
  try {
    legacy = JSON.parse(fs.readFileSync(targetAbs, 'utf8'));
  } catch (e) {
    error(`Invalid JSON: ${e.message}`, EXIT.INPUT_ERROR);
  }

  // Auto-detect format
  if (!getFlag('--from')) {
    if (legacy.packages && Array.isArray(legacy.packages)) {
      // legacy-packages format — will use default 'legacy-packages'
    } else if (legacy.domains && Array.isArray(legacy.domains)) {
      // Schema B format
      // sourceFormat already defaults to 'legacy-packages'; switch to detected
      const detectedFormat = 'schema-b-domains';
      const { manifest: m2, report: r2 } = migrateToCanonical(legacy, detectedFormat);
      finishMigration(m2, r2, outPath);
      return;
    }
  }

  const { manifest, report } = migrateToCanonical(legacy, sourceFormat);
  finishMigration(manifest, report, outPath);
}

function finishMigration(manifest, report, outPath) {
  if (!manifest) {
    console.log(JSON.stringify({ error: 'Migration failed', report }, null, 2));
    process.exit(EXIT.VALIDATION_FAILED);
  }

  // Validate the migrated manifest
  const validation = validateClusterManifest(manifest);

  // Determine migration completion state
  const hasManualDecisions = (report.manual_decisions_required || []).length > 0;
  const hasSemanticLoss = (report.semantic_loss || []).length > 0;

  let migrationStatus = 'complete';
  if (!validation.valid) {
    migrationStatus = 'validation_failed';
  } else if (hasManualDecisions) {
    migrationStatus = 'manual_action_required';
  } else if (hasSemanticLoss) {
    migrationStatus = 'semantic_loss_warning';
  }

  // Stamp migration status on the manifest
  manifest.migration = manifest.migration || {};
  manifest.migration.migration_status = migrationStatus;
  manifest.migration.manual_decisions_required = report.manual_decisions_required || [];
  manifest.migration.semantic_loss_warnings = report.semantic_loss || [];
  if (outPath) {
    manifest.migration.migration_report_ref = path
      .basename(outPath)
      .replace(/\.json$/, '.migration-report.json');
  } else {
    delete manifest.migration.migration_report_ref;
  }

  // The stamped manifest is the actual artifact. Validate it before any
  // write so migration never leaves an invalid canonical file behind.
  let finalValidation = validateClusterManifest(manifest);
  if (!finalValidation.valid) {
    migrationStatus = 'validation_failed';
    manifest.migration.migration_status = migrationStatus;
    finalValidation = validateClusterManifest(manifest);
  }

  if (outPath) {
    if (!finalValidation.valid) {
      console.log('Migrated manifest has validation errors; no output files were written:');
      finalValidation.errors.forEach((e) => console.log(`  ✗ ${e}`));
      process.exit(EXIT.VALIDATION_FAILED);
    }

    // Write ONLY the canonical manifest to the output path
    writeJson(path.resolve(outPath), manifest);
    // Write migration report as sidecar
    const reportPath = path.resolve(outPath).replace(/\.json$/, '.migration-report.json');
    writeJson(reportPath, report);

    console.log(`Canonical manifest written to: ${outPath}`);
    console.log(`Migration report written to: ${reportPath}`);
    console.log(`Migration status: ${migrationStatus}`);
    console.log(`Warnings: ${report.warnings.length}`);
    console.log(`Manual decisions required: ${report.manual_decisions_required.length}`);
    if (hasManualDecisions) {
      console.log('Manual decisions:');
      report.manual_decisions_required.forEach((d) => console.log(`  - ${d}`));
    }
  } else {
    console.log(
      JSON.stringify(
        {
          manifest,
          migration_report: report,
          migration_status: migrationStatus,
          validation: finalValidation,
        },
        null,
        2,
      ),
    );
  }

  // Exit codes map to migration quality
  if (migrationStatus === 'validation_failed') {
    process.exit(EXIT.VALIDATION_FAILED);
  }
  if (migrationStatus === 'manual_action_required' || migrationStatus === 'semantic_loss_warning') {
    process.exit(EXIT.JUDGMENT_QUALITY_FAILED);
  }
  // complete → exit 0 (already default)
}

module.exports = { cmdCluster };
