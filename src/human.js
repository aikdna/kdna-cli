'use strict';
// Human (plain text, no ANSI) renderers for the JSON the CLI emits for `inspect`, `validate [--system]`,
// `validate-input`, `diff` rejections and `read`, plus `compactReadResult` behind `read --compact`.
// Every renderer is total: an unknown shape degrades to status/code plus pretty JSON, never a throw.

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const WIDTH = 100;

function isEastAsianWide(cp) {
  return (cp >= 0x1100 && cp <= 0x115f)
    || (cp >= 0x2e80 && cp <= 0x303e)
    || (cp >= 0x3040 && cp <= 0xa4cf)
    || (cp >= 0xac00 && cp <= 0xd7a3)
    || (cp >= 0xf900 && cp <= 0xfaff)
    || (cp >= 0xfe10 && cp <= 0xfe6f)
    || (cp >= 0xff01 && cp <= 0xff60)
    || (cp >= 0xffe0 && cp <= 0xffe6)
    || (cp >= 0x20000 && cp <= 0x2fffd)
    || (cp >= 0x30000 && cp <= 0x3fffd);
}

function isCjkBreakable(cp) {
  return (cp >= 0x2e80 && cp <= 0x9fff)
    || (cp >= 0x3400 && cp <= 0x4dbf)
    || (cp >= 0xac00 && cp <= 0xd7a3)
    || (cp >= 0xf900 && cp <= 0xfaff)
    || (cp >= 0x20000 && cp <= 0x2fffd);
}

const OPEN_CJK_PUNCT = new Set([...'（《【「『“‘〈〔〖']);
const CLOSE_CJK_PUNCT = new Set([...'，。！？；：、）》】」』”’〉〕〗…—']);

function displayWidth(str) {
  let w = 0;
  for (const ch of String(str)) w += isEastAsianWide(ch.codePointAt(0)) ? 2 : 1;
  return w;
}

function tokenizeParagraph(paragraph) {
  const chars = [...String(paragraph)];
  const tokens = [];
  let i = 0;
  let sawSpace = false;
  while (i < chars.length) {
    const ch = chars[i];
    if (/\s/u.test(ch)) {
      sawSpace = true;
      i++;
      continue;
    }
    if (OPEN_CJK_PUNCT.has(ch) || isCjkBreakable(ch.codePointAt(0))) {
      let unit = '';
      while (i < chars.length && OPEN_CJK_PUNCT.has(chars[i])) unit += chars[i++];
      if (i < chars.length && isCjkBreakable(chars[i].codePointAt(0))) unit += chars[i++];
      while (i < chars.length && CLOSE_CJK_PUNCT.has(chars[i])) unit += chars[i++];
      tokens.push({ text: unit, spaceBefore: tokens.length > 0 && sawSpace });
      sawSpace = false;
      continue;
    }
    let word = '';
    while (i < chars.length && !/\s/u.test(chars[i]) && !OPEN_CJK_PUNCT.has(chars[i]) && !isCjkBreakable(chars[i].codePointAt(0))) {
      word += chars[i++];
    }
    tokens.push({ text: word, spaceBefore: tokens.length > 0 && sawSpace });
    sawSpace = false;
  }
  return tokens;
}

function wrap(text, indent = '  ', width = WIDTH) {
  const indentWidth = displayWidth(indent);
  const paragraphs = String(text ?? '').split('\n');
  const out = [];
  for (const paragraph of paragraphs) {
    const tokens = tokenizeParagraph(paragraph);
    if (tokens.length === 0) {
      out.push(indent);
      continue;
    }
    let line = '';
    let lineWidth = 0;
    for (const token of tokens) {
      const sep = line && token.spaceBefore ? ' ' : '';
      const sepWidth = sep ? 1 : 0;
      const tokenWidth = displayWidth(token.text);
      if (line && indentWidth + lineWidth + sepWidth + tokenWidth > width) {
        out.push(indent + line);
        line = token.text;
        lineWidth = tokenWidth;
      } else {
        line += sep + token.text;
        lineWidth += sepWidth + tokenWidth;
      }
    }
    out.push(indent + line);
  }
  return out.join('\n');
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
  READ_RESPONSE_BUDGET_TOO_SMALL: 'Retry with a larger --budget (default 1000000; 4000000 for whole_asset); no content was delivered.',
  READ_SELECTION_NOT_FOUND: 'Run `kdna read <file> --mode catalog --allow-read` and use a judgment id it lists.',
  KDNA_JUDGMENT_ID_UNKNOWN: 'Run `kdna read <file> --mode catalog --allow-read` and select only judgment ids listed in the catalog.',
  KDNA_READ_PERMISSION_REQUIRED: 'Re-run with --allow-read to grant this one local read.',
  KDNA_ARGUMENT_INVALID: 'Check the command arguments against `kdna --help`.',
  KDNA_ASSET_INPUT_INVALID: 'Check that the path is a readable .kdna regular file.',
  KDNA_MODEL_VIEW_UNAVAILABLE: 'Use --view raw, or install a kdna-read with the model-view projection.',
  READ_HANDLE_UNKNOWN: 'Request a fresh read and use a handle id that answer returned.',
  KDNA_PASSWORD_REQUIRED: 'Pass --password-file <path> or --password-fd <fd> (3 or higher); passwords are never accepted on the command line.',
  PROTECTION_AUTHENTICATION_FAILED: 'Check the password supplied via --password-file or --password-fd; encrypted payload authentication failed.',
  KDNA_PASSWORD_INVALID: 'Supply a non-empty UTF-8 password via --password-file <path> or --password-fd <fd>.',
  KDNA_PASSWORD_SOURCE_REQUIRED: 'Pass --password-file <path> or --password-fd <fd> (3 or higher).',
  READ_SNAPSHOT_UNATTESTED: 'Run `kdna validate <file>` to inspect format and verification diagnostics.',
};

function nextStep(code, command = 'read') {
  if (code && CODE_NEXT_STEPS[code]) return CODE_NEXT_STEPS[code];
  if (command === 'read') return 'See the diagnostic code above; re-run with --view raw for the full library envelope.';
  return 'See the diagnostic code above; re-run without --format human for the full JSON diagnostic.';
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
  if (isObject(result.protection)) out.push(`Protection: ${result.protection.status ?? 'protected'} (${result.protection.profile ?? 'password'})`);
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
  else if (typeof result?.reason === 'string' && result.reason !== code) out.push(wrap(result.reason));
  const step = typeof result?.next === 'string' ? result.next : (code ? nextStep(code, command) : null);
  if (step) out.push('Next: ' + step);
  if (!code && typeof result?.next !== 'string') out.push(pretty(result));
  return out.join('\n') + '\n';
}

// ---- closure & read helpers -------------------------------------------------------------------------

function handleIds(content) {
  const handles = Array.isArray(content?.expansion_handles) ? content.expansion_handles : [];
  return handles.map(h => (typeof h === 'string' ? h : h?.handle_id ?? h?.id)).filter(Boolean);
}

function selectedIds(content) {
  const ids = content?.selected?.judgment_ids;
  return Array.isArray(ids) ? ids : [];
}

function collectClosure(content) {
  const pool = [...(Array.isArray(content?.declarations) ? content.declarations : []), ...(Array.isArray(content?.closure) ? content.closure : [])];
  const ids = selectedIds(content);
  let declarationNode = null;
  const seenJudgments = new Set();
  const selectedJudgments = [];
  const relatedJudgments = [];
  const seenByRole = new Map();
  const addUnique = (role, node) => {
    if (!isObject(node?.value)) return;
    const key = String(node.value.id ?? node.target?.id ?? node.id ?? JSON.stringify(node.value));
    if (!seenByRole.has(role)) seenByRole.set(role, new Map());
    const map = seenByRole.get(role);
    if (!map.has(key)) map.set(key, node);
  };

  for (const node of pool) {
    if (!isObject(node)) continue;
    if (node.role === 'asset_declaration') {
      if (!declarationNode && isObject(node.value)) declarationNode = node;
      continue;
    }
    if (node.role === 'judgment' && isObject(node.value)) {
      const id = node.value.id ?? node.target?.id;
      if (!id || seenJudgments.has(id)) continue;
      seenJudgments.add(id);
      if (!ids.length || ids.includes(id)) selectedJudgments.push({ id, node });
      else relatedJudgments.push({ id, node });
      continue;
    }
    if (['boundary', 'misuse', 'condition', 'exception', 'shared_declaration', 'reason', 'example', 'material', 'source'].includes(node.role)) {
      addUnique(node.role, node);
    }
  }

  // Order selectedJudgments by selectedIds when explicit selection order is present
  if (ids.length > 1) {
    const orderMap = new Map(ids.map((id, idx) => [id, idx]));
    selectedJudgments.sort((a, b) => (orderMap.get(a.id) ?? 999999) - (orderMap.get(b.id) ?? 999999));
  }

  const valuesOf = (role, filterFn = () => true) => {
    const map = seenByRole.get(role);
    if (!map) return [];
    const out = [];
    for (const node of map.values()) if (filterFn(node)) out.push(node.value);
    return out;
  };

  const isAssetOwned = node => node.owner?.kind === 'asset' || (!node.owner_judgment_id && node.owner?.kind !== 'judgment');

  return {
    declaration: declarationNode?.value ?? null,
    selectedJudgments,
    relatedJudgments,
    assetBoundaries: valuesOf('boundary', node => isAssetOwned(node) || node.value?.applies_to?.kind === 'asset'),
    assetMisuse: valuesOf('misuse', isAssetOwned),
    assetConditions: valuesOf('condition'),
    assetExceptions: valuesOf('exception', isAssetOwned),
    sharedDeclarations: valuesOf('shared_declaration'),
    reasons: valuesOf('reason'),
    examples: valuesOf('example'),
    materials: valuesOf('material'),
    sources: valuesOf('source'),
    relationships: Array.isArray(content?.relationships) ? content.relationships : [],
  };
}

// Reduce observable read shapes (compact projection, model view, library envelope, bare/no-body rejection) to one.
function normalizeRead(result) {
  if (result.compact === 'kdna.read.compact/1') {
    return {
      shape: 'compact',
      view: result.view,
      status: result.status,
      asset: result.asset,
      request_id: result.request_id,
      compactData: result,
      diagnostics: result.diagnostics,
      handles: Array.isArray(result.expansion_handles) ? result.expansion_handles : [],
      attested: result.attested,
    };
  }
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

function authoredStatement(value) {
  return value?.core_expression?.statement
    ?? value?.formation_rule?.statement
    ?? (value?.result?.value?.kind === 'text' ? value.result.value.value : undefined);
}

function stateBlockLines(label, entry, indent = '  ') {
  if (!isObject(entry) || entry.state === 'none' || entry.value === null || entry.value === undefined) return [];
  const items = Array.isArray(entry.value) ? entry.value : [entry.value];
  if (!items.length) return [];
  const lines = [`${indent}${label}:`];
  const itemIndent = indent + '    ';
  for (const item of items) {
    if (typeof item === 'string') lines.push(wrap('- ' + item, itemIndent));
    else if (isObject(item) && typeof item.statement === 'string') lines.push(wrap(`- ${typeof item.effect === 'string' ? '[' + item.effect + '] ' : ''}${item.statement}`, itemIndent));
    else lines.push(wrap('- ' + JSON.stringify(item), itemIndent));
  }
  return lines;
}

function listBlockLines(label, items, indent = '  ') {
  if (!Array.isArray(items) || items.length === 0) return [];
  const lines = [`${indent}${label}:`];
  const itemIndent = indent + '    ';
  for (const item of items) {
    if (typeof item === 'string') lines.push(wrap('- ' + item, itemIndent));
    else if (isObject(item) && typeof item.statement === 'string') {
      const prefix = typeof item.effect === 'string' ? `[${item.effect}] ` : '';
      lines.push(wrap(`- ${prefix}${item.statement}`, itemIndent));
    } else lines.push(wrap('- ' + JSON.stringify(item), itemIndent));
  }
  return lines;
}

function renderSharedDeclarations(sharedList) {
  if (!Array.isArray(sharedList) || sharedList.length === 0) return [];
  const lines = ['Shared declarations:'];
  for (const sd of sharedList) {
    if (!isObject(sd)) continue;
    const kind = sd.kind ?? 'declaration';
    const values = Array.isArray(sd.value) ? sd.value : (typeof sd.value === 'string' ? [sd.value] : []);
    if (values.length === 0 && typeof sd.statement === 'string') values.push(sd.statement);
    for (const v of values) lines.push(wrap(`- [${kind}] ${v}`, '  '));
  }
  return lines.length > 1 ? lines : [];
}

function renderJudgmentEntry(headingPrefix, id, value, reasonsByJudgment, reasonsById, examplesByJudgment) {
  const out = ['', `${headingPrefix} ${id}${value.focus ? ' - ' + value.focus : ''}`];
  const statement = authoredStatement(value);
  if (statement) out.push(wrap(statement));
  if (value.scope?.statement) out.push(wrap('Scope: ' + value.scope.statement, '  '));

  // Method + components
  const methodTerm = value.method?.method?.term;
  const components = Array.isArray(value.method?.components) ? value.method.components : [];
  if (methodTerm || components.length) {
    out.push(`  Method (${methodTerm ?? 'unspecified'}):`);
    for (const comp of components) {
      if (!isObject(comp) || typeof comp.statement !== 'string') continue;
      out.push(wrap(`- [${comp.role ?? 'component'}] ${comp.statement}`, '      '));
    }
  }

  // Reasons (from reason_refs or judgment_ref match)
  const matchedReasons = [];
  const seenReasonIds = new Set();
  if (Array.isArray(value.reason_refs)) {
    for (const ref of value.reason_refs) {
      const r = reasonsById.get(ref);
      if (r && !seenReasonIds.has(r.id)) { seenReasonIds.add(r.id); matchedReasons.push(r); }
    }
  }
  for (const r of (reasonsByJudgment.get(id) ?? [])) {
    const key = r.id ?? r.statement;
    if (!seenReasonIds.has(key)) { seenReasonIds.add(key); matchedReasons.push(r); }
  }
  if (matchedReasons.length) {
    out.push('  Reasons:');
    for (const r of matchedReasons) {
      if (typeof r.statement === 'string') out.push(wrap(`- ${r.statement}`, '      '));
    }
  }

  for (const [label, key] of [['Boundaries', 'boundaries'], ['Exceptions', 'exceptions'], ['Misuse', 'misuse']]) {
    out.push(...stateBlockLines(label, value[key], '  '));
  }

  // Examples adopting this judgment
  const exList = examplesByJudgment.get(id) ?? [];
  if (exList.length) {
    out.push('  Examples:');
    for (const ex of exList) {
      const resultText = Array.isArray(ex.results) && ex.results[0]?.statement ? ` => ${ex.results[0].statement}` : '';
      const summary = [ex.title && `[${ex.title}]`, ex.context, ex.application && `-> ${ex.application}${resultText}`].filter(Boolean).join(' ');
      if (summary) out.push(wrap('- ' + summary, '      '));
    }
  }
  return out;
}

function renderRelationshipsBlock(relationships) {
  if (!Array.isArray(relationships) || relationships.length === 0) return [];
  const lines = ['', `Relationships (${relationships.length}):`];
  for (const rel of relationships) {
    if (!isObject(rel)) continue;
    const kind = rel.kind?.term ?? rel.kind ?? 'relation';
    const parts = Array.isArray(rel.participants)
      ? rel.participants.map(p => `${p?.role?.term ? p.role.term + ':' : ''}${p?.judgment_ref ?? '?'}`).join(' -> ')
      : (rel.id ?? '');
    const stmt = typeof rel.statement === 'string' && rel.statement.trim() ? ` — ${rel.statement}` : '';
    lines.push(wrap(`- [${kind}] ${parts}${stmt}`, '  '));
  }
  return lines;
}

function indexReasonsAndExamples(reasons, examples) {
  const reasonsById = new Map();
  const reasonsByJudgment = new Map();
  for (const r of (reasons ?? [])) {
    if (!isObject(r)) continue;
    if (r.id) reasonsById.set(r.id, r);
    if (r.judgment_ref) {
      if (!reasonsByJudgment.has(r.judgment_ref)) reasonsByJudgment.set(r.judgment_ref, []);
      reasonsByJudgment.get(r.judgment_ref).push(r);
    }
  }
  const examplesByJudgment = new Map();
  for (const ex of (examples ?? [])) {
    if (!isObject(ex)) continue;
    const adopted = Array.isArray(ex.adopted_judgments) ? ex.adopted_judgments : [];
    for (const a of adopted) {
      const jid = a?.judgment_id;
      if (jid) {
        if (!examplesByJudgment.has(jid)) examplesByJudgment.set(jid, []);
        examplesByJudgment.get(jid).push(ex);
      }
    }
  }
  return { reasonsById, reasonsByJudgment, examplesByJudgment };
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
    else if (typeof result.reason === 'string' && result.reason !== code) out.push(wrap(result.reason));
    if (Array.isArray(result.unknown_judgment_ids) && result.unknown_judgment_ids.length) {
      out.push(wrap('Unknown judgment IDs: ' + result.unknown_judgment_ids.join(', ')));
    }
    if (Array.isArray(result.catalog_judgment_ids) && result.catalog_judgment_ids.length) {
      out.push(wrap('Catalog judgment IDs: ' + result.catalog_judgment_ids.join(', ')));
    }
  }
  if (n.budget) {
    const num = v => (typeof v === 'string' && /^[0-9]+$/.test(v) ? String(BigInt(v)) : String(v ?? '?'));
    out.push(`Budget: required ${num(n.budget.required_bytes)} bytes, limit ${num(n.budget.limit_bytes)} bytes`);
  }

  if (n.shape === 'compact') {
    const c = n.compactData;
    if (Array.isArray(c.catalog)) {
      out.push(`Catalog (${c.catalog.length} judgment${c.catalog.length === 1 ? '' : 's'})`);
      for (const entry of c.catalog) out.push(`  - ${entry?.judgment_id ?? '?'}  ${entry?.focus ?? ''}`.trimEnd());
    }
    const judgments = Array.isArray(c.judgments) ? c.judgments : [];
    const related = Array.isArray(c.related_judgments) ? c.related_judgments : [];
    if (judgments.length) {
      if (c.asset?.title) out.push('Title: ' + c.asset.title);
      if (c.asset?.scope) out.push(wrap('Asset scope: ' + c.asset.scope, ''));
      const hq = c.declarations?.highest_question?.value ?? (typeof c.declarations?.highest_question === 'string' ? c.declarations.highest_question : null);
      if (hq) out.push(wrap('Highest question: ' + hq, ''));
      out.push(...renderSharedDeclarations(c.declarations?.shared_declarations));
      out.push(...stateBlockLines('Asset boundaries', c.declarations?.boundaries, ''));
      out.push(...stateBlockLines('Asset anti-misuse', c.declarations?.misuse, ''));
      out.push('Selected: ' + judgments.map(j => j.id).join(', '));
      const { reasonsById, reasonsByJudgment, examplesByJudgment } = indexReasonsAndExamples(c.reasons, c.examples);
      for (const j of judgments) {
        if (isObject(j?.body)) out.push(...renderJudgmentEntry('Judgment', j.id, j.body, reasonsByJudgment, reasonsById, examplesByJudgment));
      }
      for (const j of related) {
        if (isObject(j?.body)) out.push(...renderJudgmentEntry('Related judgment (closure)', j.id, j.body, reasonsByJudgment, reasonsById, examplesByJudgment));
      }
      out.push(...renderRelationshipsBlock(c.relationships));
    }
    if (Array.isArray(c.missing) && c.missing.length) out.push('', `Missing: ${c.missing.length} item(s) referenced but not present`);
  } else if (isObject(n.content)) {
    const content = n.content;
    const ids = selectedIds(content);
    const closure = collectClosure(content);
    if (Array.isArray(content.catalog) && (n.status === 'catalog_only' || (ids.length === 0 && closure.selectedJudgments.length === 0))) {
      out.push(`Catalog (${content.catalog.length} judgment${content.catalog.length === 1 ? '' : 's'})`);
      for (const entry of content.catalog) out.push(`  - ${entry?.judgment_id ?? '?'}  ${entry?.focus ?? ''}`.trimEnd());
    }
    if (closure.selectedJudgments.length || ids.length) {
      if (closure.declaration?.title) out.push('Title: ' + closure.declaration.title);
      if (closure.declaration?.scope?.statement) out.push(wrap('Asset scope: ' + closure.declaration.scope.statement, ''));
      const hq = closure.declaration?.declarations?.highest_question?.value;
      if (typeof hq === 'string') out.push(wrap('Highest question: ' + hq, ''));
      out.push(...renderSharedDeclarations(closure.sharedDeclarations));
      if (closure.assetBoundaries.length) out.push(...listBlockLines('Asset boundaries', closure.assetBoundaries, ''));
      else out.push(...stateBlockLines('Asset boundaries', closure.declaration?.declarations?.boundaries, ''));
      if (closure.assetMisuse.length) out.push(...listBlockLines('Asset anti-misuse', closure.assetMisuse, ''));
      if (ids.length) out.push('Selected: ' + ids.join(', '));
      const { reasonsById, reasonsByJudgment, examplesByJudgment } = indexReasonsAndExamples(closure.reasons, closure.examples);
      for (const { id, node } of closure.selectedJudgments) {
        out.push(...renderJudgmentEntry('Judgment', id, node.value, reasonsByJudgment, reasonsById, examplesByJudgment));
      }
      for (const { id, node } of closure.relatedJudgments) {
        out.push(...renderJudgmentEntry('Related judgment (closure)', id, node.value, reasonsByJudgment, reasonsById, examplesByJudgment));
      }
      out.push(...renderRelationshipsBlock(closure.relationships));
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
  if (failed) {
    const step = typeof result?.next === 'string' ? result.next : nextStep(code, 'read');
    out.push('Next: ' + step);
  }
  if (n.shape === 'bare' && !code && !isObject(n.content)) out.push(pretty(result));
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
 * Closure-preserving lean projection of a model-view (`--view body`) read result, for `read --compact`.
 *
 * Strips repeated IR wrapper boilerplate (`content.declarations` & `content.closure` node envelopes,
 * SHA-1 `references` edge graph, `provenance`, `fingerprint.omitted`/`recovery`, full 45-entry `catalog`
 * when judgment bodies are delivered, and per-judgment `result_contract` / `method_interpretation`)
 * WHILE preserving 100% of mandatory safety and reasoning closure:
 *   - `judgments`: selected judgment bodies (`{id, focus, body}`);
 *   - `related_judgments`: non-selected upstream/qualifying/conflicting judgments pulled in by Core's
 *     mandatory closure (when present);
 *   - `declarations`: asset-level declarations (`highest_question`, plus resolved asset-wide
 *     `boundaries`, `misuse`, `conditions`, `exceptions`, and `shared_declarations` from closure nodes);
 *   - `relationships`: non-empty inter-judgment relationships (`support`, `qualify`, `conflict`, `complement`);
 *   - `reasons`, `materials`, `examples`, `sources`: closure nodes referenced by the delivered judgments
 *     (omitted when empty).
 */
function compactReadResult(projected) {
  if (!isObject(projected) || !isObject(projected.content) || !(projected.view_contract || projected.fingerprint)) return projected;
  const { content } = projected, fp = projected.fingerprint ?? {};
  const closure = collectClosure(content);
  const { declaration } = closure;
  const asset = prune({ ...(fp.asset ?? {}), title: declaration?.title, scope: declaration?.scope?.statement });
  const mapJudgment = ({ id, node }) => {
    const { result_contract, method_interpretation, ...body } = node.value; // eslint-disable-line no-unused-vars
    return { id, focus: node.value.focus ?? null, body: prune(body) ?? {} };
  };
  const judgments = closure.selectedJudgments.map(mapJudgment);
  const relatedJudgments = closure.relatedJudgments.map(mapJudgment);

  const out = {
    compact: 'kdna.read.compact/1',
    view_contract: projected.view_contract,
    view: projected.view,
    status: projected.status,
    request_id: fp.request_id,
    snapshot_id: fp.snapshot_id,
    asset,
  };
  if (fp.attested) out.attested = fp.attested;
  if (judgments.length) out.judgments = judgments;
  else if (Array.isArray(content.catalog)) out.catalog = content.catalog.map(entry => ({ judgment_id: entry?.judgment_id, focus: entry?.focus ?? null }));
  if (relatedJudgments.length) out.related_judgments = relatedJudgments;

  const declaredBase = isObject(declaration?.declarations) ? { ...declaration.declarations } : {};
  if (closure.assetBoundaries.length) {
    declaredBase.boundaries = { state: 'provided', value: closure.assetBoundaries };
  } else if (isObject(declaredBase.boundaries) && declaredBase.boundaries.state === 'provided' && declaredBase.boundaries.value === undefined) {
    delete declaredBase.boundaries;
  }
  if (closure.assetMisuse.length) declaredBase.misuse = { state: 'provided', value: closure.assetMisuse };
  if (closure.assetConditions.length) declaredBase.conditions = closure.assetConditions;
  if (closure.assetExceptions.length) declaredBase.exceptions = closure.assetExceptions;
  if (closure.sharedDeclarations.length) declaredBase.shared_declarations = closure.sharedDeclarations;

  const declared = prune(declaredBase);
  if (declared) out.declarations = declared;
  const relationships = prune(closure.relationships);
  if (relationships) out.relationships = relationships;
  const reasons = prune(closure.reasons);
  if (reasons) out.reasons = reasons;
  const materials = prune(closure.materials);
  if (materials) out.materials = materials;
  const examples = prune(closure.examples);
  if (examples) out.examples = examples;
  const sources = prune(closure.sources);
  if (sources) out.sources = sources;

  const handles = handleIds(content);
  if (handles.length) out.expansion_handles = handles;
  if (Array.isArray(content.missing) && content.missing.length) out.missing = content.missing;
  for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key];
  return out;
}

function renderInspectHuman(result) { return safe(renderInspect, result, 'inspect'); }
function renderValidateHuman(result) { return safe(renderValidate, result, 'validate'); }
function renderReadHuman(result) { return safe(renderRead, result, 'read'); }
function renderRejectionHuman(command, result) { return safe(r => renderRejection(command, r), result, command); }

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

module.exports = {
  wrap,
  renderInspectHuman,
  renderValidateHuman,
  renderValidateInputHuman,
  renderReadHuman,
  renderRejectionHuman,
  compactReadResult,
};
