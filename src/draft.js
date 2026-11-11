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

function roleTable() {
  try {
    const m = require('@aikdna/kdna-core/components');
    return typeof m.getMethodRoleTable === 'function' ? m.getMethodRoleTable() : null;
  } catch { return null; }
}

function scaffoldDraft() {
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
    need('asset.title', a.title, 'a title');
    need('asset.summary', a.summary, 'a one-sentence summary');
    need('asset.language', a.language, 'a language tag', '"en"');
    if (need('asset.version', a.version, 'a semantic version', '"0.1.0"') && !/^\d+\.\d+\.\d+$/.test(a.version)) out.push(diag('asset.version', 'invalid_value', 'asset.version must be MAJOR.MINOR.PATCH.', 'Use e.g. "0.1.0".'));
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
      }
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
      reason_refs: [],
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
  return {
    manifest: {
      asset_id: `asset:${slug}`,
      asset_uid: `uid:${slug}`,
      asset_type: 'sample',
      title: draft.asset.title,
      summary: draft.asset.summary,
      languages: [draft.asset.language],
      lineage: [],
      history: { coverage: 'complete', statement: 'Initial draft.', entries: [] },
      version,
      judgment_version: version,
      created_at: when,
      updated_at: when,
      compatibility: { min_loader_version: '0.36.0', profile: 'kdna.payload.judgment', profile_version: '0.5.1' },
      runtime: { mandatory_entries: [] },
    },
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
      reasons: [],
      sources: [],
      source_uses: [],
      resources: [],
      relationships: [],
      dependencies: [],
      examples: [],
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

const MANIFEST_KEYS = ['asset_id', 'asset_uid', 'asset_type', 'title', 'summary', 'languages', 'lineage', 'history', 'version', 'judgment_version', 'created_at', 'updated_at', 'compatibility', 'runtime'];
const PAYLOAD_KEYS = ['profile', 'profile_version', 'asset', 'actors', 'scope', 'declarations', 'kernel', 'contracts', 'conditions', 'shared_declarations', 'materials', 'reasons', 'sources', 'source_uses', 'resources', 'relationships', 'dependencies', 'examples', 'exceptions', 'misuse', 'reading_order', 'extensions', 'judgments', 'asset_capability'];
const COLLECTIONS = new Set(['actors', 'contracts', 'conditions', 'shared_declarations', 'materials', 'reasons', 'sources', 'source_uses', 'resources', 'relationships', 'dependencies', 'examples', 'exceptions', 'misuse', 'reading_order', 'extensions', 'judgments']);
const JUDGMENT_KEYS = ['id', 'focus', 'subject', 'scope', 'answer_kind', 'parent_ref', 'form', 'core_expression', 'method', 'material_refs', 'reason_refs', 'content_uses', 'ports', 'inputs', 'boundaries', 'exceptions', 'misuse', 'extensions', 'result_contract', 'result'];

function validateFull(input) {
  const out = [];
  if (!isObj(input)) return [diag('', 'not_an_object', 'Input must be a JSON object.', 'Provide {manifest,payload,members}.')];
  for (const k of ['manifest', 'payload', 'members']) if (input[k] === undefined) out.push(diag(`/${k}`, 'missing_field', `/${k} is required.`, k === 'members' ? 'Add "members": [].' : `Add /${k}; run \`kdna draft\` and compile a draft for a complete one.`));
  for (const k of Object.keys(input)) if (!['manifest', 'payload', 'members'].includes(k)) out.push(diag(`/${k}`, 'unknown_field', `Unknown top-level field "${k}".`, 'Only manifest, payload, members are accepted.'));
  const keyset = (value, keys, base, hintFor) => {
    if (!isObj(value)) { if (value !== undefined) out.push(diag(base, 'invalid_value', `${base} must be an object.`, '')); return false; }
    for (const k of keys) if (!Object.hasOwn(value, k)) out.push(diag(`${base}/${k}`, 'missing_field', `${base}/${k} is required.`, hintFor(k)));
    for (const k of Object.keys(value)) if (!keys.includes(k)) out.push(diag(`${base}/${k}`, 'unknown_field', `${base}/${k} is not an allowed field.`, `Allowed: ${keys.join(', ')}.`));
    return true;
  };
  keyset(input.manifest, MANIFEST_KEYS, '/manifest', k => `Add ${k} to the manifest.`);
  if (keyset(input.payload, PAYLOAD_KEYS, '/payload', k => (COLLECTIONS.has(k) ? `Add "${k}": [] when it has no entries.` : `Add ${k} to the payload.`))) {
    if (Array.isArray(input.payload.judgments)) {
      if (!input.payload.judgments.length) out.push(diag('/payload/judgments', 'missing_field', '/payload/judgments needs at least one judgment.', 'Add one judgment.'));
      input.payload.judgments.forEach((j, i) => keyset(j, JUDGMENT_KEYS, `/payload/judgments/${i}`, k => `Add ${k} to this judgment.`));
    } else if (input.payload.judgments !== undefined) out.push(diag('/payload/judgments', 'invalid_value', '/payload/judgments must be an array.', ''));
  }
  if (input.members !== undefined && !Array.isArray(input.members)) out.push(diag('/members', 'invalid_value', '/members must be an array.', 'Use "members": [].'));
  return out;
}

function validateInput(input) {
  const draft = isObj(input) && (input.format !== undefined || (input.manifest === undefined && input.payload === undefined));
  const diagnostics = draft ? validateDraft(isObj(input) ? input : {}) : validateFull(input);
  if (draft && !isObj(input)) diagnostics.unshift(diag('', 'not_an_object', 'Draft must be a JSON object.', 'Start from scaffoldDraft().'));
  return { status: diagnostics.length ? 'invalid' : 'valid', diagnostics };
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
  if (produced.status === 'produced') return { status: 'valid', diagnostics: [] };
  const raw = Array.isArray(produced?.core?.diagnostics) ? produced.core.diagnostics : [];
  const diagnostics = raw.map(d => {
    const field = typeof d?.field === 'string' ? d.field : '';
    return diag(field, String(d?.code || d?.reason || produced.code || 'core_rejected'), `Core rejected ${field || 'the input'}${d?.code ? ` (${d.code})` : ''}.`, 'Compare this field with docs/authoring-field-reference.md.');
  });
  if (!diagnostics.length) diagnostics.push(diag('', String(produced.code || produced.status || 'core_rejected'), 'Core rejected the input.', 'Compare the input with docs/authoring-field-reference.md.'));
  return { status: 'invalid', diagnostics };
}

module.exports = { FORMAT, scaffoldDraft, compileDraft, validateInput, validateWithCore };
