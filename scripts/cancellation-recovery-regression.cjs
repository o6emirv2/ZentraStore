'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { applicationFixture } = require('./helpers/application-fixture.cjs');
const { shopierFixture } = require('./helpers/shopier-fixture.cjs');
let app, provider, store, shopier, maintenance, catalog;
const actor = { uid: 'owneruid', email: 'owner@zentra.invalid' };
before(async () => {
  app = await applicationFixture({ shopier: true }); provider = shopierFixture();
  store = require('../server/core/storeService'); shopier = require('../server/core/shopierService');
  maintenance = require('../server/core/orderMaintenanceService');
});
after(async () => { provider.close(); await app.close(); });
beforeEach(async () => {
  for (const [path] of app.db.records) if (!path.startsWith('users/') && !path.startsWith('adminUsers/')) app.db.records.delete(path);
  app.db.records.get('users/member').storeBalanceKurus = 50000;
  provider.products.clear(); provider.orders.clear(); provider.refunds.clear(); provider.calls.length = 0;
  require('../server/core/storeCatalogService').invalidateCatalogCache();
  require('../server/core/firestorePagination').invalidateCreatedAtPageCache();
  catalog = await require('../server/core/storeCatalogService').getEffectiveCatalog({ fresh: true });
});
async function telegram() {
  const product = catalog.products.find(row => row.telegramEnabled), plan = product.plans[0];
  return (await store.createOrder({ uid: 'member', authUser: app.users.get('member'), paymentMethod: 'telegram',
    rawItems: [{ productId: product.id, planKey: plan.key, quantity: 1 }], idempotencyKey: crypto.randomUUID() })).order;
}
async function topup() { return shopier.createShopierPayment({ uid: 'member', authUser: app.users.get('member'), purpose: 'wallet_topup', amountKurus: 10000, idempotencyKey: crypto.randomUUID() }); }
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
test('provider order-query timeouts cannot prevent the verified product link from being closed', async () => {
  const result = await topup(), row = app.db.records.get('storeOrders/' + result.order.id);
  for (let i = 0; i < 2; i++) provider.interceptOnce('GET', '/orders', async () => { throw Object.assign(Error('timeout'), { code: 'SHOPIER_TIMEOUT' }); });
  const closed = await shopier.closeShopierOrder(row.id, actor);
  assert.equal(closed.closed, true); assert.equal(closed.pending, true);
  assert.equal(provider.products.get(row.shopier.productId).stockQuantity, 0);
  assert.equal(row.walletTopup?.settledAt || 0, 0);
  assert.notEqual(app.db.records.get('storeOrders/' + row.id).status, 'cancelled');
});
test('bulk cancellation freezes a top-up before its first provider reconciliation and cannot credit it', async () => {
  const result = await topup(), row = app.db.records.get('storeOrders/' + result.order.id);
  provider.paid(row.shopier.productId);
  await ready('cancel_shopier'); await maintenance.drainMaintenanceJobs();
  assert.equal(app.db.records.get('users/member').storeBalanceKurus, 50000);
  const saved = app.db.records.get('storeOrders/' + row.id);
  assert.ok(saved.shopier.cancelRequestedAt); assert.ok(saved.shopier.refundRequest);
});
test('a missing callback setting blocks new checkout but does not block management of existing links', async () => {
  const result = await topup(), previous = process.env.SHOPIER_REFUND_WEBHOOK_TOKEN;
  try {
    delete process.env.SHOPIER_REFUND_WEBHOOK_TOKEN;
    const config = require('../server/config/shopier');
    assert.equal(config.getShopierConfig().configured, false);
    const closed = await shopier.closeShopierOrder(result.order.id, actor); assert.equal(closed.closed, true);
    await assert.rejects(topup(), { code: 'SHOPIER_CONFIGURATION_INVALID' });
  } finally { process.env.SHOPIER_REFUND_WEBHOOK_TOKEN = previous; }
});
test('legacy creation rejection with no possible remote listing can cancel without a fake provider closure', async () => {
  const result = await topup(), row = app.db.records.get('storeOrders/' + result.order.id);
  provider.products.delete(row.shopier.productId);
  row.shopier = { state: 'creation_failed', lastError: 'SHOPIER_REQUEST_REJECTED' }; row.shopierOpen = false; row.paymentState = 'failed'; row.status = 'payment_rejected';
  const id = await ready('cancel_shopier');
  for (let i = 0; i < 5; i++) await maintenance.drainMaintenanceJobs();
  assert.equal(app.db.records.get('storeOrders/' + row.id).status, 'cancelled');
  assert.equal((await maintenance.getJob(id, actor)).job.succeeded, 1);
  assert.equal(provider.calls.filter(c => c.method === 'PUT').length, 0);
});
test('single close is a fast authenticated durable request; it never reports a queued request as a closed link', async () => {
  const result = await topup(), session = await app.openAdmin(), path = `/api/admin/store/orders/${result.order.id}/shopier/close`;
  assert.equal((await app.request(path, { uid: 'member', method: 'POST', body: {} })).status, 403);
  assert.equal((await app.request(path, { ...session, method: 'POST', body: {} })).status, 401);
  provider.calls.length = 0;
  const accepted = await app.adminWrite(session, path, 'POST', {});
  assert.equal(accepted.status, 202); assert.equal(accepted.body.closed, false); assert.equal(accepted.body.pending, true);
  assert.equal(provider.calls.length, 0);
  assert.equal((await shopier.getShopierPayment({ uid: 'member', orderId: result.order.id })).paymentUrl, '');
  await app.adminWrite(session, path, 'POST', {});
  assert.equal([...app.db.records].filter(([p, r]) => p.startsWith('shopierJobs/') && r.kind === 'close').length, 1);
  await require('../server/core/shopierJobs').processShopierJob(app.db, app.db.doc('shopierJobs/close_' + result.order.id));
  assert.equal(app.db.records.get('storeOrders/' + result.order.id).paymentState, 'link_closed');
  assert.equal(provider.products.get(result.order.shopier.productId).stockQuantity, 0);
});
test('single paid cancellation freezes settlement before its queued refund, then confirms provider completion exactly once', async () => {
  const result = await topup(), session = await app.openAdmin(), path = `/api/admin/store/orders/${result.order.id}/shopier/cancel`;
  const remote = provider.paid(result.order.shopier.productId);
  assert.equal((await app.adminWrite(session, path, 'POST', {})).status, 202);
  await shopier.applyShopierOrder(remote);
  assert.equal(app.db.records.get('users/member').storeBalanceKurus, 50000);
  const jobs = require('../server/core/shopierJobs'), ref = app.db.doc('shopierJobs/cancel_' + result.order.id);
  await jobs.processShopierJob(app.db, ref);
  const row = app.db.records.get('storeOrders/' + result.order.id);
  provider.completeRefund(row.shopier.refundRequest.providerRefundId);
  app.db.records.get(ref.path).availableAt = 0; await jobs.processShopierJob(app.db, ref);
  assert.equal(app.db.records.get('storeOrders/' + row.id).status, 'refunded');
  assert.equal(provider.calls.filter(c => c.method === 'POST' && c.path === '/refunds').length, 1);
});
test('a slow Shopier item cannot block a Telegram cancellation in the same controlled batch', async () => {
  const payment = await topup(), order = await telegram(), id = await ready('cancel_all');
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  provider.interceptOnce('GET', '/products/' + payment.order.shopier.productId, async () => { entered(); await gate; return provider.response(provider.products.get(payment.order.shopier.productId)); });
  const drain = maintenance.drainMaintenanceJobs();
  try {
    await started;
    for (let i = 0; i < 30 && app.db.records.get('storeOrders/' + order.id).status !== 'cancelled'; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(app.db.records.get('storeOrders/' + order.id).status, 'cancelled');
    assert.equal((await maintenance.getJob(id, actor)).job.state, 'running');
  } finally { release(); await drain; }
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
test('customer cancellation cannot locally cancel a legacy Shopier record whose explicit channel field is absent', async () => {
  const result = await topup(), row = app.db.records.get('storeOrders/' + result.order.id); delete row.paymentMethod;
  await assert.rejects(store.cancelOrderByUser({ uid: 'member', orderId: row.id }), { code: 'SHOPIER_PROVIDER_ACTION_REQUIRED' });
  assert.equal(store.publicOrder(row, row.id).cancellable, false);
});
test('a queued provider mutation rechecks the operator account and cannot run after it is disabled', async () => {
  const result = await topup(), operations = require('../server/core/shopierOperations');
  await operations.requestShopierCancellation(result.order.id, actor);
  app.users.get(actor.uid).disabled = true; provider.calls.length = 0;
  try {
    await require('../server/core/shopierJobs').processShopierJob(app.db, app.db.doc('shopierJobs/cancel_' + result.order.id));
    assert.equal(provider.calls.length, 0);
    const job = app.db.records.get('shopierJobs/cancel_' + result.order.id);
    assert.ok(job.failedAt); assert.equal(job.lastError, 'ADMIN_PERMISSION_REQUIRED');
  } finally { app.users.get(actor.uid).disabled = false; }
});
test('security assessment cannot count missing provider credentials or an unreachable distributed limiter store as passed', () => {
  const previous = process.env.SHOPIER_PAT;
  try {
    delete process.env.SHOPIER_PAT;
    const report = require('../server/core/securityAssessment').assessSecurity({ configuration: { rateLimitStore: 'firestore' }, connections: { storageReady: false } });
    const providerControl = report.checks.find(row => row.key === 'shopier');
    assert.equal(providerControl.status, 'failed'); assert.equal(providerControl.earned, 0); assert.ok(providerControl.remediation);
    assert.notEqual(report.checks.find(row => row.key === 'rate-limit').status, 'passed');
    assert(report.score <= 60);
  } finally { process.env.SHOPIER_PAT = previous; }
});
test('a pre-existing v88 queued item retains its original fingerprint format when a worker is upgraded', async () => {
  const order = await telegram(), id = await ready('cancel_telegram');
  const row = app.db.records.get('storeOrders/' + order.id);
  const item = [...app.db.records].find(([p, v]) => p.startsWith('storeMaintenanceJobs/' + id + '/items/') && v.targetId === order.id)[1];
  delete item.fingerprintVersion;
  item.fingerprint = crypto.createHash('sha256').update(JSON.stringify([row.status, row.paymentState, row.updatedAt, row.paidAt, row.approvedAt, row.totalKurus, row.delivery?.itemCount, row.shopier?.refundedKurus])).digest('hex');
  await maintenance.drainMaintenanceJobs();
  assert.equal((await maintenance.getJob(id, actor)).job.succeeded, 1);
  assert.equal(app.db.records.get('storeOrders/' + order.id).status, 'cancelled');
});
test('explicitly retrying a revoked provider job renews authorization without bypassing provider verification', async () => {
  const result = await topup(), operations = require('../server/core/shopierOperations'), jobs = require('../server/core/shopierJobs');
  await operations.requestShopierClosure(result.order.id, actor);
  const id = 'close_' + result.order.id, row = app.db.records.get('shopierJobs/' + id), user = app.users.get(actor.uid);
  row.authorizedAt = Date.now() - 2000; user.tokensValidAfterTime = new Date(Date.now() - 1000).toISOString();
  try {
    await jobs.processShopierJob(app.db, app.db.doc('shopierJobs/' + id));
    assert.equal(app.db.records.get('shopierJobs/' + id).lastError, 'ADMIN_JOB_AUTHORIZATION_REVOKED');
    await jobs.retryShopierJob(id, actor); await jobs.processShopierJob(app.db, app.db.doc('shopierJobs/' + id));
    assert.equal(provider.products.get(result.order.shopier.productId).stockQuantity, 0);
    assert.equal(app.db.records.get('storeOrders/' + result.order.id).paymentState, 'link_closed');
  } finally { delete user.tokensValidAfterTime; }
});
test('a definitively rejected listing can be cancelled and permanently removed while its financial evidence is retained', async () => {
  provider.interceptOnce('POST', '/products', () => provider.response({}, 400));
  const result = await topup(), row = app.db.records.get('storeOrders/' + result.order.id);
  assert.equal(row.shopier.state, 'creation_failed'); assert.equal(row.shopier.productId || '', '');
  const preview = await maintenance.createPreview({ operation: 'cancel_delete_all', actor, idempotencyKey: crypto.randomUUID() });
  await maintenance.drainMaintenanceJobs(); await maintenance.confirmJob(preview.job.id, actor, 'KALICI SIL');
  for (let i = 0; i < 5; i++) await maintenance.drainMaintenanceJobs();
  assert.equal((await maintenance.getJob(preview.job.id, actor)).job.succeeded, 1);
  assert(!app.db.records.has('storeOrders/' + row.id));
  const archive = app.db.records.get('storeOrderArchives/' + row.id);
  assert.equal(archive.order.shopier.closureReason, 'no_listing_issued');
  assert.equal(archive.financialEvidenceRetained, true);
  assert.equal(provider.calls.filter(c => c.method === 'PUT' || c.path === '/orders').length, 0);
});
