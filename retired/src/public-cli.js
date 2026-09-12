'use strict';
const { admitNode } = require('@aikdna/kdna-core/node');
const { inspectSnapshot } = require('@aikdna/kdna-core/read-boundary');
const { readNode } = require('@aikdna/kdna-read/node');
const { createTrustedReadControlProvider, createTrustedHostReadProvider } = require('@aikdna/kdna-read/embedding');
const binding = require('../public-contract-binding.json');
const commands = new Set(['inspect', 'validate', 'read', 'plan', 'load']);
const independentStates = () => ({ writer: 'not_evaluated', confirmation: 'not_evaluated', read_permission: 'not_evaluated', action_authorization: 'not_evaluated' });

function parse(argv) {
  const [command, ...rest] = argv;
  if (!commands.has(command)) return { error: 'KDNA_COMMAND_UNAVAILABLE' };
  const options = Object.create(null);
  let file;
  const valued = new Set(['--mode', '--asset-id', '--asset-version', '--judgment-id', '--budget']);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--allow-read' || arg === '--json') {
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
  return { command, file, options };
}

async function run(argv, stdout) {
  const emit = value => stdout.write(JSON.stringify(value) + '\n');
  if (!argv.length || argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
    stdout.write('kdna inspect <asset.kdna>\nkdna validate <asset.kdna>\nkdna read <asset.kdna> --mode catalog|whole_asset|exact_selection --budget <bytes> [--asset-id <id> --asset-version <version> --judgment-id <id>] [--allow-read]\nplan/load: unavailable until public Plan admission and execution exist.\n');
    return 0;
  }
  const parsed = parse(argv);
  if (parsed.error) { emit({ status: 'unavailable', code: parsed.error, action_authorized: false }); return 2; }
  const { command, file, options } = parsed;
  if (command === 'plan' || command === 'load') {
    emit({ status: 'unavailable', code: command === 'plan' ? 'KDNA_PLAN_ADMISSION_UNAVAILABLE' : 'KDNA_PLAN_EXECUTION_UNAVAILABLE', action_authorized: false, creation_accepted: false });
    return 2;
  }
  if (command === 'inspect' || command === 'validate') {
    const admission = await admitNode(file);
    if (admission.status !== 'accepted') {
      emit({ ...admission, states: { ...independentStates(), core: admission.reason === 'READ_CORE_INVALID' ? 'invalid' : 'not_evaluated' } });
      return 1;
    }
    const view = inspectSnapshot(admission.snapshot);
    if (!view) { emit({ status: 'rejected', reason: 'READ_SNAPSHOT_UNATTESTED' }); return 1; }
    const result = { status: 'accepted', format_valid: true, states: { ...independentStates(), core: 'valid', interpretation: 'complete' }, diagnostics: [] };
    if (command === 'inspect') Object.assign(result, { tuple: view.tuple, asset: view.asset, digests: view.digests, ir_digest: view.ir_digest, judgment_count: view.ir.catalog.length, runtime_entry_names: view.runtime_entry_names });
    emit(result);
    return 0;
  }
  const mode = options['--mode'] ?? 'catalog';
  const budgetText = options['--budget'] ?? '1000000';
  if (!/^(0|[1-9][0-9]*)$/.test(budgetText) || !Number.isSafeInteger(Number(budgetText))) {
    emit({ status: 'unavailable', code: 'KDNA_ARGUMENT_INVALID', action_authorized: false }); return 2;
  }
  const selectionValues = ['--asset-id', '--asset-version', '--judgment-id'].map(k => options[k]);
  if (['whole_asset', 'catalog'].includes(mode) && selectionValues.some(v => v !== undefined)) {
    emit({ status: 'unavailable', code: 'KDNA_ARGUMENT_INVALID', action_authorized: false }); return 2;
  }
  // Process-local handles are not portable to another CLI invocation.
  if (mode === 'expand') {
    emit({ status: 'unavailable', code: 'KDNA_READ_SESSION_UNAVAILABLE', action_authorized: false }); return 2;
  }
  const request = {
    request_id: 'cli:' + crypto.randomUUID(), tuple: binding.tuple,
    budget_bytes: Number(budgetText), mode,
    selection: ['whole_asset', 'catalog'].includes(mode) ? null : {
      asset_id: options['--asset-id'], asset_version: options['--asset-version'], judgment_id: options['--judgment-id'],
    }, handle: null,
  };
  const control = createTrustedReadControlProvider(() => ({ admission_response_limit_bytes: 4096 }));
  const host = createTrustedHostReadProvider({
    observe({ request: admitted, snapshot }) {
      const view = inspectSnapshot(snapshot);
      const now = Date.now();
      return {
        host_id: 'kdna-cli:local', host_epoch: 'process:' + process.pid,
        decision_id: 'decision:' + admitted.request_id, request_id: admitted.request_id,
        snapshot_id: view.snapshot_id, A: view.digests.A.observed, C: view.digests.C.observed,
        scope: view.ir.nodes.map(n => n.id), issued_at: now, expires_at: now + 60000,
        decision: options['--allow-read'] === true ? 'allow' : 'deny',
        policy_id: 'kdna-cli:explicit-local-read-consent', current_ms: now,
      };
    },
  });
  const result = await readNode(file, request, control, host);
  emit(result);
  return result.channel === 'read_envelope' && result.envelope.status === 'ready' ? 0 : 1;
}
module.exports = { run };
