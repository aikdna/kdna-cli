'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { error, EXIT } = require('./_common');
const { prepareRuntimeContract } = require('../runtime-contract');

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

function cmdPlanUse(args) {
  const target = args.find((value) => !value.startsWith('--'));
  if (!target || args.includes('--help') || args.includes('-h')) {
    process.stderr.write(
      'Usage: kdna plan-use <name[@version]|asset.kdna> [options]\n\n' +
        'Generate the current deterministic ConsumptionPlan without Host execution.\n\n' +
        'Options:\n' +
        '  --task=<text>         Task description\n' +
        '  --task-family=<name>  Optional task family\n' +
        '  --budget=<profile>    interactive|code-review|offline-audit\n' +
        '  --shape=<name>        answer-pattern|compact|scenario|full\n' +
        '  --as=json             Current machine-readable contract\n' +
        '  --out=<path>          Write the plan to a file\n' +
        '  --plan-id=<id>        Use a caller-provided plan identifier\n' +
        '  --runtime-contract    Assert the current Runtime contract\n',
    );
    if (args.includes('--help') || args.includes('-h')) return;
    process.exit(EXIT.INPUT_ERROR);
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
  const as = getFlag(args, '--as') || 'json';
  if (as !== 'json') error('ConsumptionPlan output supports --as=json only.', EXIT.INPUT_ERROR);

  let prepared;
  try {
    prepared = prepareRuntimeContract(target, {
      task: getFlag(args, '--task') || '',
      taskFamily: getFlag(args, '--task-family') || undefined,
      budgetProfile: getFlag(args, '--budget') || 'code-review',
      profile: getFlag(args, '--shape') || 'compact',
      planId: getFlag(args, '--plan-id') || undefined,
    });
  } catch (cause) {
    error(`Runtime contract planning failed: ${cause.message}`, EXIT.VALIDATION_FAILED);
  }

  const json = `${JSON.stringify(prepared.plan, null, 2)}\n`;
  const output = getFlag(args, '--out');
  if (output) {
    const absolute = path.resolve(output);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, json);
  }
  process.stdout.write(json);
}

module.exports = { cmdPlanUse };
