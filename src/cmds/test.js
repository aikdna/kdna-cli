/**
 * KDNA Test commands — Phase 3: Test Lab / Evaluation.
 *
 *   kdna test run <domain> --input <file> [--json]
 *     Run a test case against a domain, recording results.
 *
 *   kdna test import <run-file> --as-eval --out <file>
 *     Convert a test run result into an eval card draft.
 */

const fs = require('fs');
const path = require('path');
const { error, readJson, writeJson, EXIT } = require('./_common');
const { parseName } = require('../registry');

const USER_KDNA_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.kdna');
const INSTALL_DIR = path.join(USER_KDNA_DIR, 'domains');
const RUNS_DIR = path.join(USER_KDNA_DIR, 'runs');

function cmdTestRun(args = []) {
  const jsonMode = args.includes('--json');
  const positional = args.filter((a) => !a.startsWith('--'));
  const domain = positional[1];
  const inputIdx = args.indexOf('--input');
  const inputFile = inputIdx >= 0 ? args[inputIdx + 1] : null;
  const saveIdx = args.indexOf('--save');
  const saveDir = saveIdx >= 0 ? args[saveIdx + 1] : null;

  if (!domain || !inputFile) {
    error(
      'Usage:\n' +
        '  kdna test run <domain> --input <test-file> [--save <dir>] [--json]\n' +
        '\n' +
        'Runs test input through LLM with/without KDNA and records the result.',
      EXIT.INPUT_ERROR,
    );
  }

  const parsed = parseName(domain);
  if (!parsed) error(`Invalid name "${domain}".`, EXIT.INPUT_ERROR);
  const destDir = path.join(INSTALL_DIR, parsed.scope, parsed.ident);
  if (!fs.existsSync(destDir)) {
    error(`${parsed.full} not installed. Run: kdna install ${domain}`, EXIT.INPUT_ERROR);
  }

  const absInput = path.resolve(inputFile);
  if (!fs.existsSync(absInput)) error(`Input file not found: ${absInput}`, EXIT.INPUT_ERROR);

  // Read test case
  let testCase;
  try {
    testCase = JSON.parse(fs.readFileSync(absInput, 'utf8'));
  } catch {
    error(`Invalid JSON in test file: ${absInput}`, EXIT.INPUT_ERROR);
  }

  // Validate test case structure
  const expectedClassification = testCase.expected?.classification;
  const expectedTriggeredAxioms = testCase.expected?.triggered_axioms;
  const expectedAvoidedMisunderstandings = testCase.expected?.avoided_misunderstandings;
  const expectedAvoidedBannedTerms = testCase.expected?.avoided_banned_terms;

  // Build test result
  const result = {
    test_id: testCase.id || `test_${Date.now()}`,
    domain: parsed.full,
    domain_path: destDir,
    input: typeof testCase.input === 'string' ? testCase.input : JSON.stringify(testCase.input),
    run_at: new Date().toISOString(),
    expected: {
      classification: expectedClassification || null,
      triggered_axioms: expectedTriggeredAxioms || [],
      avoided_misunderstandings: expectedAvoidedMisunderstandings || [],
      avoided_banned_terms: expectedAvoidedBannedTerms || [],
    },
    results: {
      classification: null,
      triggered_axioms: [],
      avoided_misunderstandings: [],
      avoided_banned_terms: [],
      self_checks: [],
      risk_flags: [],
    },
    human_grade: null,
    human_notes: null,
  };

  /**
   * Note: Full LLM-based compare can be run separately via:
   *   kdna compare <domain> --input "<text>"
   * Test run records the structure for human grading.
   */

  // Save result
  if (saveDir) {
    const outDir = path.resolve(saveDir);
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, `run-${result.test_id}.json`);
    writeJson(outFile, result);
    if (!jsonMode) console.log(`Test result saved: ${outFile}`);
    result.saved_to = outFile;
  } else {
    const outDir = RUNS_DIR;
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, `run-${result.test_id}.json`);
    writeJson(outFile, result);
    if (!jsonMode) console.log(`Test result saved: ${outFile}`);
    result.saved_to = outFile;
  }

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
  }

  if (!jsonMode) {
    console.log(`Test run recorded: ${result.test_id}`);
    console.log(`  Domain:  ${result.domain}`);
    console.log(`  Input:   ${result.input.slice(0, 100)}${result.input.length > 100 ? '...' : ''}`);
    if (result.expected.classification) console.log(`  Expected classification: ${result.expected.classification}`);
  }
}

function cmdTestImport(args = []) {
  const positional = args.filter((a) => !a.startsWith('--'));
  const runFile = positional[1];
  const outIdx = args.indexOf('--out');
  const outFile = outIdx >= 0 ? args[outIdx + 1] : null;
  const asEval = args.includes('--as-eval');

  if (!runFile) {
    error('Usage: kdna test import <run-file> --as-eval --out <file>', EXIT.INPUT_ERROR);
  }

  const abs = path.resolve(runFile);
  if (!fs.existsSync(abs)) error(`Run file not found: ${abs}`, EXIT.INPUT_ERROR);

  const runData = readJson(abs);
  if (!runData || !runData.test_id) error(`Not a valid test run file: ${abs}`, EXIT.INPUT_ERROR);

  if (asEval) {
    // Convert run result into an eval card draft
    const evalCard = {
      id: `eval_${runData.test_id}`,
      type: 'eval_case',
      domain: runData.domain,
      input: runData.input,
      expected_classification: runData.expected?.classification || null,
      expected_triggered_axioms: runData.expected?.triggered_axioms || [],
      expected_avoided_misunderstandings: runData.expected?.avoided_misunderstandings || [],
      expected_avoided_banned_terms: runData.expected?.avoided_banned_terms || [],
      actual_classification: runData.results?.classification || null,
      actual_triggered_axioms: runData.results?.triggered_axioms || [],
      actual_avoided_misunderstandings: runData.results?.avoided_misunderstandings || [],
      actual_avoided_banned_terms: runData.results?.avoided_banned_terms || [],
      human_grade: runData.human_grade || null,
      human_notes: runData.human_notes || null,
      source_run: path.basename(abs),
      created: new Date().toISOString(),
    };

    const outPath = outFile
      ? path.resolve(outFile)
      : path.join(path.dirname(abs), `eval-${runData.test_id}.json`);

    writeJson(outPath, evalCard);
    console.log(`Eval card created: ${outPath}`);
    console.log(`  ID:     ${evalCard.id}`);
    console.log(`  Domain: ${evalCard.domain}`);
    if (evalCard.expected_classification) {
      console.log(`  Expected: ${evalCard.expected_classification}`);
    }
  } else {
    console.log(JSON.stringify(runData, null, 2));
  }
}

module.exports = { cmdTestRun, cmdTestImport };
