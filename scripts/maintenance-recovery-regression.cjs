'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { applicationFixture } = require('./helpers/application-fixture.cjs');
let app, store, maintenance, catalog;
const actor = { uid: 'owneruid', email: 'owner@zentra.invalid' };
before(async () => {
  app = await applicationFixture();
  store = require('../server/core/storeService');
  maintenance = require('../server/core/orderMaintenanceService');
});
after(async () => { await app.close(); });
beforeEach(async () => {
  for (const [path] of app.db.records) if (!path.startsWith('users/') && !path.startsWith('adminUsers/')) app.db.records.delete(path);
  app.db.records.get('users/member').storeBalanceKurus = 50000;
 
  require('../server/core/storeCatalogService').invalidateCatalogCache();
  require('../server/core/firestorePagination').invalidateCreatedAtPageCache();
  catalog = await require('../server/core/storeCatalogService').getEffectiveCatalog({ fresh: true });
});
async function telegram() {
  const product = catalog.products.find(row => row.telegramEnabled), plan = product.plans[0];
  return (await store.createOrder({ uid: 'member', authUser: app.users.get('member'), paymentMethod: 'telegram',
    rawItems: [{ productId: product.id, planKey: plan.key, quantity: 1 }], idempotencyKey: crypto.randomUUID() })).order;
}

async function ready(operation) {
  const response = await maintenance.createPreview({ operation, actor, idempotencyKey: crypto.randomUUID() });
  for (let i = 0; i < 20; i++) {
    await maintenance.drainMaintenanceJobs(); const result = await maintenance.getJob(response.job.id, actor);
    if (result.job.state === 'ready') { await maintenance.confirmJob(result.job.id, actor); return result.job.id; }
  }
  throw Error('Preview not ready');
}
test('legacy Telegram records shown in the panel are cancellable in bulk and require evidence before approval', async () => {
  const order = await telegram(), row = app.db.records.get('storeOrders/' + order.id); delete row.paymentMethod;
  await assert.rejects(store.updateOrderByAdmin({ orderId: order.id, input: { status: 'paid' }, actor }), { code: 'STORE_MANUAL_PAYMENT_EVIDENCE_REQUIRED' });
  const id = await ready('cancel_telegram');
  for (let i = 0; i < 5; i++) await maintenance.drainMaintenanceJobs();
  assert.equal(app.db.records.get('storeOrders/' + order.id).status, 'cancelled');
  assert.equal((await maintenance.getJob(id, actor)).job.succeeded, 1);
});
test('a legacy paid Telegram record without approvedAt cannot be cancelled without external refund evidence', async () => {
  const order = await telegram(), row = app.db.records.get('storeOrders/' + order.id);
  row.status = 'paid'; row.paymentState = 'paid'; delete row.approvedAt;
  await assert.rejects(store.updateOrderByAdmin({ orderId: order.id, input: { status: 'cancelled' }, actor }), { code: 'STORE_MANUAL_PAYMENT_EVIDENCE_REQUIRED' });
  assert.equal(maintenance.orderPolicy(row, 'cancel_telegram').eligible, false);
});

test('revoked administrator sessions pause a running bulk job and explicit reauthorization updates its authorization time', async () => {
  const order = await telegram(), id = await ready('cancel_telegram');
  const job = app.db.records.get('storeMaintenanceJobs/' + id);
  job.confirmedAt = Date.now() - 2000;
  const user = app.users.get(actor.uid); user.tokensValidAfterTime = new Date(Date.now() - 1000).toISOString();
  try {
    await maintenance.drainMaintenanceJobs();
    assert.equal((await maintenance.getJob(id, actor)).job.error, 'ADMIN_JOB_AUTHORIZATION_REVOKED');
    assert.equal(app.db.records.get('storeOrders/' + order.id).status, 'awaiting_payment');
    await maintenance.confirmJob(id, actor); await maintenance.drainMaintenanceJobs();
    assert.equal(app.db.records.get('storeOrders/' + order.id).status, 'cancelled');
  } finally { delete user.tokensValidAfterTime; }
});
test('an unrecognized payment channel is not silently treated as Telegram or permitted to deliver', async () => {
  const order = await telegram(), row = app.db.records.get('storeOrders/' + order.id); row.paymentMethod = 'unrecognized';
  assert.equal(store.publicOrder(row, row.id).paymentMethod, 'unknown');
  await assert.rejects(store.updateOrderByAdmin({ orderId: order.id, input: { status: 'delivered', paymentConfirmed: true, paymentReference: 'EXTERNAL-001' }, actor }), { code: 'STORE_PAYMENT_CHANNEL_REVIEW_REQUIRED' });
  await assert.rejects(store.cancelOrderByUser({ uid: 'member', orderId: order.id }), { code: 'STORE_ORDER_CANCELLATION_NOT_ALLOWED' });
});

test('old queued jobs pause after a policy upgrade and require a fresh confirmed preview', async () => {
  const order = await telegram();
  const result = await maintenance.createPreview({ operation: 'cancel_telegram', actor, idempotencyKey: crypto.randomUUID() });
  const row = app.db.records.get('storeMaintenanceJobs/' + result.job.id); row.policyVersion = 2;
  await maintenance.drainMaintenanceJobs();
  assert.equal(app.db.records.get('storeMaintenanceJobs/' + result.job.id).state, 'paused'); assert.equal(app.db.records.get('storeMaintenanceJobs/' + result.job.id).error, 'BULK_JOB_VERSION_REVIEW_REQUIRED');
  assert.equal(app.db.records.get('storeOrders/' + order.id).status, 'awaiting_payment');
  await assert.rejects(maintenance.confirmJob(result.job.id, actor), { code: 'BULK_JOB_VERSION_REVIEW_REQUIRED' });
});
test('prototype property names cannot become valid maintenance operations', async () => {
  for (const operation of ['toString', '__proto__', 'constructor']) {
    await assert.rejects(maintenance.createPreview({ operation, actor, idempotencyKey: crypto.randomUUID() }), { code: 'BULK_OPERATION_INVALID' });
  }
});
test('Telegram cancellation never touches wallet or unknown channels', async () => {
  const order = await telegram();
  for (const paymentMethod of ['wallet', 'unrecognized']) app.db.records.set('storeOrders/' + paymentMethod, { paymentMethod, status: 'paid', totalKurus: 100, createdAt: Date.now() - 1000 });
  const id = await ready('cancel_telegram'); await maintenance.drainMaintenanceJobs();
  assert.equal(app.db.records.get('storeOrders/' + order.id).status, 'cancelled');
  for (const id of ['wallet', 'unrecognized']) assert.equal(app.db.records.get('storeOrders/' + id).status, 'paid');
  assert.equal((await maintenance.getJob(id, actor)).job.succeeded, 1);
});
test('cancel then delete removes only eligible Telegram application records and retains financial evidence', async () => {
  const order = await telegram();
  const result = await maintenance.createPreview({ operation: 'cancel_delete_telegram', actor, idempotencyKey: crypto.randomUUID() });
  await maintenance.drainMaintenanceJobs();
  await assert.rejects(maintenance.confirmJob(result.job.id, actor), { code: 'BULK_CONFIRMATION_REQUIRED' });
  await maintenance.confirmJob(result.job.id, actor, 'KALICI SIL'); await maintenance.drainMaintenanceJobs();
  assert.equal((await maintenance.getJob(result.job.id, actor)).job.succeeded, 1);
  assert(!app.db.records.has('storeOrders/' + order.id));
  assert(app.db.records.get('storeOrderArchives/' + order.id).financialEvidenceRetained);
  assert([...app.db.records.values()].some(row => row.archiveId === order.id));
});
test('a refunded wallet order cannot be deleted without a matching immutable refund ledger entry', async () => {
  const id = 'wallet-final-refund';
  const row = { id, uid: 'member', paymentMethod: 'wallet', status: 'refunded', totalKurus: 500, walletRefundedAt: Date.now(), walletRefundedKurus: 500 };
  app.db.records.set('storeOrders/' + id, row);
  await assert.rejects(maintenance.deleteOrder(id, actor), { code: 'WALLET_REFUND_NOT_VERIFIED' });
  assert(app.db.records.has('storeOrders/' + id));
  app.db.records.set('storeWalletLedger/refund_' + id, { uid: 'member', amountKurus: 500 });
  await maintenance.deleteOrder(id, actor);
  assert(!app.db.records.has('storeOrders/' + id)); assert(app.db.records.has('storeWalletLedger/refund_' + id));
});

