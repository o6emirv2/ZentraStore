'use strict';
const { test, before, after } = require('node:test'), assert = require('node:assert/strict');
const { applicationFixture } = require('./helpers/application-fixture.cjs');
let fixture, owner;
before(async () => { fixture = await applicationFixture(); owner = await fixture.openAdmin(); });
after(async () => { await fixture?.close(); });
test('financial summaries bound profile reads and label a large directory as partial', async () => {
  for (let index = 0; index < 1002; index++) fixture.db.records.set('users/bulk-' + String(index).padStart(4, '0'), { storeBalanceKurus: 100, storeAccountStatus: 'active' });
  const wallet = await fixture.request('/api/admin/store/wallet-summary', owner); assert.equal(wallet.status, 200); assert.equal(wallet.body.summary.profileDocuments, 1000); assert.equal(wallet.body.summary.profileComplete, false); assert.equal(wallet.body.summary.liabilityKurus, 100000);
  const users = await fixture.request('/api/admin/store/users-summary', owner); assert.equal(users.body.summary.profileComplete, false); assert(users.body.summary.unclassified > 0);
});
test('unavailable adjustment aggregates remain unknown instead of becoming zero', async () => {
  const service = require('../server/core/adminStoreService'), collection = fixture.db.collection; service.invalidateAdminStoreCaches();
  try {
    fixture.db.collection = name => { const query = collection(name); if (name === 'storeWalletAdjustments') query.count = () => ({ get: async () => { throw new Error('count unavailable'); } }); return query; };
    assert.equal((await fixture.request('/api/admin/store/wallet-summary', owner)).body.summary.adjustmentCount, null);
  } finally { fixture.db.collection = collection; service.invalidateAdminStoreCaches(); }
});
test('invalidating a financial cache disconnects new reads from older pending snapshots', async () => {
  const service = require('../server/core/adminStoreService'), collection = fixture.db.collection; service.invalidateAdminStoreCaches();
  let paused = false, release, started, timer;
  const waiting = new Promise(resolve => { started = resolve; }), barrier = new Promise(resolve => { release = resolve; });
  const row = fixture.db.records.get('users/bulk-0000'), priorBalance = row.storeBalanceKurus;
  try {
    fixture.db.collection = name => {
      const query = collection(name); if (name !== 'users') return query;
      const limit = query.limit; query.limit = count => { const limited = limit(count), get = limited.get; limited.get = async () => { const result = await get(); if (!paused) { paused = true; started(); await barrier; } return result; }; return limited; }; return query;
    };
    const old = service.getWalletSummary({ fresh: true }); await waiting;
    row.storeBalanceKurus += 900; service.invalidateAdminStoreCaches();
    const current = await Promise.race([service.getWalletSummary({ fresh: true }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('new read waited for invalidated data')), 1000); })]);
    release(); const previous = await old;
    assert.equal(current.liabilityKurus, previous.liabilityKurus + 900); assert.equal((await service.getWalletSummary()).liabilityKurus, current.liabilityKurus);
  } finally { clearTimeout(timer); release(); row.storeBalanceKurus = priorBalance; fixture.db.collection = collection; service.invalidateAdminStoreCaches(); }
});
