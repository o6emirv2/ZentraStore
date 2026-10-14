'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { mockModule } = require('./helpers/memory-firestore.cjs');
Object.assign(process.env, { NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://zentrastore.com.tr', CANONICAL_ORIGIN: 'https://zentrastore.com.tr', PUBLIC_BACKEND_ORIGIN: 'https://emirhan-siye.onrender.com', PUBLIC_API_BASE: 'https://zentrastore.com.tr', ALLOWED_ORIGINS: 'https://www.zentrastore.com.tr', RATE_LIMIT_STORE: 'memory', APP_CHECK_MODE: 'monitor' });
mockModule('../../server/config/firebaseAdmin', { initFirebaseAdmin: () => ({ enabled: false, db: null, auth: null }) });
const { app } = require('../server');
const server = app.listen(0, '127.0.0.1');
const ready = new Promise(resolve => server.on('listening', resolve));
after(async () => { await new Promise(resolve => server.close(resolve)); });
async function request(path, host) {
  await ready;
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port: server.address().port, path, headers: { Host: host } }, response => {
      let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: new Headers(response.headers), json: async () => JSON.parse(body) }));
    });
    request.on('error', reject);
  });
}
test('approved Render and www page entries resolve only to the canonical admin address', async () => {
  for (const host of ['emirhan-siye.onrender.com', 'www.zentrastore.com.tr']) {
    const result = await request('/admin/admin.html?next=https://evil.invalid&token=untrusted', host);
    assert.equal(result.status, 302); assert.equal(result.headers.get('location'), 'https://zentrastore.com.tr/admin/');
    assert(result.headers.get('cache-control').includes('no-store'));
  }
});
test('legacy canonical paths normalize without exposing a protected dashboard', async () => {
  for (const path of ['/admin', '/admin/admin.html']) {
    const result = await request(path, 'zentrastore.com.tr'); assert.equal(result.status, 302); assert.equal(result.headers.get('location'), 'https://zentrastore.com.tr/admin/');
  }
  const guest = await request('/admin/', 'zentrastore.com.tr'); assert.equal(guest.status, 200); assert.equal(guest.headers.get('location'), null);
});
test('an unapproved Host cannot choose a redirect destination or receive admin content', async () => {
  const result = await request('/admin/', 'attacker.invalid'); assert.equal(result.status, 421); assert.equal(result.headers.get('location'), null); assert.equal((await result.json()).error, 'HOST_NOT_ALLOWED');
});
