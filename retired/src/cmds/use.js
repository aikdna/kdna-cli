'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { error, EXIT } = require('./_common');
const { createAgentHostCapabilityRegistry } = require('../agent-host-capabilities');
const { executePreparedRuntimeContract, prepareRuntimeContract } = require('../runtime-contract');

function optionOccurrences(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === name) values.push(null);
    else if (value.startsWith(`${name}=`)) values.push(value.slice(name.length + 1));
  }
  return values;
}

function getFlag(args, name) {
  const inline = args.find((value) => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1) || null;
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith('--')
    ? args[index + 1]
    : null;
}

function getFlags(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value.startsWith(`${name}=`)) values.push(value.slice(name.length + 1));
    else if (value === name && args[index + 1] !== undefined) {
      values.push(args[index + 1]);
      index += 1;
    }
  }
  return values;
}

function cmdUse(args) {
  if (args.includes('--list-runners')) {
    console.log('Registered runners (1):\n  - cli:default');
    return;
  }
  const target = args.find((value) => !value.startsWith('--'));
  if (!target || args.includes('--help') || args.includes('-h')) {
    process.stderr.write(
      'Usage: kdna use <name[@version]|asset.kdna> [options]\n\n' +
        'Deliver the current Runtime Capsule to a registered process Host.\n\n' +
        'Options:\n' +
        '  --task=<text>                    Task description\n' +
        '  --task-family=<name>             Optional task family\n' +
        '  --runner=cli:default             Current process runner\n' +
        '  --agent-host=<command>           Process Host executable\n' +
        '  --agent-host-arg=<arg>           Exact argument (repeatable)\n' +
        '  --agent-host-capabilities=<file> Bound Host capability registration\n' +
        '  --runtime-contract               Assert the current Runtime contract\n' +
        '  --budget=<profile>               Runtime budget profile\n' +
        '  --shape=<name>                   Projection profile\n' +
        '  --timeout=<ms>                   Positive process timeout\n' +
        '  --as=<json|trace>                Output contract\n' +
        '  --out=<path>                     Write complete evidence to a file\n' +
        '  --plan-only                      Emit the ConsumptionPlan only\n',
    );
    if (args.includes('--help') || args.includes('-h')) return;
    process.exit(EXIT.INPUT_ERROR);
  }
  if (target.endsWith('.json')) {
    error(
      'Cluster execution is a separate staged Runtime and is not enabled by kdna use.',
      EXIT.INPUT_ERROR,
    );
  }

  const assertions = optionOccurrences(args, '--runtime-contract');
  if (
    assertions.length > 1 ||
    assertions.some((value) => value !== null) ||
    args.some(
      (value, index) =>
        value === '--runtime-contract' && /^\d+(?:\.\d+)*$/.test(args[index + 1] || ''),
    )
  ) {
    error(
      'Runtime contract accepts at most one bare --runtime-contract assertion and no generation selector.',
      EXIT.INPUT_ERROR,
    );
  }
  if (args.includes('--dry-run')) {
    error('Runtime execution does not support --dry-run.', EXIT.INPUT_ERROR);
  }
  const timeoutValues = optionOccurrences(args, '--timeout');
  if (
    timeoutValues.length > 1 ||
    (timeoutValues.length === 1 &&
      (!/^[1-9][0-9]*$/.test(timeoutValues[0] || '') ||
        !Number.isSafeInteger(Number(timeoutValues[0])) ||
        Number(timeoutValues[0]) > 2_147_483_647))
  ) {
    error(
      'Runtime contract --timeout must be one positive integer no greater than 2147483647.',
      EXIT.INPUT_ERROR,
    );
  }
  const as = getFlag(args, '--as') || 'json';
  if (!['json', 'trace'].includes(as)) {
    error('Runtime execution supports --as=json or --as=trace only.', EXIT.INPUT_ERROR);
  }

  let prepared;
  try {
    prepared = prepareRuntimeContract(target, {
      task: getFlag(args, '--task') || '',
      taskFamily: getFlag(args, '--task-family') || undefined,
      budgetProfile: getFlag(args, '--budget') || 'code-review',
      profile: getFlag(args, '--shape') || 'compact',
    });
  } catch (cause) {
    error(`Runtime contract planning failed: ${cause.message}`, EXIT.VALIDATION_FAILED);
  }

  const outputPath = getFlag(args, '--out');
  if (args.includes('--plan-only')) {
    const json = `${JSON.stringify(prepared.plan, null, 2)}\n`;
    if (outputPath) {
      const absolute = path.resolve(outputPath);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, json);
    }
    process.stdout.write(json);
    return;
  }

  const runner = getFlag(args, '--runner') || 'cli:default';
  if (runner !== 'cli:default') {
    error('Runtime contract requires --runner=cli:default.', EXIT.INPUT_ERROR);
  }
  const command = getFlag(args, '--agent-host');
  if (!command)
    error('Runtime contract requires an explicit --agent-host process.', EXIT.INPUT_ERROR);
  const processArgs = getFlags(args, '--agent-host-arg');
  const capabilityPath = getFlag(args, '--agent-host-capabilities');

  let capabilities;
  try {
    const registry = createAgentHostCapabilityRegistry(prepared.core);
    const selection = { command, args: processArgs };
    if (capabilityPath) registry.registerProcessFile(capabilityPath, selection);
    capabilities = registry.resolveProcess(selection);
  } catch (cause) {
    error(`Agent Host capability registration failed: ${cause.message}`, EXIT.INPUT_ERROR);
  }

  executePreparedRuntimeContract(prepared, {
    capabilities,
    command,
    args: processArgs,
    timeoutMs: Number(getFlag(args, '--timeout') || 30000),
  })
    .then((execution) => {
      const output = {
        plan_id: execution.plan.plan_id,
        mode: 'single',
        runner: 'cli:default',
        status: execution.trace.overall_status,
        result: execution.receipt?.outcome || null,
        trace: execution.trace,
      };
      if (outputPath) {
        const absolute = path.resolve(outputPath);
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(
          absolute,
          `${JSON.stringify(
            { plan: execution.plan, receipt: execution.receipt, trace: execution.trace },
            null,
            2,
          )}\n`,
        );
      }
      console.log(JSON.stringify(as === 'trace' ? execution.trace : output, null, 2));
      if (execution.trace.overall_status !== 'execution_completed') {
        process.exitCode = EXIT.VALIDATION_FAILED;
      }
    })
    .catch((cause) => {
      error(`Runtime contract execution failed: ${cause.message}`, EXIT.PROVIDER_ERROR);
    });
}

module.exports = { cmdUse };
