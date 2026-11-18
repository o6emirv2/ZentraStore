'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { applicationFixture } = require('./helpers/application-fixture.cjs');
let app, store, maintenance, catalog, owner;
const key = () => crypto.randomUUID();
const actor = { uid: 'owneruid', email: 'owner@zentra.invalid' };
const records = name => [...app.db.records].filter(([path]) => path.startsWith(name + '/'));
before(async () => {
  app = await applicationFixture();
  store = require('../server/core/storeService'); maintenance = require('../server/core/orderMaintenanceService');
  owner = await app.openAdmin();
});
after(async () => { await app.close(); });
beforeEach(async () => {
  for (const [path] of app.db.records) if (!path.startsWith('users/') && !path.startsWith('adminUsers/') && !path.startsWith('storeAdmin')) app.db.records.delete(path);
  app.db.records.get('users/member').storeBalanceKurus = 50000;
  app.db.records.get('users/member').storeWalletDebtKurus = 0;
  app.db.setFailure(false);
  require('../server/core/storeCatalogService').invalidateCatalogCache(); require('../server/core/firestorePagination').invalidateCreatedAtPageCache();
  catalog = await require('../server/core/storeCatalogService').getEffectiveCatalog({ fresh: true });
});
async function telegram() {
  const product = catalog.products.find(row => row.telegramEnabled), plan = product.plans[0];
  return (await store.createOrder({ uid: 'member', authUser: app.users.get('member'), paymentMethod: 'telegram',
    rawItems: [{ productId: product.id, planKey: plan.key, quantity: 1 }], idempotencyKey: key() })).order;
}

async function preview(operation) {
  const response = await maintenance.createPreview({ operation, actor, idempotencyKey: key() });
  for (let index = 0; index < 30; index++) {
    await maintenance.drainMaintenanceJobs();
    const value = await maintenance.getJob(response.job.id, actor);
    if (value.job.state === 'ready') return value;
  }
  throw new Error('Preview did not finish');
}
async function step(id, times = 6) { for (let index = 0; index < times; index++) await maintenance.drainMaintenanceJobs(); return maintenance.getJob(id, actor); }
async function confirmed(operation) { const value = await preview(operation); await maintenance.confirmJob(value.job.id, actor, value.job.permanent ? 'KALICI SIL' : ''); return value; }

test('TikTok migration preserves custom links and updates only the former official address once', () => {
  const links = require('../server/core/storeLinks');
  const custom = { ...links.DEFAULT_QUICK_LINKS[0], title: 'Özel başlık', enabled: false };
  const patch = links.channelLinksMigration({ channelLinksRevision: 70, quickLinks: [custom, { ...links.DEFAULT_QUICK_LINKS[4], url: 'https://www.tiktok.com/@shelbystorelive' }] });
  assert.deepEqual(patch.quickLinks[0], custom); assert.equal(patch.quickLinks[1].url, links.TIKTOK_OFFICIAL_URL);
  assert.equal(links.channelLinksMigration({ ...patch }), null);
  assert.equal(links.normalizeQuickLinks([{ ...links.DEFAULT_QUICK_LINKS[4], url: 'https://www.tiktok.com/@changedaccount' }])[0].url, 'https://www.tiktok.com/@changedaccount');
});
test('links save persists distinct active/home flags, order and editable TikTok; stale edits are rejected', async () => {
  const service = require('../server/core/storeCatalogService'), source = require('../server/core/storeLinks').DEFAULT_QUICK_LINKS;
  const links = [{ ...source[4], url: 'https://www.tiktok.com/@newaccount', showOnHome: false }, { ...source[0], enabled: false, showOnHome: true }];
  const saved = await service.updateStorefrontQuickLinks(links, actor, 0);
  assert.equal(saved[0].url, links[0].url); assert.equal(saved[0].showOnHome, false); assert.equal(saved[1].enabled, false);
  const persisted = (await service.getEffectiveCatalog({ fresh: true })).storefront;
  assert.deepEqual(persisted.quickLinks, saved); assert.equal(persisted.quickLinksRevision, 1);
  await assert.rejects(service.updateStorefrontQuickLinks([], actor, 0), { code: 'STORE_LINK_REVISION_CONFLICT' });
  assert.deepEqual(app.db.records.get('storefrontSettings/main').quickLinks, saved);
});
test('invalid social URLs and a failed database commit cannot produce a successful saved link', async () => {
  const service = require('../server/core/storeCatalogService'), link = require('../server/core/storeLinks').DEFAULT_QUICK_LINKS[0];
  for (const url of ['javascript:alert(1)', 'https://t.me.evil.invalid/test', 'https://user:pass@t.me/validname', 'https://t.me/validname?next=evil']) await assert.rejects(service.updateStorefrontQuickLinks([{ ...link, url }], actor));
  const previous = structuredClone(app.db.records.get('storefrontSettings/main')); app.db.setFailure(true);
  await assert.rejects(service.updateStorefrontQuickLinks([], actor, 0)); app.db.setFailure(false);
  assert.deepEqual(app.db.records.get('storefrontSettings/main'), previous);
});
test('manual Telegram payment cannot be approved without a verified external record reference', async () => {
  const order = await telegram();
  await assert.rejects(store.updateOrderByAdmin({ orderId: order.id, input: { status: 'paid' }, actor }), { code: 'STORE_MANUAL_PAYMENT_EVIDENCE_REQUIRED' });
  assert.equal(app.db.records.get('storeOrders/' + order.id).status, 'awaiting_payment');
  const updated = await store.updateOrderByAdmin({ orderId: order.id, input: { status: 'paid', paymentConfirmed: true, paymentReference: 'BANK-TRANSACTION-REF-001' }, actor });
  assert.equal(updated.status, 'paid'); assert.equal(app.db.records.get('storeOrders/' + order.id).manualPayment.verification, 'administrator-external-record-attestation');
  await assert.rejects(store.updateOrderByAdmin({ orderId: order.id, input: { status: 'refunded' }, actor }), { code: 'STORE_MANUAL_PAYMENT_EVIDENCE_REQUIRED' });
});

test('button 6 deletes final cancellations and keeps active orders and unresolved payment records', async () => {
  const cancelled = await telegram(); await store.updateOrderByAdmin({ orderId: cancelled.id, input: { status: 'cancelled' }, actor }); const active = await telegram();
  const value = await confirmed('delete_cancelled'); assert.equal((await step(value.job.id)).job.succeeded, 1);
  assert(!app.db.records.has('storeOrders/' + cancelled.id)); assert(app.db.records.has('storeOrders/' + active.id));
});
test('permanent deletion requires second confirmation; a failed commit leaves order and archives consistent', async () => {
  const cancelled = await telegram(); await store.updateOrderByAdmin({ orderId: cancelled.id, input: { status: 'cancelled' }, actor });
  const value = await preview('delete_cancelled'); await assert.rejects(maintenance.confirmJob(value.job.id, actor, 'wrong'), { code: 'BULK_CONFIRMATION_REQUIRED' });
  app.db.setFailure(true); await assert.rejects(maintenance.deleteOrder(cancelled.id, actor)); app.db.setFailure(false);
  assert(app.db.records.has('storeOrders/' + cancelled.id)); assert(!app.db.records.has('storeOrderArchives/' + cancelled.id));
});
test('changed preview records are excluded instead of refunding or cancelling a different state', async () => {
  const order = await telegram(), value = await preview('cancel_telegram'); const row = app.db.records.get('storeOrders/' + order.id);
  row.status = 'paid'; row.approvedAt = Date.now(); row.updatedAt = Date.now() + 1;
  await maintenance.confirmJob(value.job.id, actor); const done = await step(value.job.id);
  assert.equal(done.job.skipped, 1); assert.equal(done.job.succeeded, 0); assert.equal(row.status, 'paid');
});
test('preview paginates over 150 records and results remain independently pageable', async () => {
  for (let index = 0; index < 157; index++) app.db.records.set(`storeOrders/order-${String(index).padStart(3, '0')}`, { id: `order-${index}`, uid: 'member', paymentMethod: 'telegram', status: 'awaiting_payment', createdAt: Date.now() - 1000, totalKurus: 100, updatedAt: 1 });
  const value = await preview('cancel_telegram'); assert.equal(value.job.total, 157); assert.equal(value.results.length, 100);
  const next = await maintenance.getJob(value.job.id, actor, value.nextCursor); assert.equal(next.results.length, 57);
  assert(!next.results.some(row => value.results.some(before => before.id === row.id)));
});
test('audit purge removes eligible operational records and preserves financial/security and recent records', async () => {
  const old = Date.now() - 100 * 86400_000;
  app.db.records.set('audit/old-content', { type: 'store-content-update', at: old }); app.db.records.set('audit/old-payment', { type: 'store.payment.verified', at: old });
  app.db.records.set('adminAudit/old-login', { action: 'admin.gate.login.success', createdAt: old }); app.db.records.set('audit/recent', { type: 'store-content-update', at: Date.now() });
  const value = await confirmed('delete_audit'); assert.equal(value.job.total, 4); assert.equal(value.job.eligible, 1);
  const done = await step(value.job.id); assert.equal(done.job.succeeded, 1); assert(!app.db.records.has('audit/old-content'));
  assert(app.db.records.has('audit/old-payment')); assert(app.db.records.has('adminAudit/old-login')); assert(app.db.records.has('audit/recent'));
  assert(records('protectedSecurityAudit').some(([, row]) => row.action === 'audit.permanently_removed'));
});
test('unauthorized preview and missing action proof cannot execute bulk mutations through HTTP', async () => {
  const body = { operation: 'cancel_telegram', idempotencyKey: key() };
  assert.equal((await app.request('/api/admin/store/maintenance/preview', { uid: 'member', method: 'POST', body })).status, 403);
  const order = await telegram(), value = await preview('cancel_telegram');
  const path = `/api/admin/store/maintenance/${value.job.id}/orders/confirm`;
  assert.equal((await app.request(path, { ...owner, method: 'POST', body: { confirmation: '' } })).status, 401);
  const confirmed = await app.adminWrite(owner, path, 'POST', { confirmation: '' }); assert.equal(confirmed.status, 202);
  await step(value.job.id); assert.equal(app.db.records.get('storeOrders/' + order.id).status, 'cancelled');
});
test('security assessment never counts unknown backup or missing dependency evidence as passed', () => {
  const { assessSecurity } = require('../server/core/securityAssessment');
  const value = assessSecurity({ configuration: {}, connections: {}, gateSecurity: {}, req: {}, res: {} });
  assert(value.score < 98); assert.equal(value.checks.find(row => row.key === 'backup').status, 'unverified');
  assert.equal(value.checks.find(row => row.key === 'backup').earned, 0); assert(value.failedCount > 0); assert(value.unverifiedCount > 0);
});

test('restore digest includes inventory and delivery children whose parent documents do not exist', async () => {
  const { memoryFirestore } = require('./helpers/memory-firestore.cjs'), { databaseDigest } = require('../server/core/restoreVerification');
  const db = memoryFirestore([['storeInventory/sku/items/item', { encrypted: 'opaque-a' }], ['storeDeliveries/order/items/item', { encrypted: 'opaque-b' }]]);
  const before = await databaseDigest(db); assert.equal(before.documents, 2);
  db.records.get('storeInventory/sku/items/item').encrypted = 'changed'; assert.notEqual((await databaseDigest(db)).digest, before.digest);
});
test('restore evidence requires an isolated exact stable match and a valid source-project signature', async () => {
  const { memoryFirestore } = require('./helpers/memory-firestore.cjs'), verify = require('../server/core/restoreVerification');
  const data = [['users/example', { balanceKurus: 15000 }], ['storeInventory/sku/items/item', { encrypted: 'opaque' }]];
  const source = memoryFirestore(data), restored = memoryFirestore(structuredClone(data));
  await assert.rejects(verify.recordRestoreVerification({ source, restored, sourceProject: 'same', restoreProject: 'same' }), { code: 'ISOLATED_RESTORE_PROJECT_REQUIRED' });
  const done = await verify.recordRestoreVerification({ source, restored, sourceProject: 'primary', restoreProject: 'isolated' });
  assert.equal(done.documents, 2); const record = source.records.get('storeSecurityEvidence/restoreVerification');
  assert.equal(verify.verifyRestoreEvidence(record, 'primary').verified, true);
  assert.equal(verify.verifyRestoreEvidence({ ...record, documents: 1000 }, 'primary').verified, false);
  assert.equal(verify.verifyRestoreEvidence(record, 'different').verified, false);
  assert.equal(verify.verifyRestoreEvidence(record, 'primary', record.verifiedAt + 31 * 86400_000).verified, false);
});
test('restore mismatch cannot write successful evidence or claim a backup was restored', async () => {
  const { memoryFirestore } = require('./helpers/memory-firestore.cjs'), verify = require('../server/core/restoreVerification');
  const source = memoryFirestore([['users/example', { balanceKurus: 15000 }]]), restored = memoryFirestore([['users/example', { balanceKurus: 14999 }]]);
  await assert.rejects(verify.recordRestoreVerification({ source, restored, sourceProject: 'primary', restoreProject: 'isolated' }), { code: 'RESTORE_DATA_MISMATCH_OR_SOURCE_CHANGED' });
  assert(!source.records.has('storeSecurityEvidence/restoreVerification'));
});
test('a revoked bulk operator pauses pending work and an explicit reauthorized resume completes it once', async () => {
  const order = await telegram(), staff = { uid: 'member', email: 'member@zentra.invalid' };
  app.db.records.set('adminUsers/member', { role: 'admin', email: staff.email, active: true, policyVersion: 1 });
  const previewed = await maintenance.createPreview({ operation: 'cancel_telegram', actor: staff, idempotencyKey: key() });
  await maintenance.drainMaintenanceJobs(); await maintenance.confirmJob(previewed.job.id, staff);
  app.db.records.get('adminUsers/member').role = 'viewer'; await maintenance.drainMaintenanceJobs();
  assert.equal((await maintenance.getJob(previewed.job.id, staff)).job.state, 'paused'); assert.equal(app.db.records.get('storeOrders/' + order.id).status, 'awaiting_payment');
  app.db.records.get('adminUsers/member').role = 'admin'; await maintenance.confirmJob(previewed.job.id, staff);
  for (let index = 0; index < 5; index++) await maintenance.drainMaintenanceJobs();
  assert.equal((await maintenance.getJob(previewed.job.id, staff)).job.succeeded, 1);
});
test('unknown old audit types are retained until their retention policy has been established', () => {
  assert.equal(maintenance.auditPolicy({ type: 'unknown-legacy-event', at: Date.now() - 400 * 86400_000 }).eligible, false);
});

