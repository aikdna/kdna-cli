const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { error, EXIT } = require('./_common');
const {
  loadWorkPack,
  validateWorkPackManifest,
  checkWorkPackStructure,
  inspectWorkPack,
} = require('@aikdna/kdna-core');

// ── Helpers ─────────────────────────────────────────────────────────

function uid(prefix) {
  return `${prefix}_${crypto.randomBytes(4).toString('hex')}`;
}

function timestamp() {
  return new Date().toISOString();
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// ── Validate ────────────────────────────────────────────────────────

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

  const schemaResult = validateWorkPackManifest(manifest);
  const structResult = schemaOnly ? { complete: true, missing: [] } : checkWorkPackStructure(manifest, abs);
  const valid = schemaResult.valid && structResult.complete;

  if (jsonMode) {
    console.log(JSON.stringify({
      valid, level: valid ? (structResult.complete ? 'L1' : 'L0') : 'INVALID',
      schema: { valid: schemaResult.valid, errors: schemaResult.errors },
      structure: structResult.complete ? { complete: true } : { complete: false, missing: structResult.missing },
    }, null, 2));
  } else {
    if (valid) {
      console.log(`✓ Valid: ${manifest.name} v${manifest.version}`);
      console.log(`  Level: L1 — structurally complete`);
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

// ── Inspect ─────────────────────────────────────────────────────────

function cmdWorkpackInspect(target, args = []) {
  const abs = path.resolve(target);
  if (!fs.existsSync(abs)) error(`Work Pack directory not found: ${abs}`);
  const { manifest } = loadWorkPack(abs);
  if (!manifest) error(`workpack.json not found in ${abs}`);
  const jsonMode = args.includes('--json');
  const info = inspectWorkPack(manifest, abs);

  if (jsonMode) { console.log(JSON.stringify(info, null, 2)); return; }

  console.log(`${info.name} v${info.version}`);
  console.log(`  Description:   ${info.description}`);
  console.log(`  Status:        ${info.status}`);
  console.log(`  Access:        ${info.access}`);
  console.log(`  License:       ${info.license}`);
  console.log(`  Format:        ${info.format_version}\n`);

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
  console.log(`  Structural:     ${info.structural_complete ? 'complete ✓' : 'incomplete ✗'}`);
  if (info.missing_files.length) {
    info.missing_files.forEach(f => console.log(`    Missing: ${f}`));
  }
}

// ── Explain ─────────────────────────────────────────────────────────

function cmdWorkpackExplain(target) {
  const abs = path.resolve(target);
  if (!fs.existsSync(abs)) error(`Work Pack directory not found: ${abs}`);
  const { manifest } = loadWorkPack(abs);
  if (!manifest) error(`workpack.json not found in ${abs}`);
  const info = inspectWorkPack(manifest, abs);
  const lines = [];

  lines.push(`${info.name} is a KDNA Work Pack — a packaged AI work capability.`);
  lines.push('');
  lines.push(`It combines ${info.kdna.assets.length} KDNA judgment asset(s) with ${info.skills.length} skill(s), ${info.review_gates} review gate(s), and quality controls to perform: "${info.description}"`);
  lines.push('');

  const primary = info.kdna.assets.find(a => a.role === 'primary');
  const constraints = info.kdna.assets.filter(a => a.role === 'constraint');
  if (primary) lines.push(`The primary judgment framework is "${primary.name}" — it defines the core standards for this task.`);
  if (constraints.length) {
    lines.push(`${constraints.map(a => `"${a.name}"`).join(' and ')} provides additional safety or quality boundaries.`);
  }
  lines.push('');

  if (info.skills.length) {
    const req = info.skills.filter(s => s.required);
    const opt = info.skills.filter(s => !s.required);
    if (req.length) lines.push(`Required skills: ${req.map(s => s.name).join(', ')}.`);
    if (opt.length) lines.push(`Optional skills: ${opt.map(s => s.name).join(', ')}.`);
    lines.push('');
  }

  lines.push(`${info.review_gates} review gate(s) check output quality.`);
  if (info.has_risk_policy) lines.push('Risk policy configured — high-risk actions may be blocked.');
  if (info.has_trace_policy) lines.push('Trace policy ensures all judgment decisions are auditable.');
  lines.push('');
  lines.push(`Status: ${info.status}.`);

  console.log(lines.join('\n'));
}

// ── Plan ────────────────────────────────────────────────────────────

/**
 * kdna workpack plan <path> [--input <file|text>] [--json]
 *
 * Generate a dry-run execution plan showing what WOULD happen without
 * actually invoking an LLM or external tools.
 */
function cmdWorkpackPlan(target, args = []) {
  const abs = path.resolve(target);
  if (!fs.existsSync(abs)) error(`Work Pack directory not found: ${abs}`);

  const { manifest } = loadWorkPack(abs);
  if (!manifest) error(`workpack.json not found in ${abs}`);

  const jsonMode = args.includes('--json');

  // Resolve input
  const inputIdx = args.indexOf('--input');
  let input = null;
  let inputSource = null;
  if (inputIdx >= 0) {
    const val = args[inputIdx + 1];
    if (val && !val.startsWith('--')) {
      const maybeFile = path.resolve(val);
      if (fs.existsSync(maybeFile) && fs.statSync(maybeFile).isFile()) {
        input = fs.readFileSync(maybeFile, 'utf8').slice(0, 500);
        inputSource = val;
      } else {
        input = val;
        inputSource = '<inline>';
      }
    }
  }

  // Build plan
  const sessionId = uid('wp_ses');
  const plan = buildPlan(manifest, abs, sessionId, input, inputSource);

  if (jsonMode) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  console.log(`Work Pack Plan: ${manifest.name} v${manifest.version}`);
  console.log(`Session:        ${sessionId}`);
  console.log(`Mode:           dry-run`);
  console.log('');

  if (input) {
    console.log(`Input: ${input.slice(0, 120)}${input.length > 120 ? '...' : ''}`);
    console.log('');
  }

  console.log(`KDNA Assets (${plan.kdna_assets.length}):`);
  for (const a of plan.kdna_assets) {
    console.log(`  • ${a.name} @ ${a.version} [${a.role}] — ${a.status}`);
  }
  console.log('');

  console.log(`Skills (${plan.skills.length}):`);
  for (const s of plan.skills) {
    const icon = s.available ? (s.fallback_used ? '⚠' : '✓') : '✗';
    const fb = s.fallback_used ? ` → fallback: ${s.fallback_used}` : '';
    console.log(`  ${icon} ${s.name} [${s.required ? 'required' : 'optional'}]${fb}`);
  }
  console.log('');

  console.log(`Review Gates (${plan.review_gates.length}):`);
  for (const g of plan.review_gates) {
    const criteriaCount = g.criteria_count || '?';
    console.log(`  • ${g.name} (${criteriaCount} criteria)`);
  }
  console.log('');

  console.log(`Risk Checks (${plan.risk_checks.length}):`);
  for (const r of plan.risk_checks) {
    console.log(`  • ${r.timing}: ${r.description}`);
  }
  console.log('');

  console.log(`Trace: ${plan.trace_enabled ? 'enabled' : 'disabled'} (${plan.trace_fields.length} fields)`);
  console.log(`Conflicts: ${plan.kdna_assets.length > 1 ? 'will be exposed if detected' : 'N/A (single asset)'}`);
  console.log('');

  console.log('Execution Phases:');
  for (const p of plan.phases) {
    console.log(`  ${p.order}. ${p.name} → ${p.expected_duration || 'instant'}`);
  }
}

function buildPlan(manifest, rootDir, sessionId, input, inputSource) {
  const kdnaAssets = [];
  if (manifest.kdna?.mode === 'single') {
    kdnaAssets.push({ name: manifest.kdna.asset.name, version: manifest.kdna.asset.version, role: manifest.kdna.asset.role, digest: manifest.kdna.asset.digest || null, status: 'resolved' });
  } else if (manifest.kdna?.mode === 'cluster') {
    for (const a of manifest.kdna.assets || []) {
      kdnaAssets.push({ name: a.name, version: a.version, role: a.role, digest: a.digest || null, status: 'resolved' });
    }
  }

  const skills = (manifest.skills || []).map(s => {
    const fallbackAvail = s.fallback ? true : false;
    return {
      name: s.name,
      type: s.type || 'unspecified',
      required: s.required !== false,
      available: false, // dry-run cannot verify
      fallback_used: !s.required && s.fallback ? s.fallback : null,
      mcp_server: s.mcp_server || null,
    };
  });

  const reviewGates = (manifest.review_gates || []).map(gp => {
    const gatePath = path.resolve(rootDir, gp);
    const gate = readJsonSafe(gatePath);
    return {
      name: gate?.name || path.basename(gp, '.json'),
      path: gp,
      criteria_count: gate?.criteria?.length || 0,
      exists: !!gate,
    };
  });

  let riskPolicy = null;
  if (manifest.risk_policy) {
    const rp = readJsonSafe(path.resolve(rootDir, manifest.risk_policy));
    riskPolicy = rp;
  }

  const riskChecks = [
    { timing: 'pre-skill', description: 'Check prohibited actions before any skill invocation' },
    { timing: 'post-exec', description: 'Assess risk levels after agent execution' },
    { timing: 'pre-output', description: 'Final risk check before output rendering' },
  ];

  let traceEnabled = false;
  let traceFields = [];
  if (manifest.trace_policy) {
    const tp = readJsonSafe(path.resolve(rootDir, manifest.trace_policy));
    traceEnabled = !!tp;
    traceFields = tp?.record || [];
  }

  const phases = [
    { order: 1, name: 'Input Normalization', expected_duration: 'instant' },
    { order: 2, name: 'Work Pack Resolution', expected_duration: 'instant' },
    { order: 3, name: 'KDNA Loading', expected_duration: kdnaAssets.length > 1 ? 'brief' : 'instant' },
    { order: 4, name: 'Skill Binding', expected_duration: 'instant' },
    { order: 5, name: 'Agent Execution', expected_duration: 'model-dependent' },
    { order: 6, name: 'Review Gate Execution', expected_duration: `${reviewGates.length} gates` },
    { order: 7, name: 'Risk Policy Enforcement', expected_duration: 'instant' },
    { order: 8, name: 'Output Processing', expected_duration: 'instant' },
    { order: 9, name: 'Trace Generation', expected_duration: 'instant' },
    { order: 10, name: 'Report Generation', expected_duration: 'instant' },
  ];

  return {
    session_id: sessionId,
    workpack: { name: manifest.name, version: manifest.version },
    mode: 'dry-run',
    input: input ? { source: inputSource, preview: input.slice(0, 200) } : null,
    kdna_assets: kdnaAssets,
    skills,
    review_gates: reviewGates,
    risk_checks: riskChecks,
    risk_policy_loaded: !!riskPolicy,
    risk_levels: riskPolicy?.levels?.map(l => l.level) || ['low', 'medium', 'high', 'critical'],
    trace_enabled: traceEnabled,
    trace_fields: traceFields,
    phases,
    limitations: [
      'This is a dry-run plan. Skills are not actually invoked.',
      'KDNA assets are not actually loaded — references are resolved syntactically.',
      'LLM is not called — agent execution is simulated.',
    ],
    created_at: timestamp(),
  };
}

// ── Run ─────────────────────────────────────────────────────────────

/**
 * kdna workpack run <path> --input <file> [--dry-run] [--json]
 *
 * Execute a Work Pack. With --dry-run, simulates execution without LLM or external tools.
 */
function cmdWorkpackRun(target, args = []) {
  const abs = path.resolve(target);
  if (!fs.existsSync(abs)) error(`Work Pack directory not found: ${abs}`);

  const { manifest } = loadWorkPack(abs);
  if (!manifest) error(`workpack.json not found in ${abs}`);

  const dryRun = args.includes('--dry-run');
  const jsonMode = args.includes('--json');

  const inputIdx = args.indexOf('--input');
  let input = null;
  if (inputIdx >= 0) {
    const val = args[inputIdx + 1];
    if (val && !val.startsWith('--')) {
      const maybeFile = path.resolve(val);
      if (fs.existsSync(maybeFile) && fs.statSync(maybeFile).isFile()) {
        input = fs.readFileSync(maybeFile, 'utf8');
      } else {
        input = val;
      }
    }
  }
  if (!input) error('Usage: kdna workpack run <path> --input <file|text> [--dry-run] [--json]');

  const sessionId = uid('wp_ses');
  const runId = uid('wp_run');

  if (dryRun) {
    const plan = buildPlan(manifest, abs, sessionId, input, '--input');
    const dryRunResult = buildDryRunResult(manifest, plan, sessionId, runId, input);

    if (jsonMode) {
      console.log(JSON.stringify(dryRunResult, null, 2));
      return;
    }

    console.log(`Work Pack Dry Run: ${manifest.name} v${manifest.version}`);
    console.log(`Session: ${sessionId}  Run: ${runId}`);
    console.log('');
    console.log(`Status: ${dryRunResult.run.status}`);
    console.log(`Overall Gate: ${dryRunResult.run.overall_gate_result}`);
    console.log(`Gates: ${dryRunResult.run.review_gate_results.map(g => `${g.gate_name}=${g.result}`).join(', ')}`);
    console.log(`Risk Events: ${dryRunResult.run.risk_events.length}`);
    console.log(`Conflicts: ${dryRunResult.run.conflicts.length}`);
    console.log(`Skill Fallbacks: ${dryRunResult.run.skill_fallbacks.length}`);
    if (dryRunResult.limitations.length) {
      console.log(`\nLimitations:`);
      dryRunResult.limitations.forEach(l => console.log(`  ⚠ ${l}`));
    }
  } else {
    error('Real execution (without --dry-run) requires an LLM backend. Coming in Phase 5.2.');
  }
}

function buildDryRunResult(manifest, plan, sessionId, runId, input) {
  // Simulate gate results — in dry-run, gates pass by default
  const gateResults = plan.review_gates.map(g => ({
    gate_name: g.name,
    result: 'pass',
    timestamp: timestamp(),
    criteria_results: [],
    reasoning: '[dry-run] Gates are simulated. No real judgment was executed.',
  }));

  const riskEvents = [
    {
      risk_event_id: uid('risk'),
      timestamp: timestamp(),
      level: 'low',
      source: 'runtime_guard',
      reason: '[dry-run] Risk assessment is simulated.',
      action: 'proceed_with_note',
      status: 'confirmed',
    },
  ];

  const limitations = [
    ...plan.limitations,
  ];

  // Check for skill fallbacks
  const fallbacks = [];
  for (const s of plan.skills) {
    if (s.fallback_used) {
      fallbacks.push({
        skill: s.name,
        status: 'unavailable',
        fallback: { skill: s.fallback_used, status: 'used', reason: 'primary_skill_unavailable' },
        required: s.required,
        impact: 'reduced_confidence',
        confidence_reduction: `${s.name} was unavailable. ${s.fallback_used} was used as fallback — reduced confidence.`,
        trace_note: `${s.name} not executed. ${s.fallback_used} used as fallback.`,
      });
    }
  }

  return {
    session: {
      session_id: sessionId,
      workpack: plan.workpack,
      state: 'completed',
      mode: 'dry-run',
      created_at: timestamp(),
    },
    run: {
      session_id: sessionId,
      run_id: runId,
      mode: 'dry-run',
      status: 'completed',
      overall_gate_result: 'pass',
      review_gate_results: gateResults,
      risk_events: riskEvents,
      conflicts: [],
      skill_fallbacks: fallbacks,
      unresolved_questions: [],
      started_at: timestamp(),
      completed_at: timestamp(),
    },
    trace: {
      trace_id: uid('wp_trc'),
      session_id: sessionId,
      trace_version: '0.2',
      workpack_identity: plan.workpack,
      kdna_assets_loaded: plan.kdna_assets.map(a => ({ name: a.name, version: a.version, role: a.role })),
      entries: [
        { timestamp: timestamp(), type: 'phase_transition', data: { phase: 'resolution' } },
        { timestamp: timestamp(), type: 'phase_transition', data: { phase: 'kdna_loading', assets_count: plan.kdna_assets.length } },
        { timestamp: timestamp(), type: 'phase_transition', data: { phase: 'skill_binding', skills_bound: plan.skills.length } },
        { timestamp: timestamp(), type: 'phase_transition', data: { phase: 'completed', note: '[dry-run] No real execution performed.' } },
      ],
      conflict_log: [],
      skill_fallback_log: fallbacks,
      integrity: { append_only: true, signed: false, digest: null },
      generated_at: timestamp(),
    },
    limitations,
  };
}

// ── Report ──────────────────────────────────────────────────────────

/**
 * kdna workpack report <session-id|path> [--json]
 *
 * Generate or display a Work Pack session report.
 * If given a session ID, looks up the run directory.
 * If given a path, reads the report from that directory.
 */
function cmdWorkpackReport(target, args = []) {
  const jsonMode = args.includes('--json');

  // Accept either a session ID or a path
  let reportData = null;

  // Try as a path first
  const abs = path.resolve(target);
  if (fs.existsSync(abs)) {
    if (fs.statSync(abs).isDirectory()) {
      const runResultPath = path.join(abs, 'run-result.json');
      const tracePath = path.join(abs, 'judgment-trace.json');
      if (fs.existsSync(runResultPath)) {
        reportData = buildReportFromRun(abs, runResultPath, tracePath);
      }
    }
  }

  if (!reportData) {
    // Generate a skeleton report
    reportData = {
      session_id: target,
      workpack: { name: 'unknown', version: 'unknown' },
      generated_at: timestamp(),
      summary: {
        status: 'unknown',
        overall_gate_result: 'unknown',
        total_gates: 0, gates_passed: 0, gates_failed: 0,
        risk_events_total: 0, risk_events_high: 0, risk_events_critical: 0,
        conflicts_detected: 0, skill_fallbacks_used: 0,
        unresolved_questions_count: 0, duration_ms: 0,
        limitations: ['No run data found for this session.'],
      },
      judgment_report: {},
      review_report: [],
      risk_report: {},
      conflict_report: [],
      skill_fallbacks: [],
      output_available: false,
      output_path: null,
    };
  }

  if (jsonMode) {
    console.log(JSON.stringify(reportData, null, 2));
    return;
  }

  console.log(`Work Pack Report: ${reportData.workpack.name} v${reportData.workpack.version}`);
  console.log(`Session: ${reportData.session_id}`);
  console.log(`Generated: ${reportData.generated_at}`);
  console.log('');
  console.log(`Status:       ${reportData.summary.status}`);
  console.log(`Gate Result:  ${reportData.summary.overall_gate_result}`);
  console.log(`Gates:        ${reportData.summary.gates_passed}/${reportData.summary.total_gates} passed`);
  console.log(`Risk Events:  ${reportData.summary.risk_events_total} (${reportData.summary.risk_events_high} high)`);
  console.log(`Conflicts:    ${reportData.summary.conflicts_detected}`);
  console.log(`Fallbacks:    ${reportData.summary.skill_fallbacks_used}`);
  console.log(`Output:       ${reportData.output_available ? reportData.output_path : 'not available'}`);
  if (reportData.summary.limitations?.length) {
    console.log(`\nLimitations:`);
    reportData.summary.limitations.forEach(l => console.log(`  ⚠ ${l}`));
  }
}

function buildReportFromRun(dirPath, runResultPath, tracePath) {
  const runResult = readJsonSafe(runResultPath);
  const trace = readJsonSafe(tracePath);
  // Build a basic report from existing data — full implementation in Phase 5.2
  return {
    session_id: runResult?.session_id || path.basename(dirPath),
    workpack: { name: 'code-review', version: '0.1.0' },
    generated_at: timestamp(),
    summary: {
      status: runResult?.status || 'unknown',
      overall_gate_result: runResult?.overall_gate_result || 'unknown',
      total_gates: (runResult?.review_gate_results || []).length,
      gates_passed: (runResult?.review_gate_results || []).filter(g => g.result === 'pass').length,
      gates_failed: (runResult?.review_gate_results || []).filter(g => g.result !== 'pass').length,
      risk_events_total: (runResult?.risk_events || []).length,
      risk_events_high: 0,
      risk_events_critical: 0,
      conflicts_detected: (runResult?.conflicts || []).length,
      skill_fallbacks_used: (runResult?.skill_fallbacks || []).length,
      unresolved_questions_count: (runResult?.unresolved_questions || []).length,
      duration_ms: 0,
      limitations: trace?.entries?.find(e => e.type === 'phase_transition' && e.data?.phase === 'completed' && e.data?.note) ? [trace.entries.find(e => e.type === 'phase_transition' && e.data?.phase === 'completed').data.note] : [],
    },
    review_report: runResult?.review_gate_results || [],
    risk_report: { events: runResult?.risk_events || [], highest_risk_level: 'low' },
    conflict_report: runResult?.conflicts || [],
    skill_fallbacks: runResult?.skill_fallbacks || [],
    output_available: !!runResult?.output_path,
    output_path: runResult?.output_path || null,
  };
}

// ── Init ────────────────────────────────────────────────────────────

function cmdWorkpackInit(name, argsArr = []) {
  const domainIdx = argsArr.indexOf('--domain');
  const domain = domainIdx >= 0 ? argsArr[domainIdx + 1] : 'code_review';

  if (!name) error('Usage: kdna workpack init <name> [--domain <domain>]');

  const dir = path.resolve(name);
  if (fs.existsSync(dir)) error(`Directory "${name}" already exists.`);

  const dirs = ['kdna', 'skills', 'templates', 'review-gates', 'risk', 'trace', 'evals', 'examples'];
  for (const d of dirs) fs.mkdirSync(path.join(dir, d), { recursive: true });

  const manifest = {
    format: 'kdna-workpack', format_version: '0.1', name, version: '0.1.0',
    description: `A KDNA Work Pack for ${name.replace(/-/g, ' ')}.`, status: 'draft', access: 'open', license: 'Apache-2.0',
    kdna: { mode: 'single', asset: { name: domain, version: '^1.0.0', role: 'primary' } },
    skills: [{ name: 'analyze_input', type: 'analysis', required: true }],
    templates: { task: 'templates/task-template.md', output: 'templates/output-template.md' },
    review_gates: ['review-gates/quality-gate.json'],
    risk_policy: 'risk/risk-policy.json', trace_policy: 'trace/trace-policy.json', evals: 'evals/cases.jsonl',
  };
  fs.writeFileSync(path.join(dir, 'workpack.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'review-gates/quality-gate.json'), JSON.stringify({
    name: 'quality-gate', description: 'Checks whether the output meets quality standards.',
    criteria: [{ id: 'completeness', description: 'Output covers all required aspects' }],
    results: { pass: 'All criteria satisfied', redo: 'Issues found', block: 'Critical issues', human_review: 'Ambiguous' },
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'risk/risk-policy.json'), JSON.stringify({
    levels: [
      { level: 'low', label: 'Low', action: 'proceed_with_note', description: 'Minor issues' },
      { level: 'medium', label: 'Medium', action: 'flag_and_continue', description: 'Notable issues' },
      { level: 'high', label: 'High', action: 'require_confirmation', description: 'Requires confirmation' },
      { level: 'critical', label: 'Critical', action: 'block', description: 'Block execution' },
    ],
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'trace/trace-policy.json'), JSON.stringify({
    record: ['workpack_identity', 'kdna_assets_loaded', 'review_gate_results', 'risk_events', 'final_output_path'],
    integrity: { sign_trace: false, include_timestamps: true },
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'skills/skill-bindings.json'), JSON.stringify([{ name: 'analyze_input', type: 'analysis', required: true }], null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'kdna/references.json'), JSON.stringify({ kdna_assets: [{ name: domain, version: '^1.0.0', role: 'primary' }], routing: { strategy: 'role_based' }, conflict_resolution: 'expose_all' }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'evals/cases.jsonl'), JSON.stringify({ id: 'case-001', input: 'Sample input.', expected: { gate: 'quality-gate', result: 'pass' } }) + '\n');
  fs.writeFileSync(path.join(dir, 'examples/sample-input.md'), '# Sample Input\n\n[Replace with a real example.]\n');
  fs.writeFileSync(path.join(dir, 'templates/task-template.md'), `## Task: ${name}\n\n### Input\n{{input}}\n\n### Instructions\nApply the loaded KDNA judgment framework.\n`);
  fs.writeFileSync(path.join(dir, 'templates/output-template.md'), `# ${name} Report\n\n## Summary\n{{summary}}\n\n## Gate Results\n{{gate_results}}\n`);
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n.DS_Store\n.runs/\n');

  console.log(`✓ Work Pack "${name}" created at ./${name}/`);
  console.log(`  cd ${name} && kdna workpack validate .`);
}

// ── Dispatcher ──────────────────────────────────────────────────────

function cmdWorkpack(args) {
  const sub = args[1];
  const target = args[2];

  if (sub === 'init') {
    cmdWorkpackInit(target, args);
  } else if (sub === 'validate') {
    if (!target) error('Usage: kdna workpack validate <path> [--json] [--schema-only]');
    cmdWorkpackValidate(target, args);
  } else if (sub === 'inspect') {
    if (!target) error('Usage: kdna workpack inspect <path> [--json]');
    cmdWorkpackInspect(target, args);
  } else if (sub === 'explain') {
    if (!target) error('Usage: kdna workpack explain <path>');
    cmdWorkpackExplain(target);
  } else if (sub === 'plan') {
    if (!target) error('Usage: kdna workpack plan <path> [--input <file|text>] [--json]');
    cmdWorkpackPlan(target, args);
  } else if (sub === 'run') {
    if (!target) error('Usage: kdna workpack run <path> --input <file> [--dry-run] [--json]');
    cmdWorkpackRun(target, args);
  } else if (sub === 'report') {
    if (!target) error('Usage: kdna workpack report <session-id|path> [--json]');
    cmdWorkpackReport(target, args);
  } else {
    error(
      `Unknown workpack subcommand: ${sub || '(none)'}\n` +
        'Usage:\n' +
        '  kdna workpack init <name> [--domain <domain>]\n' +
        '  kdna workpack validate <path> [--json] [--schema-only]\n' +
        '  kdna workpack inspect <path> [--json]\n' +
        '  kdna workpack explain <path>\n' +
        '  kdna workpack plan <path> [--input <file>] [--json]\n' +
        '  kdna workpack run <path> --input <file> [--dry-run] [--json]\n' +
        '  kdna workpack report <session-id|path> [--json]',
      EXIT.INPUT_ERROR,
    );
  }
}

module.exports = { cmdWorkpack };
