'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { createAgentHostCapabilityRegistry } = require('./agent-host-capabilities');
const { EXIT, error } = require('./foundation-common');
const { executePreparedRuntimeContract, prepareRuntimeContract } = require('./runtime-contract');

const RUNTIME_INTENT_OPTIONS = Object.freeze([
  '--runtime-contract',
  '--agent-host',
  '--agent-host-arg',
  '--agent-host-capabilities',
  '--runner',
  '--budget',
  '--shape',
  '--timeout',
  '--out',
  '--plan-only',
  '--task-family',
]);

const VALUE_OPTIONS = new Set([
  '--task',
  '--task-family',
  '--runner',
  '--agent-host',
  '--agent-host-arg',
  '--agent-host-capabilities',
  '--budget',
  '--shape',
  '--timeout',
  '--as',
  '--out',
  '--plan-id',
]);
const REPEATABLE_OPTIONS = new Set(['--agent-host-arg']);
const BOOLEAN_OPTIONS = new Set(['--runtime-contract', '--plan-only']);

function isRuntimeHostRequest(args) {
  return args.some((argument) =>
    RUNTIME_INTENT_OPTIONS.some((name) => argument === name || argument.startsWith(`${name}=`)),
  );
}

function isRuntimePlanRequest(args) {
  return (
    isRuntimeHostRequest(args) ||
    args.some((argument) => argument === '--task' || argument.startsWith('--task='))
  );
}

function assertRuntimeSelector(args) {
  const assertions = args.filter(
    (argument) => argument === '--runtime-contract' || argument.startsWith('--runtime-contract='),
  );
  const bareIndex = args.indexOf('--runtime-contract');
  if (
    assertions.length > 1 ||
    assertions.some((argument) => argument !== '--runtime-contract') ||
    (bareIndex !== -1 && /^\d+(?:\.\d+)*$/u.test(args[bareIndex + 1] || ''))
  ) {
    error(
      'Runtime contract accepts at most one bare --runtime-contract assertion and no generation selector.',
      EXIT.INPUT_ERROR,
    );
  }
}

function parseRuntimeArgs(args) {
  assertRuntimeSelector(args);
  const positional = [];
  const booleans = new Set();
  const values = new Map();

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith('--')) {
      positional.push(argument);
      continue;
    }
    const equals = argument.indexOf('=');
    const name = equals === -1 ? argument : argument.slice(0, equals);
    if (BOOLEAN_OPTIONS.has(name)) {
      if (equals !== -1) error(`${name} does not accept a value.`, EXIT.INPUT_ERROR);
      if (booleans.has(name)) error(`${name} may be supplied only once.`, EXIT.INPUT_ERROR);
      booleans.add(name);
      continue;
    }
    if (!VALUE_OPTIONS.has(name)) error(`Unknown option: ${name}`, EXIT.INPUT_ERROR);
    const value = equals === -1 ? args[index + 1] : argument.slice(equals + 1);
    if (equals === -1) index += 1;
    if (typeof value !== 'string' || value.length === 0) {
      error(`${name} requires a value.`, EXIT.INPUT_ERROR);
    }
    if (!REPEATABLE_OPTIONS.has(name) && values.has(name)) {
      error(`${name} may be supplied only once.`, EXIT.INPUT_ERROR);
    }
    const current = values.get(name) || [];
    current.push(value);
    values.set(name, current);
  }

  if (positional.length !== 1) {
    error('Runtime Host operations require one explicit packaged .kdna file.', EXIT.INPUT_ERROR);
  }
  return {
    target: positional[0],
    has: (name) => booleans.has(name),
    value: (name, fallback = null) => values.get(name)?.[0] ?? fallback,
    values: (name) => values.get(name) || [],
  };
}

function assertTimeout(value) {
  if (
    value !== null &&
    (!/^[1-9][0-9]*$/u.test(value) ||
      !Number.isSafeInteger(Number(value)) ||
      Number(value) > 2_147_483_647)
  ) {
    error(
      'Runtime contract --timeout must be one positive integer no greater than 2147483647.',
      EXIT.INPUT_ERROR,
    );
  }
}

function prepare(parsed) {
  try {
    return prepareRuntimeContract(parsed.target, {
      task: parsed.value('--task', ''),
      taskFamily: parsed.value('--task-family') || undefined,
      budgetProfile: parsed.value('--budget', 'code-review'),
      profile: parsed.value('--shape', 'compact'),
      planId: parsed.value('--plan-id') || undefined,
    });
  } catch (cause) {
    error(`Runtime contract planning failed: ${cause.message}`, EXIT.VALIDATION_FAILED);
  }
}

function writeJsonOutput(value, outputPath) {
  const json = `${JSON.stringify(value, null, 2)}\n`;
  if (outputPath) {
    const absolute = path.resolve(outputPath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, json);
  }
  process.stdout.write(json);
}

function cmdRuntimePlanLoad(args) {
  const parsed = parseRuntimeArgs(args);
  if (parsed.has('--plan-only')) {
    error('--plan-only is redundant with plan-load.', EXIT.INPUT_ERROR);
  }
  if (
    parsed.value('--runner') ||
    parsed.value('--agent-host') ||
    parsed.values('--agent-host-arg').length > 0 ||
    parsed.value('--agent-host-capabilities') ||
    parsed.value('--timeout')
  ) {
    error('plan-load does not select or start an Agent Host.', EXIT.INPUT_ERROR);
  }
  const as = parsed.value('--as', 'json');
  if (as !== 'json') error('ConsumptionPlan output supports --as=json only.', EXIT.INPUT_ERROR);
  writeJsonOutput(prepare(parsed).plan, parsed.value('--out'));
}

async function cmdRuntimeLoad(args) {
  const parsed = parseRuntimeArgs(args);
  assertTimeout(parsed.value('--timeout'));
  const prepared = prepare(parsed);
  if (parsed.has('--plan-only')) {
    writeJsonOutput(prepared.plan, parsed.value('--out'));
    return;
  }

  const as = parsed.value('--as', 'json');
  if (!['json', 'trace'].includes(as)) {
    error('Runtime Host execution supports --as=json or --as=trace only.', EXIT.INPUT_ERROR);
  }
  const runner = parsed.value('--runner', 'cli:default');
  if (runner !== 'cli:default') {
    error('Runtime contract requires --runner=cli:default.', EXIT.INPUT_ERROR);
  }
  const command = parsed.value('--agent-host');
  if (!command) {
    error('Runtime contract requires an explicit --agent-host process.', EXIT.INPUT_ERROR);
  }

  const processArgs = parsed.values('--agent-host-arg');
  const capabilityPath = parsed.value('--agent-host-capabilities');
  let capabilities;
  try {
    const registry = createAgentHostCapabilityRegistry(prepared.core);
    const selection = { command, args: processArgs };
    if (capabilityPath) registry.registerProcessFile(capabilityPath, selection);
    capabilities = registry.resolveProcess(selection);
  } catch (cause) {
    error(`Agent Host capability registration failed: ${cause.message}`, EXIT.INPUT_ERROR);
  }

  let execution;
  try {
    execution = await executePreparedRuntimeContract(prepared, {
      capabilities,
      command,
      args: processArgs,
      timeoutMs: Number(parsed.value('--timeout', '30000')),
    });
  } catch (cause) {
    error(`Runtime contract execution failed: ${cause.message}`, EXIT.PROVIDER_ERROR);
  }
  const output = {
    plan_id: execution.plan.plan_id,
    mode: 'single',
    runner: 'cli:default',
    status: execution.trace.overall_status,
    result: execution.receipt?.outcome || null,
    trace: execution.trace,
  };
  const evidence = {
    plan: execution.plan,
    receipt: execution.receipt,
    trace: execution.trace,
  };
  if (parsed.value('--out')) {
    const absolute = path.resolve(parsed.value('--out'));
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, `${JSON.stringify(evidence, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(as === 'trace' ? execution.trace : output, null, 2)}\n`);
  if (execution.trace.overall_status !== 'execution_completed') {
    process.exitCode = EXIT.VALIDATION_FAILED;
  }
}

module.exports = {
  cmdRuntimeLoad,
  cmdRuntimePlanLoad,
  isRuntimeHostRequest,
  isRuntimePlanRequest,
};
