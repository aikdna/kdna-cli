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
  '  [--asset-id <id> --asset-version <version> --judgment-id <id>] [--allow-read]',
  'kdna read <asset.kdna> --session [--allow-read]',
  '  One public ReadRequest JSON object per input line; one public result per output line.',
  '  Reuse a returned handle for expand within this session.',
  'plan/load are unavailable until public Plan admission and execution exist.',
].join('\n') + '\n';

function parse(argv) {
  const [command, ...rest] = argv;
  if (!commands.has(command)) return { error: 'KDNA_COMMAND_UNAVAILABLE' };
  const options = Object.create(null);
  const valued = new Set(['--mode', '--asset-id', '--asset-version', '--judgment-id', '--budget', '--output', '--expected-a', '--edits']);
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
    : command === 'read' ? ['--mode', '--asset-id', '--asset-version', '--judgment-id', '--budget', '--allow-read', '--json', '--session'] : ['--json'];
  if (Object.keys(options).some(k => !allowed.includes(k))) return { error: 'KDNA_ARGUMENT_INVALID' };
  if (command === 'create' && (!options['--output'] || !options['--output'].endsWith('.kdna'))) return { error: 'KDNA_ARGUMENT_INVALID' };
  if (command.startsWith('source-') && !/^sha256:[0-9a-f]{64}$/.test(options['--expected-a'] || '')) return { error: 'KDNA_ARGUMENT_INVALID' };
  if (command === 'source-pack' && (!options['--edits'] || !options['--output'] || !options['--output'].endsWith('.kdna'))) return { error: 'KDNA_ARGUMENT_INVALID' };
  if (options['--session'] && Object.keys(options).some(k => valued.has(k))) return { error: 'KDNA_ARGUMENT_INVALID' };
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

async function run(argv, stdout = process.stdout, stdin = process.stdin) {
  const output = outputWriter(stdout);
  const input = sessionInput(stdin);
  output.onFailure(input.cancel);
  let code, failure, rejected = false;
  try { code = await output.settle(runWithOutput(argv, text => output.write(text), input.iterable, () => output.check())); }
  catch (error) { rejected = true; failure = error; input.cancel(); }
  finally { await output.release(); }
  output.check();
  if (rejected) throw failure;
  return code;
}

async function runWithOutput(argv, write, stdin, assertActive) {
  const emit = value => write(JSON.stringify(value) + '\n');
  const unavailable = async code => { await emit({ status: 'unavailable', code, action_authorized: false }); return 2; };
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
    catch { return unavailable('KDNA_AUTHORED_INPUT_INVALID'); }
    const request = admitNativeCreationRequest({ request_id: 'cli:' + randomUUID(), tuple: binding.tuple, operation: 'create_public_asset', timeout_ms: 60000 });
    if (request.status !== 'admitted_request') { await emit(request); return 1; }
    const authority = createNativeCreationAuthority(() => true);
    assertActive();
    const produced = await createSectionAssetNode(input, request.request, authority);
    if (produced.status !== 'produced') { await emit(produced); return 1; }
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
  const host = createTrustedHostReadProvider({
    observe({ request, preparation }) {
      const now = Date.now();
      return { host_id: 'kdna-cli:local', host_epoch: 'process:' + process.pid, decision_id: 'decision:' + request.request_id,
        operation_id: preparation.intent.operation_id, request_id: request.request_id, request_digest: preparation.request_digest,
        origin: preparation.origin, intent_digest: preparation.intent_digest, asset: preparation.asset, tuple: preparation.tuple,
        scope: retainedView.ir.nodes.map(node => node.id), issued_at: now, expires_at: now + 60000,
        decision: allow ? 'allow' : 'deny', policy_id: 'kdna-cli:explicit-local-read-consent', current_ms: now };
    },
    async deliver(result) { await emit(result); delivered = true; return true; },
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
    const result = await readRetainedSection(preparation.prepared, host);
    if (!delivered) await emit(result);
    return result.channel === 'read_envelope' && ['ready', 'catalog_only'].includes(result.envelope.status) ? 0 : 1;
  }
  if (options['--session']) {
    let code = 0;
    try {
      for await (const bytes of requestLines(stdin)) {
        let request;
        try { request = parseJsonBytes(bytes); }
        catch { return await unavailable('KDNA_SESSION_JSON_INVALID'); }
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
