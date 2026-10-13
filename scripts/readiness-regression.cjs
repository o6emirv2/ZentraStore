'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mockModule } = require('./helpers/memory-firestore.cjs');
function service({ configured = true, read = async () => ({}), user = async () => ({ email: 'owner@example.test', emailVerified: true }) } = {}) {
  let reads = 0, identities = 0;
  mockModule('../../server/config/env', { nodeEnv: 'production', adminUids: ['owner'], adminEmails: ['owner@example.test'], configurationReport: () => ({ ready: configured }) });
  mockModule('../../server/config/firebaseAdmin', { initFirebaseAdmin: () => ({ enabled: true,
    db: { collection: () => ({ doc: () => ({ get: () => { reads++; return read(); } }) }) },
    auth: { getUser: () => { identities++; return user(); } } }) });
  delete require.cache[require.resolve('../server/core/runtimeHealth')];
  return { ...require('../server/core/runtimeHealth'), counts: () => ({ reads, identities }) };
}
test('readiness probes storage and identity once for concurrent callers and caches only bounded results', async () => {
  const health = service(); const results = await Promise.all(Array.from({ length: 20 }, () => health.connectionReadiness()));
  assert(results.every((row) => row.ready)); assert.deepEqual(health.counts(), { reads: 1, identities: 1 });
  await health.connectionReadiness(); assert.deepEqual(health.counts(), { reads: 1, identities: 1 });
});
test('missing private configuration fails readiness without contacting services', async () => {
  const health = service({ configured: false }); assert.equal((await health.connectionReadiness()).ready, false); assert.deepEqual(health.counts(), { reads: 0, identities: 0 });
});
test('production financial and vault mutations stay closed while mandatory settings are absent', () => {
  const health = service({ configured: false });
  for (const path of ['/api/store/orders', '/api/store/balance-codes/redeem', '/api/admin/action-proof', '/api/admin/store/inventory/import']) {
    let allowed = false, status; const res = { status(value) { status = value; return res; }, json: () => {} };
    health.sensitiveConfigurationGuard({ method: 'POST', originalUrl: path }, res, () => { allowed = true; });
    assert.equal(allowed, false); assert.equal(status, 503);
  }
  let allowed = false; health.sensitiveConfigurationGuard({ method: 'GET', originalUrl: '/api/store/catalog' }, {}, () => { allowed = true; }); assert(allowed);
});
test('denied storage, disabled identity or a different owner fail readiness', async () => {
  for (const input of [{ read: async () => { throw new Error('IAM denied'); } }, { user: async () => ({ email: 'owner@example.test', emailVerified: true, disabled: true }) },
    { user: async () => ({ email: 'different@example.test', emailVerified: true }) }]) assert.equal((await service(input).connectionReadiness()).ready, false);
});
test('a hung service yields a bounded result and does not start another underlying probe', async () => {
  const health = service({ read: () => new Promise(() => {}) }); const held = setTimeout(() => {}, 7000);
  const clock = Date.now;
  try {
    const first = await health.connectionReadiness(); assert.equal(first.timedOut, true);
    Date.now = () => clock() + 16000;
    const second = await health.connectionReadiness(); assert.equal(second.timedOut, true);
    assert.deepEqual(health.counts(), { reads: 1, identities: 1 });
  } finally { Date.now = clock; clearTimeout(held); }
});
