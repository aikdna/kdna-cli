#!/usr/bin/env node
'use strict';
const { createAuthority } = require('./release-channel-authority.cjs');
const authority = createAuthority({
  channel: 'preview',
  version: '0.39.0-rc.native-sections.3',
  base_commit: '2adb6d403802e2ba6b9923258959c2179e05e32c',
  companions: [
    {name: '@aikdna/kdna-core', version: '0.37.1-rc.browser.1', sha256: '81639dd57dc3a56a2d9171ce3a6ce956847f4877461b8722897e4f598aa8a8ca'},
    {name: '@aikdna/kdna-read', version: '0.11.2-rc.browser.1', sha256: 'c5c2d6b65c44dd30aeddd49d6f2a4c915e9fd4d8f2a28297d6d677564e261cb7'},
  ],
});
if (require.main === module) authority.main().catch(error => {
  console.error('CLI preview release rejected: ' + error.message);
  process.exitCode = 1;
});
module.exports = authority;
