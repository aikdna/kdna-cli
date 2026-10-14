'use strict';
const { randomUUID, createHash } = require('node:crypto');
const { parseJsonBytes, readAuthoredInput, readAssetBytes, saveNewAsset } = require('./authored-input.js');
const { readSourceEdits } = require('./source-input.js');
const { Readable, Writable } = require('node:stream');
const { admitSectionRequest, inspectWholeSectionSnapshot } = require('@aikdna/kdna-core/sections-node');
const { createNativeSectionByteReadAuthority, admitSectionBytesNode } = require('@aikdna/kdna-core/sections-bytes-node');
const { admitRetainedSectionRequest, createRetainedSectionReadAuthority, prepareRetainedSectionRead } = require('@aikdna/kdna-core/retained-sections-node');
const { createTrustedHostReadProvider, readRetainedSection } = require('@aikdna/kdna-read/retained-sections-node');
const { admitNativeCreationRequest, createNativeCreationAuthority, createSectionAssetNode } = require('@aikdna/kdna-core/creation-sections-node');
const { admitSourceOperationRequest, createNativeSourceOperationAuthority, openSectionSourceNode, packSectionSourceNode } = require('@aikdna/kdna-core/source-sections-node');
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
const commands = new Set(['create', 'source-open', 'source-pack', 'inspect', 'validate', 'read', 'plan', 'load']);
const independentStates = () => ({ writer: 'not_evaluated', confirmation: 'not_evaluated', read_permission: 'not_evaluated', action_authorization: 'not_evaluated' });
const help = [
  'kdna create <authored.json> --output <new-asset.kdna> --allow-create',
  '  Input: {manifest,payload,members:[{name,type:"file",mode,bytes_base64}]}; never replaces a file.',
  'kdna source-open <asset.kdna> --expected-a <sha256:...> --allow-source',
  '  Emits an observation and edits:{manifest,payload}; original resource bytes stay in the asset.',
  'kdna source-pack <asset.kdna> --edits <edits.json> --expected-a <sha256:...> --output <new-asset.kdna> --allow-source',
  '  Edit transport: exactly {manifest,payload}; public source only, old files are never replaced.',
  'kdna inspect <asset.kdna> [--json]',
  'kdna validate <asset.kdna> [--json]',
  'kdna read <asset.kdna> --mode catalog|whole_asset|exact_selection --budget <bytes>',
  '  [--asset-id <id> --asset-version <version> --judgment-id <id>] [--allow-read] [--view body|full]',
  '  [--view-accept <model-view-contract>]',
  '  --view body answers with the author body and one fingerprint when the installed',
  '  Read package provides that projection; --view full is what this CLI printed before it.',
  '  --view-accept pins the model-view contract this run accepts; the default is the',
  '  contract this CLI is built against, and no value ever selects an older service.',
  'kdna read <asset.kdna> --session [--allow-read]',
  '  One public ReadRequest JSON object per input line; one public result per output line.',
  '  Reuse a returned handle, or name a compact handle_id from the reduced body, for',
  '  expand within this session.',
  'plan/load are unavailable until public Plan admission and execution exist.',
].join('\n') + '\n';

function parse(argv) {
  const [command, ...rest] = argv;
  if (!commands.has(command)) return { error: 'KDNA_COMMAND_UNAVAILABLE' };
  const options = Object.create(null);
  const valued = new Set(['--mode', '--asset-id', '--asset-version', '--judgment-id', '--budget', '--output', '--expected-a', '--edits', '--view', '--view-accept']);
  let file;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (['--allow-create', '--allow-read', '--allow-source', '--json', '--session'].includes(arg)) {
      if (options[arg] !== undefined) return { error: 'KDNA_ARGUMENT_INVALID' };
      options[arg] = true;
    } else if (valued.has(arg)) {
      if (options[arg] !== undefined || i + 1 >= rest.length || rest[i + 1].startsWith('--')) return { error: 'KDNA_ARGUMENT_INVALID' };
      options[arg] = rest[++i];
    } else if (arg.startsWith('-') || file !== undefined) return { error: 'KDNA_ARGUMENT_INVALID' };
    else file = arg;
  }
  if (!file && command !== 'plan' && command !== 'load') return { error: 'KDNA_ARGUMENT_INVALID' };
  const allowed = command === 'create' ? ['--output', '--allow-create', '--json']
    : command === 'source-open' ? ['--expected-a', '--allow-source', '--json']
    : command === 'source-pack' ? ['--expected-a', '--edits', '--output', '--allow-source', '--json']
    : command === 'read' ? ['--mode', '--asset-id', '--asset-version', '--judgment-id', '--budget', '--allow-read', '--json', '--session', '--view', '--view-accept'] : ['--json'];
  if (Object.keys(options).some(k => !allowed.includes(k))) return { error: 'KDNA_ARGUMENT_INVALID' };
  if (command === 'create' && (!options['--output'] || !options['--output'].endsWith('.kdna'))) return { error: 'KDNA_ARGUMENT_INVALID' };
  if (command.startsWith('source-') && !/^sha256:[0-9a-f]{64}$/.test(options['--expected-a'] || '')) return { error: 'KDNA_ARGUMENT_INVALID' };
  if (command === 'source-pack' && (!options['--edits'] || !options['--output'] || !options['--output'].endsWith('.kdna'))) return { error: 'KDNA_ARGUMENT_INVALID' };
  // A session carries one ReadRequest per line, so a CLI-level request option may
  // not accompany it. --view names the output surface, not the request, so it may.
  if (options['--session'] && Object.keys(options).some(k => k !== '--view' && k !== '--view-accept' && valued.has(k))) return { error: 'KDNA_ARGUMENT_INVALID' };
  return { command, file, options };
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
  const { command, file, options } = parsed;
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
      evidence: result.evidence, states: independentStates(), action_authorized: false, creation_accepted: false, adoption: 'not_observed' });
    return 0;
  }
  if (command === 'create') {
    if (!options['--allow-create']) {
      await emit({ status: 'rejected', code: 'KDNA_CREATE_PERMISSION_REQUIRED', action_authorized: false, creation_accepted: false });
      return 1;
    }
    let input;
    try { input = await readAuthoredInput(file); }
    catch (error) { return unavailable('KDNA_AUTHORED_INPUT_INVALID', error?.diagnostic ?? null); }
    const request = admitNativeCreationRequest({ request_id: 'cli:' + randomUUID(), tuple: binding.tuple, operation: 'create_public_asset', timeout_ms: 60000 });
    if (request.status !== 'admitted_request') { await emit(request); return 1; }
    const authority = createNativeCreationAuthority(() => true);
    assertActive();
    const produced = await createSectionAssetNode(input, request.request, authority);
    if (produced.status !== 'produced') {
      const guidance = authoringGuidance(input, produced);
      await emit(guidance ? { ...produced, guidance } : produced);
      return 1;
    }
    let saved;
    try { saved = await saveNewAsset(options['--output'], produced.bytes, assertActive); }
    catch (error) { await emit({ status: 'save_failed', code: error.message === 'KDNA_OUTPUT_EXISTS' ? error.message : 'KDNA_SAVE_FAILED', action_authorized: false, creation_accepted: false }); return 1; }
    await emit({ status: 'saved', output: { file: options['--output'], bytes: produced.bytes.length, sha256: createHash('sha256').update(produced.bytes).digest('hex'), cleanup: saved.cleanup }, evidence: produced.evidence, states: independentStates(), action_authorized: false, creation_accepted: false, adoption: 'not_observed' });
    return 0;
  }
  async function whole() {
    const request = admitSectionRequest({ request_id: 'cli:' + randomUUID(), tuple: binding.tuple, budget_bytes: 100000000, mode: 'whole_asset', selection: null, handle: null });
    let bytes;
    try { bytes = await readAssetBytes(file, assertActive); }
    catch { assertActive(); return { status: 'rejected', code: 'KDNA_ASSET_INPUT_INVALID', action_authorized: false }; }
    assertActive();
    return admitSectionBytesNode(bytes, request, createNativeSectionByteReadAuthority(() => true));
  }
  if (command === 'inspect' || command === 'validate') {
    const admission = await whole();
    if (admission.status !== 'accepted') { await emit(admission); return 1; }
    const view = inspectWholeSectionSnapshot(admission.snapshot);
    if (!view) { await emit({ status: 'rejected', reason: 'READ_SNAPSHOT_UNATTESTED' }); return 1; }
    const result = { status: 'accepted', format_valid: true, states: { ...independentStates(), core: 'valid', interpretation: 'complete' }, diagnostics: [] };
    if (command === 'inspect') Object.assign(result, { tuple: view.tuple, asset: view.asset, digests: view.digests, ir_digest: view.verification.ir_digest.digest, verification: view.verification, judgment_count: view.ir.catalog.length, runtime_entry_names: view.runtime_entry_names });
    await emit(result);
    return 0;
  }
  let retainedSnapshot = null, retainedView = null, delivered = false;
  const allow = options['--allow-read'] === true;
  if (!allow) {
    await emit({ status: 'rejected', code: 'KDNA_READ_PERMISSION_REQUIRED', action_authorized: false });
    return 1;
  }
  const authority = createRetainedSectionReadAuthority(() => allow);
  const viewOption = options['--view'];
  if (viewOption !== undefined && !['body', 'full'].includes(viewOption)) return unavailable('KDNA_ARGUMENT_INVALID');
  const modelView = loadModelView();
  const view = viewOption ?? 'body';
  // Without the capability the default path prints exactly what this CLI printed
  // before the flag existed; an explicit body request that cannot be honoured is
  // refused rather than quietly answered with the full surface.
  if (viewOption === 'body' && !modelView) return unavailable('KDNA_MODEL_VIEW_UNAVAILABLE');
  const viewAccept = options['--view-accept'] ?? REQUIRED_MODEL_VIEW;
  // An explicit acceptance without an installed projection has nothing to accept.
  if (options['--view-accept'] !== undefined && !modelView) return unavailable('KDNA_MODEL_VIEW_UNAVAILABLE');
  let projectionFailure = null;
  // The full surface is the raw answer without the reduction machinery; the body
  // surface is the author body. Both are asked of the installed projection, and
  // both carry the accepted contract. A refusal is emitted verbatim instead of
  // silently degrading to another surface.
  const projected = result => {
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
    async deliver(result) { await emit(projected(result)); delivered = true; return true; },
  });
  async function read(request) {
    // Explicit CLI consent and native request admission precede asset reads.
    const admitted = admitRetainedSectionRequest(request);
    if (admitted.status !== 'admitted_request') { await emit(admitted); return 1; }
    if (!retainedSnapshot) {
      const admission = await whole();
      if (admission.status !== 'accepted') { await emit(admission); return 1; }
      retainedSnapshot = admission.snapshot;
      retainedView = inspectWholeSectionSnapshot(retainedSnapshot);
      if (!retainedView) { await emit({ status: 'rejected', reason: 'READ_SNAPSHOT_UNATTESTED' }); return 1; }
    }
    const preparation = await prepareRetainedSectionRead(retainedSnapshot, admitted.request, authority);
    if (preparation.status !== 'prepared') { await emit(preparation); return 1; }
    delivered = false;
    projectionFailure = null;
    const result = await readRetainedSection(preparation.prepared, host);
    if (!delivered) await emit(result);
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
  return read({ request_id: 'cli:' + randomUUID(), tuple: binding.tuple, budget_bytes: Number(budgetText), mode, selection: ['whole_asset', 'catalog'].includes(mode) ? null : { asset_id: options['--asset-id'], asset_version: options['--asset-version'], judgment_ids: options['--judgment-id'] === undefined ? undefined : [options['--judgment-id']] }, handle: null });
}
module.exports = { run };
