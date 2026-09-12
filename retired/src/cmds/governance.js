/**
 * KDNA Governance commands — Phase 6: Human-Governed Self-Improvement.
 *
 *   kdna proposal create --from-test <run.json> --domain <path>
 *   kdna proposal validate <proposal.json>
 *   kdna review accept <proposal.json> --by <identity> --reason "..."
 *   kdna review reject <proposal.json> --by <identity> --reason "..."
 *   kdna lock card <id> --by <identity> --reason "..."
 *   kdna evolution add-proposal <proposal.json>
 *   kdna evolution add-lock <lock.json>
 *   kdna evolution report <domain>
 *   kdna regression <old> <new> --evals <dir> [--json]
 */

const fs = require('fs');
const path = require('path');
const { error, readJson, writeJson, EXIT } = require('./_common');

const USER_KDNA_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.kdna');
const EVOLUTION_DIR = path.join(USER_KDNA_DIR, 'evolution');

// ─── Proposal ──────────────────────────────────────────────────────────

function cmdProposalCreate(args = []) {
  const jsonMode = args.includes('--json');
  const testIdx = args.indexOf('--from-test');
  const testFile = testIdx >= 0 ? args[testIdx + 1] : null;
  const domainIdx = args.indexOf('--domain');
  const domainPath = domainIdx >= 0 ? args[domainIdx + 1] : '.';

  if (!testFile) {
    error('Usage: kdna proposal create --from-test <run-file> --domain <path>', EXIT.INPUT_ERROR);
  }

  const absTest = path.resolve(testFile);
  if (!fs.existsSync(absTest)) error(`Test run file not found: ${absTest}`, EXIT.INPUT_ERROR);

  const runData = readJson(absTest);
  if (!runData || !runData.test_id)
    error(`Not a valid test run file: ${absTest}`, EXIT.INPUT_ERROR);

  const absDomain = path.resolve(domainPath);

  // Create proposal from test failure data
  const proposal = {
    proposal_id: `prop_${runData.test_id}_${Date.now()}`,
    type: 'judgment_proposal',
    source: 'test_lab',
    source_run: path.basename(absTest),
    domain: runData.domain || path.basename(absDomain),
    domain_path: absDomain,
    created: new Date().toISOString(),
    author: null,
    status: 'draft',
    trigger: {
      test_id: runData.test_id,
      input: runData.input,
      expected_classification: runData.expected?.classification || null,
      actual_classification: runData.results?.classification || null,
    },
    suggested_changes: [],
    reasoning: '',
    review: null,
  };

  // Auto-detect suggested changes from test result gaps
  if (
    runData.expected?.classification &&
    runData.expected.classification !== runData.results?.classification
  ) {
    proposal.suggested_changes.push({
      what: 'axiom',
      field: 'applies_when',
      reason: `Expected classification "${runData.expected.classification}" but got "${runData.results?.classification || 'none'}"`,
    });
  }
  if (runData.results?.violations?.length) {
    for (const v of runData.results.violations) {
      proposal.suggested_changes.push({ what: 'boundary', field: 'violation', reason: v });
    }
  }

  const outFile = path.join(absDomain, `${proposal.proposal_id}.json`);
  writeJson(outFile, proposal);

  if (jsonMode) {
    console.log(
      JSON.stringify(
        {
          proposal_id: proposal.proposal_id,
          saved: outFile,
          suggested_changes: proposal.suggested_changes.length,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`Proposal created: ${proposal.proposal_id}`);
  console.log(`  Source:  ${runData.test_id}`);
  console.log(`  Domain:  ${proposal.domain}`);
  console.log(`  Changes: ${proposal.suggested_changes.length} suggested`);
  if (proposal.suggested_changes.length) {
    for (const c of proposal.suggested_changes) {
      console.log(`    - ${c.what}.${c.field}: ${c.reason}`);
    }
  }
  console.log(`\nNext: kdna proposal validate ${proposal.proposal_id}.json`);
}

function cmdProposalValidate(args = []) {
  const jsonMode = args.includes('--json');
  const target =
    args.filter((a) => !a.startsWith('--'))[2] || args.filter((a) => !a.startsWith('--'))[1];
  if (!target) error('Usage: kdna proposal validate <proposal.json>', EXIT.INPUT_ERROR);

  const abs = path.resolve(target);
  if (!fs.existsSync(abs)) error(`Proposal not found: ${abs}`, EXIT.INPUT_ERROR);

  const proposal = readJson(abs);
  if (!proposal || !proposal.proposal_id) error(`Not a valid proposal: ${abs}`, EXIT.INPUT_ERROR);

  const issues = [];

  if (!proposal.type) issues.push('missing type');
  if (!proposal.source) issues.push('missing source');
  if (!proposal.domain) issues.push('missing domain');
  if (!proposal.trigger?.test_id) issues.push('missing trigger.test_id');
  if (!proposal.reasoning || proposal.reasoning.length < 10)
    issues.push('reasoning too short (min 10 chars)');
  if (!proposal.suggested_changes || proposal.suggested_changes.length === 0) {
    issues.push('no suggested changes');
  } else {
    for (const c of proposal.suggested_changes) {
      if (!c.what) issues.push('change missing "what" field');
      if (!c.reason) issues.push('change missing reason');
    }
  }

  if (jsonMode) {
    console.log(
      JSON.stringify(
        {
          proposal_id: proposal.proposal_id,
          valid: issues.length === 0,
          issues,
        },
        null,
        2,
      ),
    );
    process.exit(issues.length ? EXIT.VALIDATION_FAILED : EXIT.OK);
  }

  if (issues.length) {
    console.log('Issues:');
    issues.forEach((i) => console.log(`  ✗ ${i}`));
    process.exit(EXIT.VALIDATION_FAILED);
  }

  console.log(`✓ Proposal valid: ${proposal.proposal_id}`);
}

// ─── Review ────────────────────────────────────────────────────────────

function cmdReview(args = []) {
  const jsonMode = args.includes('--json');
  const sub = args[1];
  const target = args[2];
  const byIdx = args.indexOf('--by');
  const by = byIdx >= 0 ? args[byIdx + 1] : 'unknown';
  const reasonIdx = args.indexOf('--reason');
  const reason = reasonIdx >= 0 ? args[reasonIdx + 1] : '';

  if (!sub || !['accept', 'reject'].includes(sub) || !target) {
    error(
      'Usage:\n' +
        '  kdna review accept <proposal.json> --by <name> --reason "..."\n' +
        '  kdna review reject <proposal.json> --by <name> --reason "..."',
      EXIT.INPUT_ERROR,
    );
  }

  const abs = path.resolve(target);
  if (!fs.existsSync(abs)) error(`Proposal not found: ${abs}`, EXIT.INPUT_ERROR);

  const proposal = readJson(abs);
  if (!proposal || !proposal.proposal_id) error(`Not a valid proposal: ${abs}`, EXIT.INPUT_ERROR);

  proposal.review = {
    decision: sub,
    by,
    reason,
    at: new Date().toISOString(),
  };

  // On accept, move the accepted changes into the proposal
  if (sub === 'accept') {
    proposal.accepted = true;
    proposal.accepted_at = new Date().toISOString();
    proposal.accepted_by = by;
  }

  writeJson(abs, proposal);

  if (jsonMode) {
    console.log(
      JSON.stringify(
        {
          proposal_id: proposal.proposal_id,
          decision: sub,
          by,
          reason,
        },
        null,
        2,
      ),
    );
    process.exit(sub === 'reject' ? EXIT.POLICY_VIOLATION : EXIT.OK);
  }

  const mark = sub === 'accept' ? '✓' : '✗';
  console.log(`${mark} Review ${sub}ed: ${proposal.proposal_id}`);
  console.log(`  By:     ${by}`);
  console.log(`  Reason: ${reason}`);
}

// ─── Lock ──────────────────────────────────────────────────────────────

function cmdLockCard(args = []) {
  const jsonMode = args.includes('--json');
  const sub = args[1];
  const cardId = args[2];
  const byIdx = args.indexOf('--by');
  const by = byIdx >= 0 ? args[byIdx + 1] : 'unknown';
  const reasonIdx = args.indexOf('--reason');
  const reason = reasonIdx >= 0 ? args[reasonIdx + 1] : '';

  if (sub !== 'card' || !cardId) {
    error('Usage: kdna lock card <card-id> --by <name> --reason "..."', EXIT.INPUT_ERROR);
  }

  // Lock card in the current studio project (finds studio.project.json)
  const projectPath = path.resolve('studio.project.json');
  if (!fs.existsSync(projectPath)) {
    error(
      'No studio.project.json found in current directory. Run: kdna-studio create',
      EXIT.INPUT_ERROR,
    );
  }

  const project = readJson(projectPath);
  const [cardType, id] = cardId.includes('.') ? cardId.split('.') : [null, cardId];

  let found = false;
  for (const [type, cardFile] of Object.entries(project.cards || {})) {
    if (cardType && type !== cardType) continue;

    const cardPath = path.resolve(projectPath, '..', cardFile);
    if (!fs.existsSync(cardPath)) continue;

    const cards = readJson(cardPath) || [];
    const card = cards.find((c) => c.id === id);
    if (!card) continue;

    card.locked = true;
    card.human_lock = { by, reason, at: new Date().toISOString() };
    writeJson(cardPath, cards);
    found = true;

    if (jsonMode) {
      console.log(
        JSON.stringify(
          {
            card: `${type}.${id}`,
            locked: true,
            lock: card.human_lock,
          },
          null,
          2,
        ),
      );
    } else {
      console.log(`✓ Locked: ${type}.${id}`);
      console.log(`  By:     ${by}`);
      console.log(`  Reason: ${reason}`);
    }
    break;
  }

  if (!found) {
    error(
      `Card not found: ${cardId}. Check the card ID and that a studio project exists.`,
      EXIT.INPUT_ERROR,
    );
  }
}

// ─── Evolution ─────────────────────────────────────────────────────────

function cmdEvolution(args = []) {
  const sub = args[1];
  const target = args[2];
  const jsonMode = args.includes('--json');

  if (!sub || !['add-proposal', 'add-lock', 'report'].includes(sub)) {
    error(
      'Usage:\n' +
        '  kdna evolution add-proposal <proposal.json>\n' +
        '  kdna evolution add-lock <lock-record.json>\n' +
        '  kdna evolution report <domain-path>',
      EXIT.INPUT_ERROR,
    );
  }

  if (sub === 'add-proposal') {
    if (!target) error('Usage: kdna evolution add-proposal <proposal.json>', EXIT.INPUT_ERROR);
    addEvolutionRecord('proposal', path.resolve(target));
    return;
  }

  if (sub === 'add-lock') {
    if (!target) error('Usage: kdna evolution add-lock <lock-record.json>', EXIT.INPUT_ERROR);
    addEvolutionRecord('lock', path.resolve(target));
    return;
  }

  if (sub === 'report') {
    const domainPath = path.resolve(target || '.');
    cmdEvolutionReport(domainPath, jsonMode);
  }
}

function addEvolutionRecord(type, sourcePath) {
  if (!fs.existsSync(sourcePath)) error(`${type} file not found: ${sourcePath}`, EXIT.INPUT_ERROR);

  fs.mkdirSync(EVOLUTION_DIR, { recursive: true });
  const destFile = path.join(EVOLUTION_DIR, `${type}_${Date.now()}.json`);
  fs.copyFileSync(sourcePath, destFile);

  console.log(`✓ Evolution record added: ${path.basename(destFile)}`);
  console.log(`  Type:   ${type}`);
  console.log(`  Source: ${path.basename(sourcePath)}`);
}

function cmdEvolutionReport(domainPath, jsonMode) {
  const abs = path.resolve(domainPath);
  const evoFile = path.join(abs, 'KDNA_Evolution.json');

  let evolution = readJson(evoFile);
  if (!evolution) {
    evolution = { stages: [], pending: [] };
    console.log('No KDNA_Evolution.json found. Creating empty record.');
    writeJson(evoFile, evolution);
  }

  const stages = evolution.stages || [];
  const pending = evolution.pending || [];

  if (jsonMode) {
    console.log(
      JSON.stringify(
        {
          domain: path.basename(abs),
          total_stages: stages.length,
          pending_changes: pending.length,
          stages: stages.map((s) => ({
            stage: s.stage,
            version: s.version,
            date: s.date,
            changes: s.changes?.length || 0,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`Evolution report: ${path.basename(abs)}`);
  console.log(`  Stages: ${stages.length}  |  Pending: ${pending.length}`);
  console.log('');

  if (stages.length) {
    for (const s of stages) {
      console.log(`  ${s.stage || '?'} — v${s.version || '?'} (${s.date || '?'})`);
      if (s.changes) {
        s.changes.forEach((c) => console.log(`    - ${c}`));
      }
    }
  } else {
    console.log('  No evolution stages recorded yet.');
    console.log('  Use: kdna evolution add-proposal <proposal.json>');
  }
}

// ─── Regression ────────────────────────────────────────────────────────

function cmdRegression(args = []) {
  const jsonMode = args.includes('--json');
  const positional = args.filter((a) => !a.startsWith('--'));
  const oldPath = positional[1];
  const newPath = positional[2];
  const evalsIdx = args.indexOf('--evals');
  const evalsDir = evalsIdx >= 0 ? args[evalsIdx + 1] : null;

  if (!oldPath || !newPath) {
    error(
      'Usage: kdna regression <old-domain> <new-domain> --evals <dir> [--json]',
      EXIT.INPUT_ERROR,
    );
  }

  const absOld = path.resolve(oldPath);
  const absNew = path.resolve(newPath);

  if (!fs.existsSync(absOld)) error(`Old domain not found: ${absOld}`, EXIT.INPUT_ERROR);
  if (!fs.existsSync(absNew)) error(`New domain not found: ${absNew}`, EXIT.INPUT_ERROR);

  const oldCore = readJson(path.join(absOld, 'KDNA_Core.json'));
  const newCore = readJson(path.join(absNew, 'KDNA_Core.json'));
  const oldPat = readJson(path.join(absOld, 'KDNA_Patterns.json'));
  const newPat = readJson(path.join(absNew, 'KDNA_Patterns.json'));

  // Compare judgment surface
  const oldAxiomCount = (oldCore?.axioms || []).length;
  const newAxiomCount = (newCore?.axioms || []).length;
  const oldMisCount = (oldPat?.misunderstandings || []).length;
  const newMisCount = (newPat?.misunderstandings || []).length;
  const oldSelfCheckCount = (oldPat?.self_check || []).length;
  const newSelfCheckCount = (newPat?.self_check || []).length;

  // Authoring governance coverage comparison
  function governanceCoverage(core) {
    const axioms = core?.axioms || [];
    if (!axioms.length) return 0;
    const governed = axioms.filter(
      (a) => a.applies_when?.length && a.does_not_apply_when?.length && a.failure_risk,
    ).length;
    return Math.round((governed / axioms.length) * 100);
  }

  const oldGov = governanceCoverage(oldCore);
  const newGov = governanceCoverage(newCore);

  // Eval file comparison
  let passedEvals = 0;
  let failedEvals = 0;
  let totalEvals = 0;

  if (evalsDir && fs.existsSync(evalsDir)) {
    const evalFiles = fs.readdirSync(evalsDir).filter((f) => f.endsWith('.json'));
    totalEvals = evalFiles.length;
    for (const f of evalFiles) {
      const evalData = readJson(path.join(evalsDir, f));
      if (evalData?.cases) {
        for (const c of evalData.cases) {
          if (c.pass === true) passedEvals++;
          else if (c.pass === false) failedEvals++;
        }
      }
    }
  }

  const degraded = newGov < oldGov || newAxiomCount < oldAxiomCount || newMisCount < oldMisCount;
  const improved = newGov > oldGov || newAxiomCount > oldAxiomCount;

  const result = {
    domain: path.basename(absOld),
    old: {
      axioms: oldAxiomCount,
      misunderstandings: oldMisCount,
      self_checks: oldSelfCheckCount,
      governance_coverage: oldGov,
    },
    new: {
      axioms: newAxiomCount,
      misunderstandings: newMisCount,
      self_checks: newSelfCheckCount,
      governance_coverage: newGov,
    },
    delta: {
      axioms: newAxiomCount - oldAxiomCount,
      misunderstandings: newMisCount - oldMisCount,
      self_checks: newSelfCheckCount - oldSelfCheckCount,
      governance_coverage: newGov - oldGov,
    },
    evals: { total: totalEvals, passed: passedEvals, failed: failedEvals },
    degraded,
    improved,
    safe: !degraded,
  };

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.safe ? EXIT.OK : EXIT.POLICY_VIOLATION);
  }

  console.log(`Regression check: ${path.basename(absOld)} → ${path.basename(absNew)}`);
  console.log('');
  console.log(
    `  Axioms:                  ${oldAxiomCount} → ${newAxiomCount}  (${result.delta.axioms >= 0 ? '+' : ''}${result.delta.axioms})`,
  );
  console.log(
    `  Misunderstandings:       ${oldMisCount} → ${newMisCount}  (${result.delta.misunderstandings >= 0 ? '+' : ''}${result.delta.misunderstandings})`,
  );
  console.log(
    `  Self-checks:             ${oldSelfCheckCount} → ${newSelfCheckCount}  (${result.delta.self_checks >= 0 ? '+' : ''}${result.delta.self_checks})`,
  );
  console.log(
    `  Governance coverage:     ${oldGov}% → ${newGov}%  (${result.delta.governance_coverage >= 0 ? '+' : ''}${result.delta.governance_coverage}%)`,
  );
  if (totalEvals) {
    console.log(
      `  Evals:                   ${passedEvals} passed, ${failedEvals} failed out of ${totalEvals}`,
    );
  }
  console.log('');
  const mark = result.safe ? '✓' : '✗';
  if (result.degraded) {
    console.log(`${mark} REGRESSION DETECTED — judgment surface has degraded`);
    process.exit(EXIT.POLICY_VIOLATION);
  } else if (result.improved) {
    console.log(`${mark} No regression — judgment surface has improved`);
  } else {
    console.log(`${mark} No regression — judgment surface unchanged`);
  }
}

module.exports = {
  cmdProposalCreate,
  cmdProposalValidate,
  cmdReview,
  cmdLockCard,
  cmdEvolution,
  cmdRegression,
};
