/**
 * kdna verify <name|file.kdna> — Quality signal across three layers.
 *
 *   --structure   files exist, schema OK
 *   --trust       asset digest + Ed25519 signature against scope trust key
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
const { RegistryResolver, parseName, registryTrustIssues, isEntryRevoked } = require('./registry');
const { EXIT, isYesNoSelfCheck } = require('./cmds/_common');
const { licenseDecryptOptionsForManifest } = require('./cmds/license');
const { validateAuthoringProvenance } = require('./publish');

const {
  getInstalled,
  listContainerEntries,
  readContainerEntry,
  readContainerJson,
  readContainerDataMap,
  resolveAsset,
  verifyAsset,
} = require('./package-store');

function validateManifestFn(manifest) {
  const errors = [];
  const warnings = [];
  const required = [
    'kdna_version',
    'name',
    'version',
    'judgment_version',
    'description',
    'author',
    'license',
    'status',
    'quality_badge',
    'access',
    'languages',
    'default_language',
  ];

  if (manifest.kdna_spec) errors.push('kdna.json: kdna_spec is not allowed. Use kdna_version.');
  if (manifest.language)
    errors.push('kdna.json: language is not allowed. Use default_language and languages.');
  for (const field of required) {
    if (!(field in manifest) || manifest[field] === undefined || manifest[field] === '') {
      errors.push(`kdna.json: missing required field "${field}"`);
    }
  }
  if (manifest.format && manifest.format !== 'kdna') {
    errors.push(`kdna.json.format: invalid value "${manifest.format}". Expected "kdna".`);
  }
  if (!manifest.kdna_version) {
    errors.push('kdna.json: missing required field "kdna_version"');
  } else if (manifest.kdna_version !== '1.0') {
    errors.push(
      `kdna.json.kdna_version: invalid value "${manifest.kdna_version}". Expected "1.0".`,
    );
  }
  return { errors, warnings };
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function directoryView(root) {
  return {
    kind: 'directory',
    exists(name) {
      return fs.existsSync(path.join(root, name));
    },
    readJson(name) {
      return readJson(path.join(root, name));
    },
    readText(name) {
      try {
        return fs.readFileSync(path.join(root, name), 'utf8');
      } catch {
        return '';
      }
    },
    listDirFiles(dirName) {
      const dir = path.join(root, dirName);
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
      return fs.readdirSync(dir);
    },
  };
}

function assetView(kdnaPath, options = {}) {
  const entries = new Set(listContainerEntries(kdnaPath));
  let dataMap = null;
  const _ensureDataMap = () => {
    if (!dataMap) dataMap = readContainerDataMap(kdnaPath, options);
    return dataMap;
  };
  const allEntries = new Set(entries);
  allEntries.add('KDNA_Core.json');
  allEntries.add('KDNA_Patterns.json');
  return {
    kind: 'asset',
    path: kdnaPath,
    exists(name) {
      return allEntries.has(name) || entries.has(name);
    },
    readJson(name) {
      if (entries.has(name)) return readContainerJson(kdnaPath, name, options);
      return _ensureDataMap()[name] || null;
    },
    readText(name) {
      if (entries.has(name)) return readContainerEntry(kdnaPath, name).toString('utf8');
      const dm = _ensureDataMap();
      return dm[name] ? JSON.stringify(dm[name]) : '';
    },
    listDirFiles(dirName) {
      const prefix = dirName.replace(/\/+$/, '') + '/';
      return [...entries]
        .filter((e) => e.startsWith(prefix))
        .map((e) => {
          const r = e.slice(prefix.length);
          return r.includes('/') ? null : r;
        })
        .filter(Boolean);
    },
  };
}
function asView(input, options = {}) {
  if (input && typeof input.exists === 'function') return input;
  return directoryView(input, options);
}

function readJsonFromView(view, entryName, issues = null) {
  try {
    return view.readJson(entryName);
  } catch (e) {
    if (issues) issues.push({ severity: 'error', msg: `${entryName}: ${e.message}` });
    return null;
  }
}

// ─── Structure layer ───────────────────────────────────────────────────

function checkStructure(input, options = {}) {
  const view = asView(input);
  const issues = [];
  const passed = [];
  if (options.licenseError) {
    issues.push({
      severity: 'error',
      msg: `license required to verify encrypted entries: ${options.licenseError}`,
    });
  }

  const required = ['KDNA_Core.json', 'KDNA_Patterns.json', 'kdna.json'];
  const optional = [
    'KDNA_Scenarios.json',
    'KDNA_Cases.json',
    'KDNA_Reasoning.json',
    'KDNA_Evolution.json',
  ];

  for (const f of required) {
    if (!view.exists(f)) {
      issues.push({ severity: 'error', msg: `required file missing: ${f}` });
    } else {
      passed.push(`has ${f}`);
    }
  }

  // Validate kdna.json against canonical manifest schema
  if (validateManifestFn) {
    const manifest = readJsonFromView(view, 'kdna.json', issues);
    if (manifest) {
      const mResult = validateManifestFn(manifest);
      for (const e of mResult.errors) issues.push({ severity: 'error', msg: e });
      for (const w of mResult.warnings) issues.push({ severity: 'warn', msg: w });
      if (mResult.errors.length === 0)
        passed.push('kdna.json conforms to KDNA Core manifest schema');
    }
  }

  for (const f of optional) {
    if (view.exists(f)) passed.push(`has ${f}`);
  }

  // Schema check using kdna-core if available
  try {
    const core = options.licenseError ? null : readJsonFromView(view, 'KDNA_Core.json', issues);
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
    const pat = options.licenseError ? null : readJsonFromView(view, 'KDNA_Patterns.json', issues);
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

function checkTrust(input, scope, entry, options = {}) {
  const view = asView(input);
  const issues = [];
  const passed = [];

  const manifest = readJsonFromView(view, 'kdna.json', issues);
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
  }

  if (options.assetPath) {
    const verification = verifyAsset(options.assetPath, { requireSignature: true });
    for (const warning of verification.warnings || []) {
      if (!/signature missing/.test(warning)) issues.push({ severity: 'warn', msg: warning });
    }
    for (const err of verification.errors || []) {
      if (/signature|author\.|public_key|pubkey|fingerprint|Ed25519/i.test(err)) {
        issues.push({ severity: 'error', msg: err });
      }
    }
    if (verification.signature_valid === true) {
      passed.push('Ed25519 signature VALID over canonical payload');
    } else if (manifest.signature) {
      issues.push({
        severity: 'error',
        msg: 'Ed25519 signature INVALID or unavailable',
      });
    }
  }

  // 4. asset digest vs registry (if entry provided)
  const registry = options.registry || null;
  const registryIssues = registry ? registryTrustIssues(registry) : [];
  for (const issue of registryIssues) {
    issues.push({ severity: 'error', msg: issue });
  }

  const revocation = registry && entry ? isEntryRevoked(registry, entry) : null;
  if (revocation) {
    issues.push({
      severity: 'error',
      msg: `registry revokes this asset${revocation.reason ? `: ${revocation.reason}` : ''}`,
    });
  }

  const registryDigest = entry?.asset_digest || null;
  if (registryDigest) {
    passed.push(`registry asset_digest declared: ${registryDigest.slice(0, 23)}…`);
    if (options.assetDigest && options.assetDigest !== registryDigest) {
      issues.push({
        severity: 'error',
        msg: `asset digest mismatch: registry ${registryDigest}, local ${options.assetDigest}`,
      });
    } else if (options.assetDigest) {
      passed.push('local asset_digest matches registry');
    }
  } else if (entry) {
    issues.push({ severity: 'error', msg: 'registry asset_digest missing' });
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

function checkJudgment(input, options = {}) {
  const view = asView(input);
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

  if (options.licenseError) {
    issues.push({
      severity: 'error',
      msg: `license required to verify encrypted judgment: ${options.licenseError}`,
    });
  }

  const core = options.licenseError ? null : readJsonFromView(view, 'KDNA_Core.json', issues);
  const pat = options.licenseError ? null : readJsonFromView(view, 'KDNA_Patterns.json', issues);
  const manifest = readJsonFromView(view, 'kdna.json', issues);

  // 1. Boundary declaration in README (REQUIRED)
  //    Either classic "## Scope" + "## Out of Scope" pair,
  //    OR v2.1 "Four Questions" section (#2 = applies, #4 = does not).
  let readme = '';
  try {
    readme = view.readText('README.md');
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
    const yn = pat.self_check.filter((q) => isYesNoSelfCheck(q)).length;
    bump(total, yn, `self_check yes/no questions (${yn}/${total})`);
    if (total < 3)
      issues.push({ severity: 'warn', msg: `only ${total} self_check entries (recommend ≥3)` });
  }

  // 5. eval cases present (REQUIRED: ≥4 cases)
  const evalFiles = view.listDirFiles('evals').filter((f) => f.endsWith('.json'));
  if (evalFiles.length) {
    const files = evalFiles;
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

  // 7. Authoring provenance gate for reviewed quality claims.
  const badgeRank = {
    untested: 0,
    tested: 1,
    validated: 2,
    expert_reviewed: 3,
    production_ready: 4,
  };
  const badge = manifest?.quality_badge || 'untested';
  const highTrust = (badgeRank[badge] || 0) >= badgeRank.tested;
  if (highTrust) {
    const provenanceIssues = validateAuthoringProvenance(manifest || {});
    score.max += 1;
    if (provenanceIssues.length) {
      issues.push({
        severity: 'error',
        msg: `quality_badge ${badge} authoring provenance gate failed: ${provenanceIssues.join('; ')}`,
      });
    } else {
      score.total += 1;
      passed.push('✓ authoring provenance satisfies reviewed quality gate');
    }
  } else if (!manifest?.authoring) {
    issues.push({
      severity: 'warn',
      msg: 'authoring provenance missing; asset cannot be promoted above untested',
    });
  } else if (manifest.authoring.created_by === 'manual-dev-source') {
    passed.push('authoring provenance: manual-dev-source (untested ceiling)');
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

function checkI18n(input) {
  const view = asView(input);
  const issues = [];
  const passed = [];
  const manifest = readJsonFromView(view, 'kdna.json', issues) || {};
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

    // L1: card + readme
    if (['L1', 'L2', 'L3', 'L4'].includes(i18nLevel)) {
      if (!view.exists(`locales/${lang}/KDNA_CARD.json`)) {
        issues.push({ severity: 'error', msg: `i18n: ${lang} KDNA_CARD.json missing` });
      } else {
        const card = readJsonFromView(view, `locales/${lang}/KDNA_CARD.json`, issues);
        if (card) {
          passed.push(`locales/${lang}/KDNA_CARD.json OK`);
          if (!card.display_name)
            issues.push({ severity: 'warn', msg: `i18n: ${lang} card missing display_name` });
          if (!card.intended_use?.length)
            issues.push({ severity: 'warn', msg: `i18n: ${lang} card missing intended_use` });
        }
      }
      if (!view.exists(`locales/${lang}/README.md`)) {
        issues.push({ severity: 'warn', msg: `i18n: ${lang} README.md missing` });
      } else {
        passed.push(`locales/${lang}/README.md OK`);
      }
    }

    // L2: overlay files
    if (['L2', 'L3', 'L4'].includes(i18nLevel)) {
      const coreOverlay = `locales/${lang}/KDNA_Core.overlay.json`;
      if (!view.exists(coreOverlay)) {
        issues.push({ severity: 'error', msg: `i18n: ${lang} KDNA_Core.overlay.json missing` });
      } else {
        const overlay = readJsonFromView(view, coreOverlay, issues);
        if (overlay?.translations) {
          const core = readJsonFromView(view, 'KDNA_Core.json', issues);
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
      if (!view.exists(`locales/${lang}/KDNA_Patterns.overlay.json`)) {
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

// ─── Governance layer ───────────────────────────────────────────────

function checkGovernance(input) {
  const view = asView(input);
  const issues = [];
  const passed = [];
  const card = readJsonFromView(view, 'KDNA_CARD.json', issues) || {};

  if (!card || !view.exists('KDNA_CARD.json')) {
    issues.push({ severity: 'error', msg: 'governance: KDNA_CARD.json missing — required' });
    return { layer: 'governance', passed: false, issues, results: issues.map((i) => i.msg) };
  }
  passed.push('KDNA_CARD.json present');

  if (!card.risk_level) {
    issues.push({ severity: 'error', msg: 'governance: risk_level not declared (R0/R1/R2/R3)' });
  } else if (!['R0', 'R1', 'R2', 'R3'].includes(card.risk_level)) {
    issues.push({ severity: 'error', msg: `governance: invalid risk_level "${card.risk_level}"` });
  } else {
    passed.push(`risk_level: ${card.risk_level}`);
  }

  if (!card.intended_use?.length) {
    issues.push({ severity: 'error', msg: 'governance: intended_use empty' });
  } else {
    passed.push(`intended_use: ${card.intended_use.length} entries`);
  }

  if (!card.out_of_scope?.length) {
    issues.push({ severity: 'error', msg: 'governance: out_of_scope empty' });
  } else {
    passed.push(`out_of_scope: ${card.out_of_scope.length} entries`);
  }

  if (!card.known_limitations?.length) {
    issues.push({ severity: 'warn', msg: 'governance: known_limitations empty' });
  } else {
    passed.push(`known_limitations: ${card.known_limitations.length} entries`);
  }

  if (['R1', 'R2', 'R3'].includes(card.risk_level) && !card.author_responsibility) {
    issues.push({
      severity: 'warn',
      msg: `governance: risk ${card.risk_level} should declare author_responsibility`,
    });
  }

  if (['R2', 'R3'].includes(card.risk_level)) {
    if (!card.reviewed_by && !card.requires_expert_review) {
      issues.push({
        severity: 'error',
        msg: `governance: risk ${card.risk_level} requires expert_review`,
      });
    }
    if (!card.risk_warnings?.length) {
      issues.push({
        severity: 'error',
        msg: `governance: risk ${card.risk_level} requires risk_warnings`,
      });
    }
  }

  if (!card.human_lock_summary)
    issues.push({ severity: 'warn', msg: 'governance: human_lock_summary missing' });
  else passed.push('human_lock_summary present');

  if (!card.provenance) issues.push({ severity: 'warn', msg: 'governance: provenance missing' });
  else passed.push('provenance present');

  if (!card.quality_badge)
    issues.push({ severity: 'warn', msg: 'governance: quality_badge missing' });
  else passed.push(`quality_badge: ${card.quality_badge}`);

  return {
    layer: 'governance',
    passed: issues.filter((i) => i.severity === 'error').length === 0,
    issues,
    results: passed.concat(issues.map((i) => i.msg)),
    score: { total: passed.length, max: passed.length + issues.length },
  };
}

// ─── Main ──────────────────────────────────────────────────────────────

function cmdVerify(input, args = []) {
  const jsonMode = args.includes('--json');
  const trustReport = args.includes('--trust-report');

  // --trust-report: standalone mode — output full trust report and exit
  if (trustReport) {
    const parsed = parseName(input);
    if (!parsed) {
      console.log(JSON.stringify({ ok: false, error: `Invalid name: ${input}` }));
      process.exit(EXIT.INPUT_ERROR);
    }
    const installed = getInstalled(parsed.full);
    if (!installed) {
      console.log(JSON.stringify({ ok: false, error: `Domain not installed: ${input}` }));
      process.exit(EXIT.INPUT_ERROR);
    }
    const { checkTrust: agentCheckTrust } = require('./agent');
    const trust = agentCheckTrust(parsed.full);
    console.log(
      JSON.stringify(
        {
          domain: parsed.full,
          passed: trust.passed,
          failures: trust.failures,
          warnings: trust.warnings,
          risk_level: trust.riskLevel,
          kdna_version: trust.kdnaVersion,
          signature_valid: trust.signatureValid,
        },
        null,
        2,
      ),
    );
    process.exit(trust.passed ? 0 : EXIT.TRUST_FAILED);
  }

  const want = {
    structure: args.includes('--structure'),
    trust: args.includes('--trust'),
    judgment: args.includes('--judgment'),
    i18n: args.includes('--i18n'),
    governance: args.includes('--governance'),
  };
  const all = !want.structure && !want.trust && !want.judgment && !want.i18n && !want.governance;
  if (all) want.structure = want.trust = want.judgment = true;

  // Resolve installed name or direct local .kdna asset path.
  const asset = resolveAsset(input);
  const parsed = asset?.parsed || parseName(asset?.name || '');
  const displayName = parsed?.full || asset?.name || input;
  if (!asset) {
    if (jsonMode) {
      console.log(
        JSON.stringify({
          name: input,
          ok: false,
          error: `KDNA asset not found: ${input}. Use an installed name or a .kdna file.`,
        }),
      );
    } else {
      console.error(`KDNA asset not found: ${input}. Use an installed name or a .kdna file.`);
    }
    process.exit(EXIT.INPUT_ERROR);
  }

  let scope = null,
    entry = null,
    registry = null;
  if (want.trust) {
    try {
      const resolver = new RegistryResolver({ allowNetwork: false });
      if (parsed) {
        const r = resolver.resolve(parsed.full);
        scope = r.scope;
        entry = r.entry;
        registry = r.registry;
      }
    } catch (e) {
      if (!jsonMode) console.warn(`  ⚠ registry lookup failed: ${e.message.split('\n')[0]}`);
    }
  }

  let decryptOptions = {};
  let licenseError = null;
  let manifest = null;
  try {
    manifest = readContainerJson(asset.asset_path, 'kdna.json') || {};
  } catch (e) {
    licenseError = e.message;
  }

  const encryptedEntries = Array.isArray(manifest?.encryption?.encrypted_entries)
    ? manifest.encryption.encrypted_entries
    : [];
  const requiresProtectedRead =
    encryptedEntries.length > 0 &&
    (want.structure || want.judgment || want.i18n || want.governance);
  if (requiresProtectedRead) {
    const licensed = licenseDecryptOptionsForManifest(manifest);
    if (licensed.ok) {
      decryptOptions = { decryptEntry: licensed.decryptEntry };
    } else {
      licenseError = licensed.error;
    }
  }

  const view = assetView(asset.asset_path, decryptOptions);
  const results = [];
  if (want.structure) results.push(checkStructure(view, { licenseError }));
  if (want.trust) {
    results.push(
      checkTrust(view, scope, entry, {
        registry,
        assetDigest: asset.asset_digest || null,
        assetPath: asset.asset_path,
      }),
    );
  }
  if (want.judgment) results.push(checkJudgment(view, { licenseError }));
  if (want.i18n) results.push(checkI18n(view, { licenseError }));
  if (want.governance) results.push(checkGovernance(view, { licenseError }));

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
          name: displayName,
          path: asset.asset_path,
          asset_digest: asset.asset_digest || null,
          content_digest: asset.content_digest || null,
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
  console.log(`  Verify ${displayName}`);
  console.log(`  Asset: ${asset.asset_path}`);
  if (asset.asset_digest) console.log(`  Asset digest: ${asset.asset_digest}`);
  if (asset.content_digest) console.log(`  Content digest: ${asset.content_digest}`);
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
