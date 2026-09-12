'use strict';
const { randomUUID } = require('node:crypto');
const { Readable, Writable } = require('node:stream');
const { admitNode } = require('@aikdna/kdna-core/node');
const { inspectSnapshot } = require('@aikdna/kdna-core/read-boundary');
const { readNode } = require('@aikdna/kdna-read/node');
const { readBrowser } = require('@aikdna/kdna-read/browser');
const { createTrustedReadControlProvider, createTrustedHostReadProvider } = require('@aikdna/kdna-read/embedding');
const binding = require('../public-contract-binding.json');
const commands = new Set(['inspect', 'validate', 'read', 'plan', 'load']);
const independentStates = () => ({ writer: 'not_evaluated', confirmation: 'not_evaluated', read_permission: 'not_evaluated', action_authorization: 'not_evaluated' });
const help = [
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
  const valued = new Set(['--mode', '--asset-id', '--asset-version', '--judgment-id', '--budget']);
  let file;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (['--allow-read', '--json', '--session'].includes(arg)) {
      if (options[arg] !== undefined) return { error: 'KDNA_ARGUMENT_INVALID' };
      options[arg] = true;
    } else if (valued.has(arg)) {
      if (options[arg] !== undefined || i + 1 >= rest.length || rest[i + 1].startsWith('--')) return { error: 'KDNA_ARGUMENT_INVALID' };
      options[arg] = rest[++i];
    } else if (arg.startsWith('-') || file !== undefined) return { error: 'KDNA_ARGUMENT_INVALID' };
    else file = arg;
  }
  if (!file && command !== 'plan' && command !== 'load') return { error: 'KDNA_ARGUMENT_INVALID' };
  if (command !== 'read' && Object.keys(options).some(k => k !== '--json')) return { error: 'KDNA_ARGUMENT_INVALID' };
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
  try { code = await output.settle(runWithOutput(argv, text => output.write(text), input.iterable)); }
  catch (error) { rejected = true; failure = error; input.cancel(); }
  finally { await output.release(); }
  output.check();
  if (rejected) throw failure;
  return code;
}

async function runWithOutput(argv, write, stdin) {
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
  if (command === 'inspect' || command === 'validate') {
    const admission = await admitNode(file);
    if (admission.status !== 'accepted') {
      await emit({ ...admission, states: { ...independentStates(), ...admission.states } });
      return 1;
    }
    const view = inspectSnapshot(admission.snapshot);
    if (!view) { await emit({ status: 'rejected', reason: 'READ_SNAPSHOT_UNATTESTED' }); return 1; }
    const result = { status: 'accepted', format_valid: true, states: { ...independentStates(), core: 'valid', interpretation: 'complete' }, diagnostics: [] };
    if (command === 'inspect') Object.assign(result, { tuple: view.tuple, asset: view.asset, digests: view.digests, ir_digest: view.ir_digest, judgment_count: view.ir.catalog.length, runtime_entry_names: view.runtime_entry_names });
    await emit(result);
    return 0;
  }
  let retainedSnapshot = null, delivered = false;
  const control = createTrustedReadControlProvider(() => ({ admission_response_limit_bytes: 4096 }));
  const host = createTrustedHostReadProvider({
    observe({ request, snapshot }) {
      const view = inspectSnapshot(snapshot);
      retainedSnapshot = snapshot;
      const now = Date.now();
      return { host_id: 'kdna-cli:local', host_epoch: 'process:' + process.pid, decision_id: 'decision:' + request.request_id, request_id: request.request_id, snapshot_id: view.snapshot_id, A: view.digests.A.observed, C: view.digests.C.observed, scope: view.ir.nodes.map(n => n.id), issued_at: now, expires_at: now + 60000, decision: options['--allow-read'] === true ? 'allow' : 'deny', policy_id: 'kdna-cli:explicit-local-read-consent', current_ms: now };
    },
    async deliver(result) { await emit(result); delivered = true; return true; },
  });
  async function read(request) {
    delivered = false;
    const result = retainedSnapshot
      ? await readBrowser(retainedSnapshot, request, control, host)
      : await readNode(file, request, control, host);
    if (!delivered) await emit(result);
    return result.channel === 'read_envelope' && result.envelope.status === 'ready' ? 0 : 1;
  }
  if (options['--session']) {
    let code = 0;
    try {
      for await (const bytes of requestLines(stdin)) {
        let request;
        try { request = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
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
  return read({ request_id: 'cli:' + randomUUID(), tuple: binding.tuple, budget_bytes: Number(budgetText), mode, selection: ['whole_asset', 'catalog'].includes(mode) ? null : { asset_id: options['--asset-id'], asset_version: options['--asset-version'], judgment_id: options['--judgment-id'] }, handle: null });
}
module.exports = { run };
