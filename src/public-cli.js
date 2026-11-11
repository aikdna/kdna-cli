'use strict';
const { randomUUID, createHash } = require('node:crypto');
const { parseJsonBytes, readAuthoredInput, readAssetBytes, readBoundedFile, saveNewAsset } = require('./authored-input.js');
const { scaffoldDraft, compileDraft, validateInput, validateWithCore } = require('./draft.js');
const { protectAsset, admitProtectedWithPassword, readProtected, isProtectedBytes, readPasswordSource } = require('./protect.js');
const { diffViews, renderDiffHuman } = require('./diff.js');
const { renderInspectHuman, renderValidateHuman, renderReadHuman, compactReadResult } = require('./human.js');
const renderRejectionHuman = (command, result) => (command === 'inspect' ? renderInspectHuman : renderValidateHuman)(result);
const { readSourceEdits } = require('./source-input.js');
const { Readable, Writable } = require('node:stream');
const { admitSectionRequest, inspectWholeSectionSnapshot } = require('@aikdna/kdna-core/sections-node');
const { createNativeSectionByteReadAuthority, admitSectionBytesNode } = require('@aikdna/kdna-core/sections-bytes-node');
const { admitRetainedSectionRequest, createRetainedSectionReadAuthority, prepareRetainedSectionRead } = require('@aikdna/kdna-core/retained-sections-node');
const { createTrustedHostReadProvider, readRetainedSection } = require('@aikdna/kdna-read/retained-sections-node');
const { admitNativeCreationRequest, createNativeCreationAuthority, createSectionAssetNode } = require('@aikdna/kdna-core/creation-sections-node');
const { admitSourceOperationRequest, createNativeSourceOperationAuthority, openSectionSourceNode, packSectionSourceNode } = require('@aikdna/kdna-core/source-sections-node');
const { admitSourceMigrationRequest, createNativeSourceMigrationAuthority, migratePublicSourceNode } = require('@aikdna/kdna-core/source-migration-node');
const binding = require('../public-contract-binding.json');
// The model-view contract this CLI is built against. It is the one-way gate for
// the projection: a caller may accept this contract or nothing, and a Read
// artifact that serves only an older projection is refused rather than
// silently used.
const REQUIRED_MODEL_VIEW = 'kdna.read.model-view/0.2.0';
// The body projection is a capability of the installed Read package, not of this
// CLI. It is detected once per process: an artifact that does not provide it must
// leave every byte of this CLI's output exactly as it was, and an artifact that
// does provide it becomes the default surface.
function loadModelView(){
  try{
    const module=require('@aikdna/kdna-read');
    return typeof module.projectModelView==='function'?module:null;
  }catch{return null;}
}
// The per-term method-role vocabulary is a capability of the installed Core
// package, detected once per process. When it is available, a method-role
// rejection can carry a guidance sibling that quotes the required roles and
// names which of them the authored input does not contain. The guidance is a
// presentation aid: it decides nothing and never replaces the Core diagnostic.
function loadMethodRoleTable(){
  try{
    const module=require('@aikdna/kdna-core/components');
    return typeof module.getMethodRoleTable==='function'?module.getMethodRoleTable():null;
  }catch{return null;}
}
const METHOD_COMPONENTS_FIELD=/^\/payload\/judgments\/(\d+)\/method\/components$/;
const METHOD_FIELD=/^\/payload\/judgments\/(\d+)\/method$/;
function authoringGuidance(input,rejected){
  if(rejected?.status!=='core_rejected')return null;
  const diagnostics=rejected?.core?.diagnostics;
  if(!Array.isArray(diagnostics))return null;
  const table=loadMethodRoleTable();
  const judgments=Array.isArray(input?.payload?.judgments)?input.payload.judgments:[];
  const guidance=[];
  for(const diagnostic of diagnostics){
    const field=typeof diagnostic?.field==='string'?diagnostic.field:'';
    const componentsMatch=METHOD_COMPONENTS_FIELD.exec(field);
    if(componentsMatch){
      const judgment=judgments[Number(componentsMatch[1])];
      const term=judgment?.method?.method?.term;
      const roles=table&&typeof term==='string'?table.roles?.[term]:null;
      if(!roles)continue;
      const used=new Set((judgment.method.components??[]).map(component=>component?.role));
      guidance.push({field,reason:'method_component_roles',term,missing:roles.required.filter(role=>!used.has(role)),expected:roles.required,optional:roles.optional});
      continue;
    }
    const methodMatch=METHOD_FIELD.exec(field);
    if(methodMatch){
      guidance.push({field,reason:'method_missing',expected:'a method declaration; when the author has stated none, the documented other encoding keeps that absence explicit (authoring field reference, method components)'});
    }
  }
  return guidance.length?guidance:null;
}
const commands = new Set(['init', 'compile', 'validate-input', 'create', 'protect', 'diff', 'source-open', 'source-pack', 'convert', 'inspect', 'validate', 'read', 'plan', 'load']);
const independentStates = () => ({ writer: 'not_evaluated', confirmation: 'not_evaluated', read_permission: 'not_evaluated', action_authorization: 'not_evaluated' });
const help = [
  'kdna init [--output <draft.json>]',
  '  Scaffolds a minimal 0.6.0 draft (kdna.draft/1) with one example judgment to edit; prints it',
  '  to stdout, or saves a new file (never replaces one) with --output.',
  'kdna compile <draft.json> [--output <authored.json>]',
  '  Expands a draft into the full authored input that create accepts, filling every optional',
  '  empty collection; prints it, or saves a new file with --output.',
  'kdna create --draft <draft.json> --output <new-asset.kdna> --allow-create',
  '  Same as compile then create in one step.',
  'kdna validate-input <draft-or-authored.json>',
  '  Checks a draft or full authored input and names each missing or invalid field with a hint.',
  'kdna create <authored.json> --output <new-asset.kdna> --allow-create',
  '  Input: {manifest,payload,members:[{name,type:"file",mode,bytes_base64}]}; never replaces a file.',
  'kdna source-open <asset.kdna> --expected-a <sha256:...> --allow-source',
  '  Emits an observation and edits:{manifest,payload}; original resource bytes stay in the asset.',
  'kdna source-pack <asset.kdna> --edits <edits.json> --expected-a <sha256:...> --output <new-asset.kdna> --allow-source',
  '  Edit transport: exactly {manifest,payload}; public source only, old files are never replaced.',
  '  A saved pack reports affected_by_change: the direct downstream (support, qualify, conflict)',
  '  of the judgments this revision changed; complement carries no dependence and is excluded.',
  'kdna convert <asset.kdna> --expected-a <sha256:...> --output <new-asset.kdna> --allow-source',
  '  Explicit 0.5 -> 0.6 migration of a current-generation public source: reads exactly the',
  '  container 0.5.0 / kdna.payload.judgment generation, writes an admitted 0.6 container with',
  '  a confirmed representation_origin, and saves a new file; old files are never replaced.',
  '  Historical tuples, protected sources and extension members are refused by name without',
  '  conversion; the read and source routes are unchanged.',
  'kdna protect <asset.kdna> --output <protected.kdna> (--password-fd <fd> | --password-file <path>)',
  '  Local password protection, no account and no network: writes a new 0.6.0 container whose',
  '  payload.kdnab is an AEAD envelope (password entitlement, offline). The password is read once',
  '  from an inherited descriptor (3 or higher) or a file, one trailing newline stripped; it is never',
  '  accepted on the command line. A protected asset is refused by name until a password is given.',
  'kdna diff <left.kdna> <right.kdna> [--format json|human] [--password-fd <fd> | --password-file <path>]',
  '  Compares two assets: identity, digests, judgments added/removed/changed, conditions and',
  '  relations. One password source serves every protected side.',
  'kdna inspect <asset.kdna> [--json] [--format json|human] [--password-fd <fd> | --password-file <path>]',
  'kdna validate <asset.kdna> [--json] [--system] [--format json|human] [--password-fd <fd> | --password-file <path>]',
  '  --system adds warnings-only system-integrity checks: support cycles, a pair that is',
  '  both supported and in conflict, a withdrawn judgment with an active downstream, and',
  '  ordered declarations that repeat an entry or rank fewer items than their scope. A',
  '  warning never refuses a structurally valid asset; the exit status stays 0.',
  'kdna read <asset.kdna> --mode catalog|whole_asset|exact_selection --budget <bytes>',
  '  [--asset-id <id> --asset-version <version> --judgment-id <id>] [--allow-read] [--view body|full|raw]',
  '  [--view-accept <model-view-contract>] [--compact] [--format json|human]',
  '  [--password-fd <fd> | --password-file <path>]',
  '  --judgment-id may repeat or carry a comma-separated list: with exact_selection and no --session the',
  '  asset id/version default to the admitted asset (also for a single id) and several ids are sent as one',
  '  catalog-ordered selection.',
  '  --compact (body view only) drops the repeated asset-level declarations and catalog from each answer.',
  '  --budget counts the complete final JCS read envelope (metadata, receipt, content and',
  '  the budget fields themselves), not the printed body, the full model view, model',
  '  input bytes or model tokens; --view raw or a rejection reports the envelope',
  '  budget.required_bytes/actual_bytes. Keep this disclosure budget separate from the',
  '  model context budget; measure projected input bytes and tokens separately.',
  '  --view body answers with the author body and one fingerprint when the installed',
  '  Read package provides that projection; --view full is what this CLI printed before it.',
  '  The body view also omits the asset index and expansion handles; --view raw carries the',
  '  library handles unchanged, and the session route can resolve them.',
  '  --view raw prints the library envelope unchanged, reduction machinery and issued',
  '  handles included, for adapters that apply their own projection; it is not a model',
  '  view and never pairs with --view-accept.',
  '  --view-accept pins the model-view contract this run accepts; the default is the',
  '  contract this CLI is built against, and no value ever selects an older service.',
  '  catalog lists judgment ids without bodies; exact_selection returns the selected',
  '  judgment with its mandatory closure; whole_asset returns the Core asset closure and',
  '  may defer judgment bodies behind handles. whole_asset is not "every judgment body',
  '  inline": the default body view can list the catalog with zero judgment bodies and',
  '  omits the asset index/handles. Use catalog then exact_selection for each judgment,',
  '  or one session request with multiple judgment_ids, when the task needs the bodies.',
  '  --view full shows what is inline and deferred.',
  'kdna read <asset.kdna> --session [--allow-read]',
  '  One public ReadRequest JSON object per input line; one public result per output line.',
  '  Reuse a returned handle, or name a compact handle_id from the reduced body, for',
  '  expand within this session.',
  'plan/load are unavailable until public Plan admission and execution exist.',
].join('\n') + '\n';

function budgetNote(result) {
  if (!result || typeof result !== 'object') return null;
  if (result.channel === 'read_envelope' && result.envelope?.status === 'rejected') {
    const diagnostics = Array.isArray(result.envelope.diagnostics) ? result.envelope.diagnostics : [];
    if (!diagnostics.some((entry) => entry?.code === 'READ_BUDGET_INSUFFICIENT')) return null;
    const budget = result.envelope.budget;
    const required = typeof budget?.required_bytes === 'string' && /^[0-9]+$/.test(budget.required_bytes)
      ? BigInt(budget.required_bytes).toString()
      : null;
    const limit = Number.isSafeInteger(budget?.limit_bytes) ? budget.limit_bytes : null;
    if (required === null || limit === null) return 'kdna: READ_BUDGET_INSUFFICIENT: the complete final JCS envelope exceeds --budget; retry with a larger budget or --view raw to see required_bytes. No content was delivered.';
    return `kdna: READ_BUDGET_INSUFFICIENT: the complete final JCS envelope requires ${required} bytes at this limit; --budget was ${limit}. The printed body is usually smaller; --budget does not count it, and the limit field itself is counted, so retry above the reported size. Content was not truncated.`;
  }
  if (result.channel === 'no_body_control' && result.control?.semantic_cause === 'READ_BUDGET_INSUFFICIENT') {
    return 'kdna: READ_RESPONSE_BUDGET_TOO_SMALL: the budget is below the size of the rejection envelope; retry with a larger budget (the default is 1000000) to see required_bytes. No content was delivered.';
  }
  return null;
}

// System-integrity warnings and change propagation. Both read only the result
// the same admission already returned: they re-parse nothing, verify nothing
// and refuse nothing. The relation families are the contract's own vocabulary —
// support (supporter -> claim), qualify (qualifier -> qualified) and conflict
// (undirected, both sides). complement carries `adds_perspective`: it neither
// sustains nor constrains its base, so it is deliberately outside the
// dependency warnings and outside affected_by_change.
function normalizedRelations(source) {
  const rows = Array.isArray(source?.relationships)
    ? source.relationships
    : (source?.nodes ?? []).filter(node => node.role === 'relationship').map(node => node.value ?? {});
  const relations = [];
  for (const row of rows) {
    const kind = row.kind?.term;
    if (!['support', 'qualify', 'conflict', 'complement'].includes(kind)) continue;
    const participants = (row.participants ?? [])
      .map(participant => ({ role: participant.role?.term ?? null, ref: typeof participant.judgment_ref === 'string' ? participant.judgment_ref : null }))
      .filter(participant => participant.ref !== null);
    relations.push({ id: typeof row.id === 'string' ? row.id : null, kind, participants });
  }
  return relations;
}
function dependencyEdges(relations) {
  const edges = [];
  for (const relation of relations) {
    if (relation.kind === 'support' || relation.kind === 'qualify') {
      const source = relation.participants.find(participant => participant.role === 'supporter' || participant.role === 'qualifier');
      const target = relation.participants.find(participant => participant.role === 'claim' || participant.role === 'qualified');
      if (source && target) edges.push({ from: source.ref, to: target.ref, role: target.role, relation_id: relation.id, kind: relation.kind });
      continue;
    }
    if (relation.kind === 'conflict' && relation.participants.length === 2) {
      const [a, b] = relation.participants;
      edges.push({ from: a.ref, to: b.ref, role: b.role, relation_id: relation.id, kind: 'conflict' });
      edges.push({ from: b.ref, to: a.ref, role: a.role, relation_id: relation.id, kind: 'conflict' });
    }
  }
  return edges;
}
function lifecycleStatuses(ir) {
  const statuses = new Map();
  for (const node of ir.nodes) {
    if (node.role !== 'judgment' || typeof node.value?.id !== 'string') continue;
    const status = node.value?.lifecycle?.status;
    statuses.set(node.value.id, typeof status === 'string' ? status : null);
  }
  return statuses;
}
const systemWarning = (code, message, detail) => ({ code, severity: 'warning', stage: 'system', subject: null, field: null, message, detail });
const pairKey = (a, b) => (a < b ? a + '\u0000' + b : b + '\u0000' + a);
function supportCycleWarnings(relations) {
  const adjacency = new Map();
  for (const edge of dependencyEdges(relations.filter(relation => relation.kind === 'support'))) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    adjacency.get(edge.from).push(edge);
  }
  const warnings = [], reported = new Set(), state = new Map();
  const stack = [];
  const visit = id => {
    state.set(id, 1); stack.push(id);
    for (const edge of adjacency.get(id) ?? []) {
      if (state.get(edge.to) === 1) {
        const cycle = stack.slice(stack.indexOf(edge.to));
        // Canonical rotation: the smallest judgment id leads, so one cycle is
        // one warning regardless of where the traversal entered it.
        const pivot = cycle.indexOf([...cycle].sort()[0]);
        const rotated = [...cycle.slice(pivot), ...cycle.slice(0, pivot)];
        const key = rotated.join('\u0000');
        if (!reported.has(key)) {
          reported.add(key);
          warnings.push(systemWarning('KDNA_SYSTEM_SUPPORT_CYCLE',
            'Support relations form a cycle; no judgment in it can rest on the others.',
            { judgment_ids: rotated, relation_ids: [...new Set(edgesWithin(rotated, adjacency).map(edge => edge.relation_id))].filter(Boolean).sort() }));
        }
      } else if (state.get(edge.to) !== 2) visit(edge.to);
    }
    state.set(id, 2); stack.pop();
  };
  for (const id of [...adjacency.keys()].sort()) if (!state.has(id)) visit(id);
  return warnings;
}
function edgesWithin(cycle, adjacency) {
  const edges = [];
  for (let i = 0; i < cycle.length; i++) {
    const from = cycle[i], to = cycle[(i + 1) % cycle.length];
    for (const edge of adjacency.get(from) ?? []) if (edge.to === to) edges.push(edge);
  }
  return edges;
}
function supportConflictPairWarnings(relations) {
  const supports = new Map(), conflicts = new Map();
  for (const relation of relations) {
    if (relation.participants.length !== 2) continue;
    const key = pairKey(relation.participants[0].ref, relation.participants[1].ref);
    if (relation.kind === 'support') (supports.get(key) ?? supports.set(key, []).get(key)).push(relation.id);
    if (relation.kind === 'conflict') (conflicts.get(key) ?? conflicts.set(key, []).get(key)).push(relation.id);
  }
  const warnings = [];
  for (const key of [...supports.keys()].sort()) {
    if (!conflicts.has(key)) continue;
    warnings.push(systemWarning('KDNA_SYSTEM_SUPPORT_CONFLICT_PAIR',
      'One judgment pair is both supported and in conflict; the recorded standing of each is ambiguous.',
      { judgment_ids: key.split('\u0000').sort(), relation_ids: [...supports.get(key), ...conflicts.get(key)].filter(Boolean).sort() }));
  }
  return warnings;
}
function withdrawnUpstreamWarnings(ir, relations) {
  const statuses = lifecycleStatuses(ir), grouped = new Map();
  for (const edge of dependencyEdges(relations.filter(relation => relation.kind === 'support' || relation.kind === 'qualify'))) {
    if (statuses.get(edge.from) !== 'withdrawn') continue;
    const downstream = statuses.get(edge.to);
    if (downstream !== null && downstream !== 'active') continue;
    const key = edge.from + '\u0000' + edge.to;
    if (!grouped.has(key)) grouped.set(key, { upstream: edge.from, downstream: edge.to, downstream_status: downstream ?? 'undeclared', relation_ids: new Set() });
    if (edge.relation_id) grouped.get(key).relation_ids.add(edge.relation_id);
  }
  return [...grouped.keys()].sort().map(key => {
    const entry = grouped.get(key);
    return systemWarning('KDNA_SYSTEM_WITHDRAWN_UPSTREAM',
      'A withdrawn judgment still carries an active downstream that depends on it.',
      { upstream_judgment_id: entry.upstream, downstream_judgment_id: entry.downstream, downstream_status: entry.downstream_status, relation_ids: [...entry.relation_ids].sort() });
  });
}
function valueOrderWarnings(ir) {
  const warnings = [];
  for (const node of ir.nodes) {
    if (node.role !== 'shared_declaration' || node.value?.kind !== 'value_order') continue;
    const declaration = node.value;
    const entries = Array.isArray(declaration.value) ? declaration.value : [];
    const counts = new Map();
    for (const entry of entries) counts.set(entry, (counts.get(entry) ?? 0) + 1);
    const duplicated = [...counts].filter(([, count]) => count > 1).map(([entry]) => entry).sort();
    if (duplicated.length) warnings.push(systemWarning('KDNA_SYSTEM_VALUE_ORDER_DUPLICATE',
      'The ordered declaration repeats an entry, so the ranking is not a strict order.',
      { declaration_id: declaration.id, duplicated_entries: duplicated }));
    const scope = declaration.applies_to;
    if (scope?.kind === 'judgments' && Array.isArray(scope.judgment_refs)) {
      const scoped = new Set(scope.judgment_refs);
      if (entries.length < scoped.size) warnings.push(systemWarning('KDNA_SYSTEM_VALUE_ORDER_MISSING_ENTRIES',
        'The ordered declaration is scoped to more judgments than it ranks; scoped items may be missing from the order.',
        { declaration_id: declaration.id, scoped_judgment_count: scoped.size, entry_count: entries.length }));
    }
  }
  return warnings;
}
function systemWarnings(ir) {
  const relations = normalizedRelations(ir);
  const warnings = [...supportCycleWarnings(relations), ...supportConflictPairWarnings(relations), ...withdrawnUpstreamWarnings(ir, relations), ...valueOrderWarnings(ir)];
  warnings.sort((a, b) => a.code < b.code ? -1 : a.code > b.code ? 1 : JSON.stringify(a.detail) < JSON.stringify(b.detail) ? -1 : 1);
  return { status: warnings.length ? 'warnings' : 'clean', warning_count: warnings.length, warnings };
}
function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  return JSON.stringify(value === undefined ? null : value);
}
const edgeKey = edge => JSON.stringify([edge.relation_id, edge.kind, edge.from, edge.to]);
function affectedByChange(originalPayload, editedPayload) {
  const before = new Map((originalPayload?.judgments ?? []).map(judgment => [judgment.id, canonicalJson(judgment)]));
  const after = new Map((editedPayload?.judgments ?? []).map(judgment => [judgment.id, canonicalJson(judgment)]));
  const changed = new Set();
  for (const [id, value] of after) if (!before.has(id) || before.get(id) !== value) changed.add(id);
  for (const id of before.keys()) if (!after.has(id)) changed.add(id);
  const producedEdges = dependencyEdges(normalizedRelations(editedPayload));
  const producedKeys = new Set(producedEdges.map(edgeKey));
  const grouped = new Map();
  for (const edge of [...producedEdges, ...dependencyEdges(normalizedRelations(originalPayload))]) {
    if (!changed.has(edge.from) || changed.has(edge.to) || edge.from === edge.to) continue;
    const state = producedKeys.has(edgeKey(edge)) ? 'in_produced_asset' : 'changed_by_this_revision';
    if (!grouped.has(edge.to)) grouped.set(edge.to, new Map());
    grouped.get(edge.to).set(edgeKey(edge), { relation_id: edge.relation_id, kind: edge.kind, role: edge.role, state });
  }
  return {
    changed_judgment_ids: [...changed].sort(),
    relation_kinds: ['support', 'qualify', 'conflict'],
    direct_downstream: [...grouped.keys()].sort().map(judgment_id => ({
      judgment_id,
      via: [...grouped.get(judgment_id).values()].sort((a, b) => (a.relation_id ?? '') < (b.relation_id ?? '') ? -1 : (a.relation_id ?? '') > (b.relation_id ?? '') ? 1 : a.kind < b.kind ? -1 : 1),
    })),
  };
}

function parse(argv) {
  const [command, ...rest] = argv;
  if (!commands.has(command)) return { error: 'KDNA_COMMAND_UNAVAILABLE' };
  const options = Object.create(null);
  const valued = new Set(['--mode', '--asset-id', '--asset-version', '--judgment-id', '--budget', '--output', '--expected-a', '--edits', '--view', '--view-accept', '--draft', '--password-fd', '--password-file', '--format']);
  let file, second;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (['--allow-create', '--allow-read', '--allow-source', '--json', '--session', '--system', '--compact'].includes(arg)) {
      if (options[arg] !== undefined) return { error: 'KDNA_ARGUMENT_INVALID' };
      options[arg] = true;
    } else if (valued.has(arg)) {
      // --judgment-id may repeat (and may carry a comma-separated list); the
      // values are kept together so every other option stays single-valued.
      const repeatable = arg === '--judgment-id' && options[arg] !== undefined;
      if ((options[arg] !== undefined && !repeatable) || i + 1 >= rest.length || rest[i + 1].startsWith('--')) return { error: 'KDNA_ARGUMENT_INVALID' };
      options[arg] = repeatable ? options[arg] + ',' + rest[++i] : rest[++i];
    } else if (arg.startsWith('-') || (file !== undefined && !(command === 'diff' && second === undefined))) return { error: 'KDNA_ARGUMENT_INVALID' };
    else if (file === undefined) file = arg;
    else second = arg;
  }
  const draftCreate = command === 'create' && options['--draft'] !== undefined;
  if (!file && !['plan', 'load', 'init'].includes(command) && !draftCreate) return { error: 'KDNA_ARGUMENT_INVALID' };
  if (file && (command === 'init' || draftCreate)) return { error: 'KDNA_ARGUMENT_INVALID' };
  if ((command === 'diff') !== (second !== undefined)) return { error: 'KDNA_ARGUMENT_INVALID' };
  const allowed = command === 'init' || command === 'compile' ? ['--output', '--json']
    : command === 'validate-input' ? ['--json']
    : command === 'create' ? ['--output', '--allow-create', '--json', '--draft']
    : command === 'protect' ? ['--output', '--password-fd', '--password-file', '--json']
    : command === 'diff' ? ['--format', '--password-fd', '--password-file', '--json']
    : command === 'source-open' ? ['--expected-a', '--allow-source', '--json']
    : command === 'source-pack' ? ['--expected-a', '--edits', '--output', '--allow-source', '--json']
    : command === 'convert' ? ['--expected-a', '--output', '--allow-source', '--json']
    : command === 'read' ? ['--mode', '--asset-id', '--asset-version', '--judgment-id', '--budget', '--allow-read', '--json', '--session', '--view', '--view-accept', '--compact', '--format', '--password-fd', '--password-file']
    : command === 'validate' ? ['--json', '--system', '--format', '--password-fd', '--password-file'] : ['--json', '--format', '--password-fd', '--password-file'];
  if (Object.keys(options).some(k => !allowed.includes(k))) return { error: 'KDNA_ARGUMENT_INVALID' };
  if ((command === 'create' || command === 'protect') && (!options['--output'] || !options['--output'].endsWith('.kdna'))) return { error: 'KDNA_ARGUMENT_INVALID' };
  if (options['--password-fd'] !== undefined && options['--password-file'] !== undefined) return { error: 'KDNA_ARGUMENT_INVALID' };
  if (options['--password-fd'] !== undefined && !/^(?:[3-9]|[1-9][0-9]+)$/.test(options['--password-fd'])) return { error: 'KDNA_ARGUMENT_INVALID' };
  if (command === 'protect' && options['--password-fd'] === undefined && options['--password-file'] === undefined) return { error: 'KDNA_PASSWORD_SOURCE_REQUIRED' };
  if (options['--format'] !== undefined && !['json', 'human'].includes(options['--format'])) return { error: 'KDNA_ARGUMENT_INVALID' };
  if (options['--compact'] && options['--view'] !== undefined && options['--view'] !== 'body') return { error: 'KDNA_ARGUMENT_INVALID' };
  if ((command === 'init' || command === 'compile') && options['--output'] !== undefined && !options['--output'].endsWith('.json')) return { error: 'KDNA_ARGUMENT_INVALID' };
  if ((command.startsWith('source-') || command === 'convert') && !/^sha256:[0-9a-f]{64}$/.test(options['--expected-a'] || '')) return { error: 'KDNA_ARGUMENT_INVALID' };
  if (command === 'source-pack' && !options['--edits']) return { error: 'KDNA_ARGUMENT_INVALID' };
  if ((command === 'source-pack' || command === 'convert') && (!options['--output'] || !options['--output'].endsWith('.kdna'))) return { error: 'KDNA_ARGUMENT_INVALID' };
  // A session carries one ReadRequest per line, so a CLI-level request option may
  // not accompany it. --view names the output surface, not the request, so it may.
  if (options['--session'] && Object.keys(options).some(k => !['--view', '--view-accept', '--format', '--password-fd', '--password-file'].includes(k) && valued.has(k))) return { error: 'KDNA_ARGUMENT_INVALID' };
  return { command, file, second, options };
}

async function* requestLines(input) {
  let pending = Buffer.alloc(0);
  for await (const part of input) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    let start = 0;
    for (let end = 0; end <= chunk.length; end++) {
      if (end !== chunk.length && chunk[end] !== 10) continue;
      if (pending.length + end - start > 1048576) throw new Error('KDNA_SESSION_INPUT_TOO_LARGE');
      pending = Buffer.concat([pending, chunk.subarray(start, end)]);
      if (end < chunk.length) { yield pending; pending = Buffer.alloc(0); }
      start = end + 1;
    }
  }
  if (pending.length) yield pending;
}

function sessionInput(input) {
  let iterator, closing;
  let stopped = false, finished = false, canceled = false;
  const done = () => ({ done: true });
  const close = () => {
    if (!iterator || finished) return Promise.resolve(done());
    stopped = true;
    if (!closing) {
      closing = Promise.resolve().then(() => typeof iterator.return === 'function' ? iterator.return() : done());
      // A failed run may finish first; retain observation of late cleanup rejection.
      closing.catch(() => undefined);
    }
    return closing;
  };
  return {
    cancel() {
      if (canceled) return;
      canceled = true;
      stopped = true;
      // Node input can be destroyed; arbitrary external iterator work cannot.
      Promise.resolve().then(() => {
        if (iterator && input instanceof Readable) input.destroy();
      }).catch(() => undefined);
      close();
    },
    iterable: {
      [Symbol.asyncIterator]() {
        iterator = input[Symbol.asyncIterator]();
        if (stopped) close();
        return {
          async next() {
            if (stopped) return done();
            const item = await iterator.next();
            if (stopped) return done();
            if (item.done) finished = true;
            return item;
          },
          return: close,
        };
      },
    },
  };
}

function outputWriter(stdout) {
  const stream = stdout instanceof Writable;
  const pending = new Set();
  let failure, failed = false, cancelInput = () => {}, rejectStopped;
  const stopped = new Promise((resolve, reject) => { rejectStopped = reject; });
  stopped.catch(() => undefined);
  const fail = error => {
    if (failed) return;
    failed = true;
    failure = error;
    for (const reject of pending) reject(failure);
    pending.clear();
    rejectStopped(failure);
    cancelInput();
  };
  const closed = () => fail(new Error('KDNA_CLI_OUTPUT_CLOSED'));
  if (stream) {
    stdout.on('error', fail); stdout.on('close', closed);
    if (stdout.destroyed || stdout.writableEnded) fail(stdout.errored || new Error('KDNA_CLI_OUTPUT_CLOSED'));
  }
  return {
    onFailure(cancel) { cancelInput = cancel; if (failed) cancelInput(); },
    check() { if (failed) throw failure; },
    settle(operation) {
      // The entire operation, including already-pending cleanup, stays observed.
      return Promise.race([operation, stopped]);
    },
    async write(text) {
      if (failed) throw failure;
      if (!stream) {
        try {
          if (stdout.write(text) === false) throw new Error('KDNA_CLI_OUTPUT_UNAVAILABLE');
        } catch (error) { fail(error); throw error; }
        return;
      }
      if (stdout.destroyed || stdout.writableEnded) {
        const error = stdout.errored || new Error('KDNA_CLI_OUTPUT_CLOSED');
        fail(error); throw error;
      }
      await new Promise((resolve, reject) => {
        pending.add(reject);
        try {
          stdout.write(text, error => {
            pending.delete(reject);
            if (error) fail(error);
            if (failed) reject(failure); else resolve();
          });
        } catch (error) { pending.delete(reject); fail(error); reject(error); }
      });
    },
    async release() {
      // Node may emit its write error after invoking the write callback.
      if (stream) {
        await new Promise(resolve => setImmediate(resolve));
        stdout.removeListener('error', fail);
        stdout.removeListener('close', closed);
      }
    },
  };
}

async function run(argv, stdout = process.stdout, stdin = process.stdin, { now = () => Date.now() } = {}) {
  const output = outputWriter(stdout);
  const input = sessionInput(stdin);
  output.onFailure(input.cancel);
  let code, failure, rejected = false;
  try { code = await output.settle(runWithOutput(argv, text => output.write(text), input.iterable, () => output.check(), now)); }
  catch (error) { rejected = true; failure = error; input.cancel(); }
  finally { await output.release(); }
  output.check();
  if (rejected) throw failure;
  return code;
}

async function runWithOutput(argv, write, stdin, assertActive, now = () => Date.now()) {
  // Whatever a run unlocked or read for a password is released when it ends.
  const cleanups = [];
  try { return await runCommand(argv, write, stdin, assertActive, now, cleanups); }
  finally { for (const cleanup of cleanups) { try { cleanup(); } catch { /* already released */ } } }
}

async function runCommand(argv, write, stdin, assertActive, now, cleanups) {
  const emit = value => write(JSON.stringify(value) + '\n');
  const unavailable = async (code, diagnostic) => {
    const result = { status: 'unavailable', code, action_authorized: false };
    if (diagnostic) result.diagnostic = diagnostic;
    await emit(result);
    return 2;
  };
  if (!argv.length || argv.length === 1 && ['--help', '-h'].includes(argv[0])) { await write(help); return 0; }
  if (argv.length === 1 && argv[0] === '--version') { await write(require('../package.json').version + '\n'); return 0; }
  const parsed = parse(argv);
  if (parsed.error) return unavailable(parsed.error);
  const { command, file, second, options } = parsed;
  if (command === 'plan' || command === 'load') {
    await emit({ status: 'unavailable', code: command === 'plan' ? 'KDNA_PLAN_ADMISSION_UNAVAILABLE' : 'KDNA_PLAN_EXECUTION_UNAVAILABLE', action_authorized: false, creation_accepted: false });
    return 2;
  }
  if (command === 'source-open' || command === 'source-pack') {
    if (!options['--allow-source']) {
      await emit({ status: 'rejected', code: 'KDNA_SOURCE_PERMISSION_REQUIRED', action_authorized: false });
      return 1;
    }
    assertActive();
    let edits, bytes;
    if (command === 'source-pack') {
      try { edits = await readSourceEdits(options['--edits'], assertActive); }
      catch { assertActive(); return unavailable('KDNA_SOURCE_EDITS_INVALID'); }
      assertActive();
    }
    try { bytes = await readAssetBytes(file, assertActive); }
    catch { assertActive(); return unavailable('KDNA_ASSET_INPUT_INVALID'); }
    assertActive();
    const request = admitSourceOperationRequest({ request_id: 'cli:' + randomUUID(), tuple: binding.tuple,
      operation: command === 'source-open' ? 'open_source' : 'pack_source', expected_A: options['--expected-a'], timeout_ms: 60000,
      signature_policy: { requireSignature: false, expectedPublicKeyHex: null } });
    if (request.status !== 'admitted_request') { await emit(request); return 1; }
    assertActive();
    const authority = createNativeSourceOperationAuthority(() => { assertActive(); return true; });
    // Change propagation is computed from what this run actually discloses: the
    // same original bytes reopened through the same authority, then diffed
    // against the edit payload the pack itself consumes.
    let sourcePayload = null;
    if (command === 'source-pack') {
      const disclosure = admitSourceOperationRequest({ request_id: 'cli:' + randomUUID(), tuple: binding.tuple,
        operation: 'open_source', expected_A: options['--expected-a'], timeout_ms: 60000,
        signature_policy: { requireSignature: false, expectedPublicKeyHex: null } });
      if (disclosure.status === 'admitted_request') {
        const opened = await openSectionSourceNode(bytes, disclosure.request, authority);
        if (opened.status === 'source_opened') sourcePayload = opened.source.payload;
      }
      assertActive();
    }
    const result = command === 'source-open'
      ? await openSectionSourceNode(bytes, request.request, authority)
      : await packSectionSourceNode(bytes, request.request, authority, edits);
    assertActive();
    if (command === 'source-open' && result.status === 'source_opened') {
      await emit({ status: 'source_opened', observation: result.source.observation,
        edits: { manifest: result.source.manifest, payload: result.source.payload },
        transport: { format: 'kdna.source-edits-json/1', original_asset_required: true,
          original_members: 'retained_by_native_source', logical_payload: 'derived_by_core' },
        states: independentStates(), action_authorized: false, adoption: 'not_observed' });
      return 0;
    }
    if (command === 'source-open' || result.status !== 'produced') { await emit(result); return 1; }
    let saved;
    try { saved = await saveNewAsset(options['--output'], result.bytes, assertActive); }
    catch (error) { assertActive(); await emit({ status: 'save_failed', code: error.message === 'KDNA_OUTPUT_EXISTS' ? error.message : 'KDNA_SAVE_FAILED', action_authorized: false, creation_accepted: false }); return 1; }
    assertActive();
    await emit({ status: 'saved', output: { file: options['--output'], bytes: result.bytes.length,
      sha256: createHash('sha256').update(result.bytes).digest('hex'), cleanup: saved.cleanup },
      ...(command === 'source-pack' && sourcePayload ? { affected_by_change: affectedByChange(sourcePayload, edits.payload) } : {}),
      evidence: result.evidence, states: independentStates(), action_authorized: false, creation_accepted: false, adoption: 'not_observed' });
    return 0;
  }
  if (command === 'convert') {
    if (!options['--allow-source']) {
      await emit({ status: 'rejected', code: 'KDNA_SOURCE_PERMISSION_REQUIRED', action_authorized: false });
      return 1;
    }
    assertActive();
    let bytes;
    try { bytes = await readAssetBytes(file, assertActive); }
    catch { assertActive(); return unavailable('KDNA_ASSET_INPUT_INVALID'); }
    assertActive();
    const request = admitSourceMigrationRequest({ request_id: 'cli:' + randomUUID(), tuple: binding.tuple,
      operation: 'migrate_public_source', source_expected_A: options['--expected-a'], timeout_ms: 60000,
      signature_policy: { requireSignature: false, expectedPublicKeyHex: null } });
    if (request.status !== 'admitted_request') { await emit(request); return 1; }
    assertActive();
    const authority = createNativeSourceMigrationAuthority(() => { assertActive(); return true; });
    const result = await migratePublicSourceNode(bytes, request.request, authority);
    assertActive();
    if (result.status !== 'migrated') { await emit(result); return 1; }
    let saved;
    try { saved = await saveNewAsset(options['--output'], result.bytes, assertActive); }
    catch (error) { assertActive(); await emit({ status: 'save_failed', code: error.message === 'KDNA_OUTPUT_EXISTS' ? error.message : 'KDNA_SAVE_FAILED', action_authorized: false, creation_accepted: false }); return 1; }
    assertActive();
    await emit({ status: 'saved', output: { file: options['--output'], bytes: result.bytes.length,
      sha256: createHash('sha256').update(result.bytes).digest('hex'), cleanup: saved.cleanup },
      observation: result.observation, states: independentStates(), action_authorized: false, creation_accepted: false, adoption: 'not_observed' });
    return 0;
  }
  const readJson = async path => {
    let bytes;
    try { bytes = await readBoundedFile(path, 20 * 1024 * 1024, 'KDNA_AUTHORED_INPUT_INVALID', assertActive); }
    catch { assertActive(); return { error: unavailable('KDNA_AUTHORED_INPUT_INVALID', { field: null, reason: 'unreadable_or_over_limit' }) }; }
    try { return { value: parseJsonBytes(bytes) }; }
    catch (error) { return { error: unavailable('KDNA_AUTHORED_INPUT_INVALID', error?.diagnostic ?? { field: '/', reason: 'not_json', expected: 'one UTF-8 JSON object' }) }; }
  };
  const saveJson = async (outputPath, value) => {
    const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
    try { await saveNewAsset(outputPath, bytes, assertActive); }
    catch (error) { assertActive(); await emit({ status: 'save_failed', code: error.message === 'KDNA_OUTPUT_EXISTS' ? error.message : 'KDNA_SAVE_FAILED', action_authorized: false, creation_accepted: false }); return 1; }
    await emit({ status: 'saved', output: { file: outputPath, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }, action_authorized: false, creation_accepted: false });
    return 0;
  };
  if (command === 'init') {
    const draft = scaffoldDraft();
    if (options['--output'] !== undefined) return saveJson(options['--output'], draft);
    await write(JSON.stringify(draft, null, 2) + '\n');
    return 0;
  }
  if (command === 'compile') {
    const loaded = await readJson(file);
    if (loaded.error) return loaded.error;
    let authored;
    try { authored = compileDraft(loaded.value); }
    catch (error) {
      if (error?.message !== 'KDNA_DRAFT_INVALID') throw error;
      await emit({ status: 'rejected', code: 'KDNA_DRAFT_INVALID', diagnostics: error.diagnostics ?? [], action_authorized: false, creation_accepted: false });
      return 1;
    }
    if (options['--output'] !== undefined) return saveJson(options['--output'], authored);
    await write(JSON.stringify(authored, null, 2) + '\n');
    return 0;
  }
  if (command === 'validate-input') {
    const loaded = await readJson(file);
    if (loaded.error) return loaded.error;
    const checked = await validateWithCore(loaded.value);
    await emit({ ...checked, action_authorized: false, creation_accepted: false });
    return checked.status === 'valid' ? 0 : 1;
  }
  if (command === 'create') {
    if (!options['--allow-create']) {
      await emit({ status: 'rejected', code: 'KDNA_CREATE_PERMISSION_REQUIRED', action_authorized: false, creation_accepted: false });
      return 1;
    }
    let input;
    if (options['--draft'] !== undefined) {
      const loaded = await readJson(options['--draft']);
      if (loaded.error) return loaded.error;
      // A scaffold that still carries its placeholder text is flagged here so it
      // cannot become an asset by accident; compile alone tolerates it.
      const checked = validateInput(loaded.value);
      if (checked.status !== 'valid') {
        await emit({ status: 'rejected', code: 'KDNA_DRAFT_INVALID', diagnostics: checked.diagnostics, action_authorized: false, creation_accepted: false });
        return 1;
      }
      try { input = compileDraft(loaded.value); }
      catch (error) {
        if (error?.message !== 'KDNA_DRAFT_INVALID') throw error;
        await emit({ status: 'rejected', code: 'KDNA_DRAFT_INVALID', diagnostics: error.diagnostics ?? [], action_authorized: false, creation_accepted: false });
        return 1;
      }
    } else {
      try { input = await readAuthoredInput(file); }
      catch (error) { return unavailable('KDNA_AUTHORED_INPUT_INVALID', error?.diagnostic ?? null); }
    }
    const request = admitNativeCreationRequest({ request_id: 'cli:' + randomUUID(), tuple: binding.tuple, operation: 'create_public_asset', timeout_ms: 60000 });
    if (request.status !== 'admitted_request') { await emit(request); return 1; }
    const authority = createNativeCreationAuthority(() => true);
    assertActive();
    const produced = await createSectionAssetNode(input, request.request, authority);
    if (produced.status !== 'produced') {
      const guidance = authoringGuidance(input, produced);
      // Field-level hints are a presentation aid beside the Core diagnostic,
      // never a replacement for it.
      let inputDiagnostics = null;
      try { const checked = validateInput(input); if (checked.status === 'invalid') inputDiagnostics = checked.diagnostics; } catch { inputDiagnostics = null; }
      await emit({ ...produced, ...(guidance ? { guidance } : {}), ...(inputDiagnostics ? { input_diagnostics: inputDiagnostics } : {}) });
      return 1;
    }
    let saved;
    try { saved = await saveNewAsset(options['--output'], produced.bytes, assertActive); }
    catch (error) { await emit({ status: 'save_failed', code: error.message === 'KDNA_OUTPUT_EXISTS' ? error.message : 'KDNA_SAVE_FAILED', action_authorized: false, creation_accepted: false }); return 1; }
    await emit({ status: 'saved', output: { file: options['--output'], bytes: produced.bytes.length, sha256: createHash('sha256').update(produced.bytes).digest('hex'), cleanup: saved.cleanup }, evidence: produced.evidence, states: independentStates(), action_authorized: false, creation_accepted: false, adoption: 'not_observed' });
    return 0;
  }
  // A password comes from an inherited descriptor or a file, never from argv, is
  // read once per run and is zeroed when the run ends.
  let passwordValue;
  const passwordBytes = () => {
    if (passwordValue !== undefined) return passwordValue;
    const fd = options['--password-fd'], passwordFile = options['--password-file'];
    if (fd === undefined && passwordFile === undefined) return (passwordValue = null);
    passwordValue = readPasswordSource({ fd: fd === undefined ? undefined : Number(fd), file: passwordFile });
    cleanups.push(() => passwordValue?.fill(0));
    return passwordValue;
  };
  const passwordRefusal = error => ({ status: 'rejected', code: typeof error?.code === 'string' ? error.code : 'KDNA_PASSWORD_INVALID', action_authorized: false });
  // The asset is admitted either as a public asset or, for a password-protected
  // one, through the protected route with the password the caller supplied.
  async function whole(target = file) {
    const request = admitSectionRequest({ request_id: 'cli:' + randomUUID(), tuple: binding.tuple, budget_bytes: 100000000, mode: 'whole_asset', selection: null, handle: null });
    let bytes;
    try { bytes = await readAssetBytes(target, assertActive); }
    catch { assertActive(); return { status: 'rejected', code: 'KDNA_ASSET_INPUT_INVALID', action_authorized: false }; }
    assertActive();
    if (isProtectedBytes(bytes)) {
      let password;
      try { password = passwordBytes(); } catch (error) { return passwordRefusal(error); }
      if (!password) {
        return { status: 'rejected', code: 'KDNA_PASSWORD_REQUIRED', reason: 'the asset is password-protected', next: 'pass --password-fd <fd> or --password-file <path>; the password is never accepted on the command line', action_authorized: false };
      }
      const admitted = await admitProtectedWithPassword(bytes, password, { now });
      assertActive();
      if (admitted.status !== 'accepted') return { status: 'rejected', code: admitted.code, stage: 'protected_admission', action_authorized: false };
      cleanups.push(() => admitted.dispose());
      return { status: 'accepted', protectedAdmission: admitted };
    }
    return admitSectionBytesNode(bytes, request, createNativeSectionByteReadAuthority(() => true));
  }
  const viewOf = admission => admission.protectedAdmission ? admission.protectedAdmission.view : inspectWholeSectionSnapshot(admission.snapshot);
  const humanOutput = options['--format'] === 'human';
  const emitResult = async (result, render) => humanOutput ? write(render(result) + '\n') : emit(result);
  if (command === 'protect') {
    let bytes, password;
    try { password = passwordBytes(); } catch (error) { await emit(passwordRefusal(error)); return 1; }
    try { bytes = await readAssetBytes(file, assertActive); }
    catch { assertActive(); return unavailable('KDNA_ASSET_INPUT_INVALID'); }
    assertActive();
    const result = await protectAsset(bytes, password);
    assertActive();
    if (result.status !== 'produced') { await emit({ status: 'rejected', code: result.code ?? 'KDNA_PROTECT_FAILED', stage: 'protect', action_authorized: false, creation_accepted: false }); return 1; }
    let saved;
    try { saved = await saveNewAsset(options['--output'], result.bytes, assertActive); }
    catch (error) { assertActive(); await emit({ status: 'save_failed', code: error.message === 'KDNA_OUTPUT_EXISTS' ? error.message : 'KDNA_SAVE_FAILED', action_authorized: false, creation_accepted: false }); return 1; }
    assertActive();
    await emit({ status: 'saved', output: { file: options['--output'], bytes: result.bytes.length, sha256: createHash('sha256').update(result.bytes).digest('hex'), cleanup: saved.cleanup },
      protection: { kind: 'password', profile: 'password', encrypted_entries: ['payload.kdnab'], offline: true },
      evidence: result.evidence, states: independentStates(), action_authorized: false, creation_accepted: false, adoption: 'not_observed' });
    return 0;
  }
  if (command === 'diff') {
    const left = await whole(file);
    if (left.status !== 'accepted') { await emit(left); return 1; }
    const right = await whole(second);
    if (right.status !== 'accepted') { await emit(right); return 1; }
    const leftView = viewOf(left), rightView = viewOf(right);
    if (!leftView || !rightView) { await emit({ status: 'rejected', reason: 'READ_SNAPSHOT_UNATTESTED' }); return 1; }
    const result = diffViews(leftView, rightView);
    await emitResult(result, renderDiffHuman);
    return 0;
  }
  if (command === 'inspect' || command === 'validate') {
    const admission = await whole();
    if (admission.status !== 'accepted') { await emitResult(admission, result => renderRejectionHuman(command, result)); return 1; }
    const view = viewOf(admission);
    if (!view) { await emit({ status: 'rejected', reason: 'READ_SNAPSHOT_UNATTESTED' }); return 1; }
    const result = { status: 'accepted', format_valid: true, states: { ...independentStates(), core: 'valid', interpretation: 'complete' }, diagnostics: [] };
    if (command === 'inspect' && admission.protectedAdmission) {
      Object.assign(result, { tuple: view.tuple, asset: view.asset, digests: view.digests, ir_digest: view.ir_digest, judgment_count: view.ir.catalog.length, runtime_entry_names: view.runtime_entry_names,
        protection: { status: 'unlocked', profile: 'password', encrypted_entries: ['payload.kdnab'] } });
    } else if (command === 'inspect') {
      Object.assign(result, { tuple: view.tuple, asset: view.asset, digests: view.digests, ir_digest: view.verification.ir_digest.digest, verification: view.verification, judgment_count: view.ir.catalog.length, runtime_entry_names: view.runtime_entry_names });
    }
    // --system adds warnings-only integrity findings; they never change the
    // acceptance, the exit status or any field of the unchanged output shape.
    if (command === 'validate' && options['--system'] === true) result.system = systemWarnings(view.ir);
    await emitResult(result, command === 'inspect' ? renderInspectHuman : renderValidateHuman);
    return 0;
  }
  let retainedSnapshot = null, retainedView = null, retainedProtected = null, delivered = false;
  const allow = options['--allow-read'] === true;
  if (!allow) {
    await emit({ status: 'rejected', code: 'KDNA_READ_PERMISSION_REQUIRED', action_authorized: false });
    return 1;
  }
  const authority = createRetainedSectionReadAuthority(() => allow);
  const viewOption = options['--view'];
  if (viewOption !== undefined && !['body', 'full', 'raw'].includes(viewOption)) return unavailable('KDNA_ARGUMENT_INVALID');
  const modelView = loadModelView();
  const view = viewOption ?? 'body';
  // Raw is the library envelope itself, not a model view: the acceptance pin has
  // nothing to accept there, so the combination is refused instead of ignored.
  if (viewOption === 'raw' && options['--view-accept'] !== undefined) return unavailable('KDNA_ARGUMENT_INVALID');
  // Without the capability the default path prints exactly what this CLI printed
  // before the flag existed; an explicit body request that cannot be honoured is
  // refused rather than quietly answered with the full surface.
  if (viewOption === 'body' && !modelView) return unavailable('KDNA_MODEL_VIEW_UNAVAILABLE');
  const viewAccept = options['--view-accept'] ?? REQUIRED_MODEL_VIEW;
  // An explicit acceptance without an installed projection has nothing to accept.
  if (options['--view-accept'] !== undefined && !modelView) return unavailable('KDNA_MODEL_VIEW_UNAVAILABLE');
  let projectionFailure = null;
  // The full surface is the raw answer without the reduction machinery; the body
  // surface is the author body; raw prints the library envelope unchanged for
  // adapters that project themselves. Every projection surface is asked of the
  // installed projection and carries the accepted contract; a refusal is emitted
  // verbatim instead of silently degrading to another surface.
  const projected = result => {
    if (view === 'raw') return result;
    if (!modelView) return result;
    try { return modelView.projectModelView(result, { view, mode: result?.envelope?.mode, accept: viewAccept }); }
    catch (error) {
      projectionFailure = error;
      const refusal = { status: 'unavailable', code: typeof error?.code === 'string' ? error.code : 'KDNA_MODEL_VIEW_UNAVAILABLE' };
      if (typeof error?.message === 'string') refusal.message = error.message;
      if (error?.guidance !== undefined) refusal.guidance = error.guidance;
      return refusal;
    }
  };
  // --compact trims the repeated asset-level material from the body view; a
  // refusal or another view is shown exactly as it is. --format human renders
  // the same facts as text.
  const present = async result => {
    if (humanOutput) { await write(renderReadHuman(result) + '\n'); return; }
    let shown = result;
    if (options['--compact'] === true && view === 'body' && result?.view === 'body') { try { shown = compactReadResult(result); } catch { shown = result; } }
    await emit(shown);
  };
  const sessionHandles = options['--session'] && modelView && typeof modelView.collectExpansionHandles === 'function' ? new Map() : null;
  const host = createTrustedHostReadProvider({
    observe({ request, preparation }) {
      const observedAt = now();
      return { host_id: 'kdna-cli:local', host_epoch: 'process:' + process.pid, decision_id: 'decision:' + request.request_id,
        operation_id: preparation.intent.operation_id, request_id: request.request_id, request_digest: preparation.request_digest,
        origin: preparation.origin, intent_digest: preparation.intent_digest, asset: preparation.asset, tuple: preparation.tuple,
        scope: retainedView.ir.nodes.map(node => node.id), issued_at: observedAt, expires_at: observedAt + 60000,
        decision: allow ? 'allow' : 'deny', policy_id: 'kdna-cli:explicit-local-read-consent', current_ms: observedAt };
    },
    async deliver(result) { await present(projected(result)); delivered = true; return true; },
  });
  // Loads and retains the admitted snapshot once; null means it is available,
  // anything else is the exit code of an already-emitted refusal.
  async function ensureRetained() {
    if (retainedSnapshot || retainedProtected) return null;
    const admission = await whole();
    if (admission.status !== 'accepted') { await emit(admission); return 1; }
    if (admission.protectedAdmission) {
      retainedProtected = admission.protectedAdmission;
      retainedView = retainedProtected.view;
      return null;
    }
    retainedSnapshot = admission.snapshot;
    retainedView = inspectWholeSectionSnapshot(retainedSnapshot);
    if (!retainedView) { await emit({ status: 'rejected', reason: 'READ_SNAPSHOT_UNATTESTED' }); return 1; }
    return null;
  }
  async function read(request) {
    // Explicit CLI consent and native request admission precede asset reads.
    const admitted = admitRetainedSectionRequest(request);
    if (admitted.status !== 'admitted_request') { await emit(admitted); return 1; }
    const loadFailure = await ensureRetained();
    if (loadFailure !== null) return loadFailure;
    let result;
    delivered = false;
    projectionFailure = null;
    if (retainedProtected) {
      // The password-protected route: Core decrypted and admitted the payload at
      // load time; this request is bound to that one operation.
      result = await readProtected(retainedProtected, { mode: request.mode, budget_bytes: request.budget_bytes, selection: request.selection, handle: request.handle });
      await present(projected(result));
      delivered = true;
    } else {
      const preparation = await prepareRetainedSectionRead(retainedSnapshot, admitted.request, authority);
      if (preparation.status !== 'prepared') { await emit(preparation); return 1; }
      result = await readRetainedSection(preparation.prepared, host);
    }
    if (!delivered) await present(result);
    if (!options['--session']) {
      const note = budgetNote(result);
      if (note) process.stderr.write(note + '\n');
    }
    if (projectionFailure) return 2;
    // The delivered answer's handles are kept for this session so a later
    // expand request can name one by its compact id.
    if (sessionHandles) modelView.collectExpansionHandles(result, sessionHandles);
    return result.channel === 'read_envelope' && ['ready', 'catalog_only'].includes(result.envelope.status) ? 0 : 1;
  }
  if (options['--session']) {
    let code = 0;
    try {
      for await (const bytes of requestLines(stdin)) {
        let request;
        try { request = parseJsonBytes(bytes); }
        catch { return await unavailable('KDNA_SESSION_JSON_INVALID'); }
        if (request && typeof request === 'object' && request.handle_id !== undefined) {
          // A compact id from a reduced body entry resolves to the exact handle
          // this session was issued. The resolution refuses what it cannot prove
          // and grants nothing: the resolved handle still passes the complete
          // read admission below.
          if (request.mode !== 'expand' || (request.handle !== undefined && request.handle !== null)) return await unavailable('KDNA_ARGUMENT_INVALID');
          const resolve = modelView && typeof modelView.resolveExpansionHandle === 'function' ? modelView.resolveExpansionHandle : null;
          const resolution = resolve && sessionHandles
            ? resolve(sessionHandles, request.handle_id, {
                current_ms: now(),
                snapshot_id: retainedView?.snapshot_id,
                asset_id: retainedView?.asset?.asset_id,
                asset_version: retainedView?.asset?.asset_version,
              })
            : { status: 'unavailable', code: 'READ_HANDLE_UNKNOWN', message: 'the id does not name an expansion handle this session was issued', guidance: { action: 'request a fresh read and use one of the handle ids that answer returned' } };
          if (resolution.status !== 'ready') { await emit(resolution); code = Math.max(code, 2); continue; }
          request = { ...request, handle: resolution.handle };
          delete request.handle_id;
        }
        code = Math.max(code, await read(request));
      }
    } catch (error) {
      if (error?.message === 'KDNA_SESSION_INPUT_TOO_LARGE') return unavailable(error.message);
      throw error;
    }
    return code;
  }
  const mode = options['--mode'] ?? 'catalog';
  const budgetText = options['--budget'] ?? '1000000';
  if (!/^(0|[1-9][0-9]*)$/.test(budgetText) || !Number.isSafeInteger(Number(budgetText))) return unavailable('KDNA_ARGUMENT_INVALID');
  if (mode === 'expand') return unavailable('KDNA_READ_SESSION_REQUIRED');
  const selectionValues = ['--asset-id', '--asset-version', '--judgment-id'].map(k => options[k]);
  if (['whole_asset', 'catalog'].includes(mode) && selectionValues.some(v => v !== undefined)) return unavailable('KDNA_ARGUMENT_INVALID');
  // Several judgment ids without --session: the catalog order is read from the
  // admitted asset itself, so the one exact_selection request this builds is
  // the same request a two-line session would have sent.
  const judgmentIds = options['--judgment-id'] === undefined ? undefined : options['--judgment-id'].split(',');
  if (judgmentIds && (judgmentIds.some(id => id === '') || new Set(judgmentIds).size !== judgmentIds.length)) return unavailable('KDNA_ARGUMENT_INVALID');
  if (judgmentIds && judgmentIds.length > 1) {
    if (mode !== 'exact_selection') return unavailable('KDNA_ARGUMENT_INVALID');
    const failure = await ensureRetained();
    if (failure !== null) return failure;
    const known = retainedView.ir.catalog.map(entry => entry.judgment_id);
    const missing = judgmentIds.filter(id => !known.includes(id));
    if (missing.length) {
      await emit({ status: 'rejected', code: 'KDNA_JUDGMENT_ID_UNKNOWN', unknown_judgment_ids: missing, catalog_judgment_ids: known, action_authorized: false });
      return 1;
    }
    const ordered = known.filter(id => judgmentIds.includes(id));
    return read({ request_id: 'cli:' + randomUUID(), tuple: binding.tuple, budget_bytes: Number(budgetText), mode, selection: { asset_id: options['--asset-id'] ?? retainedView.asset.asset_id, asset_version: options['--asset-version'] ?? retainedView.asset.asset_version, judgment_ids: ordered }, handle: null });
  }
  // One id with the asset id/version left out: they default to the admitted asset, as for several ids.
  const singleDefault = mode === 'exact_selection' && judgmentIds && judgmentIds.length === 1 && (options['--asset-id'] === undefined || options['--asset-version'] === undefined);
  if (singleDefault) {
    const failure = await ensureRetained();
    if (failure !== null) return failure;
    if (options['--asset-id'] === undefined) options['--asset-id'] = retainedView.asset.asset_id;
    if (options['--asset-version'] === undefined) options['--asset-version'] = retainedView.asset.asset_version;
  }
  return read({ request_id: 'cli:' + randomUUID(), tuple: binding.tuple, budget_bytes: Number(budgetText), mode, selection: ['whole_asset', 'catalog'].includes(mode) ? null : { asset_id: options['--asset-id'], asset_version: options['--asset-version'], judgment_ids: options['--judgment-id'] === undefined ? undefined : [options['--judgment-id']] }, handle: null });
}
module.exports = { run };
