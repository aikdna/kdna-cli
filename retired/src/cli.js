#!/usr/bin/env node
'use strict';
const { run } = require('./public-cli.js');
run(process.argv.slice(2), process.stdout).then(code => {
  process.exitCode = code;
}).catch(() => {
  process.stderr.write('KDNA_CLI_UNAVAILABLE\n');
  process.exitCode = 1;
});
