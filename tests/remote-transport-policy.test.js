'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const {
  MAX_REMOTE_RESPONSE_BYTES,
  accountApiEndpoint,
  assertAccountApiRequestUrl,
  canonicalLlmBaseUrl,
  legacyActivationEndpoint,
  llmProviderEndpoint,
  remoteProjectionEndpoint,
  safeRemoteCode,
  safeVerificationUrl,
} = require('../src/remote-transport');
const { postAccountJson } = require('../src/cmds/license');
const { callLlm } = require('../src/compare');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function baseUrl(server) {
  return `http://127.0.0.1:${server.address().port}`;
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

test('packaged compare provider URLs use the same fail-closed transport policy', () => {
  assert.equal(
    llmProviderEndpoint('https://api.example.test', 'openai'),
    'https://api.example.test/v1/chat/completions',
  );
  assert.equal(
    llmProviderEndpoint('https://api.example.test/openai/v1', 'openai'),
    'https://api.example.test/openai/v1/chat/completions',
  );
  assert.equal(
    llmProviderEndpoint('http://[::1]:3003', 'anthropic'),
    'http://[::1]:3003/v1/messages',
  );
  assert.equal(canonicalLlmBaseUrl('http://127.0.0.1:3003').hostname, '127.0.0.1');

  for (const unsafe of [
    'http://localhost:3003',
    'http://192.168.1.30:3003',
    'http://provider.example.test',
    'https://user:pass@provider.example.test',
    'https://provider.example.test/v1?token=secret',
    'https://provider.example.test/v1#fragment',
    'https://provider.example.test/v1/',
    'https://provider.example.test//v1',
    'https://provider.example.test/%76%31',
    'HTTPS://provider.example.test',
    'https://PROVIDER.example.test',
    'https://provider.example.test:443',
    ' https://provider.example.test',
  ]) {
    assert.throws(() => llmProviderEndpoint(unsafe, 'openai'), Error, unsafe);
  }
  assert.throws(() => llmProviderEndpoint('https://provider.example.test', 'unsupported'), Error);
});

test('packaged compare sends provider credentials and judgment only to exact loopback', async () => {
  let observed;
  const server = http.createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk;
    });
    request.on('end', () => {
      observed = {
        url: request.url,
        authorization: request.headers.authorization,
        body: JSON.parse(raw),
      };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: 'bounded answer' } }] }));
    });
  });
  await listen(server);
  try {
    const result = await callLlm(
      {
        provider: 'openai',
        baseUrl: baseUrl(server),
        apiKey: 'request-secret',
        model: 'test-model',
      },
      'system judgment',
      'user context',
    );
    assert.equal(result, 'bounded answer');
    assert.equal(observed.url, '/v1/chat/completions');
    assert.equal(observed.authorization, 'Bearer request-secret');
    assert.equal(observed.body.messages[0].content, 'system judgment');
    assert.equal(observed.body.messages[1].content, 'user context');
  } finally {
    await close(server);
  }
});

test('packaged compare rejects redirects before sending secrets to the destination', async () => {
  let destinationRequests = 0;
  const destination = http.createServer((_request, response) => {
    destinationRequests += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{}');
  });
  const redirector = http.createServer((_request, response) => {
    response.writeHead(307, { location: `${baseUrl(destination)}/capture?token=redirect-secret` });
    response.end();
  });
  await listen(destination);
  await listen(redirector);
  try {
    await assert.rejects(
      callLlm(
        {
          provider: 'openai',
          baseUrl: baseUrl(redirector),
          apiKey: 'request-secret',
          model: 'test-model',
        },
        'system judgment',
        'private user context',
      ),
      (error) => {
        assert.equal(error.code, 'REMOTE_TRANSPORT_FAILED');
        assert.doesNotMatch(
          error.message,
          /127\.0\.0\.1|redirect-secret|request-secret|private user|capture/,
        );
        return true;
      },
    );
    assert.equal(destinationRequests, 0);
  } finally {
    await close(redirector);
    await close(destination);
  }
});

test('packaged compare bounds responses and never exposes provider bodies', async () => {
  let mode = 'denied';
  const server = http.createServer((_request, response) => {
    if (mode === 'denied') {
      response.writeHead(403, { 'content-type': 'application/json' });
      response.end('{"error":"token=response-secret; file=/tmp/private.json"}');
      return;
    }
    if (mode === 'empty') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"choices":[]}');
      return;
    }
    response.writeHead(200, {
      'content-type': 'application/json',
      'content-length': String(MAX_REMOTE_RESPONSE_BYTES + 1),
    });
    response.end('{}');
  });
  await listen(server);
  try {
    for (mode of ['denied', 'empty', 'oversized']) {
      await assert.rejects(
        callLlm(
          {
            provider: 'openai',
            baseUrl: baseUrl(server),
            apiKey: 'request-secret',
            model: 'test-model',
          },
          'system judgment',
          'private user context',
        ),
        (error) => {
          assert.equal(
            error.code,
            mode === 'denied' ? 'REMOTE_HTTP_ERROR' : 'REMOTE_RESPONSE_INVALID',
          );
          assert.doesNotMatch(
            error.message,
            /response-secret|request-secret|private user|private\.json|127\.0\.0\.1/,
          );
          return true;
        },
      );
    }
  } finally {
    await close(server);
  }
});
