const { error, EXIT } = require('./_common');
const { parseName } = require('../registry');
const { getInstalled, readContainer } = require('../package-store');

function cmdExplain(args) {
  const target = args.filter((a) => !a.startsWith('--'))[1];
  if (!target) {
    error(
      'Usage: kdna explain <domain> [--locale zh-CN]\n\n' +
        '  Produces a natural language explanation of what a domain covers,\n' +
        '  its key axioms, applicable scenarios, and intended model types.',
      EXIT.INPUT_ERROR,
    );
  }

  const parsed = parseName(target);
  if (!parsed) {
    error(`Invalid domain name: ${target}`, EXIT.INPUT_ERROR);
  }

  const installed = getInstalled(parsed.full);
  if (!installed) {
    error(
      `${parsed.full} is not installed.\nRun: kdna install ${target}`,
      EXIT.INPUT_ERROR,
    );
  }

  const { core, patterns, scenarios } = readContainer(installed.asset_path);

  if (!core) {
    error(`Failed to load KDNA_Core.json from ${installed.asset_path}`, EXIT.VALIDATION_FAILED);
  }

  const m = core.meta || {};
  const purpose = m.purpose || '(not specified)';
  const domain = m.domain || parsed.ident;
  const version = m.version || 'unknown';
  const axioms = core.axioms || [];
  const bannedTerms = patterns?.terminology?.banned_terms || [];
  const selfChecks = patterns?.self_checks || patterns?.self_check || [];
  const standardTerms = patterns?.terminology?.standard_terms || [];
  const misunderstandings = patterns?.misunderstandings || [];

  console.log('');
  console.log(`╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║  KDNA Domain: ${domain.padEnd(46)}║`);
  console.log(`║  Package:     ${parsed.full.padEnd(46)}║`);
  console.log(`║  Version:     ${version.padEnd(46)}║`);
  console.log(`╚══════════════════════════════════════════════════════════════╝`);
  console.log('');

  console.log('── Purpose ──');
  console.log(`  ${purpose}`);
  console.log('');

  console.log(`── Axioms (${axioms.length} core principles) ──`);
  for (const ax of axioms) {
    console.log(`  • ${ax.one_sentence || ax.id}`);
    const applies = (ax.applies_when || []).join('; ');
    if (applies) console.log(`    Applies when: ${applies.slice(0, 120)}`);
    const notApply = (ax.does_not_apply_when || []).join('; ');
    if (notApply) console.log(`    NOT when:    ${notApply.slice(0, 120)}`);
    console.log('');
  }

  if (standardTerms.length) {
    console.log(`── Standard Terms (${standardTerms.length}) ──`);
    for (const t of standardTerms.slice(0, 8)) {
      const def = t.definition ? `: ${t.definition.slice(0, 80)}` : '';
      console.log(`  • ${t.term}${def}`);
    }
    console.log('');
  }

  if (misunderstandings.length) {
    console.log(`── Common Misunderstandings (${misunderstandings.length}) ──`);
    for (const mm of misunderstandings.slice(0, 5)) {
      console.log(`  ✗ "${mm.mistake || mm.id}"`);
    }
    console.log('');
  }

  if (bannedTerms.length) {
    console.log(`── Banned Terms (${bannedTerms.length} — do not use) ──`);
    for (const b of bannedTerms.slice(0, 6)) {
      const why = b.why ? ` → ${b.why.slice(0, 60)}` : '';
      console.log(`  ✗ "${b.term}"${why}`);
    }
    console.log('');
  }

  if (selfChecks.length) {
    console.log(`── Self-Checks (${selfChecks.length} — verify before responding) ──`);
    for (const sc of selfChecks.slice(0, 8)) {
      console.log(`  ✓ ${sc.question || sc.id || sc}`);
    }
    console.log('');
  }

  if (scenarios && scenarios.scenarios && scenarios.scenarios.length) {
    console.log(`── Scenarios (${scenarios.scenarios.length} — strategy shifts) ──`);
    for (const s of scenarios.scenarios.slice(0, 6)) {
      const desc = s.description ? s.description.slice(0, 80) : '';
      console.log(`  ▶ ${s.signal || s.id}: ${desc}`);
    }
    console.log('');
  }

  console.log('── Model Compatibility ──');
  console.log('  Works with any LLM/agent that loads context before reasoning.');
  console.log('  Tested: Claude, GPT, Gemini, Qwen, MiniMax');
  console.log('');

  console.log('── Quick Start ──');
  console.log(`  kdna verify ${target} --judgment`);
  console.log(`  kdna compare ${target} --input "<your task>"`);
  console.log(`  kdna trace --domain ${target.slice(0, 40)}`);
  console.log('');
}

module.exports = { cmdExplain };
