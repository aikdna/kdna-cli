'use strict';
/*
 * Friendly 0.6.0 authoring: a small human/Agent-friendly draft that compiles
 * into the full authored input `kdna create` accepts.
 *
 * Draft format (marker `kdna.draft/1`):
 *   {
 *     format: 'kdna.draft/1',
 *     asset: { id, title, summary, language, version },   // id is a slug, e.g. 'team-update'
 *     scope: 'one sentence: what this asset covers and what it does not',
 *     actors: [{ id, name, kind? }],        // kind defaults to 'person'
 *     highest_question: 'the question the whole asset answers',
 *     boundaries: 'asset-level limits' | null,
 *     judgments: [{
 *       id,                                 // e.g. 'update:order'
 *       focus,                              // short title of the judgment
 *       statement,                          // the authored conclusion
 *       applies_when,                       // judgment scope sentence
 *       boundaries?: string,                // judgment-level limits
 *       method?: 'feeling' | { term, roles: { '<role>': 'text' } }
 *                // default 'feeling' (role 个人感受 = statement note). Every
 *                // method term's required roles come from Core's role table
 *                // (getMethodRoleTable); a term without all roles is refused.
 *       answer_kind?: 'preference'          // default
 *     }],                                   // at least one
 *     timestamp?: ISO-8601 'Z' string       // created_at/updated_at; default: now
 *   }
 *
 * API: scaffoldDraft(), compileDraft(draft) -> {manifest,payload,members:[]},
 * validateInput(input) -> {status,diagnostics:[{field,code,message,hint}]}
 * (synchronous, draft or full input), validateWithCore(input) -> Promise of the
 * same shape, additionally asking Core itself and translating its rejection.
 * Core is never weakened: compileDraft only fills the empty collections and
 * ports Core's schema requires; Core remains the authority for acceptance.
 */
const { randomUUID } = require('node:crypto');

const FORMAT = 'kdna.draft/1';
const SLUG = /^[a-z0-9][a-z0-9._-]*$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const INIT_MODES = new Set(['minimal', 'interview', 'works', 'research']);
const ASSET_TYPES = new Set(['domain', 'cluster', 'tool', 'sample', 'fixture', 'bundle']);
const DUPLICATE_ROLE_FIX_HINT = 'Each role in method.components must appear at most once per judgment. Merge statements that share the same role in order into a single component so no authored reasoning is lost.';
const CATCH_ALL_SCOPES = new Set(['all', 'always', 'any', 'everything', 'general', 'universal', '通用', '所有', '所有场景', '任何', '任何场景', '全部', '不限']);

function roleTable() {
  try {
    const m = require('@aikdna/kdna-core/components');
    return typeof m.getMethodRoleTable === 'function' ? m.getMethodRoleTable() : null;
  } catch { return null; }
}

function inspectMethodComponents(judgment, table = roleTable()) {
  const term = judgment?.method?.method?.term;
  const roles = table && typeof term === 'string' ? table.roles?.[term] : null;
  if (!roles || !Array.isArray(judgment?.method?.components)) return null;
  const allowed = new Set([...roles.required, ...roles.optional]);
  const byRole = new Map();
  const invalidSet = new Set();
  judgment.method.components.forEach((component, idx) => {
    const r = component?.role;
    if (typeof r !== 'string') return;
    const cid = typeof component?.id === 'string' && component.id.trim() !== '' ? component.id : `#${idx}`;
    if (!byRole.has(r)) byRole.set(r, []);
    byRole.get(r).push(cid);
    if (!allowed.has(r)) invalidSet.add(r);
  });
  const duplicate_roles = [];
  for (const [role, component_ids] of byRole.entries()) {
    if (component_ids.length > 1) duplicate_roles.push({ role, component_ids });
  }
  const invalid_roles = [...invalidSet];
  const missing_required_roles = roles.required.filter(r => !byRole.has(r));
  return {
    term,
    expected: roles.required,
    optional: roles.optional,
    duplicate_roles,
    invalid_roles,
    missing_required_roles,
    ...(duplicate_roles.length ? { fix_hint: DUPLICATE_ROLE_FIX_HINT } : {}),
  };
}

function scaffoldDraft(mode = 'minimal') {
  if (!INIT_MODES.has(mode)) {
    throw Object.assign(new Error('KDNA_INVALID_INIT_MODE'), { code: 'KDNA_INVALID_INIT_MODE' });
  }
  if (mode === 'interview') {
    return {
      format: FORMAT,
      asset: { id: 'my-decision-system', type: 'domain', title: 'TODO: title of your judgment system', summary: 'TODO: one sentence on what recurring choices this system helps decide', language: 'en', version: '0.1.0' },
      scope: 'TODO: the specific work situations this system covers, and what stays outside it.',
      actors: [{ id: 'author', name: 'TODO: author name', kind: 'person' }],
      highest_question: 'TODO: the overarching question this judgment system answers',
      boundaries: 'TODO: asset-wide hard limits where these judgments must stop or yield',
      judgments: [{
        id: 'decision:first-dilemma',
        focus: 'TODO: the contested decision question when two goals collide',
        statement: 'TODO: your operational choice or priority in your own words (not a generic platitude)',
        applies_when: 'TODO: concrete conditions (who, what task, when) under which this choice applies',
        boundaries: 'TODO: exact case or threshold where this rule stops applying or flips',
        method: {
          term: 'tradeoff',
          roles: {
            '候选方案': 'TODO: the concrete options being weighed against each other',
            '比较因素': 'TODO: the factors compared under pressure',
            '取舍原则': 'TODO: which factor wins first and why',
            '不可兼得之处': 'TODO: what cost or downside you explicitly accept',
          },
        },
      }],
    };
  }
  if (mode === 'works') {
    return {
      format: FORMAT,
      asset: { id: 'my-distilled-works', type: 'domain', title: 'TODO: title of the distilled judgment work', summary: 'TODO: one sentence on the domain judgments distilled from authored materials', language: 'en', version: '0.1.0' },
      scope: 'TODO: the domain and audience covered by the source works, and what is excluded.',
      actors: [{ id: 'author', name: 'TODO: original author name', kind: 'person' }],
      highest_question: 'TODO: the central question answered across these works',
      boundaries: 'TODO: limits of the distilled work as a whole',
      judgments: [{
        id: 'work:first-criterion',
        focus: 'TODO: specific recurring question distilled from the author’s works',
        statement: 'TODO: the author’s explicit conclusion or standard',
        applies_when: 'TODO: concrete review or writing context where the author applies this standard',
        boundaries: 'TODO: explicit counter-condition or exception stated by the author',
        method: {
          term: 'criteria_comparison',
          roles: {
            '判断标准': 'TODO: the explicit criterion the author checks against',
            '对照办法': 'TODO: how a concrete work or draft is compared against that criterion',
            '归结办法': 'TODO: how passing vs failing that criterion settles the decision',
          },
        },
        reasons: ['TODO: authored rationale or concrete observation from the source work'],
        example: {
          summary: 'TODO: short title of a concrete example case',
          context: 'TODO: background situation of the case',
          input: 'TODO: specific draft or decision input examined',
          application: 'TODO: how this judgment was applied to that input',
          result: 'TODO: the resulting decision or revision disposition',
        },
      }],
    };
  }
  if (mode === 'research') {
    return {
      format: FORMAT,
      asset: { id: 'my-research-judgments', type: 'domain', title: 'TODO: title of the evidence-backed judgment work', summary: 'TODO: one sentence on the domain decisions grounded in compared materials', language: 'en', version: '0.1.0' },
      scope: 'TODO: exact domain, evidence horizon, and contexts outside scope.',
      actors: [{ id: 'author', name: 'TODO: decision owner adopting these positions', kind: 'person' }],
      highest_question: 'TODO: the core domain question evaluated from the research materials',
      boundaries: 'TODO: evidence limits, jurisdiction boundaries, or conditions requiring fresh verification',
      judgments: [{
        id: 'research:first-position',
        focus: 'TODO: contested technical or domain question with competing evidence',
        statement: 'TODO: the adopted position chosen after weighing the evidence',
        applies_when: 'TODO: specific operating conditions matching the supporting evidence',
        boundaries: 'TODO: counter-conditions or missing-evidence cases where this position does not hold',
        method: {
          term: 'evidence_analysis',
          roles: {
            '所用材料': 'TODO: the authorized evidence or standards examined',
            '材料与判断的联系': 'TODO: how those materials support the adopted position',
            '反向材料': 'TODO: competing or contrary evidence considered',
            '材料取舍': 'TODO: why the adopted position was chosen under the stated scope',
          },
        },
      }],
    };
  }
  return {
    format: FORMAT,
    asset: { id: 'my-first-judgment', title: 'TODO: a title for this asset', summary: 'TODO: one sentence on what this asset helps decide', language: 'en', version: '0.1.0' },
    scope: 'TODO: what this asset covers, and what it does not cover.',
    actors: [{ id: 'author', name: 'TODO: author or team name', kind: 'person' }],
    highest_question: 'TODO: the question this whole asset answers',
    boundaries: 'TODO: limits of the asset as a whole (or set to null)',
    judgments: [{
      id: 'main:first',
      focus: 'TODO: short title of the first judgment',
      statement: 'TODO: the conclusion you stand behind, in your own words',
      applies_when: 'TODO: the situation in which this judgment applies',
      boundaries: 'TODO: where this judgment stops applying (or remove this field)',
      method: 'feeling',
    }],
  };
}

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const isText = v => typeof v === 'string' && v.trim() !== '';
const todo = v => typeof v === 'string' && /^TODO\b/.test(v.trim());

function diag(field, code, message, hint) { return { field, code, message, hint }; }

function validateDraft(draft) {
  const out = [];
  const need = (field, v, what, example) => {
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
      out.push(diag(field, 'missing_field', `${field} is required but missing or empty.`, `Add ${what}${example ? `, e.g. ${example}` : ''}.`));
      return false;
    }
    if (todo(v)) out.push(diag(field, 'placeholder_not_replaced', `${field} still holds the scaffold TODO placeholder.`, `Replace it with ${what}.`));
    return true;
  };
  if (draft.format !== FORMAT) out.push(diag('format', 'bad_format', `format must be "${FORMAT}".`, `Set "format": "${FORMAT}".`));
  const a = draft.asset;
  if (!isObj(a)) out.push(diag('asset', 'missing_field', 'asset is required.', 'Add asset: {id,title,summary,language,version}.'));
  else {
    if (need('asset.id', a.id, 'a lowercase slug', '"team-update"') && typeof a.id === 'string' && !SLUG.test(a.id)) out.push(diag('asset.id', 'invalid_value', 'asset.id must be a lowercase slug (a-z, 0-9, . _ -).', 'Use e.g. "team-update".'));
    if (a.type !== undefined) {
      if (typeof a.type !== 'string' || !ASSET_TYPES.has(a.type)) out.push(diag('asset.type', 'invalid_value', `asset.type must be one of: ${[...ASSET_TYPES].join(', ')}.`, 'Use e.g. "domain" or "sample".'));
    }
    need('asset.title', a.title, 'a title');
    need('asset.summary', a.summary, 'a one-sentence summary');
    need('asset.language', a.language, 'a language tag', '"en"');
    if (need('asset.version', a.version, 'a semantic version', '"0.1.0"') && !/^\d+\.\d+\.\d+$/.test(a.version)) out.push(diag('asset.version', 'invalid_value', 'asset.version must be MAJOR.MINOR.PATCH.', 'Use e.g. "0.1.0".'));
    if (a.description !== undefined) {
      if (!isText(a.description)) out.push(diag('asset.description', 'invalid_value', 'asset.description must be a non-empty string.', 'Write a description or omit the field.'));
      else if (todo(a.description)) out.push(diag('asset.description', 'placeholder_not_replaced', 'asset.description still holds the scaffold TODO placeholder.', 'Replace it with the asset description, or omit the field.'));
    }
    if (a.keywords !== undefined) {
      if (!Array.isArray(a.keywords) || a.keywords.some(k => !isText(k))) out.push(diag('asset.keywords', 'invalid_value', 'asset.keywords must be an array of non-empty strings.', 'Use e.g. ["engineering", "review"].'));
      else a.keywords.forEach((k, idx) => { if (todo(k)) out.push(diag(`asset.keywords[${idx}]`, 'placeholder_not_replaced', `asset.keywords[${idx}] still holds a TODO placeholder.`, 'Replace it with a keyword.')); });
    }
    if (a.license !== undefined) {
      if (!isObj(a.license)) out.push(diag('asset.license', 'invalid_value', 'asset.license must be {identifier, uri?}.', 'Use e.g. {identifier:"CC-BY-4.0", uri:"https://creativecommons.org/licenses/by/4.0/"}.'));
      else {
        need('asset.license.identifier', a.license.identifier, 'a license identifier', '"CC-BY-4.0"');
        if (a.license.uri !== undefined) {
          if (!isText(a.license.uri)) out.push(diag('asset.license.uri', 'invalid_value', 'asset.license.uri must be a non-empty URI string.', 'Provide a valid URI or omit uri.'));
          else if (todo(a.license.uri)) out.push(diag('asset.license.uri', 'placeholder_not_replaced', 'asset.license.uri still holds a TODO placeholder.', 'Replace it with the license URI.'));
        }
        const allowedLicenseKeys = new Set(['identifier', 'uri']);
        for (const k of Object.keys(a.license)) if (!allowedLicenseKeys.has(k)) out.push(diag(`asset.license.${k}`, 'unknown_field', `Unknown asset.license field "${k}".`, 'Allowed: identifier, uri.'));
      }
    }
    const allowedAssetKeys = new Set(['id', 'type', 'title', 'summary', 'language', 'version', 'description', 'keywords', 'license']);
    for (const k of Object.keys(a)) if (!allowedAssetKeys.has(k)) out.push(diag(`asset.${k}`, 'unknown_field', `Unknown asset field "${k}".`, `Allowed: ${[...allowedAssetKeys].join(', ')}.`));
  }
  need('scope', draft.scope, 'a scope sentence');
  need('highest_question', draft.highest_question, 'the question this asset answers');
  if (draft.boundaries !== undefined && draft.boundaries !== null && !isText(draft.boundaries)) out.push(diag('boundaries', 'invalid_value', 'boundaries must be text or null.', 'Write the limits as one sentence, or set null.'));
  else if (todo(draft.boundaries)) out.push(diag('boundaries', 'placeholder_not_replaced', 'boundaries still holds the scaffold TODO placeholder.', 'Replace it with the limits, or set null.'));
  const actorIds = new Set();
  if (!Array.isArray(draft.actors) || !draft.actors.length) out.push(diag('actors', 'missing_field', 'actors needs at least one actor.', 'Add actors: [{id:"author",name:"Your name"}].'));
  else draft.actors.forEach((x, i) => {
    if (!isObj(x)) { out.push(diag(`actors[${i}]`, 'invalid_value', 'actor must be an object.', 'Use {id,name}.')); return; }
    need(`actors[${i}].id`, x.id, 'an actor id', '"author"'); need(`actors[${i}].name`, x.name, 'the actor name');
    if (isText(x.id)) { if (actorIds.has(x.id)) out.push(diag(`actors[${i}].id`, 'duplicate_id', `Duplicate actor id "${x.id}".`, 'Actor ids must be unique.')); actorIds.add(x.id); }
  });
  const table = roleTable();
  const allowedJudgmentDraftKeys = new Set(['id', 'focus', 'statement', 'applies_when', 'boundaries', 'method', 'answer_kind', 'reasons', 'example']);
  if (!Array.isArray(draft.judgments) || !draft.judgments.length) out.push(diag('judgments', 'missing_field', 'judgments needs at least one judgment.', 'Add judgments: [{id,focus,statement,applies_when}].'));
  else {
    const seen = new Set();
    draft.judgments.forEach((j, i) => {
      const p = `judgments[${i}]`;
      if (!isObj(j)) { out.push(diag(p, 'invalid_value', 'judgment must be an object.', 'Use {id,focus,statement,applies_when}.')); return; }
      if (need(`${p}.id`, j.id, 'a judgment id', '"main:first"')) { if (seen.has(j.id)) out.push(diag(`${p}.id`, 'duplicate_id', `Duplicate judgment id "${j.id}".`, 'Judgment ids must be unique.')); seen.add(j.id); }
      need(`${p}.focus`, j.focus, 'a short focus title');
      need(`${p}.statement`, j.statement, 'the authored conclusion');
      need(`${p}.applies_when`, j.applies_when, 'when this judgment applies');
      if (j.boundaries !== undefined && j.boundaries !== null && !isText(j.boundaries)) out.push(diag(`${p}.boundaries`, 'invalid_value', 'boundaries must be text or null.', 'Write one sentence, or remove the field.'));
      else if (todo(j.boundaries)) out.push(diag(`${p}.boundaries`, 'placeholder_not_replaced', 'boundaries still holds the scaffold TODO placeholder.', 'Replace it, or remove the field.'));
      const m = j.method === undefined ? 'feeling' : j.method;
      const term = typeof m === 'string' ? m : m?.term;
      const roles = table && typeof term === 'string' ? table.roles?.[term] : null;
      if (typeof term !== 'string' || (table && !roles)) out.push(diag(`${p}.method`, 'invalid_method', `Unknown method${typeof term === 'string' ? ` "${term}"` : ''}.`, table ? `Use one of: ${Object.keys(table.roles).join(', ')}.` : 'Use a Core method term.'));
      else if (typeof m === 'string' && term !== 'feeling') out.push(diag(`${p}.method`, 'method_roles_required', `Method "${term}" needs its roles written out.`, `Use method: {term:"${term}", roles:{${roles.required.map(r => `"${r}":"..."`).join(', ')}}}.`));
      else if (isObj(m)) {
        const given = isObj(m.roles) ? m.roles : {};
        const missing = roles.required.filter(r => !isText(given[r]));
        if (missing.length) out.push(diag(`${p}.method.roles`, 'method_roles_missing', `Method "${term}" is missing required roles: ${missing.join(', ')}.`, `Add roles ${missing.map(r => `"${r}":"..."`).join(', ')}. Optional: ${roles.optional.join(', ')}.`));
        const unknown = Object.keys(given).filter(r => !roles.required.includes(r) && !roles.optional.includes(r));
        if (unknown.length) out.push(diag(`${p}.method.roles`, 'method_roles_unknown', `Method "${term}" has unknown roles: ${unknown.join(', ')}.`, `Allowed: ${[...roles.required, ...roles.optional].join(', ')}.`));
        for (const [rk, rv] of Object.entries(given)) {
          if (todo(rv)) out.push(diag(`${p}.method.roles.${rk}`, 'placeholder_not_replaced', `${p}.method.roles.${rk} still holds the scaffold TODO placeholder.`, `Replace it with the authored "${rk}" statement.`));
        }
      }
      if (j.reasons !== undefined) {
        if (!Array.isArray(j.reasons) || j.reasons.some(r => !isText(r))) out.push(diag(`${p}.reasons`, 'invalid_value', `${p}.reasons must be an array of non-empty strings.`, 'Provide ["authored rationale"] or omit reasons.'));
        else j.reasons.forEach((r, rIdx) => { if (todo(r)) out.push(diag(`${p}.reasons[${rIdx}]`, 'placeholder_not_replaced', `${p}.reasons[${rIdx}] still holds a TODO placeholder.`, 'Replace it with an authored rationale or omit reasons.')); });
      }
      if (j.example !== undefined) {
        if (!isObj(j.example)) out.push(diag(`${p}.example`, 'invalid_value', `${p}.example must be {summary, context, input?, application, result}.`, 'Provide an example object or omit example.'));
        else {
          need(`${p}.example.summary`, j.example.summary, 'an example summary title');
          need(`${p}.example.context`, j.example.context, 'the example context');
          if (j.example.input !== undefined) {
            if (!isText(j.example.input)) out.push(diag(`${p}.example.input`, 'invalid_value', `${p}.example.input must be a non-empty string when provided.`, 'Write the input case or omit input.'));
            else if (todo(j.example.input)) out.push(diag(`${p}.example.input`, 'placeholder_not_replaced', `${p}.example.input still holds a TODO placeholder.`, 'Replace it with the input case or omit input.'));
          }
          need(`${p}.example.application`, j.example.application, 'how the judgment applies');
          need(`${p}.example.result`, j.example.result, 'the resulting disposition');
          const allowedExampleKeys = new Set(['summary', 'context', 'input', 'application', 'result']);
          for (const k of Object.keys(j.example)) if (!allowedExampleKeys.has(k)) out.push(diag(`${p}.example.${k}`, 'unknown_field', `Unknown example field "${k}".`, 'Allowed: summary, context, input, application, result.'));
        }
      }
      for (const k of Object.keys(j)) if (!allowedJudgmentDraftKeys.has(k)) out.push(diag(`${p}.${k}`, 'unknown_field', `Unknown judgment field "${k}".`, `Allowed: ${[...allowedJudgmentDraftKeys].join(', ')}.`));
    });
  }
  if (draft.timestamp !== undefined && !(typeof draft.timestamp === 'string' && ISO.test(draft.timestamp))) out.push(diag('timestamp', 'invalid_value', 'timestamp must be an ISO-8601 UTC string.', 'Use e.g. "2026-01-01T00:00:00Z".'));
  const known = new Set(['format', 'asset', 'scope', 'actors', 'highest_question', 'boundaries', 'judgments', 'timestamp']);
  for (const k of Object.keys(draft)) if (!known.has(k)) out.push(diag(k, 'unknown_field', `Unknown draft field "${k}".`, `Allowed: ${[...known].join(', ')}.`));
  return out;
}

const provided = text => (isText(text) && !todo(text) ? { state: 'provided', value: text } : { state: 'none', value: null });
// A boundary declaration is a list of complete Boundary objects, not text.
const boundary = (text, id, declaredBy, appliesTo) => (isText(text) && !todo(text)
  ? { state: 'provided', value: [{ id, effect: 'limit', statement: text, declared_by: declaredBy, applies_to: appliesTo, exception_refs: [] }] }
  : { state: 'none', value: null });
const nowZ = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

function compileDraft(draft) {
  if (!isObj(draft)) throw Object.assign(new Error('KDNA_DRAFT_INVALID'), { diagnostics: [diag('', 'not_an_object', 'Draft must be a JSON object.', 'Start from scaffoldDraft().')] });
  const problems = validateDraft(draft).filter(d => d.code !== 'placeholder_not_replaced');
  if (problems.length) throw Object.assign(new Error('KDNA_DRAFT_INVALID'), { diagnostics: problems });
  const when = draft.timestamp || nowZ();
  const slug = draft.asset.id;
  const table = roleTable();
  const actors = draft.actors.map(x => ({ id: `actor:${x.id}`, kind: x.kind || 'person', name: x.name }));
  const actorIds = actors.map(x => x.id);
  const reasons = [];
  const examples = [];
  const judgments = draft.judgments.map(j => {
    const m = j.method === undefined ? 'feeling' : j.method;
    const term = typeof m === 'string' ? m : m.term;
    const roleText = typeof m === 'string'
      ? { '个人感受': 'This is the author’s stated preference, not evidence of a universal effect.' }
      : m.roles;
    const order = table ? [...table.roles[term].required, ...table.roles[term].optional] : Object.keys(roleText);
    const components = order.filter(r => isText(roleText[r])).map(r => ({
      id: `component:${j.id}:${r}`, method: { term }, role: r, material_refs: [], statement: roleText[r],
    }));
    const reasonRefs = [];
    if (Array.isArray(j.reasons)) {
      j.reasons.forEach((rText, idx) => {
        if (!isText(rText)) return;
        const rid = `reason:${j.id}:${idx + 1}`;
        reasonRefs.push(rid);
        reasons.push({
          id: rid,
          role: 'support',
          judgment_ref: j.id,
          statement: rText,
          component_refs: components.length ? [components[0].id] : [],
        });
      });
    }
    if (isObj(j.example)) {
      const ex = j.example;
      examples.push({
        id: `example:${j.id}`,
        title: ex.summary,
        kind: 'illustrative',
        context: isText(ex.input) ? `${ex.context}\nInput: ${ex.input}` : ex.context,
        input_refs: [],
        adopted_judgments: [{ kind: 'local', judgment_id: j.id }],
        application: ex.application,
        results: [{ id: `example-result:${j.id}`, kind: 'disposition', statement: ex.result }],
      });
    }
    const rc = `result-contract:${j.id}`;
    return {
      id: j.id,
      focus: j.focus,
      subject: { actor_ids: actorIds, statement: j.focus },
      scope: { statement: j.applies_when },
      answer_kind: j.answer_kind || 'preference',
      parent_ref: null,
      form: 'conclusion',
      core_expression: { kind: 'authored', statement: j.statement, qualification_refs: [] },
      method: { method: { term }, components, bindings: [] },
      material_refs: [],
      reason_refs: reasonRefs,
      content_uses: [],
      ports: [],
      inputs: [],
      boundaries: boundary(j.boundaries, `boundary:${j.id}`, actorIds[0], { kind: 'judgments', judgment_refs: [j.id] }),
      exceptions: { state: 'none', value: null },
      misuse: { state: 'none', value: null },
      extensions: [],
      result_contract: {
        id: rc,
        form: { term: 'scalar', vocabulary: 'core' },
        shape: { kind: 'scalar', scalar_type: 'text' },
        minimum: 1,
        maximum: 1,
        allowed_result_types: [{ term: 'text', vocabulary: 'core' }],
      },
      result: {
        contract_ref: rc,
        result_type: { term: 'text', vocabulary: 'core' },
        value: { kind: 'text', value: j.statement },
      },
    };
  });
  const version = draft.asset.version;
  const manifest = {
    asset_id: `asset:${slug}`,
    asset_uid: `uid:${slug}`,
    asset_type: draft.asset.type || 'sample',
    title: draft.asset.title,
    summary: draft.asset.summary,
    ...(isText(draft.asset.description) ? { description: draft.asset.description } : {}),
    ...(Array.isArray(draft.asset.keywords) ? { keywords: [...draft.asset.keywords] } : {}),
    languages: [draft.asset.language],
    lineage: [],
    history: { coverage: 'complete', statement: 'Initial draft.', entries: [] },
    version,
    judgment_version: version,
    created_at: when,
    updated_at: when,
    compatibility: { min_loader_version: '0.36.0', profile: 'kdna.payload.judgment', profile_version: '0.5.1' },
    runtime: { mandatory_entries: [] },
    ...(isObj(draft.asset.license) ? { license: { identifier: draft.asset.license.identifier, ...(isText(draft.asset.license.uri) ? { uri: draft.asset.license.uri } : {}) } } : {}),
  };
  return {
    manifest,
    payload: {
      profile: 'kdna.payload.judgment',
      profile_version: '0.5.1',
      asset: { asset_id: `asset:${slug}`, asset_version: version, judgment_version: version },
      actors,
      scope: { statement: draft.scope },
      declarations: { highest_question: provided(draft.highest_question), boundaries: boundary(draft.boundaries, `boundary:${slug}`, actorIds[0], { kind: 'asset' }) },
      kernel: { purpose: { kind: 'summary' }, foundation_refs: [] },
      contracts: [],
      conditions: [],
      shared_declarations: [],
      materials: [],
      reasons,
      sources: [],
      source_uses: [],
      resources: [],
      relationships: [],
      dependencies: [],
      examples,
      exceptions: [],
      misuse: [],
      reading_order: judgments.map(j => j.id),
      extensions: [],
      judgments,
      asset_capability: 'asserted_answers',
    },
    members: [],
  };
}

const MANIFEST_REQUIRED_KEYS = ['asset_id', 'asset_uid', 'asset_type', 'title', 'version', 'judgment_version', 'created_at', 'updated_at', 'compatibility', 'runtime', 'summary', 'languages', 'history'];
const MANIFEST_OPTIONAL_KEYS = ['creator', 'content_digest', 'authoring', 'access', 'license', 'description', 'keywords', 'lineage'];
const MANIFEST_ALLOWED_KEYS = [...MANIFEST_REQUIRED_KEYS, ...MANIFEST_OPTIONAL_KEYS];

const PAYLOAD_REQUIRED_KEYS = ['profile', 'profile_version', 'asset', 'actors', 'scope', 'judgments', 'asset_capability', 'declarations', 'kernel', 'shared_declarations', 'materials', 'reasons', 'sources', 'source_uses', 'resources', 'relationships', 'dependencies', 'contracts', 'conditions', 'exceptions', 'misuse', 'examples'];
const PAYLOAD_OPTIONAL_KEYS = ['attributions', 'cohesion', 'content_risk', 'extensions', 'reading_order'];
const PAYLOAD_ALLOWED_KEYS = [...PAYLOAD_REQUIRED_KEYS, ...PAYLOAD_OPTIONAL_KEYS];

const COLLECTIONS = new Set(['actors', 'contracts', 'conditions', 'shared_declarations', 'materials', 'reasons', 'sources', 'source_uses', 'resources', 'relationships', 'dependencies', 'examples', 'exceptions', 'misuse', 'reading_order', 'extensions', 'judgments', 'attributions']);

const JUDGMENT_REQUIRED_KEYS = ['id', 'focus', 'subject', 'scope', 'form', 'answer_kind', 'core_expression', 'result_contract', 'method', 'material_refs', 'reason_refs', 'parent_ref', 'ports', 'inputs', 'content_uses'];
const JUDGMENT_OPTIONAL_KEYS = ['answer_other', 'answer_parts', 'boundaries', 'exceptions', 'extensions', 'lifecycle', 'misuse', 'result', 'formation_rule'];
const JUDGMENT_ALLOWED_KEYS = [...JUDGMENT_REQUIRED_KEYS, ...JUDGMENT_OPTIONAL_KEYS];

function validateFull(input) {
  const out = [];
  if (!isObj(input)) return [diag('', 'not_an_object', 'Input must be a JSON object.', 'Provide {manifest,payload,members}.')];
  for (const k of ['manifest', 'payload', 'members']) if (input[k] === undefined) out.push(diag(`/${k}`, 'missing_field', `/${k} is required.`, k === 'members' ? 'Add "members": [].' : `Add /${k}; run \`kdna init\` and compile a draft for a complete one.`));
  for (const k of Object.keys(input)) if (!['manifest', 'payload', 'members'].includes(k)) out.push(diag(`/${k}`, 'unknown_field', `Unknown top-level field "${k}".`, 'Only manifest, payload, members are accepted.'));
  const keyset = (value, requiredKeys, allowedKeys, base, hintFor) => {
    if (!isObj(value)) { if (value !== undefined) out.push(diag(base, 'invalid_value', `${base} must be an object.`, '')); return false; }
    for (const k of requiredKeys) if (!Object.hasOwn(value, k)) out.push(diag(`${base}/${k}`, 'missing_field', `${base}/${k} is required.`, hintFor(k)));
    for (const k of Object.keys(value)) if (!allowedKeys.includes(k)) out.push(diag(`${base}/${k}`, 'unknown_field', `${base}/${k} is not an allowed field.`, `Allowed: ${allowedKeys.join(', ')}.`));
    return true;
  };
  keyset(input.manifest, MANIFEST_REQUIRED_KEYS, MANIFEST_ALLOWED_KEYS, '/manifest', k => `Add ${k} to the manifest.`);
  if (keyset(input.payload, PAYLOAD_REQUIRED_KEYS, PAYLOAD_ALLOWED_KEYS, '/payload', k => (COLLECTIONS.has(k) ? `Add "${k}": [] when it has no entries.` : `Add ${k} to the payload.`))) {
    const table = roleTable();
    if (Array.isArray(input.payload.judgments)) {
      if (!input.payload.judgments.length) out.push(diag('/payload/judgments', 'missing_field', '/payload/judgments needs at least one judgment.', 'Add one judgment.'));
      input.payload.judgments.forEach((j, i) => {
        const base = `/payload/judgments/${i}`;
        if (!keyset(j, JUDGMENT_REQUIRED_KEYS, JUDGMENT_ALLOWED_KEYS, base, k => `Add ${k} to this judgment.`)) return;
        if (j.form === 'rule') {
          if (!Object.hasOwn(j, 'formation_rule')) out.push(diag(`${base}/formation_rule`, 'missing_field', `${base}/formation_rule is required when form is "rule".`, 'Add formation_rule to this rule judgment.'));
          if (Object.hasOwn(j, 'result')) out.push(diag(`${base}/result`, 'invalid_value', `${base}/result is not allowed when form is "rule".`, 'Remove result from rule judgments; use formation_rule instead.'));
        } else if (j.form === 'conclusion') {
          if (!Object.hasOwn(j, 'result')) out.push(diag(`${base}/result`, 'missing_field', `${base}/result is required when form is "conclusion".`, 'Add result to this conclusion judgment.'));
          if (Object.hasOwn(j, 'formation_rule')) out.push(diag(`${base}/formation_rule`, 'invalid_value', `${base}/formation_rule is not allowed when form is "conclusion".`, 'Remove formation_rule from conclusion judgments; use result instead.'));
        }
        const compCheck = inspectMethodComponents(j, table);
        if (compCheck) {
          if (compCheck.duplicate_roles.length) {
            out.push({
              ...diag(`${base}/method/components`, 'duplicate_method_roles',
                `Method "${compCheck.term}" repeats role(s): ${compCheck.duplicate_roles.map(d => `${d.role} (${d.component_ids.join(', ')})`).join('; ')}.`,
                DUPLICATE_ROLE_FIX_HINT),
              duplicate_roles: compCheck.duplicate_roles,
              invalid_roles: compCheck.invalid_roles,
              missing_required_roles: compCheck.missing_required_roles,
              fix_hint: DUPLICATE_ROLE_FIX_HINT,
            });
          }
          if (compCheck.invalid_roles.length) {
            out.push({
              ...diag(`${base}/method/components`, 'invalid_method_roles',
                `Method "${compCheck.term}" has role(s) outside its vocabulary: ${compCheck.invalid_roles.join(', ')}.`,
                `Allowed roles for "${compCheck.term}": ${[...compCheck.expected, ...compCheck.optional].join(', ')}.`),
              duplicate_roles: compCheck.duplicate_roles,
              invalid_roles: compCheck.invalid_roles,
              missing_required_roles: compCheck.missing_required_roles,
            });
          }
          if (compCheck.missing_required_roles.length) {
            out.push({
              ...diag(`${base}/method/components`, 'missing_method_roles',
                `Method "${compCheck.term}" is missing required role(s): ${compCheck.missing_required_roles.join(', ')}.`,
                `Required roles for "${compCheck.term}": ${compCheck.expected.join(', ')}.`),
              duplicate_roles: compCheck.duplicate_roles,
              invalid_roles: compCheck.invalid_roles,
              missing_required_roles: compCheck.missing_required_roles,
            });
          }
        }
      });
    } else if (input.payload.judgments !== undefined) out.push(diag('/payload/judgments', 'invalid_value', '/payload/judgments must be an array.', ''));
  }
  if (input.members !== undefined && !Array.isArray(input.members)) out.push(diag('/members', 'invalid_value', '/members must be an array.', 'Use "members": [].'));
  return out;
}

function normalizeFocusText(text) {
  return String(text || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function isProvidedDeclaration(decl) {
  return isObj(decl) && decl.state === 'provided' && decl.value !== null && decl.value !== undefined && (!Array.isArray(decl.value) || decl.value.length > 0);
}

function isCatchAllScope(text) {
  const trimmed = String(text || '').trim();
  return trimmed.length < 8 || CATCH_ALL_SCOPES.has(trimmed.toLowerCase());
}

// Structural, MP4-compliant craft advisories. Never computes a numerical score,
// never evaluates substantive truth/ideology, and never alters validity.
function computeAdvisories(input, isDraft) {
  const advisories = [];
  if (!isObj(input)) return advisories;
  if (isDraft) {
    const judgments = Array.isArray(input.judgments) ? input.judgments : [];
    const hasGlobalGuard = isText(input.boundaries);
    const focusMap = new Map();
    let omittedMethodCount = 0;
    judgments.forEach((j, i) => {
      if (!isObj(j)) return;
      const p = `judgments[${i}]`;
      const focus = isText(j.focus) ? j.focus.trim() : '';
      const stmt = isText(j.statement) ? j.statement.trim() : '';
      if (focus && stmt && focus === stmt) {
        advisories.push({ code: 'tautological_statement', path: `${p}.statement`, message: 'statement verbatim repeats focus; state the concrete decision or conclusion instead of repeating the question.' });
      }
      if (isObj(j.method) && isObj(j.method.roles) && stmt) {
        for (const [rk, rv] of Object.entries(j.method.roles)) {
          if (isText(rv) && rv.trim() === stmt) {
            advisories.push({ code: 'method_repeats_statement', path: `${p}.method.roles.${rk}`, message: `method role "${rk}" verbatim repeats statement; explain how the judgment was formed rather than restating the conclusion.` });
            break;
          }
        }
      }
      if (!isText(j.boundaries) && !hasGlobalGuard) {
        advisories.push({ code: 'unbounded_judgment', path: `${p}.boundaries`, message: 'neither this judgment nor the asset declares boundaries; consider stating where this judgment stops applying so Agents do not over-apply it.' });
      }
      if (isText(j.applies_when) && isCatchAllScope(j.applies_when)) {
        advisories.push({ code: 'overbroad_scope', path: `${p}.applies_when`, message: 'applies_when is very short or catch-all; name concrete task conditions so Agents can filter irrelevant judgments.' });
      }
      if (focus) {
        const norm = normalizeFocusText(focus);
        if (!focusMap.has(norm)) focusMap.set(norm, []);
        focusMap.get(norm).push({ index: i, path: `${p}.focus` });
      }
      if (j.method === undefined) omittedMethodCount += 1;
    });
    for (const entries of focusMap.values()) {
      if (entries.length > 1) {
        advisories.push({ code: 'duplicate_focus', path: entries[1].path, message: `judgments at ${entries.map(e => e.path).join(' and ')} ask the same focus question; split distinct sub-questions or merge them.` });
      }
    }
    if (omittedMethodCount >= 3) {
      advisories.push({ code: 'uniform_default_method', path: 'judgments', message: `${omittedMethodCount} judgments omit method (defaulting to "feeling"); consider declaring tradeoff, criteria_comparison, observation, experience, or evidence_analysis where explicit reasoning exists.` });
    }
    return advisories;
  }
  const payload = isObj(input.payload) ? input.payload : {};
  const judgments = Array.isArray(payload.judgments) ? payload.judgments : [];
  const hasGlobalGuard = isProvidedDeclaration(payload.declarations?.boundaries)
    || (Array.isArray(payload.conditions) && payload.conditions.length > 0)
    || (Array.isArray(payload.exceptions) && payload.exceptions.length > 0);
  const focusMap = new Map();
  judgments.forEach((j, i) => {
    if (!isObj(j)) return;
    const p = `/payload/judgments/${i}`;
    const focus = isText(j.focus) ? j.focus.trim() : '';
    const stmt = isText(j.core_expression?.statement) ? j.core_expression.statement.trim() : '';
    if (focus && stmt && focus === stmt) {
      advisories.push({ code: 'tautological_statement', path: `${p}/core_expression/statement`, message: 'core_expression.statement verbatim repeats focus; state the concrete conclusion instead of repeating the question.' });
    }
    if (Array.isArray(j.method?.components) && stmt) {
      for (let cIdx = 0; cIdx < j.method.components.length; cIdx++) {
        const comp = j.method.components[cIdx];
        if (isText(comp?.statement) && comp.statement.trim() === stmt) {
          advisories.push({ code: 'method_repeats_statement', path: `${p}/method/components/${cIdx}/statement`, message: `method component "${comp.role ?? cIdx}" verbatim repeats core_expression.statement; explain how the judgment was formed rather than restating the conclusion.` });
          break;
        }
      }
    }
    if (!isProvidedDeclaration(j.boundaries) && !isProvidedDeclaration(j.exceptions) && !hasGlobalGuard) {
      advisories.push({ code: 'unbounded_judgment', path: `${p}/boundaries`, message: 'judgment declares no boundaries or exceptions and the asset declares no global boundaries/conditions/exceptions; consider stating where it stops applying.' });
    }
    const scopeStmt = j.scope?.statement;
    if (isText(scopeStmt) && isCatchAllScope(scopeStmt)) {
      advisories.push({ code: 'overbroad_scope', path: `${p}/scope/statement`, message: 'scope.statement is very short or catch-all; name concrete applicability conditions so Agents can filter irrelevant judgments.' });
    }
    if (focus) {
      const norm = normalizeFocusText(focus);
      if (!focusMap.has(norm)) focusMap.set(norm, []);
      focusMap.get(norm).push({ index: i, path: `${p}/focus` });
    }
  });
  for (const entries of focusMap.values()) {
    if (entries.length > 1) {
      advisories.push({ code: 'duplicate_focus', path: entries[1].path, message: `judgments at ${entries.map(e => e.path).join(' and ')} ask the same focus question; split distinct sub-questions or merge them.` });
    }
  }
  return advisories;
}

function validateInput(input) {
  const draft = isObj(input) && (input.format !== undefined || (input.manifest === undefined && input.payload === undefined));
  const diagnostics = draft ? validateDraft(isObj(input) ? input : {}) : validateFull(input);
  if (draft && !isObj(input)) diagnostics.unshift(diag('', 'not_an_object', 'Draft must be a JSON object.', 'Start from scaffoldDraft().'));
  if (diagnostics.length) return { status: 'invalid', diagnostics };
  const judgment_count = draft ? input.judgments.length : input.payload.judgments.length;
  return {
    status: 'valid',
    input_kind: draft ? 'draft' : 'authored',
    judgment_count,
    diagnostics: [],
    advisories: computeAdvisories(input, draft),
  };
}

// Ask Core itself (the authority) and translate a rejection into the same
// diagnostic shape. A draft is compiled first; compile problems come back as-is.
async function validateWithCore(input) {
  const local = validateInput(input);
  if (local.status === 'invalid') return local;
  const full = isObj(input) && input.format === FORMAT ? compileDraft(input) : input;
  const { admitNativeCreationRequest, createNativeCreationAuthority, createSectionAssetNode } = require('@aikdna/kdna-core/creation-sections-node');
  const binding = require('../public-contract-binding.json');
  const request = admitNativeCreationRequest({ request_id: 'draft:' + randomUUID(), tuple: binding.tuple, operation: 'create_public_asset', timeout_ms: 60000 });
  if (request.status !== 'admitted_request') return { status: 'invalid', diagnostics: [diag('', 'core_request_rejected', 'Core refused the creation request.', 'Check the installed @aikdna/kdna-core matches this CLI.')] };
  const produced = await createSectionAssetNode(full, request.request, createNativeCreationAuthority(() => true));
  if (produced.status === 'produced') return local;
  const raw = Array.isArray(produced?.core?.diagnostics) ? produced.core.diagnostics : [];
  const table = roleTable();
  const judgments = Array.isArray(full?.payload?.judgments) ? full.payload.judgments : [];
  const diagnostics = raw.map(d => {
    const field = typeof d?.field === 'string' ? d.field : '';
    const compMatch = /^\/payload\/judgments\/(\d+)\/method\/components$/.exec(field);
    if (compMatch) {
      const compCheck = inspectMethodComponents(judgments[Number(compMatch[1])], table);
      if (compCheck && compCheck.duplicate_roles.length) {
        return {
          ...diag(field, String(d?.code || d?.reason || produced.code || 'core_rejected'),
            `Core rejected ${field} (${d?.code || 'READ_CORE_INVALID'}): duplicate role(s) ${compCheck.duplicate_roles.map(x => x.role).join(', ')}.`,
            DUPLICATE_ROLE_FIX_HINT),
          duplicate_roles: compCheck.duplicate_roles,
          invalid_roles: compCheck.invalid_roles,
          missing_required_roles: compCheck.missing_required_roles,
          fix_hint: DUPLICATE_ROLE_FIX_HINT,
        };
      }
    }
    return diag(field, String(d?.code || d?.reason || produced.code || 'core_rejected'), `Core rejected ${field || 'the input'}${d?.code ? ` (${d.code})` : ''}.`, 'Compare this field with docs/authoring-field-reference.md.');
  });
  if (!diagnostics.length) diagnostics.push(diag('', String(produced.code || produced.status || 'core_rejected'), 'Core rejected the input.', 'Compare the input with docs/authoring-field-reference.md.'));
  return { status: 'invalid', diagnostics };
}

module.exports = { FORMAT, INIT_MODES, DUPLICATE_ROLE_FIX_HINT, inspectMethodComponents, scaffoldDraft, compileDraft, validateInput, validateWithCore };
