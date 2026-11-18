'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const crypto = require('node:crypto');
process.env.NODE_ENV = 'development';
let docs = new Map();
let race = false;
let writes = [];
let catalog = { version: 1, telegramUsername: 'ZENTRA_STORE', storefront: {}, products: [{
  id: 'test-product', name: 'Test', platform: 'android', active: true, archived: false,
  automaticEnabled: true, fulfillmentMode: 'automatic', plans: [{ key: 'm', label: 'Month', duration: '30 days', priceKurus: 10000 }]
}] };
function ref(collection, id = crypto.randomUUID()) {
  const key = `${collection}/${id}`;
  return { id, path: key, async get() {
    const row = docs.has(key) ? structuredClone(docs.get(key)) : null;
    if (race && collection === 'users') {
      race = false;
      docs.set(key, { ...docs.get(key), storeBalanceKurus: 0, username: 'CurrentName' });
    }
    return { id, exists: row !== null, data: () => row };
  } };
}
const db = {
  collection: (name) => ({ doc: (id) => ref(name, id) }),
  async runTransaction(callback) {
    const staged = [];
    const tx = { get: (target) => target.get(),
      set: (target, data) => staged.push({ target, data, merge: true }),
      create: (target, data) => staged.push({ target, data }) };
    const result = await callback(tx);
    for (const { target, data, merge } of staged) {
      assert.ok(merge || !docs.has(target.path), 'transaction create must not overwrite');
      const before = docs.get(target.path) || {};
      const value = { ...(merge ? before : {}), ...data };
      for (const [key, entry] of Object.entries(value)) if (entry?.increment !== undefined) value[key] = Number(before[key] || 0) + entry.increment;
      docs.set(target.path, value);
      writes.push({ path: target.path, data });
    }
    return result;
  }
};
function mock(name, exports) { const filename = require.resolve(name); require.cache[filename] = { id: filename, filename, loaded: true, exports }; }
mock('../server/config/firebaseAdmin', { initFirebaseAdmin: () => ({ enabled: true, db, auth: {}, admin: { firestore: { FieldValue: { increment: (n) => ({ increment: n }) } } } }) });
mock('../server/core/storeCatalogService', { getEffectiveCatalog: async () => structuredClone(catalog) });
mock('../server/core/storeInventoryService', { allocateInventoryInTransaction: async () => [{ id: 'delivered-item' }], invalidateStockCache() {}, decorateCatalogWithStock: async (value) => value });
const service = require('../server/core/storeService');
function reset(balance = 20000) {
  docs = new Map([['users/user-1', { email: 'old@example.test', username: 'OriginalName', storeBalanceKurus: balance, storeProfile: { avatarId: '1' }, storeAccountStatus: 'active' }]]);
  writes = []; catalog.products[0].archived = false; catalog.products[0].automaticEnabled = true;
}
const order = { uid: 'user-1', authUser: { uid: 'user-1', email: 'new@example.test' }, paymentMethod: 'wallet', idempotencyKey: 'financial-test-key-1',
  rawItems: [{ productId: 'test-product', planKey: 'm', quantity: 1, unitPriceKurus: 1, totalKurus: 1, balanceKurus: 99999999 }] };

test('account email synchronization cannot overwrite a concurrent purchase balance or profile name', async () => {
  reset(); race = true;
  const account = await service.readAccount('user-1', { email: 'new@example.test', storeBalanceKurus: 9999999 });
  assert.equal(account.balanceKurus, 0);
  assert.equal(docs.get('users/user-1').storeBalanceKurus, 0);
  assert.equal(docs.get('users/user-1').username, 'CurrentName');
  assert.equal(docs.get('users/user-1').email, 'new@example.test');
  assert.ok(writes.every((write) => !Object.hasOwn(write.data, 'storeBalanceKurus')));
});

test('checkout ignores client prices and balance, debits authoritative funds once, and replays idempotently', async () => {
  reset();
  const result = await service.createOrder(order);
  assert.equal(result.order.totalKurus, 10000);
  assert.equal(result.balanceKurus, 10000);
  const replay = await service.createOrder(order);
  assert.equal(replay.order.id, result.order.id);
  assert.equal(docs.get('users/user-1').storeBalanceKurus, 10000);
  assert.equal([...docs.keys()].filter((key) => key.startsWith('storeWalletLedger/')).length, 1);
  await assert.rejects(service.createOrder({ ...order, rawItems: [{ ...order.rawItems[0], quantity: 2 }] }), (error) => error.code === 'STORE_ORDER_CONFLICT');
});

test('insufficient balance, archived products and disabled automatic sales cannot create financial writes', async () => {
  reset(0);
  await assert.rejects(service.createOrder(order), (error) => error.code === 'STORE_INSUFFICIENT_BALANCE');
  assert.equal([...docs.keys()].filter((key) => key.startsWith('storeOrders/')).length, 0);
  reset(); catalog.products[0].archived = true;
  await assert.rejects(service.createOrder(order), (error) => error.code === 'STORE_ITEM_UNAVAILABLE');
  reset(); catalog.products[0].automaticEnabled = false;
  await assert.rejects(service.createOrder(order), (error) => error.code === 'STORE_AUTOMATIC_PRODUCT_DISABLED');
  assert.equal(docs.get('users/user-1').storeBalanceKurus, 20000);
});

test('public catalog serializes saved features and category membership without losing values', async () => {
  reset();
  catalog.products[0].features = ['ESP', 'Aimbot'];
  catalog.products[0].categoryKey = 'pubg-android';
  const result = await service.publicCatalog();
  assert.deepEqual(result.products[0].features, ['ESP', 'Aimbot']);
  assert.equal(result.products[0].categoryKey, 'pubg-android');
});

test('lost order response can be recovered without another write, even after catalog changes', async () => {
  reset();
  const created = await service.createOrder(order);
  const before = writes.length;
  catalog.products[0].archived = true;
  const recovered = await service.readOrderAttempt({ uid: order.uid, idempotencyKey: order.idempotencyKey });
  assert.equal(recovered.found, true);
  assert.equal(recovered.order.id, created.order.id);
  assert.equal(recovered.balanceKurus, 10000);
  assert.equal(writes.length, before);
  const otherUser = await service.readOrderAttempt({ uid: 'another-user', idempotencyKey: order.idempotencyKey });
  assert.deepEqual(otherUser, { found: false });
});

test('cancelling an uncommitted attempt blocks late purchases and leaves funds untouched', async () => {
  reset();
  const cancelled = await service.cancelOrderAttempt({ uid: order.uid, idempotencyKey: order.idempotencyKey });
  assert.equal(cancelled.cancelled, true);
  assert.equal(docs.get('users/user-1').storeBalanceKurus, 20000);
  await assert.rejects(service.createOrder(order), (error) => error.code === 'STORE_ORDER_ATTEMPT_CANCELLED');
  const status = await service.readOrderAttempt({ uid: order.uid, idempotencyKey: order.idempotencyKey });
  assert.deepEqual(status, { found: false, cancelled: true });
  assert.equal([...docs.keys()].filter((key) => key.startsWith('storeWalletLedger/')).length, 0);
  assert.equal([...docs.keys()].filter((key) => key.startsWith('storeOrders/')).length, 0);
});

test('attempt cancellation returns an already committed order rather than cancelling or charging it again', async () => {
  reset();
  const created = await service.createOrder(order);
  const before = writes.length;
  const result = await service.cancelOrderAttempt({ uid: order.uid, idempotencyKey: order.idempotencyKey });
  assert.equal(result.cancelled, false);
  assert.equal(result.order.id, created.order.id);
  assert.equal(writes.length, before);
  assert.equal(docs.get('users/user-1').storeBalanceKurus, 10000);
});
