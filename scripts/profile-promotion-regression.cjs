'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
let records = new Map(); let writes = 0; let conflict = false;
function mock(name, exports) { const filename = require.resolve(name); require.cache[filename] = { id: filename, filename, loaded: true, exports }; }
function ref(collection, id) { const key = `${collection}/${id}`; return { id, path: key, get: async () => ({ exists: records.has(key), data: () => records.get(key) }) }; }
const db = { collection: (name) => ({ doc: (id) => ref(name, id) }), runTransaction: async (callback) => {
  const staged = []; const result = await callback({ get: (target) => target.get(), set: (target, row) => staged.push([target.path, row]) });
  for (const [key, row] of staged) { records.set(key, row); writes++; } return result;
} };
const auth = { getUser: async () => ({ uid: 'a', email: 'old@example.test' }), getUserByEmail: async () => {
  if (conflict) return { uid: 'b' }; throw Object.assign(new Error('not found'), { code: 'auth/user-not-found' });
}, updateUser: async () => { throw new Error('must not update before verification'); } };
mock('../server/config/firebaseAdmin', { initFirebaseAdmin: () => ({ db, auth, admin: {} }) });
mock('../server/core/storeService', { readAccount: async () => { throw new Error('must not sync before verification'); } });
mock('../server/core/storeCatalogService', { getEffectiveCatalog: async () => ({ products: [{ id: 'demo' }] }) });
mock('../server/core/storeMutationAudit', { recordMutationAudit() {} });
const profile = require('../server/core/storeProfileService');
const promotions = require('../server/core/storePromotionService');
test('email preflight validates eligibility without changing identity, balance or account', async () => {
  records = new Map([['users/a', { email: 'old@example.test', storeBalanceKurus: 5000, storeAccountStatus: 'active' }]]); writes = 0; conflict = false;
  const result = await profile.prepareProfileEmailChange('a', { uid: 'a' }, { email: 'new@example.test' });
  assert.deepEqual(result, { verificationRequired: true, email: 'new@example.test' });
  assert.equal(writes, 0); assert.equal(records.get('users/a').email, 'old@example.test'); assert.equal(records.get('users/a').storeBalanceKurus, 5000);
  conflict = true;
  await assert.rejects(profile.prepareProfileEmailChange('a', {}, { email: 'taken@example.test' }), { code: 'EMAIL_ALREADY_IN_USE' });
  assert.equal(writes, 0); conflict = false;
});
test('email preflight rejects unchanged, invalid and suspended requests', async () => {
  records = new Map([['users/a', { storeAccountStatus: 'active' }]]);
  await assert.rejects(profile.prepareProfileEmailChange('a', {}, { email: 'old@example.test' }), { code: 'EMAIL_UNCHANGED' });
  await assert.rejects(profile.prepareProfileEmailChange('a', {}, { email: 'bad-email' }), { code: 'EMAIL_INVALID' });
  records.set('users/a', { storeAccountStatus: 'suspended' });
  await assert.rejects(profile.prepareProfileEmailChange('a', {}, { email: 'new@example.test' }), { code: 'STORE_ACCOUNT_SUSPENDED' });
});
test('coupon creation collision is rejected atomically and editing preserves redemption count', async () => {
  records = new Map(); writes = 0;
  const input = { title: 'Test', type: 'percent', value: 10, usageLimit: 10, perUserLimit: 1, active: true, visibleInWallet: true, createOnly: true };
  await promotions.savePromotion('TEST10', input, { uid: 'admin' });
  const previous = records.get('storePromotions/TEST10'); previous.usedCount = 2;
  await assert.rejects(promotions.savePromotion('TEST10', { ...input, value: 30 }), { code: 'STORE_PROMOTION_CODE_EXISTS' });
  assert.equal(writes, 1); assert.equal(previous.value, 10);
  await promotions.savePromotion('TEST10', { ...input, createOnly: false, value: 20 });
  assert.equal(records.get('storePromotions/TEST10').usedCount, 2);
  await assert.rejects(promotions.savePromotion('MISSING', { ...input, createOnly: false }), { code: 'STORE_PROMOTION_NOT_FOUND' });
});
test('invalid coupon values, date ranges, limits and product scopes do not write', async () => {
  records = new Map(); writes = 0;
  const input = { type: 'percent', value: 10, createOnly: true };
  for (const [patch, code] of [[{ value: -1 }, 'STORE_PROMOTION_VALUE_INVALID'], [{ value: 91 }, 'STORE_PROMOTION_VALUE_INVALID'], [{ perUserLimit: -2 }, 'STORE_PROMOTION_VALUE_INVALID'], [{ minimumSubtotalKurus: -1 }, 'STORE_PROMOTION_VALUE_INVALID'], [{ usageLimit: 1.2 }, 'STORE_PROMOTION_VALUE_INVALID'], [{ startsAt: 2000, endsAt: 1000 }, 'STORE_PROMOTION_DATE_INVALID'], [{ productIds: ['unknown'] }, 'STORE_PROMOTION_SCOPE_INVALID']]) {
    await assert.rejects(promotions.savePromotion('TEST10', { ...input, ...patch }), { code });
  }
  assert.equal(writes, 0);
});
