'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { memoryFirestore, mockModule, admin } = require('./helpers/memory-firestore.cjs');
process.env.NODE_ENV = 'development';
process.env.STORE_KEY_ENCRYPTION_SECRET = crypto.randomBytes(48).toString('hex');
process.env.STORE_KEY_FINGERPRINT_SECRET = crypto.randomBytes(48).toString('hex');
let db, changeBeforeTransaction = false;
const product = { id: 'test-license', name: 'Test', platform: 'android', active: true, archived: false,
  automaticEnabled: true, fulfillmentMode: 'automatic', inventoryType: 'license', plans: [{ key: 'daily', label: 'Günlük', priceKurus: 10000, duration: '1 gün' }] };
const catalog = { version: 76, products: [product], storefront: {}, telegramUsername: 'ZENTRA_STORE' };
mockModule('../../server/config/firebaseAdmin', { initFirebaseAdmin: () => ({ db, admin, enabled: true, auth: {} }) });
const { catalogRevision } = require('../server/core/storeCatalogService');
mockModule('../../server/core/storeCatalogService', { catalogRevision, getEffectiveCatalog: async () => {
  const result = { ...structuredClone(catalog), revision: catalogRevision(db.records.get('storefrontSettings/main') || {}) };
  if (changeBeforeTransaction) db.records.set('storefrontSettings/main', { maintenance: true });
  return result;
} });
mockModule('../../server/core/errorLogger', { logError: () => {} });
const inventory = require('../server/core/storeInventoryService');
const vault = require('../server/core/storeKeyVault');
const store = require('../server/core/storeService');
const sku = 'test-license__daily', itemPath = `storeInventory/${sku}/items/key-0001`;
function reset() {
  product.inventoryType = 'license'; product.active = true; product.archived = false; product.plans[0].priceKurus = 10000; changeBeforeTransaction = false;
  db = memoryFirestore(['one', 'two'].map((uid) => [`users/${uid}`, { storeRegistrationSecurity: { admittedAt: Date.now() }, username: uid, email: `${uid}@example.test`, storeBalanceKurus: 20000, storeAccountStatus: 'active', storeProfile: { avatarId: '1' }, storeCreatedAt: 1, storeUpdatedAt: 1 }]));
  const plaintext = 'Exact-KEY-Ｘ-1234', context = { recordType: 'inventory', recordId: 'key-0001', sku, productId: product.id, planKey: 'daily' };
  db.records.set(itemPath, { id: 'key-0001', sku, productId: product.id, planKey: 'daily', status: 'available', inventoryType: 'license',
    fingerprint: vault.fingerprintSecret(plaintext), secret: vault.encryptSecret(plaintext, context), masked: 'Exact…', createdAt: 1 });
  db.records.set(`storeInventorySummary/${sku}`, { availableCount: 1, deliveredCount: 0 });
  inventory.invalidateStockCache(); return plaintext;
}
function purchase(uid = 'one', key = 'safe-stock-order-0001', rawItems = [{ productId: product.id, planKey: 'daily', quantity: 1, totalKurus: 1 }]) {
  return store.createOrder({ uid, authUser: { email: `${uid}@example.test` }, paymentMethod: 'wallet', idempotencyKey: key, rawItems });
}
test('real encrypted stock and wallet checkout commit together; delivery opens only for its owner', async () => {
  const plaintext = reset(), result = await purchase();
  assert.equal(result.balanceKurus, 10000); assert.equal(result.order.totalKurus, 10000);
  assert.equal(db.records.get(itemPath).status, 'delivered'); assert.equal(db.records.get(`storeInventorySummary/${sku}`).availableCount, 0);
  const opened = await inventory.readDeliverySecrets({ uid: 'one', orderId: result.order.id });
  assert.equal(opened.items[0].key, plaintext);
  await assert.rejects(inventory.readDeliverySecrets({ uid: 'two', orderId: result.order.id }), { code: 'STORE_ORDER_ACCESS_DENIED' });
  assert(!JSON.stringify(result).includes(plaintext));
  const replay = await purchase(); assert.equal(replay.order.id, result.order.id); assert.equal(replay.balanceKurus, 10000);
});
test('corrupt ciphertext is rejected before debit, stock assignment, order or ledger writes', async () => {
  reset(); db.records.get(itemPath).secret = { ...db.records.get(itemPath).secret, tag: Buffer.alloc(16).toString('base64url') };
  const before = structuredClone(db.records);
  await assert.rejects(purchase(), { code: 'STORE_KEY_DECRYPTION_FAILED' });
  assert.deepEqual(db.records, before);
});
test('wrong ciphertext context, plan and stock summary fail before financial writes', async () => {
  for (const change of [() => { db.records.get(itemPath).secret = vault.encryptSecret('DIFFERENT-KEY', { recordType: 'inventory', recordId: 'other', sku, productId: product.id, planKey: 'daily' }); },
    () => { db.records.get(itemPath).planKey = 'weekly'; }, () => { db.records.get(`storeInventorySummary/${sku}`).availableCount = 0; }]) {
    reset(); change(); const before = structuredClone(db.records); await assert.rejects(purchase()); assert.deepEqual(db.records, before);
  }
});
test('the last key cannot be sold twice across parallel buyers and only the successful buyer is charged', async () => {
  reset(); const results = await Promise.allSettled(['one', 'two'].map((uid) => purchase(uid, `last-stock-${uid}-0001`)));
  assert.equal(results.filter((row) => row.status === 'fulfilled').length, 1);
  assert.equal(results.find((row) => row.status === 'rejected').reason.code, 'STORE_OUT_OF_STOCK');
  assert.equal([...db.records.keys()].filter((path) => path.startsWith('storeWalletLedger/')).length, 1);
  assert.equal(['one', 'two'].map((uid) => db.records.get(`users/${uid}`).storeBalanceKurus).sort().join(','), '10000,20000');
});
test('a failed commit preserves key, balance and ledger and the same attempt can recover', async () => {
  reset(); const before = structuredClone(db.records); db.setFailure(true);
  await assert.rejects(purchase(), { code: 'CONTROLLED_COMMIT_FAILURE' }); assert.deepEqual(db.records, before);
  db.setFailure(false); const result = await purchase(); assert.equal(result.balanceKurus, 10000);
  assert.equal((await store.readOrderAttempt({ uid: 'one', idempotencyKey: 'safe-stock-order-0001' })).order.id, result.order.id);
});
test('invalid financial record, plan price or quantity cannot silently become a valid purchase', async () => {
  for (const value of [NaN, -1, true, {}, 1.2, Number.MAX_SAFE_INTEGER]) {
    reset(); db.records.get('users/one').storeBalanceKurus = value; const before = structuredClone(db.records);
    await assert.rejects(purchase(), { code: 'STORE_BALANCE_RECORD_INVALID' }); assert.deepEqual(db.records, before);
  }
  for (const value of [true, '1', {}, 0, 6]) { reset(); await assert.rejects(purchase('one', 'quantity-test-0001', [{ productId: product.id, planKey: 'daily', quantity: value }])); }
  for (const price of [NaN, -1, '100', Infinity, 1.5]) { reset(); product.plans[0].priceKurus = price; await assert.rejects(purchase(), { code: 'STORE_ORDER_TOTAL_INVALID' }); }
});
test('legacy wallet balances and missing stock type remain readable without data replacement', async () => {
  reset(); const user = db.records.get('users/one'); delete user.storeBalanceKurus; user.storeWallet = { balanceKurus: '20000' };
  delete db.records.get(itemPath).inventoryType;
  assert.equal((await purchase()).balanceKurus, 10000);
});
test('account passwords preserve exact Unicode and boundary whitespace through encryption and delivery decoding', () => {
  reset(); const password = ' Ａé-𝒜-Password ', username = 'AccountUser';
  const encoded = inventory.normalizeImportKeys([{ username, password }], 'account')[0].value;
  const context = { recordType: 'inventory', recordId: 'exact-account', productId: product.id, planKey: 'daily', sku };
  const opened = inventory.decodeInventorySecret({ inventoryType: 'account', secret: vault.encryptSecret(encoded, context) }, context);
  assert.equal(opened.account.password, password); assert.equal(opened.account.username, username);
  assert.equal(vault.fingerprintSecret('KEY-ＡBCD'), vault.fingerprintSecret('KEY-ABCD'), 'historical duplicate registry remains compatible');
  assert.equal(vault.decryptSecret(vault.encryptSecret('KEY-ＡBCD', context), context), 'KEY-ＡBCD');
});
test('parallel imports with different identities cannot add the same key twice', async () => {
  reset(); const input = { productId: product.id, planKey: 'daily', keys: ['PARALLEL-EXACT-KEY-0001'], actor: { uid: 'admin-one' } };
  const results = await Promise.allSettled(['first-import-0001', 'second-import-0001'].map((idempotencyKey) => inventory.importInventory({ ...input, idempotencyKey })));
  assert.equal(results.filter((row) => row.status === 'fulfilled').length, 1);
  assert.equal(results.find((row) => row.status === 'rejected').reason.code, 'STORE_INVENTORY_DUPLICATE_KEY');
  assert.equal(db.records.get(`storeInventorySummary/${sku}`).availableCount, 2);
});
test('parallel and lost-response import replay reuse the receipt without duplicate stock or audit entries', async () => {
  reset(); const input = { productId: product.id, planKey: 'daily', keys: ['REPLAY-EXACT-KEY-0001'], actor: { uid: 'admin-one' }, idempotencyKey: 'stable-import-0001' };
  const results = await Promise.all([inventory.importInventory(input), inventory.importInventory(input)]);
  assert.equal(results.filter((row) => !row.idempotentReplay).length, 1);
  const before = structuredClone(db.records); assert.equal((await inventory.importInventory(input)).idempotentReplay, true); assert.deepEqual(db.records, before);
});
test('a changed expected price is rejected without charging and is never accepted as the authoritative price', async () => {
  reset(); const before = structuredClone(db.records);
  for (const expectedUnitPriceKurus of [1, 9000, 20000]) {
    await assert.rejects(purchase('one', 'price-check-00001', [{ productId: product.id, planKey: 'daily', quantity: 1, expectedUnitPriceKurus }]), { code: 'STORE_PRICE_CHANGED' });
    assert.deepEqual(db.records, before);
  }
  assert.equal((await purchase('one', 'price-check-00001', [{ productId: product.id, planKey: 'daily', quantity: 1, expectedUnitPriceKurus: 10000 }])).order.totalKurus, 10000);
});
test('a catalog change between preflight and transaction is fenced before stock and financial writes', async () => {
  reset(); changeBeforeTransaction = true;
  await assert.rejects(purchase(), { code: 'STORE_CATALOG_CHANGED' });
  assert.equal(db.records.get('users/one').storeBalanceKurus, 20000); assert.equal(db.records.get(itemPath).status, 'available');
  assert.equal([...db.records.keys()].filter((path) => path.startsWith('storeOrders/') || path.startsWith('storeWalletLedger/')).length, 0);
});
test('an already committed request replays even after its price, active state or availability changes', async () => {
  reset(); const lines = [{ productId: product.id, planKey: 'daily', quantity: 1, expectedUnitPriceKurus: 10000 }];
  const created = await purchase('one', 'completed-price-0001', lines), writes = db.stats.writes;
  product.plans[0].priceKurus = 20000; product.active = false; product.archived = true;
  const replay = await purchase('one', 'completed-price-0001', lines); assert.equal(replay.order.id, created.order.id); assert.equal(replay.order.totalKurus, 10000); assert.equal(db.stats.writes, writes);
  await assert.rejects(purchase('one', 'completed-price-0001', [{ ...lines[0], expectedUnitPriceKurus: 20000 }]), { code: 'STORE_ORDER_CONFLICT' });
});
