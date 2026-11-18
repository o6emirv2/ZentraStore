'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { applicationFixture } = require('./helpers/application-fixture.cjs');
let app, session, catalog, service;
const ids = ['gbox-iphone', 'gbox-ipad'];
const line = (productId, quantity = 1) => ({ productId, planKey: 'yearly', quantity, expectedUnitPriceKurus: 75000 });
const orderCount = () => [...app.db.records.keys()].filter(key => /^storeOrders\/[^/]+$/.test(key)).length;
const orderBody = items => ({ items, paymentMethod: 'telegram', idempotencyKey: crypto.randomUUID() });
before(async () => {
  app = await applicationFixture(); session = await app.openAdmin();
  service = require('../server/core/storeCatalogService');
  catalog = await service.getEffectiveCatalog({ fresh: true });
});
after(async () => app?.close());

test('two stable GBOX device identities have exactly one annual 750 TL plan', () => {
  const products = catalog.products.filter(product => ids.includes(product.id));
  assert.equal(products.length, 2);
  for (const [index, product] of ids.map(id => products.find(row => row.id === id)).entries()) {
    assert.equal(product.name, `GBOX · ${index ? 'iPad' : 'iPhone'}`);
    assert.equal(product.platform, 'ios'); assert.equal(product.game, 'gbox'); assert.equal(product.categoryKey, 'gbox-ios');
    assert.deepEqual(product.plans.map(({ key, label, duration, priceKurus }) => ({ key, label, duration, priceKurus })),
      [{ key: 'yearly', label: 'Yıllık', duration: '12 ay', priceKurus: 75000 }]);
    assert.equal(product.automaticEnabled, false); assert.equal(product.telegramEnabled, true);
    assert.equal(product.fulfillmentMode, 'telegram_only');
  }
});
test('catalog upgrade persists annual plan defaults and keeps other existing prices', async () => {
  const stored = app.db.records.get('storefrontSettings/main');
  const oldId = catalog.products.find(product => !ids.includes(product.id)).id;
  const plan = catalog.products.find(product => product.id === oldId).plans[0];
  stored.catalog.products[oldId].plans[plan.key].priceKurus = 77777;
  for (const id of ids) delete stored.catalog.products[id];
  stored.catalog.sourceVersion = 1; service.invalidateCatalogCache();
  const updated = await service.getEffectiveCatalog({ fresh: true });
  for (const id of ids) assert.equal(app.db.records.get('storefrontSettings/main').catalog.products[id].plans.yearly.priceKurus, 75000);
  assert.equal(updated.products.find(product => product.id === oldId).plans[0].priceKurus, 77777);
  assert.equal(updated.products.filter(product => ids.includes(product.id)).length, 2);
});
test('authoritative cart computes each device and combined quantity totals in integer kurus', () => {
  const { normalizeCart } = require('../server/core/storeService');
  for (const id of ids) assert.equal(normalizeCart([line(id)], catalog).totalKurus, 75000);
  const combined = normalizeCart(ids.map(id => line(id)), catalog);
  assert.equal(combined.totalKurus, 150000);
  assert.deepEqual(combined.items.map(item => item.productName), ['GBOX · iPhone', 'GBOX · iPad']);
  assert.equal(normalizeCart([line(ids[0], 2), line(ids[1])], catalog).totalKurus, 225000);
});
test('HTTP catalog and protected admin product list use the same device prices', async () => {
  const publicResult = await app.request('/api/store/catalog');
  const adminResult = await app.request('/api/admin/store/catalog', session);
  assert.equal(publicResult.status, 200); assert.equal(adminResult.status, 200);
  for (const id of ids) {
    assert.equal(publicResult.body.catalog.products.find(product => product.id === id).plans[0].priceKurus, 75000);
    assert.equal(adminResult.body.catalog.products.find(product => product.id === id).plans[0].priceKurus, 75000);
  }
});
test('a forged expected price is rejected without an order, balance debit or delivery', async () => {
  const before = orderCount(), balance = app.db.records.get('users/member').storeBalanceKurus;
  const result = await app.request('/api/store/orders', { uid: 'member', method: 'POST', body: orderBody([{ ...line(ids[0]), expectedUnitPriceKurus: 1 }]) });
  assert.equal(result.status, 409); assert.equal(result.body.error, 'STORE_PRICE_CHANGED');
  assert.equal(orderCount(), before); assert.equal(app.db.records.get('users/member').storeBalanceKurus, balance);
});
test('unrecognized client price fields are rejected at the HTTP schema boundary', async () => {
  const before = orderCount();
  const result = await app.request('/api/store/orders', { uid: 'member', method: 'POST', body: orderBody([{ ...line(ids[1]), priceKurus: 1 }]) });
  assert.equal(result.status, 400); assert.equal(result.body.error, 'API_BODY_INVALID'); assert.equal(orderCount(), before);
});
test('a combined Telegram order persists the correct devices and cannot claim delivery or debit balance', async () => {
  const before = orderCount(), balance = app.db.records.get('users/member').storeBalanceKurus;
  const body = orderBody(ids.map(id => line(id)));
  const first = await app.request('/api/store/orders', { uid: 'member', method: 'POST', body });
  assert.equal(first.status, 201); assert.equal(first.body.order.totalKurus, 150000);
  const order = app.db.records.get('storeOrders/' + first.body.order.id);
  assert.equal(order.status, 'awaiting_payment'); assert.equal(first.body.order.deliveryVisible, false);
  assert.deepEqual(order.items.map(item => item.productName), ['GBOX · iPhone', 'GBOX · iPad']);
  assert.equal(app.db.records.get('users/member').storeBalanceKurus, balance);
  assert(![...app.db.records.keys()].some(key => key.startsWith(`storeDeliveries/${order.id}/`)));
  const replay = await app.request('/api/store/orders', { uid: 'member', method: 'POST', body });
  assert([200, 201].includes(replay.status)); assert.equal(replay.body.order.id, first.body.order.id); assert.equal(orderCount(), before + 1);
  const history = await app.request('/api/store/orders', { uid: 'member' });
  assert.equal(history.status, 200); assert.equal(history.body.orders.find(row => row.id === order.id).items[1].productName, 'GBOX · iPad');
});
test('automatic wallet delivery is unavailable for products with no supplied licenses', async () => {
  const before = orderCount();
  const result = await app.request('/api/store/orders', { uid: 'member', method: 'POST', body: { ...orderBody([line(ids[0])]), paymentMethod: 'wallet' } });
  assert.equal(result.status, 409); assert.equal(result.body.error, 'STORE_TELEGRAM_ONLY_PRODUCT'); assert.equal(orderCount(), before);
});
test('unsupported monthly plan and fractional quantities cannot create device orders', async () => {
  const { createOrder } = require('../server/core/storeService');
  for (const item of [{ ...line(ids[0]), planKey: 'monthly' }, line(ids[1], 1.5)]) {
    await assert.rejects(createOrder({ uid: 'member', authUser: app.users.get('member'), rawItems: [item], paymentMethod: 'telegram', idempotencyKey: crypto.randomUUID() }));
  }
});
test('customer and unauthenticated price changes fail without changing persisted annual prices', async () => {
  for (const uid of [undefined, 'member']) {
    const result = await app.request('/api/admin/store/products/gbox-iphone', { uid, method: 'PATCH', body: { plans: { yearly: { priceKurus: 1 } } } });
    assert([401, 403].includes(result.status));
  }
  assert.equal(app.db.records.get('storefrontSettings/main').catalog.products['gbox-iphone'].plans.yearly.priceKurus, 75000);
});
test('a proven administrator can save and reload a price; stale customer prices fail', async () => {
  const route = '/api/admin/store/products/gbox-ipad';
  const save = await app.adminWrite(session, route, 'PATCH', { plans: { yearly: { priceKurus: 76000 } } });
  assert.equal(save.status, 200);
  const updated = await service.getEffectiveCatalog({ fresh: true });
  assert.equal(updated.products.find(product => product.id === ids[1]).plans[0].priceKurus, 76000);
  const result = await app.request('/api/store/orders', { uid: 'member', method: 'POST', body: orderBody([line(ids[1])]) });
  assert.equal(result.status, 409); assert.equal(result.body.error, 'STORE_PRICE_CHANGED');
  assert.equal((await app.adminWrite(session, route, 'PATCH', { plans: { yearly: { priceKurus: 75000 } } })).status, 200);
  assert.equal(app.db.records.get('storefrontSettings/main').catalog.products[ids[1]].plans.yearly.priceKurus, 75000);
});
test('a database commit failure cannot leave a partial device order or report success', async () => {
  const before = orderCount(); app.db.setFailure(true);
  try {
    const result = await app.request('/api/store/orders', { uid: 'member', method: 'POST', body: orderBody([line(ids[0])]) });
    assert(result.status >= 500); assert.equal(orderCount(), before);
  } finally { app.db.setFailure(false); }
});
test('both products use the supplied unchanged image and the real server serves it', async () => {
  const images = ids.map(id => catalog.products.find(product => product.id === id).image);
  assert.equal(new Set(images).size, 1);
  const bytes = fs.readFileSync(path.join(__dirname, '..', images[0]));
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), 'bf93971bfc15462ab5677dce3e9c874af5e9c52473cc122064821ba73fdfdb76');
  const response = await fetch(app.origin + images[0]);
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /image\/webp/);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
});
