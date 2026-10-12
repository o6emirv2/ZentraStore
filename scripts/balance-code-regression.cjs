'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
let records = new Map(), rollback = false, tail = Promise.resolve();
const auditDetails = [];
function ref(path) { return { path, id: path.split('/').at(-1), get: async () => snap(ref(path)) }; }
function snap(target) { return { id: target.id, exists: records.has(target.path), data: () => structuredClone(records.get(target.path)) }; }
const db = { collection: (name) => ({ doc: (id = crypto.randomUUID()) => ref(`${name}/${id}`) }), runTransaction: async (callback) => {
  let unlock; const previous = tail; tail = new Promise((resolve) => { unlock = resolve; }); await previous;
  try {
    const staged = []; let writing = false;
    const result = await callback({
      get: async (target) => { assert.equal(writing, false, 'all reads precede financial writes'); return snap(target); },
      set: (target, value, options) => { writing = true; staged.push([target, value, options?.merge]); },
      update: (target, value) => { writing = true; staged.push([target, value, true]); },
      create: (target, value) => { writing = true; assert(!records.has(target.path)); staged.push([target, value, false]); }
    });
    if (rollback) throw new Error('commit failed');
    for (const [target, value, merge] of staged) records.set(target.path, merge ? { ...records.get(target.path), ...value } : value);
    return result;
  } finally { unlock(); }
} };
function mock(name, exports) { const filename = require.resolve(name); require.cache[filename] = { id: filename, filename, loaded: true, exports }; }
mock('../server/config/firebaseAdmin', { initFirebaseAdmin: () => ({ db, admin: {} }) });
mock('../server/core/storeCatalogService', { getEffectiveCatalog: async () => ({ products: [{ id: 'demo' }] }) });
mock('../server/core/storeMutationAudit', { recordMutationAudit: (_tx, _db, _action, _actor, details) => auditDetails.push(details) });
mock('../server/core/firestorePagination', { invalidateCreatedAtPageCache() {} });
const { savePromotion, previewPromotion } = require('../server/core/storePromotionService');
const { redeemBalanceCode } = require('../server/core/storeBalanceCodeService');
function reset() { records = new Map([['users/member', { username: 'Member', storeBalanceKurus: 5000 }], ['users/other', { storeBalanceKurus: 0 }]]); rollback = false; auditDetails.length = 0; }
const body = { type: 'balance', value: 20000, title: '200 TL', usageLimit: 1, perUserLimit: 1, active: true, createOnly: true, visibleInWallet: true };
const create = (patch = {}) => savePromotion('ZENTRASTORE200', { ...body, ...patch }, { uid: 'admin' }, { canManageBalance: true });
test('bakiye code creation requires financial permission and hides codes from customer listing', async () => {
  reset(); await assert.rejects(savePromotion('ZENTRASTORE200', body, { uid: 'content-editor' }), { code: 'STORE_PERMISSION_DENIED' });
  const result = await create(); assert.equal(result.type, 'balance'); assert.equal(result.value, 20000); assert.equal(result.visibleInWallet, false);
  assert.equal(auditDetails[0].code, undefined); assert.equal(auditDetails[0].codeFingerprint.length, 64);
});
test('ZENTRASTORE200 atomically credits 200 TL with a single ledger and receipt', async () => {
  reset(); await create(); const result = await redeemBalanceCode('member', { code: 'zentrastore200' });
  assert.equal(result.creditedKurus, 20000); assert.equal(result.committed, true); assert.equal(records.get('users/member').storeBalanceKurus, 25000);
  assert.equal(records.get('storePromotions/ZENTRASTORE200').usedCount, 1);
  assert.equal([...records.keys()].filter((key) => key.startsWith('storeWalletLedger/')).length, 1);
  assert.equal([...records.keys()].filter((key) => key.startsWith('audit/')).length, 1);
});
test('concurrent and lost-response retries never credit the same member twice', async () => {
  reset(); await create(); const results = await Promise.all(Array.from({ length: 8 }, () => redeemBalanceCode('member', { code: 'ZENTRASTORE200' })));
  assert.equal(results.filter((result) => !result.idempotentReplay).length, 1); assert.equal(records.get('users/member').storeBalanceKurus, 25000);
  assert.equal((await redeemBalanceCode('member', { code: 'ZENTRASTORE200' })).idempotentReplay, true);
});
test('global single-use limit is shared across accounts', async () => {
  reset(); await create(); const results = await Promise.allSettled(['member', 'other'].map((uid) => redeemBalanceCode(uid, { code: 'ZENTRASTORE200' })));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'BALANCE_CODE_LIMIT_REACHED');
});
test('client amounts and code suffixes cannot determine credit value', async () => {
  reset(); await create({ value: 12345 });
  await assert.rejects(redeemBalanceCode('member', { code: 'ZENTRASTORE200', amountKurus: 999999 }), { code: 'BALANCE_CODE_INPUT_INVALID' });
  assert.equal((await redeemBalanceCode('member', { code: 'ZENTRASTORE200' })).creditedKurus, 12345);
});
test('inactive, scheduled, expired and missing codes do not credit accounts', async () => {
  for (const [patch, code] of [[{ active: false }, 'BALANCE_CODE_INACTIVE'], [{ startsAt: Date.now() + 60000 }, 'BALANCE_CODE_NOT_STARTED'], [{ endsAt: Date.now() - 60000 }, 'BALANCE_CODE_EXPIRED']]) {
    reset(); await create(patch); await assert.rejects(redeemBalanceCode('member', { code: 'ZENTRASTORE200' }), { code }); assert.equal(records.get('users/member').storeBalanceKurus, 5000);
  }
  reset(); await assert.rejects(redeemBalanceCode('member', { code: 'MISSING' }), { code: 'BALANCE_CODE_NOT_FOUND' });
});
test('failed commit leaves balance, campaign usage and ledger unchanged', async () => {
  reset(); await create(); const before = structuredClone(records); rollback = true;
  await assert.rejects(redeemBalanceCode('member', { code: 'ZENTRASTORE200' }), /commit failed/); assert.deepEqual(records, before);
});
test('used balance codes cannot be converted, repriced or edited without financial permission', async () => {
  reset(); await create(); await redeemBalanceCode('member', { code: 'ZENTRASTORE200' });
  for (const [patch, options, code] of [[{ value: 30000 }, { canManageBalance: true }, 'BALANCE_CODE_VALUE_LOCKED'], [{ type: 'fixed' }, { canManageBalance: true }, 'STORE_PROMOTION_TYPE_LOCKED'], [{ active: false }, {}, 'STORE_PERMISSION_DENIED']]) {
    await assert.rejects(savePromotion('ZENTRASTORE200', { ...body, createOnly: false, ...patch }, {}, options), { code });
  }
});
test('unbounded codes, repeated per-member use and cart-specific settings are rejected', async () => {
  for (const patch of [{ usageLimit: 0 }, { perUserLimit: 2 }, { minimumSubtotalKurus: 1 }, { platforms: ['ios'] }, { value: -1 }]) {
    reset(); await assert.rejects(create(patch)); assert(!records.has('storePromotions/ZENTRASTORE200'));
  }
});
test('suspended users and overflowing balances cannot redeem', async () => {
  reset(); await create(); records.get('users/member').storeAccountStatus = 'suspended';
  await assert.rejects(redeemBalanceCode('member', { code: 'ZENTRASTORE200' }), { code: 'STORE_ACCOUNT_SUSPENDED' });
  records.get('users/member').storeAccountStatus = 'active'; records.get('users/member').storeBalanceKurus = 1_000_000_000_000;
  await assert.rejects(redeemBalanceCode('member', { code: 'ZENTRASTORE200' }), { code: 'STORE_BALANCE_LIMIT_EXCEEDED' });
});
test('balance code remains idempotent after disabling a redeemed code', async () => {
  reset(); await create(); await redeemBalanceCode('member', { code: 'ZENTRASTORE200' }); records.get('storePromotions/ZENTRASTORE200').active = false;
  assert.equal((await redeemBalanceCode('member', { code: 'ZENTRASTORE200' })).idempotentReplay, true);
});
test('invalid stored receipts fail closed without increasing balance', async () => {
  reset(); await create(); const result = await redeemBalanceCode('member', { code: 'ZENTRASTORE200' });
  records.get('storeBalanceCodeRedemptions/' + result.transactionId).amountKurus = -1;
  await assert.rejects(redeemBalanceCode('member', { code: 'ZENTRASTORE200' }), { code: 'BALANCE_CODE_RECEIPT_INVALID' });
  assert.equal(records.get('users/member').storeBalanceKurus, 25000);
});
test('balance code is never applied as a percentage discount', async () => {
  reset(); await create(); const codeRef = ref('storePromotions/ZENTRASTORE200'); codeRef.collection = () => ({ doc: () => ref('usage/test') });
  const original = db.collection; db.collection = (name) => name === 'storePromotions' ? { doc: () => codeRef } : original(name);
  try { await assert.rejects(previewPromotion({ uid: 'member', code: 'ZENTRASTORE200', cart: { totalKurus: 10000, items: [{ lineTotalKurus: 10000 }] } }), { code: 'BALANCE_CODE_USE_ACCOUNT' }); }
  finally { db.collection = original; }
});
