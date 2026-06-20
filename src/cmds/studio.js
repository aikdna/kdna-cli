/**
 * Dev-only Studio project diagnostics retained for old project files.
 *
 *   kdna-studio create <name>         Create Studio project skeleton
 *   kdna cards validate <project.json>  Validate Judgment Cards
 *   kdna lock verify <project.json>     Verify Human Lock status
 *   kdna-studio compile <project.json>  Compile locked cards into Studio build output
 *   kdna-studio report <project.json>  Generate Domain Readiness Card
 */

const fs = require('fs');
const path = require('path');
const { error, readJson, writeJson, EXIT, isYesNoSelfCheck } = require('./_common');

// ─── Scaffold ─────────────────────────────────────────────────────────

const CARD_TEMPLATES = {
  axioms: [
    {
      id: 'ax_001',
      one_sentence: '[TODO: One-line judgment principle]',
      full_statement: '[TODO: Full statement — what the agent should do differently]',
      why: '[TODO: What the agent would get wrong without this axiom]',
      applies_when: [],
      does_not_apply_when: [],
      failure_risk: null,
      confidence: null,
      evidence_type: [],
      locked: false,
      human_lock: null,
      feynman_restatement: null,
    },
  ],
  ontology: [
    {
      id: 'ont_001',
      concept: '[TODO: Core concept name]',
      essence: '[TODO: Operational essence — what the agent checks]',
      boundary: '[TODO: What this is not, or is often confused with]',
      trigger_signal: '[TODO: Observable words/patterns the agent detects]',
      locked: false,
      human_lock: null,
      feynman_restatement: null,
    },
  ],
  misunderstandings: [
    {
      id: 'ms_001',
      wrong: '[TODO: A belief a real agent might hold]',
      correct: '[TODO: The correct judgment]',
      key_distinction: '[TODO: Conceptual boundary between wrong and correct]',
      failure_risk: null,
      locked: false,
      human_lock: null,
      feynman_restatement: null,
    },
  ],
  boundaries: [
    {
      id: 'bd_001',
      scope: '[TODO: What this domain covers]',
      out_of_scope: '[TODO: What this domain explicitly does not cover]',
      acceptable_exceptions: [],
      locked: false,
      human_lock: null,
      feynman_restatement: null,
    },
  ],
  self_checks: [
    {
      id: 'sc_001',
      question: '[TODO: A yes/no question the agent asks before final output?]',
      applies_to: [],
      locked: false,
      human_lock: null,
      feynman_restatement: null,
    },
  ],
};

function cmdStudioScaffold(name, args = []) {
  if (!name)
    error('Usage: kdna-studio create <name> [--type=domain|cluster] [--minimal]', EXIT.INPUT_ERROR);
  if (!/^[a-z][a-z0-9_-]*$/.test(name)) {
    error(
      `Invalid name "${name}". Use lowercase letters, numbers, hyphens, underscores. Start with letter.`,
      EXIT.INPUT_ERROR,
    );
  }

  const type = args.includes('--type=cluster') ? 'cluster' : 'domain';
  const minimal = args.includes('--minimal');
  const targetDir = path.resolve(name);

  if (fs.existsSync(targetDir)) {
    error(`Directory already exists: ${targetDir}`, EXIT.INPUT_ERROR);
  }

  const today = new Date().toISOString().slice(0, 10);

  // Create directory structure
  fs.mkdirSync(targetDir, { recursive: true });
  fs.mkdirSync(path.join(targetDir, 'cards'), { recursive: true });
  fs.mkdirSync(path.join(targetDir, 'exports'), { recursive: true });

  // Write studio.project.json
  const project = {
    kdna_studio: '1.0-beta',
    name,
    type,
    created: today,
    updated: today,
    cards: {
      axioms: 'cards/axioms.json',
      ontology: 'cards/ontology.json',
      misunderstandings: 'cards/misunderstandings.json',
      boundaries: 'cards/boundaries.json',
      self_checks: 'cards/self_checks.json',
    },
    exports: {
      dir: 'exports/',
    },
  };
  writeJson(path.join(targetDir, 'studio.project.json'), project);

  // Write card templates (skip ontology/boundaries in minimal mode)
  const cardTypes = minimal
    ? ['axioms', 'self_checks']
    : ['axioms', 'ontology', 'misunderstandings', 'boundaries', 'self_checks'];

  for (const type of cardTypes) {
    const file = project.cards[type];
    writeJson(path.join(targetDir, file), CARD_TEMPLATES[type]);
  }

  // Write exports/README.md
  fs.writeFileSync(
    path.join(targetDir, 'exports', 'README.md'),
    `# ${name}\n\nCompiled KDNA domain files will appear here after \`kdna-studio compile\`.\n`,
  );

  console.log(`✓ Studio project created: ${targetDir}/`);
  console.log(`  Type:       ${type}${minimal ? ' (minimal)' : ''}`);
  console.log(`  Cards:      ${cardTypes.join(', ')}`);
  console.log('');
  console.log('Next steps:');
  console.log('  1. Edit cards/ — replace all [TODO] placeholders');
  console.log('  2. Run: kdna cards validate studio.project.json');
  console.log('  3. Run: kdna lock verify studio.project.json');
  console.log('  4. Run: kdna-studio compile studio.project.json');
}

// ─── Cards Validate ───────────────────────────────────────────────────

function cmdCardsValidate(projectPath, args = []) {
  const jsonMode = args.includes('--json');
  const abs = path.resolve(projectPath);

  if (!fs.existsSync(abs)) error(`Project file not found: ${abs}`, EXIT.INPUT_ERROR);
  const project = readJson(abs);
  if (!project || !project.kdna_studio)
    error(`Not a KDNA Studio project: ${abs}`, EXIT.INPUT_ERROR);

  const errors = [];
  const warnings = [];
  const passed = [];

  function fail(msg) {
    errors.push(msg);
  }
  function warn(msg) {
    warnings.push(msg);
  }
  function ok(msg) {
    passed.push(msg);
  }

  // Validate each card set
  for (const [cardType, cardFile] of Object.entries(project.cards || {})) {
    const cardPath = path.join(path.dirname(abs), cardFile);
    if (!fs.existsSync(cardPath)) {
      warn(`Card file not found: ${cardFile}`);
      continue;
    }

    const cards = readJson(cardPath);
    if (!cards || !Array.isArray(cards)) {
      fail(`Invalid card file (not a JSON array): ${cardFile}`);
      continue;
    }

    switch (cardType) {
      case 'axioms':
        for (const ax of cards) {
          const label = ax.id || '?';
          if (!ax.one_sentence || ax.one_sentence.includes('[TODO]')) {
            warn(`axiom ${label}: one_sentence is placeholder`);
          } else {
            ok(`axiom ${label}: one_sentence OK`);
          }
          if (!ax.applies_when || !Array.isArray(ax.applies_when) || ax.applies_when.length === 0) {
            fail(`axiom ${label}: missing applies_when`);
          } else {
            ok(`axiom ${label}: applies_when has ${ax.applies_when.length} entries`);
          }
          if (
            !ax.does_not_apply_when ||
            !Array.isArray(ax.does_not_apply_when) ||
            ax.does_not_apply_when.length === 0
          ) {
            fail(`axiom ${label}: missing does_not_apply_when`);
          } else {
            ok(`axiom ${label}: does_not_apply_when has ${ax.does_not_apply_when.length} entries`);
          }
          if (!ax.failure_risk) {
            fail(`axiom ${label}: missing failure_risk`);
          } else {
            ok(`axiom ${label}: failure_risk declared`);
          }
        }
        break;

      case 'misunderstandings':
        for (const ms of cards) {
          const label = ms.id || '?';
          if (!ms.wrong || ms.wrong.includes('[TODO]'))
            warn(`misunderstanding ${label}: wrong is placeholder`);
          else ok(`misunderstanding ${label}: wrong OK`);
          if (!ms.correct || ms.correct.includes('[TODO]'))
            warn(`misunderstanding ${label}: correct is placeholder`);
          else ok(`misunderstanding ${label}: correct OK`);
          if (!ms.key_distinction || ms.key_distinction.length < 15) {
            fail(`misunderstanding ${label}: key_distinction missing or too short`);
          } else {
            ok(`misunderstanding ${label}: key_distinction OK`);
          }
        }
        break;

      case 'boundaries':
        for (const bd of cards) {
          const label = bd.id || '?';
          if (!bd.scope || bd.scope.includes('[TODO]'))
            warn(`boundary ${label}: scope is placeholder`);
          else ok(`boundary ${label}: scope OK`);
          if (!bd.out_of_scope || bd.out_of_scope.includes('[TODO]'))
            warn(`boundary ${label}: out_of_scope is placeholder`);
          else ok(`boundary ${label}: out_of_scope OK`);
          if (!bd.acceptable_exceptions || !Array.isArray(bd.acceptable_exceptions)) {
            warn(`boundary ${label}: acceptable_exceptions not declared`);
          } else {
            ok(
              `boundary ${label}: acceptable_exceptions has ${bd.acceptable_exceptions.length} entries`,
            );
          }
        }
        break;

      case 'self_checks':
        for (const sc of cards) {
          const label = sc.id || '?';
          if (!sc.question || sc.question.includes('[TODO]')) {
            warn(`self_check ${label}: question is placeholder`);
          } else if (!isYesNoSelfCheck(sc.question)) {
            fail(`self_check ${label}: question should be answerable with yes/no`);
          } else {
            ok(`self_check ${label}: question OK`);
          }
        }
        break;

      case 'ontology':
        for (const ont of cards) {
          const label = ont.id || '?';
          if (!ont.essence || ont.essence.includes('[TODO]'))
            warn(`ontology ${label}: essence is placeholder`);
          else ok(`ontology ${label}: essence OK`);
          if (!ont.boundary || ont.boundary.includes('[TODO]'))
            warn(`ontology ${label}: boundary is placeholder`);
          else ok(`ontology ${label}: boundary OK`);
          if (!ont.trigger_signal || ont.trigger_signal.includes('[TODO]'))
            warn(`ontology ${label}: trigger_signal is placeholder`);
          else ok(`ontology ${label}: trigger_signal OK`);
        }
        break;
    }
  }

  if (jsonMode) {
    console.log(
      JSON.stringify(
        {
          project: path.basename(abs),
          valid: errors.length === 0,
          errors,
          warnings,
          passed: passed.length,
          total_checks: errors.length + warnings.length + passed.length,
        },
        null,
        2,
      ),
    );
    process.exit(errors.length ? EXIT.VALIDATION_FAILED : EXIT.OK);
  }

  if (warnings.length) {
    console.log('Warnings:');
    warnings.forEach((w) => console.log(`  ⚠ ${w}`));
  }
  if (errors.length) {
    console.error('Errors:');
    errors.forEach((e) => console.error(`  ✗ ${e}`));
  }
  if (passed.length) {
    console.log(`✓ ${passed.length} checks passed`);
  }

  if (errors.length) process.exit(EXIT.VALIDATION_FAILED);
  console.log(`✓ All ${passed.length} checks passed (no errors)`);
}

// ─── Lock Verify ──────────────────────────────────────────────────────

function cmdLockVerify(projectPath, args = []) {
  const jsonMode = args.includes('--json');
  const abs = path.resolve(projectPath);

  if (!fs.existsSync(abs)) error(`Project file not found: ${abs}`, EXIT.INPUT_ERROR);
  const project = readJson(abs);
  if (!project || !project.kdna_studio)
    error(`Not a KDNA Studio project: ${abs}`, EXIT.INPUT_ERROR);

  const locked = [];
  const unlocked = [];
  const blocking = [];

  for (const [cardType, cardFile] of Object.entries(project.cards || {})) {
    const cardPath = path.join(path.dirname(abs), cardFile);
    if (!fs.existsSync(cardPath)) {
      blocking.push(`${cardType}: file not found (${cardFile})`);
      continue;
    }

    const cards = readJson(cardPath);
    if (!cards || !Array.isArray(cards)) {
      blocking.push(`${cardType}: invalid file`);
      continue;
    }

    for (const card of cards) {
      const label = `${cardType}.${card.id || '?'}`;
      if (card.locked === true) {
        if (!card.human_lock || !card.human_lock.by || !card.human_lock.at) {
          locked.push(label);
        } else {
          // Check Feynman restatement for axioms and misunderstandings
          if (
            (cardType === 'axioms' || cardType === 'misunderstandings') &&
            !card.feynman_restatement
          ) {
            unlocked.push(label);
            blocking.push(`${label} missing Feynman restatement`);
          } else {
            locked.push(label);
          }
        }
      } else {
            unlocked.push(label);
            blocking.push(`${label} requires Studio review approval`);
      }
    }
  }

  const exportReady = blocking.length === 0 && locked.length > 0;

  if (jsonMode) {
    console.log(
      JSON.stringify(
        {
          project: path.basename(abs),
          locked_cards: locked.length,
          unlocked_cards: unlocked.length,
          export_ready: exportReady,
          blocking,
          locked: locked.sort(),
          unlocked: unlocked.sort(),
        },
        null,
        2,
      ),
    );
    process.exit(exportReady ? EXIT.OK : EXIT.HUMAN_LOCK_REQUIRED);
  }

  console.log(`Studio review status for: ${path.basename(abs)}`);
  console.log('');
  console.log(`  Approved: ${locked.length}`);
  console.log(`  Pending:  ${unlocked.length}`);
  console.log(`  Export ready: ${exportReady ? '✓ yes' : '✗ no'}`);
  console.log('');

  if (blocking.length) {
    console.log('Blocking issues:');
    blocking.forEach((b) => console.log(`  ✗ ${b}`));
    console.log('');
  }

  if (locked.length) {
    console.log('Approved cards:');
    locked.forEach((l) => console.log(`  ✓ ${l}`));
  }

  process.exit(exportReady ? EXIT.OK : EXIT.HUMAN_LOCK_REQUIRED);
}

// ─── Studio Compile ───────────────────────────────────────────────────

function cmdStudioCompile(projectPath, args = []) {
  const abs = path.resolve(projectPath);

  if (!fs.existsSync(abs)) error(`Project file not found: ${abs}`, EXIT.INPUT_ERROR);
  const project = readJson(abs);
  if (!project || !project.kdna_studio)
    error(`Not a KDNA Studio project: ${abs}`, EXIT.INPUT_ERROR);

  // Determine output directory
  const outIdx = args.indexOf('--out');
  const outDir =
    outIdx >= 0
      ? path.resolve(args[outIdx + 1])
      : path.join(path.dirname(abs), project.exports?.dir || 'exports');

  fs.mkdirSync(outDir, { recursive: true });

  const today = new Date().toISOString().slice(0, 10);
  const excluded = [];
  const included = [];

  // Compile axioms → KDNA_Core.json
  const axioms = loadCards(project, path.dirname(abs), 'axioms');
  const ontology = loadCards(project, path.dirname(abs), 'ontology');

  const core = {
    meta: {
      domain: project.name,
      purpose: '',
      language: 'en',
      created: project.created || today,
      updated: today,
    },
    axioms: axioms.locked.map((ax) => ({
      id: ax.id,
      one_sentence: ax.one_sentence,
      full_statement: ax.full_statement,
      why: ax.why,
      applies_when: ax.applies_when || [],
      does_not_apply_when: ax.does_not_apply_when || [],
      failure_risk: ax.failure_risk || null,
      confidence: ax.confidence || null,
      evidence_type: ax.evidence_type || [],
    })),
    ontology: ontology.locked.map((ont) => ({
      id: ont.id,
      concept: ont.concept,
      essence: ont.essence,
      boundary: ont.boundary,
      trigger_signal: ont.trigger_signal,
    })),
    stances: [],
    frameworks: [],
    core_structure: [],
  };
  excluded.push(
    ...axioms.unlocked.map((ax) => `axiom ${ax.id || '?'} not locked`),
    ...ontology.unlocked.map((ont) => `ontology ${ont.id || '?'} not locked`),
  );

  // Compile misunderstandings + self_checks + banned_terms → KDNA_Patterns.json
  const misunderstandings = loadCards(project, path.dirname(abs), 'misunderstandings');
  const selfChecks = loadCards(project, path.dirname(abs), 'self_checks');

  const patterns = {
    misunderstandings: misunderstandings.locked.map((ms) => ({
      id: ms.id,
      wrong: ms.wrong,
      correct: ms.correct,
      key_distinction: ms.key_distinction,
      failure_risk: ms.failure_risk || null,
    })),
    self_check: selfChecks.locked.map((sc) => sc.question).filter(Boolean),
    terminology: {
      banned_terms: [],
      preferred_terms: [],
    },
  };
  excluded.push(
    ...misunderstandings.unlocked.map((ms) => `misunderstanding ${ms.id || '?'} not locked`),
    ...selfChecks.unlocked.map((sc) => `self_check ${sc.id || '?'} not locked`),
  );

  // Compile manifest → kdna.json
  const manifest = {
    format: 'kdna',
    format_version: '1.0',
    spec_version: '1.0-rc',
    name: `@aikdna/${project.name}`,
    version: '0.1.0',
    judgment_version: '0.1.0',
    status: 'experimental',
    quality_badge: 'untested',
    access: 'open',
    languages: ['en'],
    default_language: 'en',
    author: { name: '', id: '' },
    license: { type: 'CC-BY-4.0' },
    description: '',
    created: project.created || today,
    updated: today,
  };

  writeJson(path.join(outDir, 'KDNA_Core.json'), core);
  writeJson(path.join(outDir, 'KDNA_Patterns.json'), patterns);
  writeJson(path.join(outDir, 'kdna.json'), manifest);

  included.push(
    `axioms: ${axioms.locked.length} included`,
    `ontology: ${ontology.locked.length} included`,
    `misunderstandings: ${misunderstandings.locked.length} included`,
    `self_checks: ${selfChecks.locked.length} included`,
  );

  console.log(`✓ Compiled: ${outDir}/`);
  console.log(`  Included:`);
  included.forEach((i) => console.log(`    + ${i}`));

  if (excluded.length) {
    console.log(`  Excluded (not locked):`);
    excluded.forEach((e) => console.log(`    - ${e}`));
  }

  console.log('');
  console.log('Next:');
  console.log(`  kdna dev validate ${outDir}`);
}

function loadCards(project, projectDir, cardType) {
  const cardFile = project.cards?.[cardType];
  if (!cardFile) return { locked: [], unlocked: [] };

  const cardPath = path.join(projectDir, cardFile);
  if (!fs.existsSync(cardPath)) return { locked: [], unlocked: [] };

  const cards = readJson(cardPath) || [];
  return {
    locked: cards.filter((c) => c.locked === true),
    unlocked: cards.filter((c) => c.locked !== true),
  };
}

// ─── Studio Readiness ─────────────────────────────────────────────────

function cmdStudioReadiness(projectPath, args = []) {
  const jsonMode = args.includes('--json');
  const abs = path.resolve(projectPath);

  if (!fs.existsSync(abs)) error(`Project file not found: ${abs}`, EXIT.INPUT_ERROR);
  const project = readJson(abs);
  if (!project || !project.kdna_studio)
    error(`Not a KDNA Studio project: ${abs}`, EXIT.INPUT_ERROR);

  const readiness = {
    axioms: loadCardStats(project, path.dirname(abs), 'axioms'),
    ontology: loadCardStats(project, path.dirname(abs), 'ontology'),
    misunderstandings: loadCardStats(project, path.dirname(abs), 'misunderstandings'),
    boundaries: loadCardStats(project, path.dirname(abs), 'boundaries'),
    self_checks: loadCardStats(project, path.dirname(abs), 'self_checks'),
    test_cases: 0,
    human_pass: '0/0',
    export_ready: false,
  };

  // Determine Studio export readiness.
  const allTypes = Object.values(readiness).filter(
    (v) => v && typeof v === 'object' && 'total' in v,
  );
  let allLocked = allTypes.every((t) => t.total > 0 && t.total === t.locked);
  if (allTypes.length === 0) allLocked = false;
  readiness.export_ready = allLocked;

  if (jsonMode) {
    console.log(JSON.stringify(readiness, null, 2));
    process.exit(readiness.export_ready ? EXIT.OK : EXIT.HUMAN_LOCK_REQUIRED);
  }

  console.log(`Domain Readiness: ${project.name}`);
  console.log('');
  for (const [type, stats] of Object.entries(readiness)) {
    if (!stats || typeof stats !== 'object' || !('total' in stats)) {
      console.log(`  ${type}: ${stats}`);
      continue;
    }
    const marker = stats.total > 0 && stats.total === stats.locked ? '✓' : '○';
    console.log(`  ${marker} ${type}: ${stats.locked}/${stats.total} locked`);
  }

  console.log('');
  console.log(`  Export ready: ${readiness.export_ready ? '✓ yes' : '✗ no'}`);
  process.exit(readiness.export_ready ? EXIT.OK : EXIT.HUMAN_LOCK_REQUIRED);
}

function loadCardStats(project, projectDir, cardType) {
  const result = loadCards(project, projectDir, cardType);
  return {
    total: result.locked.length + result.unlocked.length,
    locked: result.locked.length,
  };
}

module.exports = {
  cmdStudioScaffold,
  cmdCardsValidate,
  cmdLockVerify,
  cmdStudioCompile,
  cmdStudioReadiness,
};
