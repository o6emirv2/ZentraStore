'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { applicationFixture } = require('./helpers/application-fixture.cjs');
const { shopierFixture } = require('./helpers/shopier-fixture.cjs');
let app, provider, service, inventory, jobs, config, product, plan, validEnv, adminSession;
const key = () => `shopier-test-${crypto.randomUUID()}`;
const rows = (prefix) => [...app.db.records].filter(([path]) => path.startsWith(prefix));
async function seed(count = 1, selected = product, selectedPlan = plan) {
  await inventory.importInventory({ productId: selected.id, planKey: selectedPlan.key,
    keys: Array.from({ length: count }, () => `SHOPIER-TEST-LICENSE-${crypto.randomUUID()}`), actor: { uid: 'owneruid' }, idempotencyKey: key() });
}
function body(extra = {}) { return { uid: 'member', authUser: app.users.get('member'), items: [{ productId: product.id, planKey: plan.key, quantity: 1, expectedUnitPriceKurus: plan.priceKurus }], idempotencyKey: key(), ...extra }; }
async function pending(extra) { await seed(); return service.createShopierPayment(body(extra)); }
async function deliver(result) { const remote = provider.paid(result.order.shopier.productId); await service.applyShopierOrder(remote); await service.deliverShopierOrder(result.order.id); return remote; }
async function webhook(event, data, options = {}) {
  const signed = provider.signed(event, data, options);
  const response = await fetch(app.origin + '/api/payments/shopier/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'shopier-signature': signed.signature, 'shopier-event': event }, body: signed.raw });
  return { status: response.status, body: await response.json() };
}
async function drainAll() {
  for (let pass = 0; pass < 3; pass++) {
    const refs = rows('shopierJobs/').filter(([, job]) => !job.completedAt && !job.failedAt);
    for (const [path] of refs) { const row = app.db.records.get(path); row.availableAt = 0; await jobs.processShopierJob(app.db, app.db.doc(path)); }
  }
}
before(async () => {
  app = await applicationFixture({ shopier: true }); provider = shopierFixture();
  service = require('../server/core/shopierService'); inventory = require('../server/core/storeInventoryService'); jobs = require('../server/core/shopierJobs'); config = require('../server/config/shopier');
  product = require('../server/core/storeCatalog').STORE_CATALOG.products.find((entry) => entry.automaticEnabled !== false && entry.fulfillmentMode !== 'telegram_only'); plan = product.plans[0];
  validEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(?:SHOPIER_|WEQ_PUBLIC)/.test(name)));
});
beforeEach(() => {
  for (const [path] of app.db.records) if (/^(?:storeOrders|shopier|storeInventory|storeDeliveries|storeRestock|audit|storePromotions|storePromotionUsage|storeWalletLedger)/.test(path)) app.db.records.delete(path);
  provider.products.clear(); provider.orders.clear(); provider.refunds.clear(); provider.calls.length = 0;
  for (const name of Object.keys(process.env)) if (/^(?:SHOPIER_|WEQ_PUBLIC)/.test(name)) delete process.env[name]; Object.assign(process.env, validEnv);
  app.db.records.get('users/member').storeBalanceKurus = 50000; app.db.records.get('users/member').storeAccountStatus = 'active';
  app.db.setFailure(false); inventory.invalidateStockCache(); require('../server/core/firestorePagination').invalidateCreatedAtPageCache('storeOrders');
});
after(async () => { provider.close(); await app.close(); });

test('01 authenticated HTTP checkout creates one digital custom listing and pending order, no delivery', async () => {
  await seed(); const input = body(); const { uid, authUser, ...requestBody } = input;
  const result = await app.request('/api/payments/shopier/create', { uid, method: 'POST', body: requestBody });
  assert.equal(result.status, 200); assert.equal(result.body.order.status, 'awaiting_payment'); assert.equal(result.body.order.paymentState, 'pending');
  assert.match(result.body.paymentUrl, /^https:\/\/www\.shopier\.com\//); assert.equal(rows('storeDeliveries/').length, 0);
  assert.equal(rows('storeInventory/').filter(([, row]) => row.status === 'reserved').length, 1);
  const call = provider.calls.find((entry) => entry.method === 'POST'); assert.equal(call.path, '/products'); assert.equal(call.body.type, 'digital'); assert.equal(call.body.stockQuantity, 1); assert.equal(call.body.customListing, true);
  assert(!JSON.stringify(call.body).includes(process.env.SHOPIER_PAT)); assert(!('successUrl' in call.body)); assert(!('callback' in call.body));
});
test('02 valid daily/weekly/monthly plans use server prices and preserve package metadata', async () => {
  const selected = product.plans.slice(0, 3); for (const p of selected) await seed(1, product, p);
  for (const p of selected) {
    const result = await service.createShopierPayment(body({ items: [{ productId: product.id, planKey: p.key, quantity: 1 }] }));
    assert.equal(result.order.totalKurus, p.priceKurus); assert.equal(result.order.items[0].duration, p.duration);
    app.db.records.get('storeOrders/' + result.order.id).shopierOpen = false;
  }
});
test('03 forged expected price is rejected before remote calls', async () => {
  await seed(); await assert.rejects(service.createShopierPayment(body({ items: [{ productId: product.id, planKey: plan.key, quantity: 1, expectedUnitPriceKurus: 1 }] })), { code: 'STORE_PRICE_CHANGED' }); assert.equal(provider.calls.length, 0);
});
test('04 unknown price field is rejected by HTTP schema', async () => {
  const result = await app.request('/api/payments/shopier/create', { uid: 'member', method: 'POST', body: { items: [{ productId: product.id, planKey: plan.key, quantity: 1 }], idempotencyKey: key(), totalKurus: 1 } });
  assert.equal(result.status, 400); assert.equal(provider.calls.length, 0);
});
for (const [name, item] of [['05 invalid product', { productId: 'unknown-product', planKey: 'daily', quantity: 1 }], ['06 invalid plan', { productId: 'kingmod', planKey: 'not-a-plan', quantity: 1 }]]) test(name, async () => { await assert.rejects(service.createShopierPayment(body({ items: [item] })), { code: 'STORE_ITEM_UNAVAILABLE' }); assert.equal(provider.calls.length, 0); });
test('07 signed success is durably queued, API verified and delivered exactly once', async () => {
  const result = await pending(), remote = provider.paid(result.order.shopier.productId); const start = Date.now();
  assert.equal((await webhook('order.created', { id: remote.id })).status, 200); assert(Date.now() - start < 5000);
  assert.equal(rows('storeDeliveries/').length, 0); await drainAll();
  const order = app.db.records.get('storeOrders/' + result.order.id); assert.equal(order.status, 'delivered'); assert(order.paidAt > 0); assert.equal(order.shopier.orderId, remote.id);
  assert.equal(rows('shopierPayments/').length, 1); assert.equal(rows('storeDeliveries/').length, 1); assert.equal(rows('storeWalletLedger/').length, 0);
});
test('08 definitive provider rejection releases stock without marking paid', async () => {
  await seed(); provider.failNext(() => provider.response({ private: 'never expose' }, 400)); const result = await service.createShopierPayment(body());
  assert.equal(result.order.paymentState, 'failed'); assert.equal(result.order.paidAt, 0); assert.equal(rows('storeDeliveries/').length, 0); assert.equal(rows('storeInventory/').find(([, row]) => row.status)?.[1].status, 'available');
});
test('09 cancelled URL is a real page and never changes payment records', async () => {
  const result = await pending(); const response = await fetch(app.origin + '/odeme/iptal?order=' + result.order.id + '&status=paid'); assert.equal(response.status, 200);
  assert((await response.text()).includes('shopier-result.js')); assert.equal(app.db.records.get('storeOrders/' + result.order.id).paymentState, 'pending'); assert.equal(rows('storeDeliveries/').length, 0);
});
test('10 unpaid provider order stays pending and never delivers', async () => {
  const result = await pending(), remote = provider.paid(result.order.shopier.productId, { paymentStatus: 'unpaid' }); await service.applyShopierOrder(remote);
  assert.equal(app.db.records.get('storeOrders/' + result.order.id).paymentState, 'pending'); await assert.rejects(service.deliverShopierOrder(result.order.id), { code: 'SHOPIER_PAYMENT_NOT_VERIFIED' });
});
test('11 fake webhook without signature fails', async () => {
  const response = await fetch(app.origin + '/api/payments/shopier/webhook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"event":"order.created","data":{"id":"123"}}' }); assert.equal(response.status, 401); assert.equal(rows('shopierWebhookReceipts/').length, 0);
});
test('12 invalid signature and changed signed bytes fail', async () => {
  assert.equal((await webhook('order.created', { id: '123' }, { token: crypto.randomBytes(32).toString('hex') })).status, 401);
  const signed = provider.signed('order.created', { id: '123' }); const response = await fetch(app.origin + '/api/payments/shopier/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'shopier-signature': signed.signature }, body: signed.raw + ' ' }); assert.equal(response.status, 401);
});
test('13 repeated same and differently serialized notifications cannot duplicate delivery', async () => {
  const result = await pending(), remote = provider.paid(result.order.shopier.productId);
  await Promise.all(Array.from({ length: 6 }, () => webhook('order.created', { id: remote.id }))); await webhook('order.created', { id: remote.id }, { space: 2 });
  assert.equal(rows('shopierWebhookReceipts/').length, 2); await drainAll(); await service.applyShopierOrder(remote); await service.deliverShopierOrder(result.order.id);
  assert.equal(rows('storeDeliveries/').length, 1); assert.equal(rows('shopierPayments/').length, 1); assert.equal(app.db.records.get('storeOrders/' + result.order.id).delivery.itemCount, 1);
});
test('14 wrong provider order number cannot approve the referenced order', async () => {
  const result = await pending(), remote = provider.paid(result.order.shopier.productId); provider.orders.set('wrong-123', remote);
  await webhook('order.created', { id: 'wrong-123' }); const path = rows('shopierJobs/').find(([, row]) => row.kind === 'order.created')[0]; await jobs.processShopierJob(app.db, app.db.doc(path));
  assert.equal(app.db.records.get(path).lastError, 'SHOPIER_ORDER_MISMATCH'); assert.equal(app.db.records.get('storeOrders/' + result.order.id).paidAt, 0);
});
test('15 wrong amount fails closed', async () => { const result = await pending(), remote = provider.paid(result.order.shopier.productId); remote.totals.total = '0.01'; await assert.rejects(service.applyShopierOrder(remote), { code: 'SHOPIER_AMOUNT_MISMATCH' }); assert.equal(rows('shopierPayments/').length, 0); });
test('16 wrong currency fails closed', async () => { const result = await pending(), remote = provider.paid(result.order.shopier.productId, { currency: 'USD' }); await assert.rejects(service.applyShopierOrder(remote), { code: 'SHOPIER_CURRENCY_MISMATCH' }); assert.equal(rows('storeDeliveries/').length, 0); });
test('17 timeout keeps an uncertain order/reservation, repeated create never repeats remote POST', async () => {
  await seed(); provider.failNext((_url, options) => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true })));
  const input = body(), result = await service.createShopierPayment(input); assert.equal(result.order.shopier.state, 'creation_uncertain');
  await service.createShopierPayment(input); assert.equal(provider.calls.filter((call) => call.method === 'POST').length, 1); assert.equal(rows('storeInventory/').find(([, row]) => row.status)?.[1].status, 'reserved');
});
test('18 connection loss after remote create recovers the same listing', async () => {
  await seed(); provider.failNext((_url, options) => { const body = JSON.parse(options.body); provider.products.set('lost-123', { id: 'lost-123', ...body, url: 'https://www.shopier.com/lost-123' }); throw new TypeError('disconnected'); });
  const input = body(), result = await service.createShopierPayment(input); assert.equal(result.order.shopier.state, 'creation_uncertain'); await service.recoverShopierProduct(result.order.id);
  const recovered = await service.createShopierPayment(input); assert.equal(recovered.order.shopier.productId, 'lost-123'); assert.equal(provider.calls.filter((call) => call.method === 'POST').length, 1);
});
test('19 concurrent checkouts cannot sell one key twice', async () => {
  await seed(); const results = await Promise.allSettled([service.createShopierPayment(body()), service.createShopierPayment(body())]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1); assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'STORE_OUT_OF_STOCK');
});
test('20 concurrent same idempotency key creates only one remote product/order', async () => {
  await seed(); const input = body(), results = await Promise.all(Array.from({ length: 5 }, () => service.createShopierPayment(input)));
  assert.equal(new Set(results.map((r) => r.order.id)).size, 1); assert.equal(provider.calls.filter((call) => call.method === 'POST').length, 1);
});
test('21 concurrent delivery attempts are atomic and idempotent', async () => {
  const result = await pending(), remote = provider.paid(result.order.shopier.productId); await service.applyShopierOrder(remote);
  await Promise.all(Array.from({ length: 8 }, () => service.deliverShopierOrder(result.order.id))); assert.equal(rows('storeDeliveries/').length, 1); assert.equal(rows('storeInventoryEvents/').filter(([, row]) => row.type === 'delivered').length, 1);
});
test('22 paid order is visible to its customer and admin, never another customer', async () => {
  const result = await pending(); await deliver(result);
  const mine = await app.request('/api/store/orders', { uid: 'member' }); assert(mine.body.orders.some((row) => row.id === result.order.id && row.paymentMethod === 'shopier'));
  const other = await app.request('/api/payments/shopier/orders/' + result.order.id, { uid: 'finance' }); assert.equal(other.status, 404);
  const admin = adminSession = await app.openAdmin(), list = await app.request('/api/admin/store/orders', admin); assert.equal(list.status, 200); assert.equal(list.body.orders.find((row) => row.id === result.order.id).shopier.orderId, provider.orders.values().next().value.id);
});
test('23 wallet and Telegram paths still work and never call Shopier', async () => {
  await seed(); const old = require('../server/core/storeService'); const wallet = await old.createOrder({ uid: 'member', authUser: app.users.get('member'), rawItems: body().items, paymentMethod: 'wallet', idempotencyKey: key() });
  assert.equal(wallet.order.status, 'delivered'); const telegram = await old.createOrder({ uid: 'member', authUser: app.users.get('member'), rawItems: body().items, paymentMethod: 'telegram', idempotencyKey: key() }); assert.equal(telegram.order.status, 'awaiting_payment'); assert.equal(provider.calls.length, 0);
});
test('24 missing PAT, disabled flag and invalid config block new payments', async () => {
  for (const changes of [{ SHOPIER_PAT: '' }, { SHOPIER_PAT: '<YENI_GIZLI_PAT>' }, { SHOPIER_HTTP_TIMEOUT_MS: '0' }, { SHOPIER_API_BASE_URL: 'https://attacker.invalid/v1' }, { SHOPIER_WEBHOOK_TOKEN: process.env.SHOPIER_PAT }, { SHOPIER_WEBHOOK_URL: 'https://unknown.invalid/api/payments/shopier/webhook' }]) {
    assert.equal(config.getShopierConfig({ ...process.env, ...changes }).configured, false);
  }
  process.env.SHOPIER_ENABLED = 'false'; await assert.rejects(service.createShopierPayment(body()), { code: 'SHOPIER_DISABLED' }); assert.equal(provider.calls.length, 0);
});
test('25 malformed or unsupported paid status never delivers', async () => {
  const result = await pending(), remote = provider.paid(result.order.shopier.productId, { paymentStatus: 'failed' }); await assert.rejects(service.applyShopierOrder(remote), { code: 'SHOPIER_PAYMENT_STATUS_INVALID' });
  remote.paymentStatus = 'cancelled'; await assert.rejects(service.applyShopierOrder(remote), { code: 'SHOPIER_PAYMENT_STATUS_INVALID' }); assert.equal(rows('storeDeliveries/').length, 0);
});
test('26 official hex raw-body signature tolerates signed whitespace and rejects unsupported base64 encoding', async () => {
  assert.equal((await webhook('order.created', { id: '123' }, { space: 2, encoding: 'hex' })).status, 200);
  assert.equal((await webhook('order.created', { id: '124' }, { space: 2, encoding: 'base64' })).status, 401);
});
test('27 wrong product, quantity, title or customer fails closed', async () => {
  const result = await pending(), remote = provider.paid(result.order.shopier.productId);
  for (const change of [{ quantity: 2 }, { title: 'Wrong order' }, { type: 'physical' }, { total: '0.01' }, { options: [{ id: '1' }] }]) {
    const bad = structuredClone(remote); Object.assign(bad.lineItems[0], change); await assert.rejects(service.applyShopierOrder(bad), { code: 'SHOPIER_PRODUCT_MISMATCH' });
  }
  const bad = structuredClone(remote); bad.shippingInfo.email = 'someone@else.invalid'; await assert.rejects(service.applyShopierOrder(bad), { code: 'SHOPIER_CUSTOMER_MISMATCH' });
});
test('28 two provider payments cannot deliver one local order twice', async () => {
  const result = await pending(); await deliver(result); const second = provider.paid(result.order.shopier.productId); await assert.rejects(service.applyShopierOrder(second), { code: 'SHOPIER_PAYMENT_ALREADY_BOUND' }); assert.equal(rows('storeDeliveries/').length, 1);
});
test('29 full verified refund updates order and prevents delivery', async () => {
  const result = await pending(), remote = provider.paid(result.order.shopier.productId); remote.refunds = [{ id: 'refund1', type: 'full', status: 'succeeded', total: remote.totals.total }];
  await service.applyShopierOrder(remote); assert.equal(app.db.records.get('storeOrders/' + result.order.id).status, 'refunded'); await assert.rejects(service.deliverShopierOrder(result.order.id), { code: 'SHOPIER_PAYMENT_NOT_VERIFIED' });
});
test('30 refund notification is independently signed and verified via API', async () => {
  const result = await pending(), remote = await deliver(result); const refund = { id: 'refund-123', orderId: remote.id, type: 'full', status: 'succeeded', currency: 'TRY', total: remote.totals.total };
  remote.refunds = [refund]; provider.refunds.set(refund.id, refund);
  assert.equal((await webhook('refund.updated', { id: refund.id })).status, 200); await drainAll(); assert.equal(app.db.records.get('storeOrders/' + result.order.id).status, 'refunded'); assert.equal(rows('storeDeliveries/').length, 1);
  assert.equal((await webhook('refund.updated', { id: refund.id }, { token: process.env.SHOPIER_WEBHOOK_TOKEN })).status, 400);
});
test('31 partial or pending refunds suspend automatic delivery', async () => {
  const result = await pending(), remote = provider.paid(result.order.shopier.productId); remote.refunds = [{ id: 'partial', type: 'partial', status: 'pending', total: '1.00' }];
  await service.applyShopierOrder(remote); await assert.rejects(service.deliverShopierOrder(result.order.id), { code: 'SHOPIER_DELIVERY_REVIEW_REQUIRED' }); assert.equal(rows('storeDeliveries/').length, 0); assert.equal(app.db.records.get('storeOrders/' + result.order.id).status, 'delivery_pending');
});
test('32 disabling new checkouts does not disable outstanding webhook/payment verification', async () => {
  const result = await pending(), remote = provider.paid(result.order.shopier.productId); process.env.SHOPIER_ENABLED = 'false'; assert.equal((await webhook('order.created', { id: remote.id })).status, 200); await drainAll(); assert.equal(app.db.records.get('storeOrders/' + result.order.id).status, 'delivered');
});
test('33 failed transaction cannot leave partial order, stock or provider mutation', async () => {
  await seed(); app.db.setFailure(true); await assert.rejects(service.createShopierPayment(body()), { code: 'CONTROLLED_COMMIT_FAILURE' }); app.db.setFailure(false); assert.equal(rows('storeOrders/').length, 0); assert.equal(provider.calls.length, 0); assert.equal(rows('storeInventory/').find(([, row]) => row.status)?.[1].status, 'available');
});
test('34 spoofed success URL never proves payment', async () => {
  const result = await pending(); const response = await fetch(app.origin + '/odeme/sonuc?order=' + result.order.id + '&status=paid&amount=250'); assert.equal(response.status, 200); assert.equal(app.db.records.get('storeOrders/' + result.order.id).paidAt, 0); assert.equal(rows('storeDeliveries/').length, 0);
});
test('35 unauthorized users cannot create payments or mutate admin orders', async () => {
  const input = body(); const result = await app.request('/api/payments/shopier/create', { method: 'POST', body: { items: input.items, idempotencyKey: input.idempotencyKey } }); assert.equal(result.status, 401);
  const denied = await app.request('/api/admin/store/orders/unknown/shopier/reconcile', { uid: 'member', method: 'POST', body: {} }); assert.equal(denied.status, 403);
});
test('36 admin cannot locally mark a Shopier payment as paid/refunded', async () => {
  const result = await pending(); const old = require('../server/core/storeService');
  for (const status of ['paid', 'refunded', 'cancelled']) await assert.rejects(old.updateOrderByAdmin({ orderId: result.order.id, actor: { uid: 'owneruid' }, input: { status } }), { code: 'SHOPIER_PROVIDER_ACTION_REQUIRED' });
  await assert.rejects(old.updateOrderByAdmin({ orderId: result.order.id, actor: { uid: 'owneruid' }, input: { status: 'delivered' } }), { code: 'SHOPIER_PAYMENT_NOT_VERIFIED' });
});
test('37 buyer cannot cancel an active remote payment link locally', async () => {
  const result = await pending(); await assert.rejects(require('../server/core/storeService').cancelOrderByUser({ uid: 'member', orderId: result.order.id }), { code: 'SHOPIER_PROVIDER_ACTION_REQUIRED' });
});
test('38 closing a listing requires provider verification and a later second check before stock release', async () => {
  const result = await pending(); const first = await service.closeShopierOrder(result.order.id, { uid: 'owneruid' }); assert.equal(first.released, false); assert.equal(rows('storeInventory/').find(([, row]) => row.status)?.[1].status, 'reserved');
  const row = app.db.records.get('storeOrders/' + result.order.id); row.shopier.linkClosedAt = Date.now() - 11 * 60_000;
  const second = await service.closeShopierOrder(result.order.id, { uid: 'owneruid' }); assert.equal(second.released, true); assert.equal(app.db.records.get('storeOrders/' + result.order.id).status, 'cancelled'); assert.equal(rows('storeInventory/').find(([, row]) => row.status)?.[1].status, 'available');
});
test('39 late payment after local close is paid but never delivers a reallocated key', async () => {
  const result = await pending(); await service.closeShopierOrder(result.order.id, { uid: 'owneruid' }); app.db.records.get('storeOrders/' + result.order.id).shopier.linkClosedAt = Date.now() - 11 * 60_000;
  await service.closeShopierOrder(result.order.id, { uid: 'owneruid' }); const remote = provider.paid(result.order.shopier.productId); await service.applyShopierOrder(remote);
  await assert.rejects(service.deliverShopierOrder(result.order.id), { code: 'SHOPIER_DELIVERY_REVIEW_REQUIRED' }); assert.equal(rows('storeDeliveries/').length, 0); assert.equal(app.db.records.get('storeOrders/' + result.order.id).paymentState, 'paid');
});
test('40 offsite redirects, malformed provider responses and decimal formats are rejected', async () => {
  const client = require('../server/core/shopierClient'); for (const address of ['http://www.shopier.com/123', 'https://shopier.com.evil.invalid/123', 'https://www.shopier.com@evil.invalid/123', 'javascript:alert(1)', 'https://www.shopier.com:444/123']) assert.throws(() => client.paymentUrl(address));
  for (const value of ['1,00', '1e4', 'NaN', '-1.00', '0.001', 250]) assert.throws(() => client.decimalKurus(value));
  await seed(); provider.failNext(() => new Response('<html>provider error</html>', { status: 200, headers: { 'content-type': 'text/html' } })); const result = await service.createShopierPayment(body()); assert.equal(result.order.shopier.state, 'creation_uncertain'); assert.equal(result.paymentUrl, '');
});
test('41 webhook persistence failure returns non-200 so provider can retry', async () => {
  app.db.setFailure(true); const result = await webhook('order.created', { id: '123' }); app.db.setFailure(false); assert(result.status >= 500); assert.equal(rows('shopierWebhookReceipts/').length, 0);
});
test('42 no stock or Telegram-only product cannot start card payment', async () => {
  await assert.rejects(service.createShopierPayment(body()), { code: 'STORE_OUT_OF_STOCK' });
  const telegram = require('../server/core/storeCatalog').STORE_CATALOG.products.find((entry) => entry.fulfillmentMode === 'telegram_only');
  if (telegram) await assert.rejects(service.createShopierPayment(body({ items: [{ productId: telegram.id, planKey: telegram.plans[0].key, quantity: 1 }] })), { code: 'STORE_AUTOMATIC_DELIVERY_DISABLED' });
});
test('43 same idempotency key with changed cart cannot create another payment', async () => {
  await seed(2); const input = body(); await service.createShopierPayment(input); input.items[0].quantity = 2; await assert.rejects(service.createShopierPayment(input), { code: 'STORE_ORDER_CONFLICT' }); assert.equal(provider.calls.filter((call) => call.method === 'POST').length, 1);
});
test('44 pending limit blocks unbounded per-user inventory reservations', async () => {
  await seed(3); await service.createShopierPayment(body()); await service.createShopierPayment(body()); await assert.rejects(service.createShopierPayment(body()), { code: 'SHOPIER_PENDING_LIMIT' });
});
test('45 out-of-order API snapshots cannot resurrect a fully refunded payment', async () => {
  const result = await pending(), remote = provider.paid(result.order.shopier.productId), stale = structuredClone(remote);
  remote.refunds = [{ id: 'full', status: 'succeeded', total: remote.totals.total }]; await service.applyShopierOrder(remote); await service.applyShopierOrder(stale);
  assert.equal(app.db.records.get('storeOrders/' + result.order.id).paymentState, 'refunded'); assert.equal(rows('storeDeliveries/').length, 0);
});
test('46 discount is computed and reserved server-side, not reapplied at Shopier', async () => {
  await require('../server/core/storePromotionService').savePromotion('SHOPIER10', { title: 'Ten percent', type: 'percent', value: 10, active: true, usageLimit: 10, perUserLimit: 1 }, { uid: 'owneruid' });
  const result = await pending({ promotionCode: 'SHOPIER10' }); assert.equal(result.order.discountKurus, plan.priceKurus / 10); assert.equal(result.order.totalKurus, plan.priceKurus * .9);
  assert.equal(provider.products.get(result.order.shopier.productId).priceData.price, require('../server/core/shopierClient').money(result.order.totalKurus));
  assert.equal(app.db.records.get('storePromotions/SHOPIER10').usedCount, 1); await deliver(result); assert.equal(app.db.records.get('storePromotions/SHOPIER10').usedCount, 1);
});
test('47 invalid webhook event header or envelope is never accepted', async () => {
  assert.equal((await webhook('order.created', { event: 'order.created', data: { id: '123' } })).status, 400);
  const signed = provider.signed('order.created', { id: '123' });
  const response = await fetch(app.origin + '/api/payments/shopier/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'shopier-signature': signed.signature }, body: signed.raw }); assert.equal(response.status, 400);
  assert.equal(rows('shopierWebhookReceipts/').length, 0);
});
test('48 webhook header cannot change a subscription-bound event type', async () => {
  assert.equal((await webhook('refund.updated', { id: '123' }, { token: process.env.SHOPIER_WEBHOOK_TOKEN })).status, 400);
  assert.equal((await webhook('order.created', { id: '123' }, { token: process.env.SHOPIER_REFUND_WEBHOOK_TOKEN })).status, 400);
});
test('49 paid webhook trusts API, not a forged paid amount in signed notification', async () => {
  const result = await pending(), remote = provider.paid(result.order.shopier.productId, { paymentStatus: 'unpaid' });
  await webhook('order.created', { id: remote.id, paymentStatus: 'paid', totals: { total: '9999.00' } }); await drainAll(); assert.equal(app.db.records.get('storeOrders/' + result.order.id).paidAt, 0);
});
test('50 remote read failure leaves a retryable durable job and no delivery', async () => {
  const result = await pending(), remote = provider.paid(result.order.shopier.productId); await webhook('order.created', { id: remote.id });
  const [path] = rows('shopierJobs/').find(([, row]) => row.kind === 'order.created'); provider.failNext(() => { throw new TypeError('lost connection'); }); await jobs.processShopierJob(app.db, app.db.doc(path));
  assert.equal(app.db.records.get(path).attempts, 1); assert(app.db.records.get(path).availableAt > Date.now()); assert.equal(app.db.records.get('storeOrders/' + result.order.id).paidAt, 0);
  await jobs.processShopierJob(app.db, app.db.doc(path)); assert.equal(app.db.records.get(path).attempts, 1);
  app.db.records.get(path).availableAt = 0; await jobs.processShopierJob(app.db, app.db.doc(path)); assert(app.db.records.get(path).completedAt > 0);
});
test('51 max attempts keep the dead job and audit state for operator recovery', async () => {
  await webhook('order.created', { id: 'not-found' }); const [path] = rows('shopierJobs/').find(([, row]) => row.kind === 'order.created'); app.db.records.get(path).attempts = 9;
  await jobs.processShopierJob(app.db, app.db.doc(path)); assert(app.db.records.get(path).failedAt > 0); assert.equal(app.db.records.get(path).availableAt, service.FINAL_TIME);
});
test('52 API rejects insecure base URLs, redirect responses and oversized/malformed payloads', async () => {
  const client = require('../server/core/shopierClient').createShopierClient({ config: config.getShopierConfig(), transport: async () => new Response('{broken', { status: 200, headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(client.getOrder('123'), { code: 'SHOPIER_RESPONSE_INVALID' }); assert.throws(() => client.getOrder('../private'), { code: 'SHOPIER_RESPONSE_INVALID' });
  const createClient = require('../server/core/shopierClient').createShopierClient;
  const redirect = createClient({ config: config.getShopierConfig(), transport: async () => new Response('', { status: 302, headers: { location: 'https://evil.invalid' } }) });
  await assert.rejects(redirect.getOrder('123'), { code: 'SHOPIER_API_ERROR' });
  const oversized = createClient({ config: config.getShopierConfig(), transport: async () => new Response(JSON.stringify({ payload: 'x'.repeat(1_048_577) }), { headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(oversized.getOrder('123'), { code: 'SHOPIER_RESPONSE_INVALID' });
  assert.equal(config.getShopierConfig({ ...process.env, SHOPIER_SUCCESS_URL: 'https://evil.invalid/odeme/sonuc' }).configured, false);
  assert.equal(config.getShopierConfig({ ...process.env, WEQ_PUBLIC_BASE_URL: 'http://insecure.invalid' }).configured, false);
});
test('53 paid record persists when automatic delivery fails and operator sees delivery_pending', async () => {
  const result = await pending(), remote = provider.paid(result.order.shopier.productId); await service.applyShopierOrder(remote);
  const stock = rows('storeInventory/').find(([, row]) => row.status === 'reserved'); stock[1].status = 'revoked';
  await assert.rejects(service.deliverShopierOrder(result.order.id), { code: 'STORE_STOCK_CONFLICT' }); const row = app.db.records.get('storeOrders/' + result.order.id);
  assert.equal(row.paymentState, 'paid'); assert.equal(row.status, 'delivery_pending'); assert.equal(rows('storeDeliveries/').length, 0);
});
test('54 failed durable jobs are visible and can be safely requeued with an audit record', async () => {
  await webhook('order.created', { id: 'not-found' }); const [path] = rows('shopierJobs/').find(([, row]) => row.kind === 'order.created'); app.db.records.get(path).attempts = 9;
  await jobs.processShopierJob(app.db, app.db.doc(path)); const state = await jobs.shopierJobStatus(); assert.equal(state.failed.length, 1);
  await jobs.retryShopierJob(path.split('/')[1], { uid: 'owneruid' }); assert.equal(app.db.records.get(path).attempts, 0); assert.equal(app.db.records.get(path).failedAt, 0);
  assert(rows('audit/').some(([, row]) => row.type === 'shopier.job.retry')); await assert.rejects(jobs.retryShopierJob(path.split('/')[1], { uid: 'owneruid' }), { code: 'SHOPIER_JOB_NOT_FAILED' });
});
test('55 refund signing key is mandatory and must differ from order signing key', async () => {
  assert.equal(config.getShopierConfig({ ...process.env, SHOPIER_REFUND_WEBHOOK_TOKEN: '' }).configured, false);
  assert.equal(config.getShopierConfig({ ...process.env, SHOPIER_REFUND_WEBHOOK_TOKEN: process.env.SHOPIER_WEBHOOK_TOKEN }).configured, false);
});
test('56 failed-job retry endpoint requires admin identity and an action-bound password proof', async () => {
  const denied = await app.request('/api/admin/store/shopier/jobs/unknown/retry', { uid: 'member', method: 'POST', body: {} }); assert.equal(denied.status, 403);
  const admin = adminSession || await app.openAdmin(); const unsigned = await app.request('/api/admin/store/shopier/jobs/unknown/retry', { ...admin, method: 'POST', body: {} }); assert.equal(unsigned.status, 401);
});
test('57 payment creation is rate limited while stable retries never create a second remote listing', async () => {
  await seed(); const input = body(), requestBody = { items: input.items, idempotencyKey: input.idempotencyKey }; const statuses = [];
  for (let attempt = 0; attempt < 42; attempt++) statuses.push((await app.request('/api/payments/shopier/create', { uid: 'member', method: 'POST', body: requestBody })).status);
  assert.equal(statuses[0], 200); assert(statuses.includes(429)); assert.equal(provider.calls.filter((row) => row.method === 'POST').length, 1);
});
