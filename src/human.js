'use strict';
// Human (plain text, no ANSI) renderers for the JSON the CLI emits for `inspect`, `validate [--system]`
// and `read`, plus `compactReadResult`, the lean projection behind `read --compact`.
// Every renderer is total: an unknown shape degrades to status/code plus pretty JSON, never a throw.

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const WIDTH = 100;

function wrap(text, indent = '  ') {
  const words = String(text).split(/\s+/).filter(Boolean), lines = [];
  let line = '';
  for (const word of words) {
    if (line && (indent + line + ' ' + word).length > WIDTH) { lines.push(indent + line); line = word; }
    else line = line ? line + ' ' + word : word;
  }
  lines.push(indent + line);
  return lines.join('\n');
}

const shortDigest = value => (typeof value === 'string' ? value.replace(/^(sha256:)([0-9a-f]{12})[0-9a-f]+$/, '$1$2…') : String(value ?? '-'));
const pretty = value => JSON.stringify(value, null, 2);
const fallback = (title, value) => title + '\n' + pretty(value === undefined ? null : value) + '\n';
const safe = (render, value, name) => {
  try { return render(value); }
  catch (error) { return `${name}: could not render (${error?.message ?? 'error'})\n` + pretty(value === undefined ? null : value) + '\n'; }
};

const STATE_EXPLANATIONS = {
  writer: 'who authored it (not evaluated by reading)',
  confirmation: 'whether the author claim is verified',
  read_permission: 'whether this read was permitted',
  action_authorization: 'whether any action is authorised (reading never authorises one)',
  core: 'the asset passes core format checks',
  interpretation: 'whether the asset could be fully interpreted',
};

const SYSTEM_EXPLANATIONS = {
  KDNA_SYSTEM_SUPPORT_CYCLE: 'Judgments support each other in a loop, so none of them is grounded independently.',
  KDNA_SYSTEM_SUPPORT_CONFLICT_PAIR: 'The same pair of judgments is both supporting and conflicting; their standing is ambiguous.',
  KDNA_SYSTEM_WITHDRAWN_UPSTREAM: 'An active judgment depends on one that has been withdrawn.',
  KDNA_SYSTEM_VALUE_ORDER_DUPLICATE: 'The value order ranks the same item more than once.',
  KDNA_SYSTEM_VALUE_ORDER_MISSING_ENTRIES: 'The value order is scoped to more judgments than it ranks.',
};

const CODE_NEXT_STEPS = {
  READ_BUDGET_INSUFFICIENT: 'Retry with a larger --budget (above the required bytes shown); nothing was truncated.',
  READ_RESPONSE_BUDGET_TOO_SMALL: 'Retry with a larger --budget (default 1000000); no content was delivered.',
  READ_SELECTION_NOT_FOUND: 'Run `kdna read <file> --mode catalog --allow-read` and use a judgment id it lists.',
  KDNA_READ_PERMISSION_REQUIRED: 'Re-run with --allow-read to grant this one local read.',
  KDNA_ARGUMENT_INVALID: 'Check the command arguments against `kdna read --help`.',
  KDNA_ASSET_INPUT_INVALID: 'Check that the path is a readable .kdna file.',
  KDNA_MODEL_VIEW_UNAVAILABLE: 'Use --view raw, or install a kdna-read with the model-view projection.',
  READ_HANDLE_UNKNOWN: 'Request a fresh read and use a handle id that answer returned.',
};

function nextStep(code) {
  return CODE_NEXT_STEPS[code] ?? 'See the diagnostic code above; re-run with --view raw for the full library envelope.';
}

function assetLine(asset) {
  if (!isObject(asset)) return null;
  return `${asset.asset_id ?? '?'} version ${asset.asset_version ?? '?'}` + (asset.judgment_version && asset.judgment_version !== asset.asset_version ? ` (judgments ${asset.judgment_version})` : '');
}

function statesBlock(states) {
  if (!isObject(states)) return [];
  const lines = ['States'];
  for (const key of Object.keys(states)) lines.push(`  ${key}: ${states[key]}` + (STATE_EXPLANATIONS[key] ? `  - ${STATE_EXPLANATIONS[key]}` : ''));
  return lines;
}

function diagnosticsBlock(diagnostics) {
  if (!Array.isArray(diagnostics)) return [];
  if (diagnostics.length === 0) return ['Diagnostics: none'];
  const lines = ['Diagnostics'];
  for (const entry of diagnostics) lines.push('  ! ' + (isObject(entry) ? [entry.code, entry.stage && `(${entry.stage})`, entry.message].filter(Boolean).join(' ') : String(entry)));
  return lines;
}

function systemBlock(system) {
  if (!isObject(system)) return [];
  const warnings = Array.isArray(system.warnings) ? system.warnings : [];
  if (system.status === 'clean' && warnings.length === 0) return ['System checks: clean (no integrity warnings)'];
  const lines = [`System checks: ${system.status ?? '?'} (${system.warning_count ?? warnings.length} warning${warnings.length === 1 ? '' : 's'}; warnings never change acceptance)`];
  for (const warning of warnings) {
    lines.push('  ! ' + (warning?.code ?? '?'));
    const message = warning?.message ?? SYSTEM_EXPLANATIONS[warning?.code];
    if (message) lines.push(wrap(message, '      '));
    if (warning?.detail !== undefined) lines.push('      detail: ' + JSON.stringify(warning.detail));
  }
  return lines;
}

function renderInspect(result) {
  if (!isObject(result)) return fallback('inspect: unexpected result', result);
  if (result.status !== 'accepted') return renderRejection('inspect', result);
  const out = ['KDNA asset: ' + (assetLine(result.asset) ?? '(unknown)')];
  out.push(`Format valid: ${result.format_valid === true ? 'yes' : 'no'}`);
  if (typeof result.judgment_count === 'number') out.push(`Judgments: ${result.judgment_count}`);
  if (isObject(result.tuple)) {
    out.push('Contract tuple');
    for (const [key, value] of Object.entries(result.tuple)) out.push(`  ${key}: ${value}`);
  }
  if (isObject(result.digests)) {
    out.push('Digests (observed)');
    const names = { A: 'container bytes', C: 'content tree', E: 'runtime entries' };
    for (const [key, value] of Object.entries(result.digests)) {
      const compared = value?.comparison?.state;
      out.push(`  ${key} (${names[key] ?? value?.basis ?? '?'}): ${shortDigest(value?.observed)}` + (compared && compared !== 'not_compared' ? `  [${compared}]` : ''));
    }
  }
  if (result.ir_digest) out.push('  IR: ' + shortDigest(result.ir_digest));
  const verification = result.verification;
  if (isObject(verification)) {
    out.push('Verification');
    if (verification.signature_integrity?.status) out.push('  signature: ' + verification.signature_integrity.status);
    if (verification.checksum_integrity?.status) out.push('  checksums: ' + verification.checksum_integrity.status);
    if (verification.routing_integrity) out.push('  routing: ' + verification.routing_integrity);
    if (verification.semantic_status) out.push('  semantics: ' + verification.semantic_status);
  }
  if (Array.isArray(result.runtime_entry_names)) out.push('Runtime entries: ' + (result.runtime_entry_names.join(', ') || 'none'));
  out.push(...statesBlock(result.states), ...diagnosticsBlock(result.diagnostics));
  return out.join('\n') + '\n';
}

function renderValidate(result) {
  if (!isObject(result)) return fallback('validate: unexpected result', result);
  if (result.status !== 'accepted') return renderRejection('validate', result);
  const out = [`Valid: yes (status ${result.status}, format_valid ${result.format_valid === true})`];
  out.push(...statesBlock(result.states), ...diagnosticsBlock(result.diagnostics));
  if (result.system) out.push(...systemBlock(result.system));
  return out.join('\n') + '\n';
}

function codeOf(result) {
  return result?.code ?? result?.diagnostic?.code ?? result?.reason ?? result?.control?.code
    ?? (Array.isArray(result?.diagnostics) ? result.diagnostics.find(d => d?.code)?.code : undefined)
    ?? result?.envelope?.diagnostics?.find?.(d => d?.code)?.code
    ?? result?.admission_rejection?.code ?? result?.admission_rejection?.diagnostic?.code ?? result?.transport_failure?.code;
}

function renderRejection(command, result) {
  const code = codeOf(result);
  const out = [`${command}: ${result?.status ?? 'unknown status'}${code ? ' ' + code : ''}`];
  if (typeof result?.message === 'string') out.push(wrap(result.message));
  if (code) out.push('Next: ' + nextStep(code));
  if (!code) out.push(pretty(result));
  return out.join('\n') + '\n';
}

// ---- read -------------------------------------------------------------------------------------------

// Reduce the three observable read shapes (model view, library envelope, bare/no-body rejection) to one.
function normalizeRead(result) {
  if (result.view_contract || result.fingerprint) {
    const fp = result.fingerprint ?? {};
    return { shape: 'model_view', view: result.view, status: result.status, asset: fp.asset, request_id: fp.request_id, content: result.content, diagnostics: result.diagnostics, handles: handleIds(result.content), omitted: fp.omitted, attested: fp.attested };
  }
  if (isObject(result.envelope)) {
    const e = result.envelope;
    return { shape: 'envelope', status: e.status, mode: e.mode, asset: e.asset, request_id: e.request_id, content: e.content, diagnostics: e.diagnostics, budget: e.budget, states: e.states, handles: handleIds(e.content), omissions: e.omissions, attested: e.digests && Object.fromEntries(Object.entries(e.digests).map(([k, v]) => [k, v?.observed ?? v])) };
  }
  return { shape: 'bare', status: result.status, request_id: result.request_id, diagnostics: result.diagnostic ? [result.diagnostic] : result.diagnostics, control: result.control, content: null };
}

function handleIds(content) {
  const handles = Array.isArray(content?.expansion_handles) ? content.expansion_handles : [];
  return handles.map(h => (typeof h === 'string' ? h : h?.handle_id ?? h?.id)).filter(Boolean);
}

function judgmentNodes(content, ids) {
  const pool = [...(Array.isArray(content?.closure) ? content.closure : []), ...(Array.isArray(content?.declarations) ? content.declarations : [])];
  const seen = new Set(), found = [];
  for (const node of pool) {
    if (node?.role !== 'judgment' || !isObject(node.value)) continue;
    const id = node.value.id ?? node.target?.id;
    if (seen.has(id) || (ids && ids.length && !ids.includes(id))) continue;
    seen.add(id);
    found.push({ id, node });
  }
  return found;
}

function selectedIds(content) {
  const ids = content?.selected?.judgment_ids;
  return Array.isArray(ids) ? ids : [];
}

function authoredStatement(value) {
  return value?.core_expression?.statement ?? (value?.result?.value?.kind === 'text' ? value.result.value.value : undefined);
}

function stateBlockLines(label, entry) {
  if (!isObject(entry) || entry.state === 'none' || entry.value === null || entry.value === undefined) return [];
  // Authored items carry their words in `statement`; show those, with the effect when present,
  // and fall back to JSON only for a shape without one.
  const items = Array.isArray(entry.value) ? entry.value : [entry.value];
  const lines = [`  ${label}:`];
  for (const item of items) {
    if (typeof item === 'string') lines.push(wrap('- ' + item, '      '));
    else if (isObject(item) && typeof item.statement === 'string') lines.push(wrap(`- ${typeof item.effect === 'string' ? '[' + item.effect + '] ' : ''}${item.statement}`, '      '));
    else lines.push(wrap('- ' + JSON.stringify(item), '      '));
  }
  return lines;
}

function renderRead(result) {
  if (!isObject(result)) return fallback('read: unexpected result', result);
  const n = normalizeRead(result);
  const out = [`Read: ${n.status ?? 'unknown'}${n.mode ? ' (' + n.mode + ')' : ''}${n.view ? ' [view ' + n.view + ']' : ''}`];
  const asset = assetLine(n.asset);
  if (asset) out.push('Asset: ' + asset);
  if (n.request_id) out.push('Request: ' + n.request_id);
  const code = codeOf(result);
  const failed = !['ready', 'catalog_only', 'accepted', 'complete'].includes(n.status);
  if (failed || code) {
    out.push('Code: ' + (code ?? '(none given)'));
    if (typeof result.message === 'string') out.push(wrap(result.message));
  }
  if (n.budget) {
    const num = v => (typeof v === 'string' && /^[0-9]+$/.test(v) ? String(BigInt(v)) : String(v ?? '?'));
    out.push(`Budget: required ${num(n.budget.required_bytes)} bytes, limit ${num(n.budget.limit_bytes)} bytes`);
  }
  const content = n.content;
  if (isObject(content)) {
    const ids = selectedIds(content);
    if (Array.isArray(content.catalog) && (n.status === 'catalog_only' || ids.length === 0)) {
      out.push(`Catalog (${content.catalog.length} judgment${content.catalog.length === 1 ? '' : 's'})`);
      for (const entry of content.catalog) out.push(`  - ${entry?.judgment_id ?? '?'}  ${entry?.focus ?? ''}`.trimEnd());
    }
    const nodes = judgmentNodes(content, ids);
    if (ids.length) out.push('Selected: ' + ids.join(', '));
    for (const { id, node } of nodes) {
      const value = node.value;
      out.push('', `Judgment ${id}${value.focus ? ' - ' + value.focus : ''}`);
      const statement = authoredStatement(value);
      if (statement) out.push(wrap(statement));
      if (value.scope?.statement) out.push('  Scope: ' + value.scope.statement);
      for (const [label, key] of [['Boundaries', 'boundaries'], ['Exceptions', 'exceptions'], ['Misuse', 'misuse']]) out.push(...stateBlockLines(label, value[key]));
    }
    if (Array.isArray(content.missing) && content.missing.length) out.push('', `Missing: ${content.missing.length} item(s) referenced but not present`);
  }
  const deferred = [...(n.omissions ?? []), ...(Array.isArray(n.omitted?.content) ? n.omitted.content.map(field => ({ state: 'omitted_in_view', field })) : [])];
  if (n.handles?.length) out.push('', `Expansion handles (${n.handles.length}): ` + n.handles.join(', '), '  Use --session with expand mode to fetch deferred content.');
  const real = deferred.filter(entry => entry?.state === 'explicitly_omitted' && entry.reason);
  for (const entry of real) out.push(`Deferred: ${entry.field ?? '?'} on ${entry.target ?? '?'} (${entry.reason}${entry.expandable ? ', expandable' : ''})`);
  if (n.omitted?.content?.length) out.push('Omitted from this view: ' + n.omitted.content.join(', ') + ' (use --view raw for everything).');
  if (n.attested) out.push('Attested: ' + Object.entries(n.attested).map(([k, v]) => `${k} ${shortDigest(v)}`).join('  '));
  if (n.diagnostics?.length) out.push(...diagnosticsBlock(n.diagnostics));
  if (failed) out.push('Next: ' + nextStep(code));
  if (n.shape === 'bare' && !code && !isObject(content)) out.push(pretty(result));
  return out.join('\n') + '\n';
}

// ---- compact ----------------------------------------------------------------------------------------

const EMPTY_STATES = new Set(['none']);
function prune(value) {
  if (Array.isArray(value)) {
    const items = value.map(prune).filter(item => item !== undefined);
    return items.length ? items : undefined;
  }
  if (isObject(value)) {
    if (EMPTY_STATES.has(value.state) && (value.value === null || value.value === undefined)) return undefined;
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      const kept = prune(item);
      if (kept !== undefined) out[key] = kept;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return value === null ? undefined : value;
}

/**
 * Lean projection of a model-view (`--view body`) read result, for `read --compact`.
 *
 * KEPT (each exactly once):
 *   - status, request_id, view_contract, view, snapshot_id and `asset` {asset_id, asset_version,
 *     judgment_version, title, scope} (title/scope taken from the asset declaration);
 *   - `attested` A/C/E digests (what is needed to cite the read);
 *   - `judgments`: for every selected judgment (all judgments in the closure when nothing is selected)
 *     the authored body `value` of the judgment node with no-content noise pruned (nulls, empty
 *     arrays/objects, `{state:'none'}` fields) and WITHOUT the redundant `result_contract` block;
 *     `boundaries`/`exceptions`/`misuse` therefore survive iff they carry content;
 *   - `declarations`: the asset-level `declarations` of the asset declaration (value order, boundaries,
 *     highest question...) pruned the same way, once, only if non-empty;
 *   - `catalog` as [{judgment_id, focus}] only when no judgment body is delivered (catalog reads);
 *   - `expansion_handles`: handle ids, and `missing` when non-empty;
 *   - any `diagnostics`/code of non-ready results are preserved by returning non-model-view or
 *     rejected inputs unchanged.
 * DROPPED: the declarations array and closure array (full asset-declaration/actor/dependency/result/
 *   result_contract/method_component nodes with node ids, owners, targets), `references`,
 *   `relationships` when empty, `provenance`, `asset_capability`, per-judgment `method_interpretation`,
 *   `result_contract`, catalog node_ref/parent_ref, and the `fingerprint.omitted`/`recovery` bookkeeping.
 * Inputs that are not a model-view result with content are returned unchanged.
 */
function compactReadResult(projected) {
  if (!isObject(projected) || !isObject(projected.content) || !(projected.view_contract || projected.fingerprint)) return projected;
  const { content } = projected, fp = projected.fingerprint ?? {};
  const ids = selectedIds(content);
  const declarationNode = [...(content.declarations ?? []), ...(content.closure ?? [])].find(node => node?.role === 'asset_declaration');
  const declaration = declarationNode?.value;
  const asset = prune({ ...(fp.asset ?? {}), title: declaration?.title, scope: declaration?.scope?.statement });
  const judgments = judgmentNodes(content, ids).map(({ id, node }) => {
    const { result_contract, ...body } = node.value; // eslint-disable-line no-unused-vars
    const pruned = prune(body) ?? {};
    return { id, focus: node.value.focus ?? null, body: pruned };
  });
  const out = { compact: 'kdna.read.compact/1', view_contract: projected.view_contract, view: projected.view, status: projected.status, request_id: fp.request_id, snapshot_id: fp.snapshot_id, asset };
  if (fp.attested) out.attested = fp.attested;
  if (judgments.length) out.judgments = judgments;
  else if (Array.isArray(content.catalog)) out.catalog = content.catalog.map(entry => ({ judgment_id: entry?.judgment_id, focus: entry?.focus ?? null }));
  const declared = prune(declaration?.declarations);
  if (declared) out.declarations = declared;
  const handles = handleIds(content);
  if (handles.length) out.expansion_handles = handles;
  if (Array.isArray(content.missing) && content.missing.length) out.missing = content.missing;
  for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key];
  return out;
}

function renderInspectHuman(result) { return safe(renderInspect, result, 'inspect'); }
function renderValidateHuman(result) { return safe(renderValidate, result, 'validate'); }
function renderReadHuman(result) { return safe(renderRead, result, 'read'); }

function renderValidateInput(result) {
  if (!isObject(result)) return fallback('validate-input: unexpected result', result);
  if (result.status === 'valid') {
    const out = [
      `Valid input: yes (kind ${result.input_kind ?? '?'}, judgments ${result.judgment_count ?? '?'})`,
      'Diagnostics: none',
    ];
    const advisories = Array.isArray(result.advisories) ? result.advisories : [];
    if (advisories.length === 0) out.push('Advisories: none');
    else {
      out.push('Advisories (non-blocking):');
      for (const adv of advisories) {
        out.push(`  * [${adv?.code ?? '?'}] ${adv?.path ?? '?'}: ${adv?.message ?? ''}`.trimEnd());
      }
    }
    return out.join('\n') + '\n';
  }
  const diags = Array.isArray(result.diagnostics) ? result.diagnostics : [];
  const out = [`Valid input: no (${diags.length} diagnostic${diags.length === 1 ? '' : 's'})`];
  for (const d of diags) {
    out.push(`  ! [${d?.field || '/'}] (${d?.code ?? '?'}) ${d?.message ?? ''}${d?.hint ? ` — Hint: ${d.hint}` : ''}`.trimEnd());
  }
  return out.join('\n') + '\n';
}

function renderValidateInputHuman(result) { return safe(renderValidateInput, result, 'validate-input'); }

module.exports = { renderInspectHuman, renderValidateHuman, renderValidateInputHuman, renderReadHuman, compactReadResult };
