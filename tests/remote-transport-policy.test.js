'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const {
  accountApiEndpoint,
  assertAccountApiRequestUrl,
  legacyActivationEndpoint,
  remoteProjectionEndpoint,
  safeRemoteCode,
  safeVerificationUrl,
} = require('../src/remote-transport');
const { postAccountJson } = require('../src/cmds/license');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test('remote projection requires HTTPS except exact numeric loopback HTTP', () => {
  assert.equal(
    remoteProjectionEndpoint('https://remote.example.test'),
    'https://remote.example.test/project',
  );
  assert.equal(
    remoteProjectionEndpoint('https://remote.example.test/project'),
    'https://remote.example.test/project',
  );
  assert.equal(remoteProjectionEndpoint('http://127.0.0.1:3000/'), 'http://127.0.0.1:3000/project');
  assert.equal(remoteProjectionEndpoint('http://[::1]:3000'), 'http://[::1]:3000/project');

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

test('legacy Activation accepts only its exact contractual endpoint', () => {
  assert.equal(
    legacyActivationEndpoint('https://licenses.example.test'),
    'https://licenses.example.test/entitlements/activate',
  );
  assert.equal(
    legacyActivationEndpoint('http://127.0.0.1:3001/entitlements/activate'),
    'http://127.0.0.1:3001/entitlements/activate',
  );
  for (const unsafe of [
    'http://localhost:3001/entitlements/activate',
    'http://licenses.example.test/entitlements/activate',
    'https://user@licenses.example.test/entitlements/activate',
    'https://licenses.example.test/entitlements/sync',
    'https://licenses.example.test/entitlements/activate?key=secret',
  ]) {
    assert.throws(() => legacyActivationEndpoint(unsafe), Error, unsafe);
  }
});

test('account API base is a canonical origin or exact /api base', () => {
  assert.equal(
    accountApiEndpoint('https://accounts.example.test', 'device-activations'),
    'https://accounts.example.test/api/v1/device-activations',
  );
  assert.equal(
    accountApiEndpoint('http://[::1]:3002/api', 'entitlements/ent_1/sync'),
    'http://[::1]:3002/api/v1/entitlements/ent_1/sync',
  );
  for (const unsafe of [
    'http://localhost:3002',
    'http://accounts.example.test',
    'https://user:pass@accounts.example.test',
    'https://accounts.example.test/api/v1',
    'https://accounts.example.test?tenant=secret',
    'https://accounts.example.test#fragment',
  ]) {
    assert.throws(() => accountApiEndpoint(unsafe, 'device-activations'), Error, unsafe);
  }
  for (const unsafeResource of [
    '../admin',
    'device-activations/',
    '/device-activations',
    'x?y',
    'x#y',
  ]) {
    assert.throws(
      () => accountApiEndpoint('https://accounts.example.test', unsafeResource),
      Error,
      unsafeResource,
    );
  }
  assert.equal(
    assertAccountApiRequestUrl('https://accounts.example.test/api/v1/device-activations'),
    'https://accounts.example.test/api/v1/device-activations',
  );
  assert.throws(
    () => assertAccountApiRequestUrl('http://accounts.example.test/api/v1/device-activations'),
    Error,
  );
});

test('account requests reject redirects and sterilize response bodies', async () => {
  let destinationRequests = 0;
  const destination = http.createServer((_request, response) => {
    destinationRequests += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{}');
  });
  const redirector = http.createServer((_request, response) => {
    response.writeHead(302, {
      location: `http://127.0.0.1:${destination.address().port}/capture?token=redirect-secret`,
    });
    response.end();
  });
  const rejecting = http.createServer((_request, response) => {
    response.writeHead(403, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        error: {
          code: 'ENTITLEMENT_DENIED',
          message: 'token=response-secret; file=/tmp/provider/private.json',
        },
      }),
    );
  });
  await listen(destination);
  await listen(redirector);
  await listen(rejecting);
  try {
    const redirectUrl = `http://127.0.0.1:${redirector.address().port}/api/v1/device-activations`;
    await assert.rejects(
      postAccountJson(redirectUrl, { activation_credential: 'request-secret' }),
      (error) => {
        assert.match(error.message, /ACCOUNT_REQUEST_REJECTED/);
        assert.doesNotMatch(error.message, /127\.0\.0\.1|redirect-secret|request-secret|capture/);
        return true;
      },
    );
    assert.equal(destinationRequests, 0);

    const rejectUrl = `http://127.0.0.1:${rejecting.address().port}/api/v1/device-activations`;
    await assert.rejects(
      postAccountJson(rejectUrl, { activation_credential: 'request-secret' }),
      (error) => {
        assert.match(error.message, /ENTITLEMENT_DENIED/);
        assert.doesNotMatch(
          error.message,
          /response-secret|request-secret|provider\/private|127\.0\.0\.1/,
        );
        return true;
      },
    );
  } finally {
    await close(rejecting);
    await close(redirector);
    await close(destination);
  }
});

test('device verification URI rejects localhost, credentials, and fragments', () => {
  assert.equal(
    safeVerificationUrl('https://accounts.example.test/activate?code=TEST-CODE'),
    'https://accounts.example.test/activate?code=TEST-CODE',
  );
  assert.equal(
    safeVerificationUrl('http://127.0.0.1:3002/activate?code=TEST-CODE'),
    'http://127.0.0.1:3002/activate?code=TEST-CODE',
  );
  for (const unsafe of [
    'http://localhost:3002/activate',
    'http://accounts.example.test/activate',
    'https://user:pass@accounts.example.test/activate',
    'https://accounts.example.test/activate#code',
  ]) {
    assert.throws(() => safeVerificationUrl(unsafe), Error, unsafe);
  }
});

test('only bounded stable upstream codes cross the error boundary', () => {
  assert.equal(safeRemoteCode('ENTITLEMENT_DENIED'), 'ENTITLEMENT_DENIED');
  for (const unsafe of ['lowercase', 'TOKEN=secret', '/tmp/private', 'A'.repeat(65), 42]) {
    assert.equal(safeRemoteCode(unsafe), 'REMOTE_REQUEST_REJECTED');
  }
});
