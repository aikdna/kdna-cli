#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const https = require('node:https');

const URL = 'https://registry.npmjs.org/npm/-/npm-11.17.0.tgz';
const MAX_BYTES = 8 * 1024 * 1024;

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

const destination = process.argv[2];
if (!destination) {
  fail('trusted npm download destination is required');
} else {
  const request = https.get(
    URL,
    { headers: { accept: 'application/octet-stream' } },
    (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        fail('trusted npm download returned an unexpected status');
        return;
      }
      if (response.headers['content-encoding']) {
        response.resume();
        fail('trusted npm download must not be content encoded');
        return;
      }
      const declaredLength = Number(response.headers['content-length']);
      if (
        !Number.isSafeInteger(declaredLength) ||
        declaredLength <= 0 ||
        declaredLength > MAX_BYTES
      ) {
        response.resume();
        fail('trusted npm download length is invalid');
        return;
      }
      let received = 0;
      const chunks = [];
      response.on('data', (chunk) => {
        received += chunk.length;
        if (received > MAX_BYTES) request.destroy(new Error('trusted npm download exceeded limit'));
        else chunks.push(chunk);
      });
      response.on('end', () => {
        if (received !== declaredLength) {
          fail('trusted npm download was truncated');
          return;
        }
        try {
          fs.writeFileSync(destination, Buffer.concat(chunks), { flag: 'wx', mode: 0o600 });
        } catch {
          fail('trusted npm download could not be stored');
        }
      });
    },
  );
  request.setTimeout(30_000, () => request.destroy(new Error('trusted npm download timed out')));
  request.on('error', () => fail('trusted npm download failed'));
}
