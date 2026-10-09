'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
process.env.NODE_ENV = 'development';
process.env.APP_CHECK_MODE = 'monitor';
process.env.RATE_LIMIT_STORE = 'memory';
process.env.PUBLIC_BASE_URL = 'https://zentrastore.com.tr';
const { app } = require('../server');
const server = app.listen(0, '127.0.0.1');
const ready = new Promise((resolve) => server.on('listening', resolve));
after(async () => { await new Promise((resolve) => server.close(resolve)); });
async function request(path, options = {}) {
  await ready;
  return fetch(`http://127.0.0.1:${server.address().port}${path}`, options);
}

test('public liveness responds while readiness refuses missing private configuration', async () => {
  assert.equal((await request('/healthz')).status, 200);
  assert.equal((await request('/readyz')).status, 503);
  const response = await request('/api/public/runtime-config');
  assert.equal(response.status, 200);
  const config = await response.json();
  assert.equal(config.ok, true);
  assert.equal(Object.hasOwn(config, 'serviceAccount'), false);
  assert.equal(JSON.stringify(config).includes('private_key'), false);
  assert.ok(response.headers.get('content-security-policy').includes("object-src 'none'"));
});

test('protected wallet and catalog mutations cannot be submitted anonymously', async () => {
  for (const path of ['/api/admin/store/wallet/adjust', '/api/admin/store/products', '/api/store/orders', '/api/store/order-attempt/cancel']) {
    const response = await request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://zentrastore.com.tr' }, body: JSON.stringify({ balanceKurus: 999999, features: ['forged'] }) });
    assert.equal(response.status, 401, path);
    const payload = await response.json();
    assert.equal(payload.error, 'AUTH_REQUIRED');
    assert.ok(payload.requestId);
  }
});

test('order attempt lookup requires authentication and does not expose account data', async () => {
  const response = await request('/api/store/order-attempt?key=financial-request-123');
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, 'AUTH_REQUIRED');
});

test('malformed JSON, prototype keys and untrusted origins produce specific failures', async () => {
  const common = { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://zentrastore.com.tr' } };
  const invalid = await request('/api/store/orders', { ...common, body: '{' });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error, 'INVALID_JSON');
  const unsafe = await request('/api/store/orders', { ...common, body: '{"__proto__":{"isAdmin":true}}' });
  assert.equal(unsafe.status, 400);
  assert.equal((await unsafe.json()).error, 'REQUEST_BODY_UNSAFE');
  const cross = await request('/api/store/orders', { ...common, headers: { ...common.headers, Origin: 'https://evil.example' }, body: '{}' });
  assert.equal(cross.status, 403);
  assert.equal((await cross.json()).error, 'ORIGIN_NOT_ALLOWED');
});

test('removed upload route and private source paths are unavailable, and image formats are served', async () => {
  assert.equal((await request('/api/admin/store/products/image', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://zentrastore.com.tr' }, body: '{}' })).status, 404);
  assert.equal((await request('/server/config/env.js')).status, 404);
  for (const path of ['/public/assets/products/gbox.jpeg', '/public/assets/products/random.jpeg', '/public/assets/products/h-kernel.PNG', '/public/assets/products/CRY4ME.JPG']) {
    const response = await request(path);
    assert.equal(response.status, 200, path);
    assert.ok(response.headers.get('content-type').startsWith('image/'));
  }
});

test('browser error telemetry accepts bounded codes and refuses arbitrary messages or secrets', async () => {
  const options = { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://zentrastore.com.tr' } };
  const good = await request('/api/client-errors', { ...options, body: JSON.stringify({ code: 'BROWSER_RUNTIME_ERROR', source: '/script.js', line: 10, column: 1 }) });
  assert.equal(good.status, 202);
  const bad = await request('/api/client-errors', { ...options, body: JSON.stringify({ code: 'BROWSER_RUNTIME_ERROR', source: '/script.js', line: 10, column: 1, message: 'secret-token' }) });
  assert.equal(bad.status, 400);
});

test('large authorized-catalog payload capacity does not raise the limit on other API writes', async () => {
  const options = { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://zentrastore.com.tr' },
    body: JSON.stringify({ updates: Array.from({ length: 80 }, (_, i) => ({ productId: `product-${i}`, settings: { features: 'a'.repeat(6400) } })) }) };
  const bulk = await request('/api/admin/store/products/bulk', options);
  assert.equal(bulk.status, 401); // Fits bounded catalog input, then fails real authorization.
  const order = await request('/api/store/orders', options);
  assert.equal(order.status, 413);
  assert.equal((await order.json()).error, 'REQUEST_BODY_TOO_LARGE');
});
