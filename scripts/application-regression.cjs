'use strict';
const { test, before, after } = require('node:test'), assert = require('node:assert/strict');
const { applicationFixture } = require('./helpers/application-fixture.cjs');
let fixture, owner, finance, product;
before(async () => { fixture = await applicationFixture(); owner = await fixture.openAdmin(); finance = await fixture.openAdmin('finance'); });
after(async () => { await fixture?.close(); });
const credit = { title: '200 TL balance credit', value: 20000, usageLimit: 10, perUserLimit: 1, startsAt: 0, endsAt: 0, active: true, createOnly: true };
test('real username login, supplementary cookie and account routes agree on the same owner', async () => {
  const login = await fixture.request('/api/auth/login', { method: 'POST', body: { identifier: 'EMIRHAN', password: fixture.password } });
  assert.equal(login.status, 200); assert.deepEqual(Object.keys(login.body).sort(), ['customToken', 'ok']);
  const user = fixture.exchangeCustomToken(login.body.customToken); assert.equal(user.uid, 'member');
  const account = await fixture.request('/api/store/account', { token: user.idToken }); assert.equal(account.body.account.uid, user.uid); assert.equal(account.body.account.balanceKurus, 50000);
  assert.equal((await fixture.request('/api/auth/session', { method: 'POST', body: { idToken: user.idToken, remember: true } })).status, 200);
  assert.equal((await fixture.request('/api/auth/login', { method: 'POST', body: { identifier: 'EmirHan', password: 'incorrect' } })).status, 401);
});
test('canonical admin entry serves the dashboard only after both identity and gate cookies are verified', async () => {
  const identity = await fixture.request('/api/auth/session', { method: 'POST', body: { idToken: owner.token, remember: false } });
  const cookie = [owner.cookie, ...identity.headers.getSetCookie().map(value => value.split(';')[0])].join('; ');
  const result = await fetch(fixture.origin + '/admin/', { headers: { cookie }, redirect: 'manual' });
  assert.equal(result.status, 200); assert((await result.text()).includes('id="adminLoader"')); assert(result.headers.get('cache-control').includes('no-store'));
  const identityOnly = identity.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const gate = await fetch(fixture.origin + '/admin/', { headers: { cookie: identityOnly }, redirect: 'manual' });
  assert.equal(gate.status, 200); assert((await gate.text()).includes('id="fifthFactor"'));
  const mismatch = await fixture.request('/api/admin/store/balance-codes', { token: fixture.idToken('member'), cookie });
  assert.equal(mismatch.status, 403);
});
test('five-step gate, TOTP and content-bound password proof create a separate credit campaign', async () => {
  assert.equal((await fixture.adminWrite(owner, '/api/admin/store/balance-codes/ZENTRASTORE200', 'PUT', credit)).status, 200);
  assert.equal(fixture.db.records.get('storePromotions/ZENTRASTORE200').type, 'balance');
  assert.equal((await fixture.request('/api/admin/store/balance-codes', owner)).body.codes[0].code, 'ZENTRASTORE200');
});
test('parallel HTTP redemption produces one 200 TL credit and one immutable receipt', async () => {
  const results = await Promise.all([0, 1].map(() => fixture.request('/api/store/balance-codes/redeem', { uid: 'member', method: 'POST', body: { code: 'ZENTRASTORE200' } })));
  assert(results.every(row => row.status === 200)); assert.equal(results[0].body.transactionId, results[1].body.transactionId); assert.equal(fixture.db.records.get('users/member').storeBalanceKurus, 70000);
  assert.equal([...fixture.db.records.keys()].filter(key => key.startsWith('storeWalletLedger/')).length, 1);
});
test('financial role cannot edit the catalog and loses access immediately after deactivation', async () => {
  assert.equal((await fixture.adminWrite(finance, '/api/admin/store/balance-codes/FINANCE200', 'PUT', credit)).status, 200);
  assert.equal((await fixture.adminWrite(finance, '/api/admin/store/products', 'POST', {})).status, 403);
  fixture.db.records.get('adminUsers/finance').active = false;
  assert.equal((await fixture.request('/api/admin/store/balance-codes', finance)).status, 403);
});
test('malformed stored dates cannot credit funds while a committed receipt remains replayable', async () => {
  const row = fixture.db.records.get('storePromotions/FINANCE200'); row.startsAt = 'tomorrow';
  assert.equal((await fixture.request('/api/store/balance-codes/redeem', { uid: 'viewer', method: 'POST', body: { code: 'FINANCE200' } })).status, 409);
  assert.equal(fixture.db.records.get('users/viewer'), undefined);
  fixture.db.records.get('storePromotions/ZENTRASTORE200').active = false;
  assert.equal((await fixture.request('/api/store/balance-codes/redeem', { uid: 'member', method: 'POST', body: { code: 'ZENTRASTORE200' } })).body.idempotentReplay, true);
});
test('new catalog product accepts supported feature boundaries through actual routes', async () => {
  const base = require('../public/data/store-products.json').products[0];
  product = { id: 'integration-product', name: 'Integration product', description: 'Controlled catalog record.', platform: 'android', game: 'pubg', categoryKey: 'pubg-android', category: 'PUBG Android', inventoryType: 'license', fulfillmentMode: 'automatic', image: base.image, features: ['x'.repeat(160)], badgeKey: 'premium', featured: false, plans: [{ key: 'daily', label: 'Günlük', duration: '24 Saat', priceKurus: 25000 }] };
  const result = await fixture.adminWrite(owner, '/api/admin/store/products', 'POST', product); assert.equal(result.status, 201);
  assert((await fixture.request('/api/store/catalog')).body.catalog.products.some(row => row.id === product.id));
});
test('stock inspection, encrypted import and replay preserve product and package ownership', async () => {
  const body = { productId: product.id, planKey: 'daily', keys: ['INTEGRATION-KEY-ONE'], idempotencyKey: 'integration-import-0001' };
  assert.equal((await fixture.request('/api/admin/store/inventory/import-check', { ...owner, method: 'POST', body })).status, 200);
  const imported = await fixture.adminWrite(owner, '/api/admin/store/inventory/import', 'POST', body); assert.equal(imported.status, 201); assert.equal(imported.body.result.imported, 1);
  assert.equal((await fixture.adminWrite(owner, '/api/admin/store/inventory/import', 'POST', body)).body.result.idempotentReplay, true);
});
test('purchase and private delivery allocate one key and reject a different customer', async () => {
  const body = { items: [{ productId: product.id, planKey: 'daily', quantity: 1, expectedUnitPriceKurus: 25000 }], paymentMethod: 'wallet', promotionCode: '', idempotencyKey: 'integration-purchase-0001' };
  const bought = await fixture.request('/api/store/orders', { uid: 'member', method: 'POST', body }); assert.equal(bought.status, 201);
  const id = bought.body.order.id; assert.equal(fixture.db.records.get('users/member').storeBalanceKurus, 45000);
  const delivery = await fixture.request(`/api/store/orders/${id}/delivery`, { uid: 'member' }); assert.equal(delivery.status, 200); assert(JSON.stringify(delivery.body).includes('INTEGRATION-KEY-ONE'));
  const other = await fixture.request(`/api/store/orders/${id}/delivery`, { uid: 'viewer' }); assert.notEqual(other.status, 200); assert(!JSON.stringify(other.body).includes('INTEGRATION-KEY-ONE'));
  assert.equal((await fixture.request('/api/store/orders', { uid: 'member', method: 'POST', body })).body.order.id, id); assert.equal(fixture.db.records.get('users/member').storeBalanceKurus, 45000);
});
test('profile confirmation comes from its committed transaction and keeps the actual wallet', async () => {
  const result = await fixture.request('/api/store/profile/name', { uid: 'member', method: 'PATCH', body: { firstName: 'İsmail', lastName: 'Çelik' } });
  assert.equal(result.status, 200); assert.equal(result.body.account.uid, 'member'); assert.equal(result.body.account.fullName, 'İsmail Çelik'); assert.equal(result.body.account.balanceKurus, 45000); assert.equal(result.body.account.profileChanges.fullName.remaining, 0);
});
test('invalid bearer never falls back to another valid session cookie', async () => {
  const session = await fixture.request('/api/auth/session', { method: 'POST', body: { idToken: fixture.idToken('owneruid'), remember: false } });
  const cookie = session.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  assert.equal((await fixture.request('/api/store/account', { cookie, token: 'invalid-explicit-token' })).status, 401);
});
test('old known clients cannot write business records while login stays compatible', async () => {
  const result = await fixture.request('/api/store/profile/name', { uid: 'member', client: 'premium-store-v75', method: 'PATCH', body: { firstName: 'Old', lastName: 'Client' } });
  assert.equal(result.status, 409); assert.equal(result.body.error, 'CLIENT_UPDATE_REQUIRED');
  const login = await fixture.request('/api/auth/login', { client: 'premium-store-v75', method: 'POST', body: { identifier: 'member@zentra.invalid', password: fixture.password } }); assert.equal(login.status, 200);
});
test('logout revokes previous bearer tokens and session cookies in actual middleware', async () => {
  const token = fixture.idToken('member'), session = await fixture.request('/api/auth/session', { method: 'POST', body: { idToken: token, remember: false } });
  const cookie = session.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  assert.equal((await fixture.request('/api/auth/logout', { token, method: 'POST', body: {} })).status, 200);
  assert.equal((await fixture.request('/api/store/account', { token })).status, 401); assert.equal((await fixture.request('/api/store/account', { cookie })).status, 401);
});
