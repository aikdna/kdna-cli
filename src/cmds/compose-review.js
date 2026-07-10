const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { error, EXIT } = require('./_common');

function loadKdnaEval() {
  try {
    return require('@aikdna/kdna-eval');
  } catch (e) {
    const altPaths = [
      process.env.KDNA_EVAL_PATH,
      path.resolve(__dirname, '..', '..', '..', 'kdna', 'packages', 'kdna-eval'),
    ];
    for (const p of altPaths) {
      if (p) {
        try {
          return require(p);
        } catch (_) {}
      }
    }
    process.stderr.write(
      'Error: @aikdna/kdna-eval is required.\n' +
        'Install it with: npm install @aikdna/kdna-eval@^0.2.0\n',
    );
    process.exit(EXIT.DEPENDENCY_ERROR || 6);
  }
}

function cmdComposeReview(args) {
  const getFlag = (name) => {
    const eq = args.find((a) => a.startsWith(name + '='));
    if (eq) return eq.slice(name.length + 1);
    const idx = args.indexOf(name);
    return idx >= 0 ? args[idx + 1] : null;
  };

  const posArgs = args.filter((a) => !a.startsWith('--'));
  const command = posArgs[0];
  const target = posArgs[1];

  if (!command || args.includes('--help') || args.includes('-h')) {
    process.stderr.write(
      'Usage:\n' +
        '  kdna compose-review-workbook <diagnostic.json>          Generate review workbook\n' +
        '  kdna validate-compose-decisions <ledger.jsonl>           Validate with 5-mode replay\n' +
        '    --fixtures=<path>   Replay fixtures (optional)\n' +
        '  kdna apply-reviewed-compose-decisions <ledger.jsonl>     Apply reviewed decisions\n' +
        '    --validation=<report.json>  Validation report (required)\n' +
        '  --consumer-index=<path>     Consumer index to update\n' +
        '    --out=<path>                Output path\n' +
        '\n' +
        'Options (shared):\n' +
        '  --out=<path>              Output file path\n' +
        '  --as=<json|md>            Output format (default: md for workbook)\n' +
        '  --policy=<path>           Route policy JSON\n' +
        '  --fixtures=<path>         Replay fixture directory\n' +
        '  --gates=<list>            Gates to validate (comma-sep)\n' +
        '  --consumer-index=<path>   Consumer index to update\n',
    );
    if (args.includes('--help') || args.includes('-h')) {
      process.exit(0);
    }
    process.exit(EXIT.INPUT_ERROR);
  }

  if (command === 'compose-review-workbook') {
    if (!target)
      error(
        'Usage: kdna compose-review-workbook <diagnostic.json> [--out=<path>] [--as=<json|md>]',
        EXIT.INPUT_ERROR,
      );
    cmdWorkbook(target, args);
    return;
  }

  if (command === 'validate-compose-decisions') {
    if (!target)
      error('Usage: kdna validate-compose-decisions <ledger.jsonl> [options]', EXIT.INPUT_ERROR);
    cmdValidateDecisions(target, args);
    return;
  }

  if (command === 'apply-reviewed-compose-decisions') {
    if (!target)
      error(
        'Usage: kdna apply-reviewed-compose-decisions <ledger.jsonl> [options]',
        EXIT.INPUT_ERROR,
      );
    cmdApplyDecisions(target, args);
    return;
  }

  error(`Unknown compose-review command: ${command}`);
}

function cmdWorkbook(target, args) {
  const getFlag = (name) => {
    const eq = args.find((a) => a.startsWith(name + '='));
    if (eq) return eq.slice(name.length + 1);
    const idx = args.indexOf(name);
    return idx >= 0 ? args[idx + 1] : null;
  };

  const outPath = getFlag('--out');
  const as = getFlag('--as') || 'md';

  let diagnostic = null;
  try {
    const abs = path.resolve(target);
    if (target !== '/dev/null' && fs.existsSync(abs)) {
      diagnostic = JSON.parse(fs.readFileSync(abs, 'utf8'));
    }
  } catch (e) {
    error(`Cannot read diagnostic: ${target} — ${e.message}`, EXIT.INPUT_ERROR);
  }

  if (!diagnostic) {
    diagnostic = {
      kdna_eval_consumption: '0.1.0',
      asset: { path: 'unknown', version: 'unknown' },
      run: { timestamp: new Date().toISOString(), modes: [], gates: [] },
      results: {},
      verdict: { overall: 'no-data', blocked_gates: [], failed_gates: [], regression_flags: [] },
      budget: { profile: 'interactive', consumed: { tokens: 0, chars: 0, assets: 0 } },
    };
  }

  const workbook = buildWorkbook(diagnostic);

  const output =
    as === 'json' ? JSON.stringify(workbook, null, 2) : formatWorkbookMarkdown(workbook);

  if (outPath) {
    fs.writeFileSync(path.resolve(outPath), output + '\n');
  } else {
    process.stdout.write(output + '\n');
  }
}

function buildWorkbook(diagnostic) {
  const decisions = [];
  const reviewPrompts = [];
  const candidatePatch = [];

  for (const [mode, data] of Object.entries(diagnostic.results || {})) {
    for (const g of data.gates || []) {
      const passIcon = g.pass === true ? 'PASS' : g.pass === false ? 'FAIL' : 'BLOCKED';
      decisions.push({
        gate: g.gate,
        mode,
        status: passIcon,
        details: g.details || {},
        errors: g.errors || [],
      });

      if (g.pass !== true) {
        reviewPrompts.push({
          gate: g.gate,
          mode,
          status: passIcon,
          reason: (g.errors || []).join('; ') || g.details?.blockReason || 'gate did not pass',
        });
      }
    }
  }

  const blockReasons = new Set();
  for (const d of decisions) {
    if (d.status === 'BLOCKED' || d.status === 'FAIL') {
      blockReasons.add(d.gate);
    }
  }

  if (blockReasons.has('promotion')) {
    reviewPrompts.push({
      gate: 'promotion',
      mode: 'all',
      status: 'BLOCKED',
      reason: 'sealed-derived evidence cannot be auto-promoted — requires human review',
    });
  }

  for (const [mode] of Object.entries(diagnostic.results || {})) {
    const gates = diagnostic.results[mode]?.gates || [];
    const primaryGate = gates.find((g) => g.gate === 'route');
    if (primaryGate?.details?.primary) {
      candidatePatch.push({
        op: 'add',
        path: `/entries/${diagnostic.asset?.path || 'unknown'}`,
        value: {
          domain_id: primaryGate.details.primary,
          status: 'eval_candidate',
          enabled: false,
          recommendation: primaryGate.details.confidence || 'medium',
        },
      });
      break;
    }
  }

  return {
    title: 'KDNA Compose Review Workbook',
    asset: diagnostic.asset || { path: 'unknown' },
    generated: diagnostic.run?.timestamp || new Date().toISOString(),
    decisions,
    reviewPrompts: generateReviewPrompts(decisions, diagnostic),
    candidateSidecarPatch:
      candidatePatch.length > 0
        ? candidatePatch
        : [{ note: 'no primary domain resolved — patch generation skipped' }],
  };
}

function generateReviewPrompts(decisions, diagnostic) {
  const prompts = [];

  const blockedGates = decisions.filter((d) => d.status === 'BLOCKED' || d.status === 'FAIL');
  const uniqueBlocked = [...new Set(blockedGates.map((d) => d.gate))];

  for (const gate of uniqueBlocked) {
    prompts.push({
      gate,
      questions: [
        `Has a human reviewed the ${gate} decision?`,
        `Are there any conflicts that need resolution?`,
        `Should any advisor be promoted to primary for this task?`,
      ],
    });
  }

  if (diagnostic.verdict?.regression_flags?.length > 0) {
    prompts.push({
      gate: 'regression',
      questions: ['Are these regressions acceptable for this evaluation phase?'],
    });
  }

  return prompts;
}

function formatWorkbookMarkdown(workbook) {
  const lines = [];
  lines.push(`# ${workbook.title}`);
  lines.push(`## Asset: ${workbook.asset.path || 'unknown'}`);
  lines.push(`## Generated: ${workbook.generated}`);
  lines.push('');

  for (const d of workbook.decisions) {
    lines.push(`### Decision: ${d.gate} (${d.mode})`);
    lines.push(`- **Status:** ${d.status}`);
    if (d.details.primary) {
      lines.push(
        `- **Primary:** ${typeof d.details.primary === 'string' ? d.details.primary : d.details.primary.domain_id || '?'}`,
      );
    }
    if (d.details.advisors) {
      const names = d.details.advisors.map((a) => a.domain_id || a).join(', ');
      lines.push(`- **Advisors:** ${names || 'none'}`);
    }
    if (d.errors.length > 0) {
      for (const e of d.errors) {
        lines.push(`- **Error:** ${e}`);
      }
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('## Review Prompts');
  lines.push('');

  for (const p of workbook.reviewPrompts) {
    lines.push(`### ${p.gate} gate`);
    for (const q of p.questions) {
      lines.push(`- [ ] ${q}`);
    }
    lines.push('');
  }

  lines.push('## Candidate Sidecar Patch');
  lines.push('```json');
  lines.push(JSON.stringify(workbook.candidateSidecarPatch, null, 2));
  lines.push('```');

  return lines.join('\n');
}

// ─── validate-compose-decisions ────────────────────────────────────────

function cmdValidateDecisions(target, args) {
  const getFlag = (name) => {
    const eq = args.find((a) => a.startsWith(name + '='));
    if (eq) return eq.slice(name.length + 1);
    const idx = args.indexOf(name);
    return idx >= 0 ? args[idx + 1] : null;
  };

  const policyPath = getFlag('--policy');
  const fixturesDir = getFlag('--fixtures');
  const gatesRaw = getFlag('--gates') || 'route,compose,cost,promotion';
  const outPath = getFlag('--out');

  const gates = gatesRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const abs = path.resolve(target);

  let records = [];
  try {
    const content = fs.readFileSync(abs, 'utf8');
    const lines = content.split('\n').filter((l) => l.trim());
    for (const line of lines) {
      try {
        records.push(JSON.parse(line));
      } catch (_) {}
    }
  } catch (e) {
    error(`Cannot read ledger: ${target} — ${e.message}`, EXIT.INPUT_ERROR);
  }

  if (records.length === 0) {
    records = [{ record_id: 'placeholder-1', decisions: [] }];
  }

  let policies = null;
  if (policyPath) {
    try {
      policies = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
    } catch (e) {
      error(`Cannot read policy: ${policyPath}`, EXIT.INPUT_ERROR);
    }
  }

  const { createMultiGateRunner, createConsumptionRunner, createReplayEngine } = loadKdnaEval();
  const consumption = createConsumptionRunner({ policies, budgetProfile: 'interactive' });

  const REPLAY_MODES = ['repair', 'holdout', 'fresh', 'candidate-sealed', 'new-sealed'];
  const engine = createReplayEngine();

  const fixtures = [];
  if (fixturesDir) {
    try {
      const files = fs.readdirSync(fixturesDir).filter((f) => f.endsWith('.json'));
      for (const f of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(fixturesDir, f), 'utf8'));
          if (Array.isArray(data)) fixtures.push(...data);
          else fixtures.push(data);
        } catch (_) {}
      }
    } catch (_) {}
  }

  const allGates = [
    consumption.route,
    consumption.cost,
    consumption.compose,
    consumption.promotion,
  ];

  const selectedGates = allGates.filter((g) => gates.includes(g.name));
  const runner = createMultiGateRunner(selectedGates.length > 0 ? selectedGates : allGates);

  const results = [];
  let passed = 0;
  let failed = 0;
  let promotionBlocked = 0;

  for (const record of records) {
    const recordId = record.record_id || `record-${crypto.randomBytes(6).toString('hex')}`;
    const replay = {};
    const accumulatedReplayResults = {};

    let baselineRun = null;

    for (const mode of REPLAY_MODES) {
      const context = {
        task: record.task || 'review',
        mode,
        source: record.source || 'experiment-derived',
        reviewStatus: record.review_status || 'eval_candidate',
        primary: record.primary,
        advisors: record.advisors || [],
        sourceHardmax: record.source_hardmax || 3,
        budget: 'interactive',
        assetPath: record.asset_path || target,
        fixtures,
        replayResults: { ...accumulatedReplayResults },
      };

      const gateResults = runner.runGates(context);

      // Build current run for the replay engine
      const currentRun = {
        mode,
        results: gateResults.map((g) => ({
          id: g.gate,
          score: g.score != null ? g.score : g.pass === true ? 1.0 : g.pass === false ? 0.0 : 0.5,
          pass: g.pass === true,
          dimensions: g.details || {},
        })),
      };

      if (!baselineRun) {
        baselineRun = currentRun;
      }

      const comparison = engine.compareRuns(baselineRun, currentRun);
      const modePassed = gateResults.every((g) => g.pass === true || g.pass === null);

      replay[mode] = {
        overall: modePassed ? 'pass' : 'fail',
        passed: modePassed,
        failed_gates: gateResults.filter((g) => g.pass === false).map((g) => g.gate),
        comparison: {
          scoreDelta: comparison.scoreDelta,
          regressions: (comparison.diff || []).filter(
            (d) => d.kind === 'pass-change' && d.b && d.b.pass !== true,
          ),
        },
      };

      accumulatedReplayResults[mode] = { pass: modePassed };

      if (!replay[mode].passed && replay[mode].failed_gates.includes('promotion')) {
        promotionBlocked++;
      }
    }

    const allModesPassed = Object.values(replay).every((r) => r.overall === 'pass');
    const verdict = allModesPassed ? 'pass' : 'fail';

    if (verdict === 'pass') passed++;
    else failed++;

    results.push({ record_id: recordId, replay, verdict });
  }

  const report = {
    kdna_validate_compose: '0.1.0',
    ledger: { path: target, records: records.length },
    results,
    summary: {
      total: records.length,
      passed,
      failed,
      promotion_blocked: promotionBlocked,
    },
  };

  const output = JSON.stringify(report, null, 2);
  if (outPath) {
    fs.writeFileSync(path.resolve(outPath), output + '\n');
  } else {
    process.stdout.write(output + '\n');
  }
}

// ─── apply-reviewed-compose-decisions ───────────────────────────────────

function cmdApplyDecisions(target, args) {
  const getFlag = (name) => {
    const eq = args.find((a) => a.startsWith(name + '='));
    if (eq) return eq.slice(name.length + 1);
    const idx = args.indexOf(name);
    return idx >= 0 ? args[idx + 1] : null;
  };

  const consumerIndexPath = getFlag('--consumer-index');
  const outPath = getFlag('--out');
  const force = args.includes('--force');
  const validationPath = getFlag('--validation');

  if (!validationPath) {
    error(
      'Usage: kdna apply-reviewed-compose-decisions <ledger.jsonl> --validation=<validation-report.json> [options]\n' +
        'A validation report from kdna validate-compose-decisions is required.',
      EXIT.INPUT_ERROR,
    );
  }

  let validationReport;
  try {
    validationReport = JSON.parse(fs.readFileSync(path.resolve(validationPath), 'utf8'));
  } catch (e) {
    error(`Cannot read validation report: ${validationPath}`, EXIT.INPUT_ERROR);
  }

  if (!validationReport.results || !Array.isArray(validationReport.results)) {
    error("Invalid validation report: missing 'results' array", EXIT.INPUT_ERROR);
  }

  const abs = path.resolve(target);
  const records = [];
  try {
    const content = fs.readFileSync(abs, 'utf8');
    const lines = content.split('\n').filter((l) => l.trim());
    for (const line of lines) {
      try {
        records.push(JSON.parse(line));
      } catch (_) {}
    }
  } catch (e) {
    error(`Cannot read ledger: ${target} — ${e.message}`, EXIT.INPUT_ERROR);
  }

  if (records.length === 0) {
    console.log(
      JSON.stringify(
        { applied: [], skipped: [], summary: { total: 0, applied: 0, skipped: 0 } },
        null,
        2,
      ),
    );
    return;
  }

  let consumerIndex = { consumer_index: '0.1.0', entries: [] };
  if (consumerIndexPath) {
    try {
      consumerIndex = JSON.parse(fs.readFileSync(path.resolve(consumerIndexPath), 'utf8'));
    } catch (e) {
      error(`Cannot read consumer-index: ${consumerIndexPath}`, EXIT.INPUT_ERROR);
    }
  }

  const applied = [];
  const skipped = [];

  for (const record of records) {
    const recordId = record.record_id || 'unknown';

    const validationResult = validationReport.results.find((r) => r.record_id === recordId);

    if (!validationResult) {
      skipped.push({
        record_id: recordId,
        reason: 'no validation result found for this record',
      });
      continue;
    }

    if (validationResult.verdict !== 'pass') {
      skipped.push({
        record_id: recordId,
        reason: `validation verdict is "${validationResult.verdict}", not "pass"`,
      });
      continue;
    }

    if (record.source === 'sealed-derived') {
      skipped.push({
        record_id: recordId,
        reason:
          'sealed-derived evidence cannot be auto-applied — requires human review (--force cannot override)',
      });
      continue;
    }

    const reviewOk =
      record.review_status &&
      ['human_reviewed', 'eval_candidate', 'trusted_runtime'].includes(record.review_status);

    if (!reviewOk && record.approved !== true) {
      skipped.push({
        record_id: recordId,
        reason: `review status "${record.review_status}" below human_reviewed`,
      });
      continue;
    }

    const primaryDomain = record.primary || record.decision?.primary?.domain_id || null;
    if (!primaryDomain) {
      skipped.push({ record_id: recordId, reason: 'no primary domain resolved' });
      continue;
    }

    const existingIdx = consumerIndex.entries.findIndex((e) => e.domain_id === primaryDomain);

    const entry = {
      domain_id: primaryDomain,
      status: 'eval_candidate',
      enabled: false,
      route_preference: {
        primary_for: [record.task || 'review'],
        advisor_for: [],
        never_for: [],
      },
      provenance: {
        generated_by: 'compose-review',
        generated_at: new Date().toISOString(),
        source: record.source || 'experiment-derived',
      },
    };

    if (existingIdx >= 0) {
      consumerIndex.entries[existingIdx] = entry;
    } else {
      consumerIndex.entries.push(entry);
    }

    applied.push({ record_id: recordId, domain_id: primaryDomain });
  }

  const output = JSON.stringify(
    {
      applied,
      skipped,
      consumer_index: consumerIndex,
      summary: {
        total: records.length,
        applied: applied.length,
        skipped: skipped.length,
      },
    },
    null,
    2,
  );

  if (outPath) {
    fs.writeFileSync(path.resolve(outPath), output + '\n');
  } else {
    process.stdout.write(output + '\n');
  }
}

module.exports = { cmdComposeReview };
