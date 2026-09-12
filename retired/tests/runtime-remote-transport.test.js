'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_REMOTE_RESPONSE_BYTES,
  readBoundedFetchJson,
  remoteProjectionEndpoint,
  safeRemoteCode,
} = require('../src/runtime-remote-transport');

test('runtime projection accepts only canonical HTTPS or exact loopback HTTP', () => {
  assert.equal(
    remoteProjectionEndpoint('https://remote.example.test'),
    'https://remote.example.test/project',
  );
  assert.equal(
    remoteProjectionEndpoint('https://remote.example.test/project'),
    'https://remote.example.test/project',
  );
  assert.equal(remoteProjectionEndpoint('http://127.0.0.1:3000'), 'http://127.0.0.1:3000/project');
  assert.equal(remoteProjectionEndpoint('http://[::1]:3000/'), 'http://[::1]:3000/project');

  for (const unsafe of [
    'http://localhost:3000',
    'http://192.168.1.20:3000',
    'http://remote.example.test',
    'ftp://remote.example.test',
    'https://user:pass@remote.example.test',
    'https://remote.example.test/other',
    'https://remote.example.test/project/',
    'https://remote.example.test?token=secret',
    'https://remote.example.test#fragment',
    'HTTPS://remote.example.test',
    'https://REMOTE.example.test',
    'https://remote.example.test:443',
    'https://remote.example.test\\project',
    ' https://remote.example.test',
    'https://例子.测试',
  ]) {
    assert.throws(() => remoteProjectionEndpoint(unsafe), Error, unsafe);
  }
});

test('runtime response reader accepts one bounded canonical JSON object', async () => {
  const response = new globalThis.Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
  assert.deepEqual(await readBoundedFetchJson(response), { ok: true });
});

test('runtime response reader rejects content type, arrays, and declared oversize', async () => {
  await assert.rejects(
    readBoundedFetchJson(
      new globalThis.Response('{}', {
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      }),
    ),
    /canonical JSON/u,
  );
  await assert.rejects(
    readBoundedFetchJson(
      new globalThis.Response('[]', { headers: { 'content-type': 'application/json' } }),
    ),
    /JSON object/u,
  );
  await assert.rejects(
    readBoundedFetchJson(
      new globalThis.Response(null, {
        headers: {
          'content-type': 'application/json',
          'content-length': String(MAX_REMOTE_RESPONSE_BYTES + 1),
        },
      }),
    ),
    /size is invalid/u,
  );
});

test('only bounded stable upstream codes cross the runtime error boundary', () => {
  assert.equal(safeRemoteCode('ENTITLEMENT_DENIED'), 'ENTITLEMENT_DENIED');
  for (const unsafe of ['lowercase', 'TOKEN=secret', '/tmp/private', 'A'.repeat(65), 42]) {
    assert.equal(safeRemoteCode(unsafe), 'REMOTE_REQUEST_REJECTED');
  }
});
