'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createRouter } = require('../server/core/asyncRouter');
const { requestErrorObserver } = require('../server/core/errorLogger');

test('Express async failures reach the error handler and error-only logs exclude sensitive values', async () => {
  const app = express();
  app.use(requestErrorObserver);
  app.use((req, res, next) => { req.requestId = 'qa-request'; next(); });
  const router = createRouter();
  router.get('/normal', (_req, res) => res.json({ ok: true }));
  router.get('/failure', async () => {
    const error = new Error('private-password-and-token');
    error.code = 'TEST_FAILURE';
    throw error;
  });
  app.use(router);
  app.use((error, req, res, next) => {
    res.locals.requestError = error;
    res.status(500).json({ ok: false, error: error.code });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const output = [];
  const original = process.stderr.write;
  process.stderr.write = function (chunk) { output.push(String(chunk)); return true; };
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(origin + '/normal')).status, 200);
    assert.equal(output.length, 0);
    const response = await fetch(origin + '/failure');
    assert.equal(response.status, 500);
    assert.equal((await response.json()).requestId, 'qa-request');
    assert.equal(output.length, 1);
    const row = JSON.parse(output[0]);
    assert.equal(row.level, 'error');
    assert.equal(row.code, 'TEST_FAILURE');
    assert.equal(row.requestId, 'qa-request');
    assert.equal(row.route, '/failure');
    assert.ok(row.frames.length > 0);
    assert.equal(output[0].includes('private-password-and-token'), false);
  } finally {
    process.stderr.write = original;
    await new Promise((resolve) => server.close(resolve));
  }
});
