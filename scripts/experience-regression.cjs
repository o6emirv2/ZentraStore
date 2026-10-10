'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const load = (file) => import('data:text/javascript;base64,' + fs.readFileSync(path.join(__dirname, '../public/js/', file)).toString('base64'));
const storage = () => {
  const map = new Map();
  return { getItem: (key) => map.get(key) || null, setItem: (key, value) => map.set(key, value), removeItem: (key) => map.delete(key), entries: () => [...map.values()] };
};
const body = { paymentMethod: 'wallet', idempotencyKey: 'stable-purchase-request-123', items: [{ productId: 'demo-product', planKey: 'm', quantity: 1, priceKurus: 1 }] };

test('pending purchase restoration preserves its identity and never resubmits a financial write automatically', async () => {
  const { createPurchaseTracker } = await load('store/purchase-tracker.js');
  const local = storage();
  const calls = [];
  const api = async (url, options) => { calls.push({ url, options }); return { found: true, order: { id: 'confirmed' } }; };
  const first = createPurchaseTracker({ api, storage: local, userId: () => 'user-a' });
  first.start(body, { clearCart: true });
  const second = createPurchaseTracker({ api, storage: local, userId: () => 'user-a' });
  const restored = second.pending();
  assert.equal(restored.body.idempotencyKey, body.idempotencyKey);
  assert.equal(Object.hasOwn(restored.body.items[0], 'priceKurus'), false);
  const result = await second.verify();
  assert.equal(result.order.id, 'confirmed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, undefined);
  assert.ok(calls[0].url.startsWith('/api/store/order-attempt?'));
  second.finish(restored);
  assert.equal(second.pending(), null);
  assert.equal(local.entries().length, 0);
});

test('pending intent is hidden from another signed-in user and is cleared on logout', async () => {
  const { createPurchaseTracker } = await load('store/purchase-tracker.js');
  let uid = 'user-a';
  const local = storage();
  const tracker = createPurchaseTracker({ api: async () => { throw new Error('must not read another account'); }, storage: local, userId: () => uid });
  tracker.start(body);
  uid = 'user-b';
  assert.equal(tracker.pending(), null);
  assert.equal(await tracker.verify(), null);
  tracker.clear();
  uid = 'user-a';
  assert.equal(tracker.pending(), null);
});

test('a late purchase status response cannot enter a different user session', async () => {
  const { createPurchaseTracker } = await load('store/purchase-tracker.js');
  let uid = 'user-a', resolve;
  const tracker = createPurchaseTracker({ storage: storage(), userId: () => uid, api: () => new Promise((done) => { resolve = done; }) });
  tracker.start(body);
  const pending = tracker.verify();
  uid = 'user-b';
  resolve({ found: true, order: { id: 'private-order' } });
  assert.equal(await pending, null);
});

test('blocked browser storage still permits in-memory purchase tracking', async () => {
  const { createPurchaseTracker } = await load('store/purchase-tracker.js');
  const tracker = createPurchaseTracker({ userId: () => 'user-a', storage: {
    getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); }
  }, api: async () => ({ found: true, order: { id: 'confirmed' } }) });
  const attempt = tracker.start(body);
  assert.equal(tracker.pending().body.idempotencyKey, body.idempotencyKey);
  assert.equal((await tracker.verify()).order.id, 'confirmed');
  tracker.finish(attempt);
  assert.equal(tracker.pending(), null);
});

test('external abort and request timeout remain distinct and listeners are cleaned up', async () => {
  const { requestController, waitForSignal } = await load('request-utils.js');
  const external = new AbortController();
  const request = requestController(1000, external.signal);
  const waiting = waitForSignal(new Promise(() => {}), request.controller.signal);
  external.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
  assert.equal(request.timedOut, false);
  request.cleanup();
  const timeout = requestController(5);
  await assert.rejects(waitForSignal(new Promise(() => {}), timeout.controller.signal), { name: 'AbortError' });
  assert.equal(timeout.timedOut, true);
  timeout.cleanup();
});

test('store writes bind the initial identity and do not fall back to another account cookie', async () => {
  const utils = 'data:text/javascript;base64,' + fs.readFileSync(path.join(__dirname, '../public/js/request-utils.js')).toString('base64');
  const source = fs.readFileSync(path.join(__dirname, '../public/js/store/api.js'), 'utf8').replace("'../request-utils.js?v=zentra-ui-v70'", JSON.stringify(utils));
  const previous = { window: global.window, document: global.document, fetch: global.fetch };
  let fetches = 0;
  global.window = { location: { href: 'https://store.test/', origin: 'https://store.test' }, __ZENTRA_RUNTIME__: { apiBase: 'https://store.test' } };
  global.document = { querySelector: () => null };
  global.fetch = async (_url, options) => { fetches++; assert.equal(options.headers.get('Authorization'), 'Bearer initial-user'); return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } }); };
  try {
    const api = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
    api.setStoreTokenProvider(async () => 'initial-user');
    await api.storeApi('/api/store/orders', { method: 'POST', body: {} });
    assert.equal(fetches, 1);
    let release;
    api.setStoreTokenProvider(() => new Promise((resolve) => { release = resolve; }));
    const pending = api.storeApi('/api/store/orders', { method: 'POST', body: {} });
    await Promise.resolve(); await Promise.resolve();
    api.setStoreTokenProvider(async () => 'different-user');
    release('initial-user');
    await assert.rejects(pending, { code: 'AUTH_SESSION_CHANGED' });
    assert.equal(fetches, 1);
    api.setStoreTokenProvider(async () => { throw new Error('token unavailable'); });
    await assert.rejects(api.storeApi('/api/store/orders', { method: 'POST', body: {} }), { code: 'AUTH_FRESH_TOKEN_REQUIRED' });
    assert.equal(fetches, 1);
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete global[key]; else global[key] = value; }
  }
});


test('admin product filtering distinguishes archived and inactive records without changing them', async () => {
  const { matchesAdminProduct, sortRecords } = await load('ui/list-controls.js');
  const rows = [{ id: 'ios-gbox-1', name: 'GBox', platform: 'ios', active: true }, { id: 'demo', name: 'Türkçe Ürün', game: 'pubg', platform: 'android', active: false }, { id: 'old', name: 'Arşiv', game: 'oxide', platform: 'ios', archived: true }];
  const before = structuredClone(rows);
  assert.deepEqual(rows.filter((row) => matchesAdminProduct(row, { category: 'gbox' })), [rows[0]]);
  assert.deepEqual(rows.filter((row) => matchesAdminProduct(row, { query: 'TÜRKÇE', status: 'inactive' })), [rows[1]]);
  assert.deepEqual(rows.filter((row) => matchesAdminProduct(row, { status: 'archived' })), [rows[2]]);
  assert.equal(rows.filter((row) => matchesAdminProduct(row, { query: 'olmayan' })).length, 0);
  sortRecords(rows, 'name');
  assert.deepEqual(rows, before);
});

test('loaded order sorting preserves IDs and financial fields while ordering by date or amount', async () => {
  const { sortRecords } = await load('ui/list-controls.js');
  const rows = [{ id: 'a', createdAt: 10, totalKurus: 400 }, { id: 'b', createdAt: 30, totalKurus: 100 }, { id: 'c', createdAt: 20, totalKurus: 700 }];
  assert.deepEqual(sortRecords(rows, 'newest').map((r) => r.id), ['b', 'c', 'a']);
  assert.deepEqual(sortRecords(rows, 'amount-low').map((r) => r.id), ['b', 'a', 'c']);
  assert.deepEqual(sortRecords(rows, 'amount-high').map((r) => r.id), ['c', 'a', 'b']);
  assert.deepEqual(rows.map((r) => r.id), ['a', 'b', 'c']);
  assert.equal(rows.reduce((sum, row) => sum + row.totalKurus, 0), 1200);
});

test('forced catalog refresh after a mutation waits for an old read and then loads fresh prices', async () => {
  const root = path.join(__dirname, '../public/js/store/');
  let source = fs.readFileSync(root + 'products.js', 'utf8');
  for (const file of ['product-fields.js', 'social-links.js']) {
    const url = 'data:text/javascript;base64,' + fs.readFileSync(root + file).toString('base64');
    source = source.replace(`'./${file}?v=zentra-ui-v70'`, JSON.stringify(url));
  }
  const { loadStoreCatalog } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  const makeCatalog = (price) => ({ products: [{ id: 'demo-product', name: 'Demo', platform: 'android', image: '/public/assets/products/gbox.jpeg', plans: [{ key: 'm', label: 'Aylık', duration: '30 gün', priceKurus: price }] }] });
  let calls = 0, release;
  const api = async () => { calls++; if (calls === 1) return new Promise((resolve) => { release = resolve; }); return makeCatalog(20000); };
  const initial = loadStoreCatalog(api);
  const refreshed = loadStoreCatalog(api, { force: true });
  const concurrent = loadStoreCatalog(api, { force: true });
  release(makeCatalog(10000));
  assert.equal((await initial).products[0].plans[0].priceKurus, 10000);
  assert.equal((await refreshed).products[0].plans[0].priceKurus, 20000);
  assert.equal((await concurrent).products[0].plans[0].priceKurus, 20000);
  assert.equal(calls, 2);
});
