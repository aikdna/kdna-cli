/**
 * kdna verify <name> — Quality signal across three layers.
 *
 *   --structure   files exist, schema OK
 *   --trust       sha256 + Ed25519 signature against scope trust key
 *   --judgment    v2.1 governance fields (boundary, applies_when, eval cases)
 *
 * No flag = run all three.
 *
 * Exit codes (semantic, from cmds/_common.js):
 *   0  all checks passed (warnings allowed)
 *   1  VALIDATION_FAILED — structure layer failed
 *   2  INPUT_ERROR — invalid name or not installed
 *   3  TRUST_FAILED — trust layer failed
 *   4  JUDGMENT_QUALITY_FAILED — judgment layer failed
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { RegistryResolver, parseName } = require('./registry');
const { EXIT } = require('./cmds/_common');

const USER_KDNA_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.kdna');
const INSTALL_DIR = path.join(USER_KDNA_DIR, 'domains');

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

// ─── Structure layer ───────────────────────────────────────────────────

function checkStructure(destDir) {
  const issues = [];
  const passed = [];

  const required = ['KDNA_Core.json', 'KDNA_Patterns.json', 'kdna.json'];
  const optional = [
    'KDNA_Scenarios.json',
    'KDNA_Cases.json',
    'KDNA_Reasoning.json',
    'KDNA_Evolution.json',
  ];

  for (const f of required) {
    if (!fs.existsSync(path.join(destDir, f))) {
      issues.push({ severity: 'error', msg: `required file missing: ${f}` });
    } else {
      passed.push(`has ${f}`);
    }
  }

  for (const f of optional) {
    if (fs.existsSync(path.join(destDir, f))) passed.push(`has ${f}`);
  }

  // Schema check using kdna-core if available
  try {
    const core = readJson(path.join(destDir, 'KDNA_Core.json'));
    if (core) {
      if (!core.axioms || !Array.isArray(core.axioms) || core.axioms.length === 0) {
        issues.push({ severity: 'error', msg: 'KDNA_Core.axioms missing or empty' });
      } else passed.push(`${core.axioms.length} axioms`);
      if (!core.ontology || !Array.isArray(core.ontology) || core.ontology.length === 0) {
        issues.push({ severity: 'warn', msg: 'KDNA_Core.ontology missing or empty' });
      }
      if (!core.stances || !Array.isArray(core.stances) || core.stances.length === 0) {
        issues.push({ severity: 'warn', msg: 'KDNA_Core.stances missing or empty' });
      }
    }
    const pat = readJson(path.join(destDir, 'KDNA_Patterns.json'));
    if (pat) {
      if (!pat.misunderstandings || pat.misunderstandings.length === 0) {
        issues.push({ severity: 'warn', msg: 'KDNA_Patterns.misunderstandings missing or empty' });
      } else passed.push(`${pat.misunderstandings.length} misunderstandings`);
      if (!pat.self_check || pat.self_check.length < 3) {
        issues.push({
          severity: 'warn',
          msg: `KDNA_Patterns.self_check has ${(pat.self_check || []).length} entries (recommend ≥3)`,
        });
      }
    }
  } catch (e) {
    issues.push({ severity: 'error', msg: `schema parse failed: ${e.message}` });
  }

  return { layer: 'structure', issues, passed };
}

// ─── Trust layer ───────────────────────────────────────────────────────

function checkTrust(destDir, scope, entry) {
  const issues = [];
  const passed = [];

  const manifest = readJson(path.join(destDir, 'kdna.json'));
  if (!manifest) {
    issues.push({ severity: 'error', msg: 'kdna.json missing — cannot verify trust' });
    return { layer: 'trust', issues, passed };
  }

  // 1. author.pubkey
  if (!manifest.author?.pubkey) {
    issues.push({ severity: 'error', msg: 'author.pubkey missing in kdna.json' });
  } else {
    passed.push(`author.pubkey present`);
    if (scope?.trust_pubkey && manifest.author.pubkey !== scope.trust_pubkey) {
      issues.push({
        severity: 'error',
        msg: `author.pubkey does not match scope trust_pubkey`,
      });
    } else if (scope?.trust_pubkey) {
      passed.push('author.pubkey matches scope trust_pubkey');
    }
  }

  // 2. signature
  if (!manifest.signature) {
    issues.push({ severity: 'error', msg: 'signature missing in kdna.json' });
  } else {
    passed.push('signature present');
  }

  // 3. embedded PEM (v0.7.1+)
  if (!manifest.author?.public_key_pem) {
    issues.push({
      severity: 'warn',
      msg: 'author.public_key_pem missing (pre-v0.7.1 package — full Ed25519 verify unavailable)',
    });
  } else {
    passed.push('embedded public_key_pem present');

    // Recompute fingerprint
    const fp =
      'ed25519:' + crypto.createHash('sha256').update(manifest.author.public_key_pem).digest('hex');
    if (fp !== manifest.author.pubkey) {
      issues.push({
        severity: 'error',
        msg: 'embedded PEM does not match author.pubkey fingerprint',
      });
    } else {
      passed.push('PEM fingerprint matches author.pubkey');

      // Full Ed25519 verify
      try {
        const files = fs
          .readdirSync(destDir)
          .filter((f) => f.endsWith('.json'))
          .sort();
        const parts = [];
        for (const f of files) {
          const full = path.join(destDir, f);
          let buf;
          if (f === 'kdna.json') {
            const obj = JSON.parse(fs.readFileSync(full, 'utf8'));
            delete obj.signature;
            delete obj._source;
            buf = Buffer.from(JSON.stringify(obj));
          } else {
            buf = fs.readFileSync(full);
          }
          const hash = crypto.createHash('sha256').update(buf).digest('hex');
          parts.push(`${f}:${hash}`);
        }
        const payload = parts.join('\n');
        const sigHex = manifest.signature.replace(/^ed25519:/, '');
        const publicKey = crypto.createPublicKey(manifest.author.public_key_pem);
        const ok = crypto.verify(null, Buffer.from(payload), publicKey, Buffer.from(sigHex, 'hex'));
        if (ok) passed.push('Ed25519 signature VALID over canonical payload');
        else
          issues.push({
            severity: 'error',
            msg: 'Ed25519 signature INVALID — package may be tampered',
          });
      } catch (e) {
        issues.push({ severity: 'error', msg: `signature verify failed: ${e.message}` });
      }
    }
  }

  // 4. sha256 vs registry (if entry provided)
  if (entry?.sha256) {
    passed.push(`registry sha256 declared: ${entry.sha256.slice(0, 16)}…`);
  }

  // 5. scope governance
  if (scope) {
    passed.push(`scope type: ${scope.type}`);
    if (scope.type === 'private' && !scope.registry_url) {
      issues.push({ severity: 'error', msg: 'private scope missing registry_url' });
    }
  }

  return { layer: 'trust', issues, passed };
}

// ─── Judgment layer ────────────────────────────────────────────────────

function checkJudgment(destDir) {
  const issues = [];
  const passed = [];
  const score = { total: 0, max: 0 };

  function bump(max, gain, label) {
    score.max += max;
    score.total += gain;
    if (gain === max) passed.push(`✓ ${label}`);
    else if (gain > 0) issues.push({ severity: 'warn', msg: `partial: ${label} (${gain}/${max})` });
    else issues.push({ severity: 'warn', msg: `missing: ${label}` });
  }

  const core = readJson(path.join(destDir, 'KDNA_Core.json'));
  const pat = readJson(path.join(destDir, 'KDNA_Patterns.json'));
  const manifest = readJson(path.join(destDir, 'kdna.json'));

  // 1. Boundary declaration in README (REQUIRED)
  //    Either classic "## Scope" + "## Out of Scope" pair,
  //    OR v2.1 "Four Questions" section (#2 = applies, #4 = does not).
  const readmePath = path.join(destDir, 'README.md');
  let readme = '';
  try {
    readme = fs.readFileSync(readmePath, 'utf8');
  } catch {
    /* ok */
  }
  const hasScope = /^##\s+Scope\b/im.test(readme);
  const hasOutOfScope = /^##\s+(Out of Scope|Out-of-Scope|Not for|Where this does)/im.test(readme);
  const hasFourQuestions =
    /(Four Questions|四个问题|四问)/i.test(readme) &&
    /(Where (does it|it) apply|适用|2\.\s+(Where|Applies))/i.test(readme) &&
    /(does(?:\s+it)?\s+NOT\s+apply|when it does not apply|何时不|when not to (use|load))/i.test(
      readme,
    );
  if ((hasScope && hasOutOfScope) || hasFourQuestions) {
    bump(2, 2, 'README declares boundary (Scope+Out-of-Scope, or v2.1 Four Questions)');
  } else if (hasScope || hasOutOfScope) {
    score.max += 2;
    score.total += 1;
    issues.push({
      severity: 'warn',
      msg: 'partial: README boundary declaration incomplete (missing Scope or Out-of-Scope section)',
    });
  } else {
    score.max += 2;
    issues.push({
      severity: 'error',
      msg: 'README missing boundary declaration: require ## Scope + ## Out of Scope (or v2.1 Four Questions)',
    });
  }

  // 2. v2.1 axiom governance fields
  if (core?.axioms) {
    const axioms = core.axioms;
    const withApplies = axioms.filter(
      (a) => Array.isArray(a.applies_when) && a.applies_when.length,
    ).length;
    const withDoesNotApply = axioms.filter(
      (a) => Array.isArray(a.does_not_apply_when) && a.does_not_apply_when.length,
    ).length;
    const withFailureRisk = axioms.filter((a) => a.failure_risk).length;
    const withConfidence = axioms.filter((a) => a.confidence).length;
    const withEvidence = axioms.filter(
      (a) => Array.isArray(a.evidence_type) && a.evidence_type.length,
    ).length;

    bump(axioms.length, withApplies, `axioms with applies_when (${withApplies}/${axioms.length})`);
    bump(
      axioms.length,
      withDoesNotApply,
      `axioms with does_not_apply_when (${withDoesNotApply}/${axioms.length})`,
    );
    bump(
      axioms.length,
      withFailureRisk,
      `axioms with failure_risk (${withFailureRisk}/${axioms.length})`,
    );
    bump(
      axioms.length,
      withConfidence,
      `axioms with confidence (${withConfidence}/${axioms.length})`,
    );
    bump(
      axioms.length,
      withEvidence,
      `axioms with evidence_type (${withEvidence}/${axioms.length})`,
    );
  }

  // 3. v2.1 misunderstanding governance fields
  if (pat?.misunderstandings) {
    const ms = pat.misunderstandings;
    const withApplies = ms.filter(
      (m) => Array.isArray(m.applies_when) && m.applies_when.length,
    ).length;
    const withFailureRisk = ms.filter((m) => m.failure_risk).length;
    bump(
      ms.length,
      withApplies,
      `misunderstandings with applies_when (${withApplies}/${ms.length})`,
    );
    bump(
      ms.length,
      withFailureRisk,
      `misunderstandings with failure_risk (${withFailureRisk}/${ms.length})`,
    );
  }

  // 4. self_check format: yes/no questions
  if (pat?.self_check) {
    const total = pat.self_check.length;
    const yn = pat.self_check.filter((q) => typeof q === 'string' && q.trim().endsWith('?')).length;
    bump(total, yn, `self_check questions ending in "?" (${yn}/${total})`);
    if (total < 3)
      issues.push({ severity: 'warn', msg: `only ${total} self_check entries (recommend ≥3)` });
  }

  // 5. eval cases present (REQUIRED: ≥4 cases)
  const evalDir = path.join(destDir, 'evals');
  if (fs.existsSync(evalDir)) {
    const files = fs.readdirSync(evalDir).filter((f) => f.endsWith('.json'));
    if (files.length >= 4) {
      bump(2, 2, `evals/ directory has ${files.length} case files`);
    } else if (files.length > 0) {
      score.max += 2;
      score.total += 1;
      issues.push({
        severity: 'warn',
        msg: `evals/ has only ${files.length} files (require ≥4: core/boundary/failure/excluded)`,
      });
    } else {
      score.max += 2;
      issues.push({ severity: 'error', msg: 'evals/ directory exists but contains no case files' });
    }
  } else {
    score.max += 2;
    issues.push({
      severity: 'error',
      msg: 'evals/ directory missing: require ≥4 evaluation cases',
    });
  }

  // 6. judgment_version manifest field (REQUIRED)
  if (manifest?.judgment_version) {
    bump(1, 1, `judgment_version: ${manifest.judgment_version}`);
  } else {
    score.max += 1;
    issues.push({ severity: 'error', msg: 'kdna.json missing required field: judgment_version' });
  }

  return { layer: 'judgment', issues, passed, score };
}

// ─── Render ────────────────────────────────────────────────────────────

function renderLayer(result) {
  const errors = result.issues.filter((i) => i.severity === 'error').length;
  const warns = result.issues.filter((i) => i.severity === 'warn').length;
  const passCount = result.passed.length;

  console.log('');
  console.log('─'.repeat(64));
  let header = `  ${result.layer.toUpperCase().padEnd(10)}  passed:${passCount}  warn:${warns}  errors:${errors}`;
  if (result.score) {
    const pct =
      result.score.max > 0 ? Math.round((result.score.total / result.score.max) * 100) : 0;
    header += `  score:${result.score.total}/${result.score.max} (${pct}%)`;
  }
  console.log(header);
  console.log('─'.repeat(64));

  for (const p of result.passed) console.log(`  ✓ ${p}`);
  for (const i of result.issues) {
    const mark = i.severity === 'error' ? '✗' : '⚠';
    console.log(`  ${mark} ${i.msg}`);
  }
}

// ─── I18N layer ──────────────────────────────────────────────────────

function checkI18n(destDir) {
  const issues = [];
  const passed = [];
  const manifest = readJson(path.join(destDir, 'kdna.json')) || {};
  const languages = manifest.languages || [];
  const i18nLevel = manifest.i18n_level || 'L0';

  if (languages.length === 0) {
    passed.push('i18n: no languages declared (L0 — monolingual)');
    return { layer: 'i18n', passed: true, issues, results: passed };
  }

  passed.push(`languages declared: ${languages.join(', ')}`);
  passed.push(`i18n level: ${i18nLevel}`);

  const canonical = manifest.default_language || languages[0] || 'en';
  for (const lang of languages) {
    if (lang === canonical) continue;
    const localeDir = path.join(destDir, 'locales', lang);

    // L1: card + readme
    if (['L1', 'L2', 'L3', 'L4'].includes(i18nLevel)) {
      if (!fs.existsSync(path.join(localeDir, 'KDNA_CARD.json'))) {
        issues.push({ severity: 'error', msg: `i18n: ${lang} KDNA_CARD.json missing` });
      } else {
        const card = readJson(path.join(localeDir, 'KDNA_CARD.json'));
        if (card) {
          passed.push(`locales/${lang}/KDNA_CARD.json OK`);
          if (!card.display_name)
            issues.push({ severity: 'warn', msg: `i18n: ${lang} card missing display_name` });
          if (!card.intended_use?.length)
            issues.push({ severity: 'warn', msg: `i18n: ${lang} card missing intended_use` });
        }
      }
      if (!fs.existsSync(path.join(localeDir, 'README.md'))) {
        issues.push({ severity: 'warn', msg: `i18n: ${lang} README.md missing` });
      } else {
        passed.push(`locales/${lang}/README.md OK`);
      }
    }

    // L2: overlay files
    if (['L2', 'L3', 'L4'].includes(i18nLevel)) {
      const coreOverlay = path.join(localeDir, 'KDNA_Core.overlay.json');
      if (!fs.existsSync(coreOverlay)) {
        issues.push({ severity: 'error', msg: `i18n: ${lang} KDNA_Core.overlay.json missing` });
      } else {
        const overlay = readJson(coreOverlay);
        if (overlay?.translations) {
          const core = readJson(path.join(destDir, 'KDNA_Core.json'));
          if (core?.axioms) {
            const validIds = new Set(core.axioms.map((a) => a.id));
            for (const key of Object.keys(overlay.translations)) {
              const refId = key.split('.')[0];
              if (!validIds.has(refId)) {
                issues.push({
                  severity: 'error',
                  msg: `i18n: overlay refs unknown axiom: ${refId}`,
                });
              }
            }
          }
          passed.push(
            `locales/${lang}/KDNA_Core.overlay.json OK (${Object.keys(overlay.translations).length} translations)`,
          );
        }
      }
      if (!fs.existsSync(path.join(localeDir, 'KDNA_Patterns.overlay.json'))) {
        issues.push({ severity: 'warn', msg: `i18n: ${lang} KDNA_Patterns.overlay.json missing` });
      }
    }
  }

  if (manifest.languages?.length && !manifest.i18n_level) {
    issues.push({ severity: 'warn', msg: 'i18n: languages declared but i18n_level not set' });
  }

  return {
    layer: 'i18n',
    passed: issues.filter((i) => i.severity === 'error').length === 0,
    issues,
    results: passed.concat(issues.map((i) => i.msg)),
    score: { total: passed.length, max: passed.length + issues.length },
  };
}

// ─── Main ──────────────────────────────────────────────────────────────

function cmdVerify(input, args = []) {
  const jsonMode = args.includes('--json');

  const want = {
    structure: args.includes('--structure'),
    trust: args.includes('--trust'),
    judgment: args.includes('--judgment'),
    i18n: args.includes('--i18n'),
  };
  const all = !want.structure && !want.trust && !want.judgment && !want.i18n;
  if (all) want.structure = want.trust = want.judgment = true;

  // Resolve name → installed path + scope/entry
  const parsed = parseName(input);
  if (!parsed) {
    if (jsonMode) {
      console.log(
        JSON.stringify({
          name: input,
          ok: false,
          error: `Invalid name "${input}". Use @scope/name or bare name.`,
        }),
      );
    } else {
      console.error(`Invalid name "${input}". Use @scope/name or bare name.`);
    }
    process.exit(EXIT.INPUT_ERROR);
  }

  const destDir = path.join(INSTALL_DIR, parsed.scope, parsed.ident);
  if (!fs.existsSync(destDir)) {
    if (jsonMode) {
      console.log(
        JSON.stringify({
          name: parsed.full,
          ok: false,
          error: `${parsed.full} is not installed. Run: kdna install ${input}`,
        }),
      );
    } else {
      console.error(`${parsed.full} is not installed. Run: kdna install ${input}`);
    }
    process.exit(EXIT.INPUT_ERROR);
  }

  let scope = null,
    entry = null;
  if (want.trust) {
    try {
      const resolver = new RegistryResolver({ allowNetwork: false });
      const r = resolver.resolve(parsed.full);
      scope = r.scope;
      entry = r.entry;
    } catch (e) {
      if (!jsonMode) console.warn(`  ⚠ registry lookup failed: ${e.message.split('\n')[0]}`);
    }
  }

  const results = [];
  if (want.structure) results.push(checkStructure(destDir));
  if (want.trust) results.push(checkTrust(destDir, scope, entry));
  if (want.judgment) results.push(checkJudgment(destDir));
  if (want.i18n) results.push(checkI18n(destDir));

  // ── JSON output ──────────────────────────────────────────────────────
  if (jsonMode) {
    const layers = {};
    for (const r of results) {
      layers[r.layer] = {
        passed: r.passed,
        errors: r.issues.filter((i) => i.severity === 'error').map((i) => i.msg),
        warnings: r.issues.filter((i) => i.severity === 'warn').map((i) => i.msg),
      };
      if (r.score) layers[r.layer].score = r.score;
    }

    const structureResult = results.find((r) => r.layer === 'structure');
    const trustResult = results.find((r) => r.layer === 'trust');
    const judgmentResult = results.find((r) => r.layer === 'judgment');

    let exitCode = EXIT.OK;
    if (structureResult && structureResult.issues.some((i) => i.severity === 'error')) {
      exitCode = EXIT.VALIDATION_FAILED;
    } else if (trustResult && trustResult.issues.some((i) => i.severity === 'error')) {
      exitCode = EXIT.TRUST_FAILED;
    } else if (judgmentResult && judgmentResult.issues.some((i) => i.severity === 'error')) {
      exitCode = EXIT.JUDGMENT_QUALITY_FAILED;
    }

    console.log(
      JSON.stringify(
        {
          name: parsed.full,
          path: destDir,
          layers,
          ok: exitCode === EXIT.OK,
        },
        null,
        2,
      ),
    );
    process.exit(exitCode);
  }

  // ── Text output (default) ────────────────────────────────────────────
  console.log('═'.repeat(64));
  console.log(`  Verify ${parsed.full}`);
  console.log(`  Path:  ${destDir}`);
  console.log('═'.repeat(64));

  for (const r of results) renderLayer(r);

  const totalErrors = results.reduce(
    (sum, r) => sum + r.issues.filter((i) => i.severity === 'error').length,
    0,
  );

  console.log('');
  console.log('═'.repeat(64));
  if (totalErrors === 0) {
    console.log(
      `  ✓ All ${results.length} layer(s) passed (warnings are quality signals, not failures)`,
    );
  } else {
    console.log(`  ✗ ${totalErrors} hard failure(s)`);
  }
  console.log('═'.repeat(64));

  // Semantic exit codes for text mode
  const structureResult = results.find((r) => r.layer === 'structure');
  const trustResult = results.find((r) => r.layer === 'trust');
  const judgmentResult = results.find((r) => r.layer === 'judgment');

  let exitCode = EXIT.OK;
  if (structureResult && structureResult.issues.some((i) => i.severity === 'error')) {
    exitCode = EXIT.VALIDATION_FAILED;
  } else if (trustResult && trustResult.issues.some((i) => i.severity === 'error')) {
    exitCode = EXIT.TRUST_FAILED;
  } else if (judgmentResult && judgmentResult.issues.some((i) => i.severity === 'error')) {
    exitCode = EXIT.JUDGMENT_QUALITY_FAILED;
  }

  process.exit(exitCode);
}

module.exports = { cmdVerify, checkStructure, checkTrust, checkJudgment };
