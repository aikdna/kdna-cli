const { error, EXIT } = require('./_common');

function cmdCompare(args) {
  const { cmdCompare } = require('../compare');
  const jsonMode = args.includes('--json');
  const target = args.filter((a) => !a.startsWith('--'))[1];
  if (!target || !args.includes('--input')) {
    error(
      'Usage:\n' +
        '  kdna compare <name|file.kdna> --input "<text>" [--json]\n' +
        '\n' +
        'Runs your input through the LLM twice (with/without KDNA loaded),\n' +
        'then diffs the reasoning trajectory. Requires ANTHROPIC_API_KEY or\n' +
        'OPENAI_API_KEY in the environment.',
      EXIT.INPUT_ERROR,
    );
  }
  (async () => {
    try {
      await cmdCompare(target, args);
    } catch (e) {
      if (jsonMode) {
        console.log(JSON.stringify({ error: e.message }));
        process.exit(EXIT.PROVIDER_ERROR);
      }
      console.error(`Error: ${e.message}`);
      process.exit(EXIT.VALIDATION_FAILED);
    }
  })();
}

function cmdDiff(args) {
  const { cmdDiff } = require('../diff');
  const jsonMode = args.includes('--json');
  const positional = args.filter((a) => !a.startsWith('--'));
  const a = positional[0];
  const b = positional[1];
  if (!a) {
    error(
      'Usage:\n' +
        '  kdna diff <name>@<v1> <name>@<v2>   Compare two versions\n' +
        '  kdna diff <name> [--json]            Installed vs registry-current\n' +
        '\n' +
        'Surfaces judgment-level diff: added/removed/changed axioms,\n' +
        'misunderstandings, banned terms, stances.',
      EXIT.INPUT_ERROR,
    );
  }
  (async () => {
    try {
      await cmdDiff(a, b, args);
    } catch (e) {
      if (jsonMode) {
        console.log(JSON.stringify({ error: e.message }));
        process.exit(EXIT.VALIDATION_FAILED);
      }
      console.error(`Error: ${e.message}`);
      process.exit(EXIT.VALIDATION_FAILED);
    }
  })();
}

function cmdSearch(args) {
  const { cmdSearch } = require('../search');
  const json = args.includes('--json');
  const query = args
    .slice(1)
    .filter((a) => a !== '--json')
    .join(' ')
    .trim();
  cmdSearch(query, json);
}

function cmdAvailable(args) {
  const { cmdAvailable } = require('../agent');
  cmdAvailable(args);
}

function cmdMatch(args) {
  const { cmdMatch } = require('../agent');
  const positional = [];
  const flags = [];
  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith('--')) flags.push(args[i]);
    else positional.push(args[i]);
  }
  cmdMatch(positional.join(' ').trim(), flags);
}

function cmdSelect(args) {
  const { cmdSelect } = require('../agent');
  cmdSelect(args);
}

function cmdLoad(args) {
  const { cmdLoad } = require('../agent');
  const target = args.filter((a) => !a.startsWith('--'))[1];
  if (!target)
    error(
      'Usage: kdna load <name|file.kdna> [--as=prompt|json|raw] [--profile=index|compact|scenario|full]',
    );
  cmdLoad(target, args);
}

function cmdPostvalidate(args) {
  const { cmdPostvalidate } = require('../agent');
  cmdPostvalidate(args);
}

function cmdRoute(args) {
  const { cmdRoute } = require('../agent');
  const positional = args.filter((a) => !a.startsWith('--'));
  const flags = args.filter((a) => a.startsWith('--'));
  if (!positional[1]) {
    const { error, EXIT } = require('./_common');
    error('Usage: kdna route "<task description>" [--json] [--discover]', EXIT.INPUT_ERROR);
  }
  cmdRoute(positional.slice(1).join(' ').trim(), flags);
}

module.exports = {
  cmdCompare,
  cmdDiff,
  cmdSearch,
  cmdAvailable,
  cmdMatch,
  cmdSelect,
  cmdLoad,
  cmdPostvalidate,
  cmdRoute,
};
