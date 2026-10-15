'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { applicationFixture } = require('./helpers/application-fixture.cjs');
let fixture, owner;
const code = 'ZA-' + 'B'.repeat(24);
const link = { title: 'HTTP affiliate', ownerUsername: 'ShopOwner', rate: 30, active: true, commissionEnabled: true, createOnly: true };
before(async () => { fixture = await applicationFixture(); owner = await fixture.openAdmin(); });
after(async () => { await fixture?.close(); });
test('affiliate writes require an admin gate, finance permission and a content-bound password proof', async () => {
  assert.equal((await fixture.request('/api/admin/store/affiliates', { uid: 'member' })).status, 403);
  assert.equal((await fixture.request(`/api/admin/store/affiliates/${code}`, { ...owner, method: 'PUT', body: link })).status, 401);
  assert.equal((await fixture.adminWrite(owner, `/api/admin/store/affiliates/${code}`, 'PUT', link)).status, 200);
  const list = await fixture.request('/api/admin/store/affiliates', owner);
  assert.equal(list.body.links[0].rate, 30);
  const asset = await fetch(fixture.origin + '/admin/affiliate-links.js?v=zentra-affiliate-v1');
  assert.equal(asset.status, 200); assert((await asset.text()).includes('createAffiliateManager'));
});
test('real profile initialization binds a new Firebase identity once and refuses later attachment to an established account', async () => {
  fixture.users.set('newmember', { uid: 'newmember', email: 'newmember@zentra.invalid', emailVerified: true, disabled: false,
    password: fixture.password, generation: 0, metadata: { creationTime: new Date().toISOString() } });
  const body = { firstName: 'Deniz', lastName: 'Test', username: 'NewMember', birthDate: '2000-01-01', affiliateCode: code };
  const created = await fixture.request('/api/profile/update', { uid: 'newmember', method: 'POST', body });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal((await fixture.request('/api/profile/update', { uid: 'newmember', method: 'POST', body })).status, 200);
  assert.equal(fixture.db.records.get('users/newmember').storeAffiliate.rate, 30);
  assert.equal(fixture.db.records.get(`storeAffiliateLinks/${code}`).referralCount, 1);
  const old = await fixture.request('/api/profile/update', { uid: 'member', method: 'POST', body: {
    firstName: 'Emir', lastName: 'Deneme', username: 'EmirHan', birthDate: '2000-01-01', affiliateCode: code
  } });
  assert.equal(old.status, 409); assert.equal(old.body.error, 'AFFILIATE_ALREADY_BOUND');
});
test('transfer HTTP contracts reject forged fields and stale auth; replay preserves both balances and creates no commission', async () => {
  const preview = await fixture.request('/api/store/transfers/preview', { uid: 'member', method: 'POST', body: { recipientUsername: 'ShopOwner', amountKurus: 10000 } });
  assert.equal(preview.status, 200); assert.equal(preview.body.preview.netKurus, 2500); assert.equal(preview.body.preview.feeKurus, 7500);
  const body = { recipientUsername: 'ShopOwner', recipientUid: 'owneruid', amountKurus: 10000, idempotencyKey: 'http-transfer-00001' };
  const stale = fixture.idToken('member', Math.floor(Date.now() / 1000) - 7200);
  assert.equal((await fixture.request('/api/store/transfers', { token: stale, method: 'POST', body })).status, 401);
  assert.equal((await fixture.request('/api/store/transfers', { uid: 'member', method: 'POST', body: { ...body, feeKurus: 0 } })).status, 400);
  const sent = await fixture.request('/api/store/transfers', { uid: 'member', method: 'POST', body });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  const replay = await fixture.request('/api/store/transfers', { uid: 'member', method: 'POST', body });
  assert.equal(replay.body.idempotentReplay, true);
  assert.equal(fixture.db.records.get('users/member').storeBalanceKurus, 40000);
  assert.equal(fixture.db.records.get('users/owneruid').storeBalanceKurus, 2500);
  const history = await fixture.request('/api/store/wallet/history', { uid: 'member' });
  assert.equal(history.body.entries.length, 1); assert.equal(history.body.entries[0].amountKurus, -10000);
  assert.equal([...fixture.db.records.keys()].filter(key => key.startsWith('storeAffiliateCommissions/')).length, 0);
});
test('real Telegram order approval pays the bound owner and the admin refund reverses the same receipt', async () => {
  const catalog = await fixture.request('/api/store/catalog');
  const product = catalog.body.catalog.products.find(row => row.telegramEnabled !== false), plan = product.plans.find(row => row.active !== false);
  const created = await fixture.request('/api/store/orders', { uid: 'newmember', method: 'POST', body: {
    paymentMethod: 'telegram', idempotencyKey: 'http-affiliate-order1', items: [{ productId: product.id, planKey: plan.key, quantity: 1 }]
  } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(fixture.db.records.get('users/owneruid').storeBalanceKurus, 2500);
  const id = created.body.order.id, commission = Math.floor(created.body.order.totalKurus * .3);
  const paid = await fixture.adminWrite(owner, `/api/admin/store/orders/${id}`, 'PATCH', { status: 'paid' });
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  assert.equal(fixture.db.records.get('users/owneruid').storeBalanceKurus, 2500 + commission);
  const refunded = await fixture.adminWrite(owner, `/api/admin/store/orders/${id}`, 'PATCH', { status: 'refunded', refundReason: 'Regression refund' });
  assert.equal(refunded.status, 200); assert.equal(fixture.db.records.get('users/owneruid').storeBalanceKurus, 2500);
  const details = await fixture.request(`/api/admin/store/affiliates/${code}/details?kind=commissions`, owner);
  assert.equal(details.body.rows.length, 1); assert(details.body.rows[0].reversedAt > 0);
});
