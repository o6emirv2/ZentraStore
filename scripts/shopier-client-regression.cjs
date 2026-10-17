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
