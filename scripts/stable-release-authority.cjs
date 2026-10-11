#!/usr/bin/env node
'use strict';
const { createAuthority } = require('./release-channel-authority.cjs');
const authority = createAuthority(require('./stable-release-profile.json'));
if (require.main === module) authority.main().catch(() => {
  console.error('CLI stable release rejected by exact source and artifact policy');
  process.exitCode = 1;
});
module.exports = authority;
