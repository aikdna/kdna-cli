/**
 * cmds/identity.js — Wrapper for the identity subcommand (Story 19)
 *
 * The wrapper exists for symmetry with the other command groups
 * (license, governance, etc.). The actual implementation lives in
 * `../identity.js` because the `sign` and `verify` commands are
 * top-level (not subcommands of `identity`); keeping the
 * implementation in one file avoids the wrapper needing to
 * re-export the internals.
 *
 * `cli.js` imports `cmdIdentityInit` and `cmdIdentityShow`
 * directly (for direct dispatch in the case-fallthrough). The
 * wrapper also re-exports them so the import path is consistent
 * with the wrapper.
 */

const { error, EXIT } = require('./_common');

const {
  cmdIdentityInit,
  cmdIdentityShow,
  cmdIdentityExport,
  cmdIdentityImport,
} = require('../identity');

function cmdIdentity(args) {
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
      `Usage: kdna identity init
       kdna identity show [--json]
       kdna identity export [--out <file>]
       kdna identity import <file>`,
      EXIT.INPUT_ERROR,
    );
  }
}

module.exports = {
  cmdIdentity,
  cmdIdentityInit,
  cmdIdentityShow,
  cmdIdentityExport,
  cmdIdentityImport,
};
