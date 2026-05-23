const { error, EXIT } = require('./_common');

function cmdIdentity(args) {
  const {
    cmdIdentityInit,
    cmdIdentityShow,
    cmdIdentityExport,
    cmdIdentityImport,
  } = require('../identity');
  const sub = args[1];
  if (sub === 'init') {
    cmdIdentityInit();
  } else if (sub === 'show') {
    cmdIdentityShow(args.includes('--json'));
  } else if (sub === 'export') {
    const outIdx = args.indexOf('--out');
    cmdIdentityExport(outIdx >= 0 ? args[outIdx + 1] : null);
  } else if (sub === 'import') {
    const target = args[2];
    if (!target) error('Usage: kdna identity import <file>', EXIT.INPUT_ERROR);
    cmdIdentityImport(target);
  } else {
    error(
      `Usage: kdna identity init\n       kdna identity show [--json]\n       kdna identity export [--out <file>]\n       kdna identity import <file>`,
      EXIT.INPUT_ERROR,
    );
  }
}

module.exports = {
  cmdIdentity,
};
