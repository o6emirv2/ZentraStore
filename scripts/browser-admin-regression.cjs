'use strict';
const { test, before, after } = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const { applicationFixture } = require('./helpers/application-fixture.cjs');
const origin = 'https://store.zentra.invalid';
let fixture, key, keyId, browserKey, session, token;
before(async () => {
  fixture = await applicationFixture({ additionalOrigins: [origin], canonicalOrigin: origin });
  key = await crypto.webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign','verify']);
  const { kty, crv, x, y } = await crypto.webcrypto.subtle.exportKey('jwk', key.publicKey);
  keyId = crypto.randomUUID(); browserKey = { keyId, publicKey: { kty, crv, x, y } }; token = fixture.idToken('owneruid');
});
after(async () => fixture?.close());
async function proof(path, method, body, options = {}) {
  const ts = options.ts || Date.now(), nonce = crypto.randomBytes(18).toString('base64url'), boundSession = options.session ?? session ?? '';
  const digest = crypto.createHash('sha256').update(JSON.stringify(body || {})).digest('hex');
  const message = JSON.stringify(['zentra-browser-admin-v1', options.uid || 'owneruid', keyId, boundSession, options.origin || origin, method, path, digest, ts, nonce]);
  const sig = Buffer.from(await crypto.webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, (options.signingKey || key.privateKey), Buffer.from(message))).toString('base64url');
  return Buffer.from(JSON.stringify({ v: 1, keyId, session: boundSession, ts, nonce, sig })).toString('base64url');
}
async function request(path, method = 'GET', body, options = {}) {
  return fixture.request(path, { token: options.token || token, method, body,
    headers: { origin: options.origin || origin, 'x-zentra-admin-proof': options.header || await proof(path, method, body, options) } });
}
test('all five gate stages complete without any cookie and return no handoff or bearer admin token', async () => {
  let ticket = '';
  for (const [step, extra] of [['email', { browserKey }], ['uid', {}], ['firebase-password', { password: fixture.password }], ['four', { password: fixture.four }], ['five', { password: fixture.five, totpCode: fixture.totp() }]]) {
    const body = { ...(ticket ? { ticket } : {}), ...extra };
    const result = await request('/api/auth/admin/gate/step-' + step, 'POST', body, { session: '' });
    assert.equal(result.status, 200, step + ' ' + JSON.stringify(result.body)); ticket = result.body.ticket || ticket;
    if (step === 'five') { assert.equal(result.body.handoff, undefined); assert.equal(result.body.accessToken, undefined); assert.equal(result.body.redirectTo, '/admin/'); assert.equal(result.body.browserSession.keyId, keyId); session = result.body.browserSession.session; }
  }
  assert.equal((await request('/api/auth/admin/gate/status')).body.access.mode, 'browser-key');
});
test('private browser-key requests require possession, current uid, exact origin and a fresh one-use signature', async () => {
  const path = '/api/admin/store/balance-codes', signed = await proof(path, 'GET');
  assert.equal((await request(path, 'GET', undefined, { header: signed })).status, 200);
  assert.equal((await request(path, 'GET', undefined, { header: signed })).status, 401);
  assert.equal((await request(path, 'GET', undefined, { ts: Date.now() - 70_000 })).status, 401);
  assert.equal((await request(path, 'GET', undefined, { token: fixture.idToken('finance') })).status, 401);
  assert.equal((await request(path, 'GET', undefined, { origin: fixture.origin })).status, 401);
  assert.equal((await fixture.request(path, { token, headers: { origin } })).status, 401);
});
test('parallel replay admits one request and a sealed gate ticket cannot be moved to another private key', async () => {
  const path = '/api/admin/store/balance-codes', header = await proof(path, 'GET');
  const parallel = await Promise.all([request(path, 'GET', undefined, { header }), request(path, 'GET', undefined, { header })]);
  assert.deepEqual(parallel.map(result => result.status).sort(), [200, 401]);
  const start = await request('/api/auth/admin/gate/step-email', 'POST', { browserKey }, { session: '' }); assert.equal(start.status, 200);
  const other = await crypto.webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign','verify']);
  assert.equal((await request('/api/auth/admin/gate/step-uid', 'POST', { ticket: start.body.ticket }, { session: '', signingKey: other.privateKey })).status, 401);
  assert.equal((await fixture.request('/api/auth/admin/gate/step-uid', { token, method: 'POST', body: { ticket: start.body.ticket }, headers: { origin } })).status, 401);
});
test('same-origin browser reads without Origin require matching Fetch Metadata and Host', async () => {
  const { registerAdminSession } = require('../server/core/adminSessionRegistry');
  const sameSession = crypto.randomBytes(24).toString('base64url');
  await registerAdminSession({ uid: 'owneruid', email: 'owner@zentra.invalid', session: sameSession, expiresAt: Date.now() + 60_000, browserKey: { ...browserKey, origin: fixture.origin } });
  const path = '/api/admin/store/balance-codes';
  const header = await proof(path, 'GET', undefined, { session: sameSession, origin: fixture.origin });
  assert.equal((await fixture.request(path, { token, headers: { origin: '', 'sec-fetch-site': 'same-origin', 'x-zentra-admin-proof': header } })).status, 200);
  assert.equal((await fixture.request(path, { token, headers: { origin: '', 'sec-fetch-site': 'cross-site', 'x-zentra-admin-proof': await proof(path, 'GET', undefined, { session: sameSession, origin: fixture.origin }) } })).status, 401);
});
test('body and target tampering cannot reuse an otherwise valid browser signature', async () => {
  const body = { method: 'PUT', path: '/api/admin/store/balance-codes/BROWSER200', bodyHash: 'a'.repeat(64), password: fixture.password };
  const signed = await proof('/api/admin/action-proof', 'POST', body);
  assert.equal((await request('/api/admin/action-proof', 'POST', { ...body, bodyHash: 'b'.repeat(64) }, { header: signed })).status, 401);
  assert.equal((await request('/api/admin/store/balance-codes', 'GET', undefined, { header: signed })).status, 401);
});
async function write(path, method, body) {
  const approvalBody = { method, path, bodyHash: crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex'), password: fixture.password };
  const approval = await request('/api/admin/action-proof', 'POST', approvalBody); assert.equal(approval.status, 200, JSON.stringify(approval.body));
  return fixture.request(path, { token, method, body, headers: { origin, 'x-zentra-admin-proof': await proof(path, method, body), 'x-admin-action': approval.body.proof.token } });
}
test('cookie-free admin can create a balance promotion and a product through the protected business routes', async () => {
  const promo = await write('/api/admin/store/balance-codes/BROWSER200', 'PUT', { title: 'Browser credit', value: 20000, usageLimit: 10, perUserLimit: 1, startsAt: 0, endsAt: 0, active: true, createOnly: true }); assert.equal(promo.status, 200, JSON.stringify(promo.body));
  const source = require('../public/data/store-products.json').products[0];
  const product = { id: 'browser-product', name: 'Browser product', description: 'Test product', platform: 'android', game: 'pubg', categoryKey: 'pubg-android', category: 'PUBG Android', inventoryType: 'license', fulfillmentMode: 'automatic', image: source.image, features: ['Test feature'], badgeKey: 'premium', featured: false, plans: [{ key: 'daily', label: 'Daily', duration: '24 Saat', priceKurus: 20000 }] };
  const saved = await write('/api/admin/store/products', 'POST', product); assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert((await request('/api/admin/store/balance-codes')).body.codes.some(row => row.code === 'BROWSER200'));
});
test('a temporary nonce-store failure refuses access without revoking the valid browser session', async () => {
  const original = fixture.db.runTransaction;
  fixture.db.runTransaction = async () => { throw Object.assign(new Error('controlled datastore outage'), { code: 'UNAVAILABLE' }); };
  try { const result = await request('/api/admin/store/balance-codes'); assert.equal(result.status, 503); assert.equal(result.body.error, 'ADMIN_SESSION_UNAVAILABLE'); }
  finally { fixture.db.runTransaction = original; }
  assert.equal((await request('/api/admin/store/balance-codes')).status, 200);
});
test('logout immediately revokes the browser session across requests and does not rely on a cookie', async () => {
  assert.equal((await request('/api/auth/admin/gate/logout', 'POST', {})).body.revoked, true);
  assert.equal((await request('/api/admin/store/balance-codes')).status, 401);
});
