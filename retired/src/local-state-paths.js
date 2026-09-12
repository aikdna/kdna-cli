'use strict';

const path = require('node:path');

function root() {
  return (
    process.env.KDNA_HOME || path.join(process.env.HOME || process.env.USERPROFILE || '.', '.kdna')
  );
}

module.exports = Object.freeze({
  get root() {
    return root();
  },
  get audit() {
    return path.join(root(), 'audit.jsonl');
  },
  get licenses() {
    return path.join(root(), 'licenses');
  },
});
