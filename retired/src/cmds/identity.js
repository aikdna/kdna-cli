/**
 * Current identity subcommand wrapper.
 */

const { error, EXIT } = require('./_common');

const { cmdIdentityInit, cmdIdentityShow } = require('../identity');

function cmdIdentity(args) {
  const sub = args[1];
  if (sub === 'init') {
    cmdIdentityInit();
  } else if (sub === 'show') {
    cmdIdentityShow(args.includes('--json'));
  } else {
    error(
      `Usage: kdna identity init
       kdna identity show [--json]`,
      EXIT.INPUT_ERROR,
    );
  }
}

module.exports = {
  cmdIdentity,
  cmdIdentityInit,
  cmdIdentityShow,
};
