'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { memoryFirestore, mockModule, admin } = require('./helpers/memory-firestore.cjs');
let db;
mockModule('../../server/config/firebaseAdmin', { initFirebaseAdmin: () => ({ db, admin }) });
mockModule('../../server/core/errorLogger', { logError: () => {} });
const jobs = require('../server/core/storeRestockJobs');
const sku = 'test-license__daily';
async function reset(count = 1, sourceSkus = [sku]) {
  db = memoryFirestore(sourceSkus.map((key) => [`storeInventorySummary/${key}`, { availableCount: 1 }]));
  const now = Date.now();
  for (let n = 0; n < count; n++) db.records.set(`storeRestockSubscriptions/s${String(n).padStart(3, '0')}`, { uid: `member-${n}`, sku, active: true, createdAt: now - 1, expiresAt: now + 60000 });
  await db.runTransaction(async (tx) => jobs.enqueueRestockJob(tx, db, { id: 'job-1', sourceSkus, product: { id: 'test-license', name: 'Test' }, plan: { key: 'daily', label: 'Günlük' }, now }));
  return db.collection('storeRestockJobs').doc('job-1');
}
const notices = () => [...db.records].filter(([path]) => path.startsWith('storeUserNotifications/'));
test('restock processing is bounded to 50 subscribers per page and resumes from a durable cursor', async () => {
  const ref = await reset(120); await jobs.processRestockJob(db, admin, ref);
  assert.equal(notices().length, 50); assert.equal(db.records.get(ref.path).cursor, 's049');
  await jobs.processRestockJob(db, admin, ref); assert.equal(notices().length, 100);
  await jobs.processRestockJob(db, admin, ref); assert.equal(notices().length, 120); assert(db.records.get(ref.path).completedAt);
  const writes = db.stats.writes; await jobs.processRestockJob(db, admin, ref); assert.equal(db.stats.writes, writes);
});
test('two workers cannot process the same lease twice', async () => {
  const ref = await reset(1); await Promise.all([jobs.processRestockJob(db, admin, ref), jobs.processRestockJob(db, admin, ref)]);
  assert.equal(notices().length, 1); assert.equal(db.records.get(ref.path).notified, 1);
});
test('shared pool subscriptions produce one notice per customer', async () => {
  const alias = 'legacy-license__daily', ref = await reset(1, [sku, alias]);
  db.records.set('storeRestockSubscriptions/alias', { uid: 'member-0', sku: alias, active: true, createdAt: Date.now() - 10 });
  await jobs.processRestockJob(db, admin, ref); await jobs.processRestockJob(db, admin, ref);
  assert.equal(notices().length, 1); assert(!db.records.has('storeRestockSubscriptions/alias'));
});
test('expired, inactive and newly-created subscriptions do not generate stale notices', async () => {
  const ref = await reset(3); db.records.get('storeRestockSubscriptions/s000').expiresAt = Date.now() - 1;
  db.records.get('storeRestockSubscriptions/s001').active = false; db.records.get('storeRestockSubscriptions/s002').createdAt = Date.now() + 100;
  await jobs.processRestockJob(db, admin, ref); assert.equal(notices().length, 0);
});
test('sold-out stock is not announced and subscriptions remain available for a later restock', async () => {
  const ref = await reset(1); db.records.get(`storeInventorySummary/${sku}`).availableCount = 0;
  await jobs.processRestockJob(db, admin, ref); assert.equal(notices().length, 0); assert(db.records.has('storeRestockSubscriptions/s000'));
});
test('temporary job failures retry with a lease fence and do not erase another worker lease', async () => {
  const ref = await reset(1);
  db.setQueryHook(async (path) => { if (path === 'storeRestockSubscriptions') throw new Error('controlled query outage'); });
  await assert.rejects(jobs.processRestockJob(db, admin, ref)); assert.equal(db.records.get(ref.path).failures, 1); assert.equal(db.records.get(ref.path).lease, '');
  db.records.get(ref.path).availableAt = Date.now() - 1;
  db.setQueryHook(async (path) => { if (path === 'storeRestockSubscriptions') { db.records.get(ref.path).lease = 'new-worker-lease'; throw new Error('expired worker'); } });
  await assert.rejects(jobs.processRestockJob(db, admin, ref)); assert.equal(db.records.get(ref.path).lease, 'new-worker-lease'); assert.equal(db.records.get(ref.path).failures, 1);
});
test('invalid jobs and five consecutive failures stop retrying instead of looping forever', async () => {
  let ref = await reset(); db.records.get(ref.path).sourceSkus = ['../../secret']; await jobs.processRestockJob(db, admin, ref); assert(db.records.get(ref.path).failedAt);
  ref = await reset(); db.setQueryHook(async () => { throw new Error('outage'); });
  for (let n = 0; n < 5; n++) { db.records.get(ref.path).availableAt = Date.now() - 1; await assert.rejects(jobs.processRestockJob(db, admin, ref)); }
  assert.equal(db.records.get(ref.path).failures, 5); assert(db.records.get(ref.path).failedAt);
});
