const fs = require('fs');
const path = require('path');
const { error, EXIT } = require('./_common');
const {
  loadWorkPack,
  validateWorkPackManifest,
  checkWorkPackStructure,
  inspectWorkPack,
} = require('@aikdna/kdna-core');

/**
 * kdna workpack validate <path> [--json]
 *
 * Validate a Work Pack directory: schema validation + structural completeness.
 */
function cmdWorkpackValidate(target, args = []) {
  const abs = path.resolve(target);
  if (!fs.existsSync(abs)) error(`Work Pack directory not found: ${abs}`);
  if (!fs.statSync(abs).isDirectory()) error(`Not a directory: ${abs}. Work Packs must be directories.`);

  const jsonMode = args.includes('--json');
  const schemaOnly = args.includes('--schema-only');

  const { manifest } = loadWorkPack(abs);
  if (!manifest) {
    if (jsonMode) {
      console.log(JSON.stringify({ valid: false, errors: [`workpack.json not found in ${abs}`] }));
    } else {
      error(`workpack.json not found in ${abs}`);
    }
    process.exit(EXIT.VALIDATION_FAILED);
  }

  // Schema validation (L0)
  const schemaResult = validateWorkPackManifest(manifest);

  // Structural completeness (L1)
  const structResult = schemaOnly ? { complete: true, missing: [] } : checkWorkPackStructure(manifest, abs);

  const valid = schemaResult.valid && structResult.complete;

  if (jsonMode) {
    console.log(JSON.stringify({
      valid,
      level: valid ? (structResult.complete ? 'L1' : 'L0') : 'INVALID',
      schema: { valid: schemaResult.valid, errors: schemaResult.errors },
      structure: structResult.complete ? { complete: true } : { complete: false, missing: structResult.missing },
    }, null, 2));
  } else {
    if (valid) {
      console.log(`✓ Valid: ${manifest.name} v${manifest.version}`);
      if (structResult.complete) {
        console.log('  Level: L1 — structurally complete');
      } else {
        console.log('  Level: L0 — schema-valid (structural check skipped)');
      }
    } else {
      if (!schemaResult.valid) {
        console.error(`✗ Schema validation failed for ${manifest.name}:`);
        schemaResult.errors.forEach(e => console.error(`  ${e}`));
      }
      if (!structResult.complete) {
        console.error(`✗ Structural completeness — missing files:`);
        structResult.missing.forEach(f => console.error(`  ${f}`));
      }
    }
  }

  process.exit(valid ? EXIT.OK : EXIT.VALIDATION_FAILED);
}

/**
 * kdna workpack inspect <path> [--json]
 *
 * Inspect a Work Pack: show its structure, KDNA references, skills, gates.
 */
function cmdWorkpackInspect(target, args = []) {
  const abs = path.resolve(target);
  if (!fs.existsSync(abs)) error(`Work Pack directory not found: ${abs}`);

  const { manifest } = loadWorkPack(abs);
  if (!manifest) error(`workpack.json not found in ${abs}`);

  const jsonMode = args.includes('--json');
  const info = inspectWorkPack(manifest, abs);

  if (jsonMode) {
    console.log(JSON.stringify(info, null, 2));
    return;
  }

  console.log(`${info.name} v${info.version}`);
  console.log(`  Description:   ${info.description}`);
  console.log(`  Status:        ${info.status}`);
  console.log(`  Access:        ${info.access}`);
  console.log(`  License:       ${info.license}`);
  console.log(`  Format:        ${info.format_version}`);
  console.log('');

  console.log('KDNA:');
  console.log(`  Mode:          ${info.kdna.mode}`);
  for (const a of info.kdna.assets) {
    console.log(`  • ${a.name} @ ${a.version} [${a.role}]`);
  }
  console.log('');

  if (info.skills.length) {
    console.log('Skills:');
    for (const s of info.skills) {
      const flags = [];
      if (s.required) flags.push('required');
      if (s.fallback) flags.push(`fallback:${s.fallback}`);
      console.log(`  • ${s.name}${s.type !== 'unspecified' ? ` (${s.type})` : ''} ${flags.length ? `[${flags.join(', ')}]` : ''}`);
    }
    console.log('');
  }

  if (info.templates?.task || info.templates?.output) {
    console.log('Templates:');
    if (info.templates.task) console.log(`  Task:   ${info.templates.task}`);
    if (info.templates.output) console.log(`  Output: ${info.templates.output}`);
    console.log('');
  }

  console.log('Quality & Safety:');
  console.log(`  Review Gates:   ${info.review_gates}`);
  console.log(`  Risk Policy:    ${info.has_risk_policy ? '✓' : '✗'}`);
  console.log(`  Trace Policy:   ${info.has_trace_policy ? '✓' : '✗'}`);
  console.log(`  Eval Cases:     ${info.has_evals ? '✓' : '✗'}`);
  console.log('');

  console.log(`Structural: ${info.structural_complete ? 'complete ✓' : 'incomplete ✗'}`);
  if (info.missing_files.length) {
    console.log('  Missing files:');
    info.missing_files.forEach(f => console.log(`    ${f}`));
  }
}

/**
 * kdna workpack explain <path>
 *
 * Explain what a Work Pack does in human-readable form.
 */
function cmdWorkpackExplain(target) {
  const abs = path.resolve(target);
  if (!fs.existsSync(abs)) error(`Work Pack directory not found: ${abs}`);

  const { manifest } = loadWorkPack(abs);
  if (!manifest) error(`workpack.json not found in ${abs}`);

  const info = inspectWorkPack(manifest, abs);

  // Build a natural-language explanation
  const lines = [];

  lines.push(`${info.name} is a KDNA Work Pack — a packaged AI work capability.`);
  lines.push('');
  lines.push(`It combines ${info.kdna.assets.length} KDNA judgment asset(s) with ${info.skills.length} skill(s), ${info.review_gates} review gate(s), and quality controls to perform: "${info.description}"`);
  lines.push('');

  // KDNA
  const primaryAsset = info.kdna.assets.find(a => a.role === 'primary');
  const constraintAssets = info.kdna.assets.filter(a => a.role === 'constraint');
  if (primaryAsset) {
    lines.push(`The primary judgment framework is "${primaryAsset.name}" — it defines the core standards for this task.`);
  }
  if (constraintAssets.length) {
    const names = constraintAssets.map(a => `"${a.name}"`).join(' and ');
    lines.push(`${names} provides additional safety or quality boundaries that the AI must respect.`);
  }
  lines.push('');

  // Skills
  if (info.skills.length) {
    const required = info.skills.filter(s => s.required);
    const optional = info.skills.filter(s => !s.required);
    if (required.length) {
      lines.push(`Required skills: ${required.map(s => s.name).join(', ')}.`);
    }
    if (optional.length) {
      lines.push(`Optional skills: ${optional.map(s => s.name).join(', ')}. The Work Pack can function without them.`);
    }
    lines.push('');
  }

  // Gates
  lines.push(`${info.review_gates} review gate(s) check the output quality. The AI's work must pass these gates before it's accepted.`);

  // Risk
  if (info.has_risk_policy) {
    lines.push('A risk policy is configured — high-risk actions may require human confirmation or be blocked entirely.');
  }

  // Trace
  if (info.has_trace_policy) {
    lines.push('A trace policy ensures all judgment decisions are recorded and auditable.');
  }

  // Status
  lines.push('');
  lines.push(`Status: ${info.status} — ${{
    draft: 'still being defined, not for production use.',
    experimental: 'testable but interfaces may change.',
    stable: 'ready for production use.',
    deprecated: 'no longer recommended — check for a replacement.',
  }[info.status] || 'unknown maturity level.'}`);

  console.log(lines.join('\n'));
}

/**
 * kdna workpack <subcommand> [args]
 *
 * Main dispatcher for workpack subcommands.
 */
function cmdWorkpack(args) {
  const sub = args[1];
  const target = args[2];

  if (sub === 'validate') {
    if (!target) error('Usage: kdna workpack validate <path> [--json] [--schema-only]');
    cmdWorkpackValidate(target, args);
  } else if (sub === 'inspect') {
    if (!target) error('Usage: kdna workpack inspect <path> [--json]');
    cmdWorkpackInspect(target, args);
  } else if (sub === 'explain') {
    if (!target) error('Usage: kdna workpack explain <path>');
    cmdWorkpackExplain(target);
  } else {
    error(
      `Unknown workpack subcommand: ${sub || '(none)'}\n` +
        'Usage:\n' +
        '  kdna workpack validate <path> [--json] [--schema-only]\n' +
        '  kdna workpack inspect <path> [--json]\n' +
        '  kdna workpack explain <path>',
      EXIT.INPUT_ERROR,
    );
  }
}

module.exports = { cmdWorkpack };
