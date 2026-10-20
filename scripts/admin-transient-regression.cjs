'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { applicationFixture } = require('./helpers/application-fixture.cjs');
let app, session;
before(async () => {
  process.env.ADMIN_SECURITY_MIN_SCORE = '100';
  app = await applicationFixture({ transientStore: 'memory', rateLimitStore: 'memory', appCheckMode: 'monitor' });
  session = await app.openAdmin();
});
after(async () => app?.close());

test('monitor App Check and local limits permit six-factor login without writing ephemeral admin documents', async () => {
  const result = await app.request('/api/auth/admin/gate/status', session);
  assert.equal(result.body.authenticated, true);
  assert.equal(result.body.security.ready, true);
  assert(result.body.security.score < 100);
  assert.equal([...app.db.records.keys()].filter(key => /^(storeAdminSessions|storeAdminBrowserNonces|storeAdminActionReceipts|storeSecurityRateLimits|adminAudit)\//.test(key)).length, 0);
  assert.equal([...app.db.records.keys()].filter(key => key.startsWith('storeAdminTotpState/')).length, 1);
});

test('memory receipts reject concurrent replay while a wallet mutation and its business audit remain durable', async () => {
  const path = '/api/admin/store/wallet/adjust';
  const body = { uid: 'member', amountKurus: 10000, type: 'CREDIT', reason: 'Kontrollü bakiye düzeltme', idempotencyKey: 'memory-wallet-adjustment-0001' };
  const proof = await app.request('/api/admin/action-proof', { ...session, method: 'POST', body: { method: 'POST', path,
    bodyHash: crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex'), password: app.password } });
  assert.equal(proof.status, 200);
  const results = await Promise.all(Array.from({ length: 4 }, () => app.request(path, { ...session, method: 'POST', body, headers: { 'x-admin-action': proof.body.proof.token } })));
  assert.equal(results.filter(result => result.status === 200).length, 1);
  assert(results.filter(result => result.status !== 200).every(result => result.body.error === 'ADMIN_ACTION_ALREADY_USED'));
  assert.equal(app.db.records.get('users/member').storeBalanceKurus, 60000);
  assert([...app.db.records.keys()].some(key => key.startsWith('storeWalletLedger/')));
  assert([...app.db.records.keys()].some(key => key.startsWith('audit/')));
  assert.equal([...app.db.records.keys()].filter(key => /^(storeAdminActionReceipts|adminAudit)\//.test(key)).length, 0);
  const logs = await app.request('/api/admin/store/audit', session);
  assert(logs.body.logs?.some?.(row => row.action === 'admin.gate.login.success') || JSON.stringify(logs.body).includes('admin.gate.login.success'));
});

test('session loss after a deployment fails closed and requires the six stages again', async () => {
  const state = require('../server/core/adminTransientStore');
  state.sessions.rows.clear();
  const result = await app.request('/api/auth/admin/gate/status', session);
  assert.equal(result.body.authenticated, false);
  assert.equal((await app.request('/api/admin/store/catalog', session)).status, 401);
});

test('bounded replay storage refuses overflow and retains unexpired claims', () => {
  const { ExpiringStore } = require('../server/core/adminTransientStore');
  const store = new ExpiringStore(2);
  assert(store.claim('one', { ok: true }, Date.now() + 10000));
  assert(store.claim('two', { ok: true }, Date.now() + 10000));
  assert.equal(store.claim('one', {}, Date.now() + 10000), false);
  assert.throws(() => store.claim('three', {}, Date.now() + 10000), { code: 'ADMIN_TRANSIENT_CAPACITY' });
  assert(store.get('one'));
  const clock = Date.now;
  try { Date.now = () => clock() + 20000; assert.equal(store.get('one'), null); store.prune(); assert.equal(store.values().length, 0); }
  finally { Date.now = clock; }
});
