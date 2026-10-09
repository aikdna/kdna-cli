#!/usr/bin/env node
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const DIST_TAG = 'native-preview';
const REGISTRY = 'https://registry.npmjs.org/';
const NPM_VERSION = '11.17.0';
function assert(value, message) {
  if (!value) throw new Error(message);
}
function read(file) {
  assert(
    path.isAbsolute(file) && fs.realpathSync(file) === file,
    'publisher file path must be canonical',
  );
  const stat = fs.lstatSync(file);
  assert(
    stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 64 * 1024 * 1024,
    'publisher input must be a bounded regular file',
  );
  return fs.readFileSync(file);
}
async function publishVerified({
  libraryPath,
  manifestPath,
  artifactPath,
  artifactSha256,
  token,
  library = null,
}) {
  assert(path.isAbsolute(libraryPath), 'publisher library path must be absolute');
  assert(
    typeof token === 'string' && token !== '' && !/[\r\n\0]/u.test(token),
    'publisher token missing or invalid',
  );
  assert(/^[0-9a-f]{64}$/u.test(artifactSha256 || ''), 'publisher artifact digest invalid');
  const bytes = read(artifactPath);
  assert(
    crypto.createHash('sha256').update(bytes).digest('hex') === artifactSha256,
    'publisher retained artifact digest mismatch',
  );
  const manifest = JSON.parse(read(manifestPath).toString('utf8'));
  const versions = { '@aikdna/kdna-cli': '0.39.0-rc.native-sections.3' };
  assert(
    Object.hasOwn(versions, manifest.name) &&
      manifest.version === versions[manifest.name] &&
      /^[a-f0-9]{40}$/u.test(manifest.gitHead || ''),
    'publisher target identity invalid',
  );
  assert(
    !Object.hasOwn(manifest, 'publishConfig') &&
      !Object.hasOwn(manifest, 'dist') &&
      !Object.hasOwn(manifest, 'tag'),
    'publisher manifest contains conflicting metadata',
  );
  const publisher = library || require(libraryPath);
  assert(typeof publisher.publish === 'function', 'publisher audited library unavailable');
  await publisher.publish(manifest, bytes, {
    '//registry.npmjs.org/:_authToken': token,
    access: 'public',
    algorithms: ['sha512'],
    defaultTag: DIST_TAG,
    npmVersion: NPM_VERSION,
    provenance: true,
    registry: REGISTRY,
  });
  return true;
}
async function main(argv = process.argv.slice(2)) {
  assert(argv.length === 4, 'publisher arguments invalid');
  const token = process.env.NODE_AUTH_TOKEN;
  retainedToken = typeof token === 'string' ? token : '';
  delete process.env.NODE_AUTH_TOKEN;
  await publishVerified({
    libraryPath: argv[0],
    manifestPath: argv[1],
    artifactPath: argv[2],
    artifactSha256: argv[3],
    token,
  });
}
const DETAIL_LIMIT = 2048;
let retainedToken = '';
function bounded(value) {
  const text = typeof value === 'string' ? value : '';
  return text.length > DETAIL_LIMIT ? text.slice(0, DETAIL_LIMIT) + '...[truncated]' : text;
}
// The token is redacted defensively so a provider that echoes it cannot leak it
// into the workflow log, and the detail is bounded.
function redacted(value) {
  const text = bounded(value);
  if (retainedToken === '') return text;
  return text.split(retainedToken).join('[redacted]');
}
if (require.main === module)
  main().catch((error) => {
    console.error('Verified preview publisher rejected the request');
    console.error(
      'Verified preview publisher detail: ' +
        JSON.stringify({
          name: typeof error?.name === 'string' ? error.name : null,
          code:
            typeof error?.code === 'string' || typeof error?.code === 'number'
              ? error.code
              : null,
          statusCode: typeof error?.statusCode === 'number' ? error.statusCode : null,
          message: redacted(typeof error?.message === 'string' ? error.message : ''),
          body: redacted(
            typeof error?.body === 'string'
              ? error.body
              : error?.body
                ? JSON.stringify(error.body)
                : '',
          ),
        }),
    );
    process.exitCode = 1;
  });
module.exports = { DIST_TAG, publishVerified };
