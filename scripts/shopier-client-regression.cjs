'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { browserModule } = require('./helpers/browser-module.cjs');
async function setup(request, storage) {
  const { createShopierCheckout } = await browserModule('public/js/store/shopier-checkout.js'); const map = new Map();
  return { map, client: createShopierCheckout({ request, storage: storage || { getItem: (key) => map.get(key), setItem: (key, value) => map.set(key, value), removeItem: (key) => map.delete(key) }, createId: () => 'persisted-shopier-attempt-123' }) };
}
const items = [{ productId: 'test-product', planKey: 'weekly', quantity: 1, expectedUnitPriceKurus: 70000 }];
test('browser records stable intent before sending a payment mutation', async () => {
  let fixture; fixture = await setup(async (path, options) => { assert.equal(fixture.map.size, 1); assert.equal(options.body.items[0].expectedUnitPriceKurus, 70000); return { order: { paymentState: 'pending' } }; }); await fixture.client.start('member', items);
});
test('browser retry after lost response checks first, reuses identical body/key and does not use changed cart', async () => {
  const sent = []; let first = true;
  const { client } = await setup(async (path, options) => { if (!options) return { found: false }; sent.push(structuredClone(options.body)); if (first) { first = false; throw new TypeError('lost response'); } return { order: { paymentState: 'pending' } }; });
  await assert.rejects(client.start('member', items)); await client.start('member', [{ ...items[0], quantity: 2 }]); assert.deepEqual(sent[0], sent[1]);
});
test('browser recovery of a committed order never submits a second financial request', async () => {
  let posts = 0; const { client } = await setup(async (path, options) => { if (options) { posts++; return { order: { paymentState: 'pending' } }; } return { found: true, order: { id: 'saved', paymentState: 'pending' }, paymentUrl: 'https://www.shopier.com/123' }; });
  await client.start('member', items); const result = await client.start('member', items); assert.equal(posts, 1); assert.equal(result.order.id, 'saved');
});
test('browser refuses a payment POST when intent cannot be persisted', async () => {
  let posts = 0; const { client } = await setup(async () => { posts++; }, { getItem() { return null; }, setItem() { throw new Error('storage disabled'); } });
  await assert.rejects(client.start('member', items), { code: 'SHOPIER_ATTEMPT_STORAGE_REQUIRED' }); assert.equal(posts, 0);
});
test('browser attempts are scoped to the current identity', async () => {
  const { client } = await setup(async () => ({ order: { paymentState: 'pending' } })); await client.start('member', items); assert.equal(client.pending('other'), null); assert(client.pending('member'));
});
test('browser clears terminal attempts only after reading an authoritative result', async () => {
  const { client } = await setup(async (_path, options) => options ? { order: { paymentState: 'pending' } } : { found: true, order: { paymentState: 'paid' } }); await client.start('member', items); await client.check('member'); assert.equal(client.pending('member'), null);
});
test('browser redirect accepts only HTTPS Shopier hosts', async () => {
  const { verifiedShopierUrl } = await browserModule('public/js/store/shopier-checkout.js'); assert.equal(verifiedShopierUrl('https://www.shopier.com/123'), 'https://www.shopier.com/123');
  for (const url of ['https://shopier.com.evil.invalid/123', 'https://shopier.com@evil.invalid/123', 'http://www.shopier.com/123', 'javascript:alert(1)', 'https://www.shopier.com:444/123']) assert.throws(() => verifiedShopierUrl(url));
});
test('browser persists the selected topup amount before the wallet POST', async () => {
  let fixture; fixture = await setup(async (path, options) => { assert.equal(fixture.map.size, 1); assert.equal(path, '/api/payments/shopier/topups'); assert.equal(options.body.amountKurus, 25000); assert.equal(options.body.items, undefined); return { order: { orderType: 'wallet_topup', paymentState: 'pending' } }; });
  await fixture.client.startTopup('member', 25000); assert.equal(fixture.client.pending('member', 'wallet_topup').kind, 'wallet_topup');
});
test('browser topup retry cannot silently change an uncertain payment amount', async () => {
  const sent = []; let first = true;
  const { client } = await setup(async (_p, options) => { if (!options) return { found: false }; sent.push(structuredClone(options.body)); if (first) { first = false; throw new TypeError('lost response'); } return { order: { orderType: 'wallet_topup', paymentState: 'pending' } }; });
  await assert.rejects(client.startTopup('member', 25000)); await client.startTopup('member', 50000); assert.deepEqual(sent[0], sent[1]);
});
test('purchase and topup have independent persisted intents and never resume each other', async () => {
  const posts = [], saved = new Map();
  const { client, map } = await setup(async (path, options) => {
    if (!options) return { found: true, ...saved.get(new URLSearchParams(path.split('?')[1]).get('idempotencyKey')) };
    posts.push(path); const result = { order: { id: path.endsWith('/topups') ? 'topup' : 'purchase', orderType: path.endsWith('/topups') ? 'wallet_topup' : 'purchase', paymentState: 'pending' } };
    saved.set(options.body.idempotencyKey, result); return result;
  });
  assert.equal((await client.startTopup('member', 25000)).order.id, 'topup');
  assert.equal((await client.start('member', items)).order.id, 'purchase');
  assert.equal(map.size, 2); assert.notEqual(client.pending('member').body.idempotencyKey, client.pending('member', 'wallet_topup').body.idempotencyKey);
  assert.equal((await client.startTopup('member', 99999)).order.id, 'topup');
  assert.equal((await client.start('member', [])).order.id, 'purchase');
  assert.deepEqual(posts, ['/api/payments/shopier/topups', '/api/payments/shopier/create']);
});
test('legacy topup recovery keeps its original key and cannot occupy the purchase slot', async () => {
  const calls = [], local = new Map([['zentra-shopier-attempt-v1:member', JSON.stringify({ uid: 'member', kind: 'wallet_topup', body: { amountKurus: 25000, idempotencyKey: 'original-stable-key-123' } })]]);
  const { client } = await setup(async path => { calls.push(path); return { found: true, order: { orderType: 'wallet_topup', paymentState: 'pending' } }; }, { getItem: k => local.get(k), setItem: (k,v) => local.set(k,v), removeItem: k => local.delete(k) });
  assert.equal(client.pending('member'), null); assert(local.has('zentra-shopier-attempt-v1:member'));
  assert.equal(client.pending('member', 'wallet_topup').body.idempotencyKey, 'original-stable-key-123');
  await client.startTopup('member', 50000); assert.equal(calls.length, 1); assert(calls[0].includes('original-stable-key-123')); assert(!local.has('zentra-shopier-attempt-v1:member'));
});
test('terminal purchase cleanup cannot discard an unresolved wallet payment', async () => {
  const { client } = await setup(async (path, options) => options ? { order: { orderType: path.endsWith('/topups') ? 'wallet_topup' : 'purchase', paymentState: 'pending' } } : { found: true, order: { orderType: 'purchase', paymentState: 'paid' } });
  await client.start('member', items); await client.startTopup('member', 25000); await client.check('member');
  assert.equal(client.pending('member'), null); assert(client.pending('member', 'wallet_topup'));
});
test('mismatched recovered payment purpose fails closed without creating another payment', async () => {
  let posts = 0;
  const { client } = await setup(async (_path, options) => options ? (posts++, { order: { orderType: 'wallet_topup', paymentState: 'pending' } }) : { found: true, order: { orderType: 'purchase', paymentState: 'paid' } });
  await client.startTopup('member', 25000); await assert.rejects(client.startTopup('member', 25000), { code: 'SHOPIER_ATTEMPT_KIND_MISMATCH' });
  assert.equal(posts, 1); assert(client.pending('member', 'wallet_topup'));
});
test('browser Turkish amount parsing uses exact kurus and rejects ambiguous formats', async () => {
  const { parseTopupAmount } = await browserModule('public/js/store/shopier-checkout.js');
  assert.equal(parseTopupAmount('250,75'), 25075); assert.equal(parseTopupAmount('10000.00'), 1000000);
  for (const value of ['99,99','10000,01','1.000,00','1e3','-250','250,001','','NaN']) assert.throws(() => parseTopupAmount(value), { code: 'SHOPIER_TOPUP_AMOUNT_INVALID' });
});
test('browser preserves topup availability independently from product stock readiness', async () => {
  const { loadStoreCatalog } = await browserModule('public/js/store/products.js');
  const catalog = await loadStoreCatalog(async () => ({ catalog: { payments: { shopier: { available: false, topupAvailable: true, topupLimits: { minKurus: 10000, maxKurus: 1000000 } } }, products: [] } }), { force: true });
  assert.equal(catalog.payments.shopier.available, false); assert.equal(catalog.payments.shopier.topupAvailable, true); assert.deepEqual(catalog.payments.shopier.topupLimits, { minKurus: 10000, maxKurus: 1000000 });
});
