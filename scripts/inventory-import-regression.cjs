'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const crypto = require('node:crypto');
process.env.NODE_ENV = 'development';
process.env.STORE_KEY_ENCRYPTION_SECRET = crypto.randomBytes(48).toString('hex');
process.env.STORE_KEY_FINGERPRINT_SECRET = crypto.randomBytes(48).toString('hex');
let records = new Map(), failSummary = false, failCommit = false, consumedBeforeSummary = false;
const logs = [];
function snapshot(target) {
  return { id: target.id, exists: records.has(target.path), data: () => structuredClone(records.get(target.path)) };
}
function reference(path) {
  return { path, id: path.split('/').at(-1), get: async () => snapshot(reference(path)), collection: (name) => collection(`${path}/${name}`) };
}
function collection(path) {
  const query = { doc: (id = crypto.randomUUID()) => reference(`${path}/${id}`), where: () => query, orderBy: () => query, limit: () => query,
    get: async () => ({ docs: [], size: 0 }) };
  return query;
}
const db = { collection, getAll: async (...refs) => {
  if (failSummary && refs.some((ref) => ref.path.startsWith('storeInventorySummary/'))) throw new Error('summary unavailable');
  if (consumedBeforeSummary) for (const ref of refs) {
    if (ref.path.startsWith('storeInventorySummary/') && records.has(ref.path)) records.set(ref.path, { ...records.get(ref.path), availableCount: 0, deliveredCount: 1 });
  }
  return refs.map(snapshot);
}, runTransaction: async (callback) => {
  const staged = []; let writing = false;
  const read = (ref) => { assert.equal(writing, false, 'transaction reads must precede writes'); return snapshot(ref); };
  const tx = { get: async (ref) => read(ref), getAll: async (...refs) => refs.map(read),
    create: (ref, row) => { writing = true; staged.push({ ref, row, create: true }); },
    set: (ref, row) => { writing = true; staged.push({ ref, row }); } };
  const result = await callback(tx);
  if (failCommit) throw Object.assign(new Error('commit unavailable'), { code: 'STORE_STORAGE_UNAVAILABLE' });
  for (const { ref, create } of staged) if (create) assert.equal(records.has(ref.path), false, 'create must not overwrite an existing record');
  for (const { ref, row, create } of staged) records.set(ref.path, { ...(!create ? records.get(ref.path) : {}), ...structuredClone(row) });
  return result;
} };
function mock(name, exports) { const filename = require.resolve(name); require.cache[filename] = { id: filename, filename, loaded: true, exports }; }
const product = { id: 'new-product', name: 'Yeni ürün', platform: 'android', inventoryType: 'license', automaticEnabled: true, fulfillmentMode: 'automatic', plans: [{ key: 'daily', label: 'Günlük' }] };
mock('../server/config/firebaseAdmin', { initFirebaseAdmin: () => ({ enabled: true, db, admin: { firestore: { FieldPath: { documentId: () => '__name__' } } } }) });
mock('../server/core/storeCatalogService', { getEffectiveCatalog: async () => ({ products: [product] }) });
mock('../server/core/errorLogger', { logError: (error, context) => logs.push(context) });
// Force document reads so the test can distinguish a failed post-commit summary.
const originalCollection = db.collection;
db.collection = (path) => { const value = originalCollection(path); if (path === 'storeInventorySummary') delete value.where; return value; };
const inventory = require('../server/core/storeInventoryService');
const vault = require('../server/core/storeKeyVault');
const input = { productId: product.id, planKey: 'daily', keys: ['QA-STOCK-LICENSE-0001'], actor: { uid: 'admin-1', email: 'admin@example.test' }, idempotencyKey: 'inventory-regression-0001' };
function reset() { records = new Map(); failSummary = false; failCommit = false; consumedBeforeSummary = false; logs.length = 0; inventory.invalidateStockCache(); }

test('new product stock imports atomically as encrypted records and replays without duplicates', async () => {
  reset();
  assert.equal((await inventory.inspectInventoryImport(input)).duplicateCount, 0);
  const first = await inventory.importInventory(input);
  assert.equal(first.imported, 1); assert.equal(first.available, 1); assert.equal(first.idempotentReplay, false);
  const item = [...records.entries()].find(([path]) => /^storeInventory\/.*\/items\//.test(path))[1];
  assert.equal(typeof item.secret, 'object'); assert(!JSON.stringify(item).includes(input.keys[0]));
  assert.equal(vault.decryptSecret(item.secret, { ...item, recordType: 'inventory' }), input.keys[0]);
  const before = records.size;
  const replay = await inventory.importInventory(input);
  assert.equal(replay.idempotentReplay, true); assert.equal(records.size, before);
  assert.equal((await inventory.inspectInventoryImport(input)).duplicateCount, 1);
  await assert.rejects(inventory.importInventory({ ...input, idempotencyKey: 'different-request-0001' }), { code: 'STORE_INVENTORY_DUPLICATE_KEY' });
  await assert.rejects(inventory.importInventory({ ...input, keys: ['QA-DIFFERENT-KEY-0001'] }), { code: 'STORE_INVENTORY_IMPORT_CONFLICT' });
  assert.equal(records.size, before);
});

test('a failed summary after commit does not report an already saved import as failed', async () => {
  reset(); failSummary = true;
  const result = await inventory.importInventory(input);
  assert.equal(result.available, 1); assert.equal(result.idempotentReplay, false);
  assert(logs.some((log) => log.code === 'STOCK_IMPORT_SUMMARY_FAILED'));
  assert.equal(records.get('storeInventorySummary/new-product__daily').availableCount, 1);
  assert.equal((await inventory.importInventory(input)).idempotentReplay, true);
});

test('failed commits preserve all records and allow the same request to succeed later', async () => {
  reset(); failCommit = true;
  await assert.rejects(inventory.importInventory(input), { code: 'STORE_STORAGE_UNAVAILABLE' });
  assert.equal(records.size, 0);
  failCommit = false;
  assert.equal((await inventory.importInventory(input)).available, 1);
});

test('a current zero stock count is preserved after concurrent consumption', async () => {
  reset(); consumedBeforeSummary = true;
  const result = await inventory.importInventory(input);
  assert.equal(result.imported, 1); assert.equal(result.available, 0); assert.equal(result.notificationsQueued, 0);
});

test('invalid, duplicate and manual-only stock requests never write', async () => {
  reset();
  for (const [patch, code] of [[{ keys: [] }, 'STORE_INVENTORY_IMPORT_INVALID'], [{ keys: ['a'] }, 'STORE_INVENTORY_KEY_INVALID'], [{ keys: [input.keys[0], input.keys[0]] }, 'STORE_INVENTORY_DUPLICATE_KEY']]) {
    await assert.rejects(inventory.importInventory({ ...input, ...patch }), { code });
    assert.equal(records.size, 0);
  }
  product.fulfillmentMode = 'telegram_only';
  await assert.rejects(inventory.importInventory(input), { code: 'STORE_AUTOMATIC_INVENTORY_DISABLED' });
  assert.equal(records.size, 0); product.fulfillmentMode = 'automatic';
});
