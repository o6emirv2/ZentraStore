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
const { savePromotion, previewPromotion, listPromotions } = require('../server/core/storePromotionService');
const { redeemBalanceCode, saveBalanceCode, listBalanceCodes } = require('../server/core/storeBalanceCodeService');
function reset() { records = new Map([['users/member', { storeRegistrationSecurity: { admittedAt: Date.now() }, username: 'Member', storeBalanceKurus: 5000 }], ['users/other', { storeRegistrationSecurity: { admittedAt: Date.now() }, storeBalanceKurus: 0 }]]); rollback = false; auditDetails.length = 0; }
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

const promoBody = { title: '200 ₺ promosyon', value: 20000, usageLimit: 1, perUserLimit: 1, startsAt: 0, endsAt: 0, active: true, createOnly: true };
test('dedicated promotion writer rejects discount fields, invalid values and missing required information', async () => {
  for (const patch of [{ type: 'percent' }, { minimumSubtotalKurus: 1 }, { productIds: ['demo'] }, { value: -1 }, { value: '20000' }, { value: 100000001 }, { usageLimit: 0 }, { usageLimit: 1.5 }, { perUserLimit: 2 }, { title: '' }, { title: 'x'.repeat(101) }, { active: 'true' }, { createOnly: undefined }]) {
    reset();
    await assert.rejects(saveBalanceCode('ZENTRASTORE200', { ...promoBody, ...patch }, { uid: 'finance' }), { code: 'BALANCE_CODE_INPUT_INVALID' });
    assert(!records.has('storePromotions/ZENTRASTORE200'));
  }
});
test('dedicated promotion writer validates exact code and timestamp formats before writing', async () => {
  reset();
  for (const code of ['AB', 'A'.repeat(33), '<PROMO', 'PROMO/200']) await assert.rejects(saveBalanceCode(code, promoBody), { code: 'STORE_PROMOTION_CODE_INVALID' });
  for (const startsAt of [-1, NaN, 'tomorrow', 8640000000000001]) await assert.rejects(saveBalanceCode('ZENTRASTORE200', { ...promoBody, startsAt }), { code: 'STORE_PROMOTION_DATE_INVALID' });
  await assert.rejects(saveBalanceCode('ZENTRASTORE200', { ...promoBody, startsAt: 200, endsAt: 100 }), { code: 'STORE_PROMOTION_DATE_INVALID' });
  const row = await saveBalanceCode('zentrastore200', promoBody, { uid: 'finance' });
  assert.equal(row.code, 'ZENTRASTORE200'); assert.equal(row.type, 'balance'); assert.equal(row.visibleInWallet, false);
});
test('discount endpoint cannot create, convert or modify wallet promotions', async () => {
  reset();
  await assert.rejects(savePromotion('NEWBALANCE', body, {}, { kind: 'discount', canManageBalance: true }), { code: 'STORE_PROMOTION_TYPE_LOCKED' });
  await saveBalanceCode('ZENTRASTORE200', promoBody);
  const before = structuredClone(records);
  await assert.rejects(savePromotion('ZENTRASTORE200', { type: 'fixed', value: 100, createOnly: false }, {}, { kind: 'discount' }), { code: 'STORE_PROMOTION_TYPE_LOCKED' });
  assert.deepEqual(records, before);
});
test('wallet promotion endpoint preserves existing discount records sharing a code', async () => {
  reset();
  await savePromotion('DISCOUNT10', { type: 'percent', value: 10, active: true, createOnly: true }, {}, { kind: 'discount' });
  const before = structuredClone(records);
  for (const createOnly of [true, false]) await assert.rejects(saveBalanceCode('DISCOUNT10', { ...promoBody, createOnly }), { code: 'STORE_PROMOTION_TYPE_LOCKED' });
  assert.deepEqual(records, before);
});
test('separate promotion lists remain scoped even when the ordered index is unavailable', async () => {
  reset();
  await saveBalanceCode('ZENTRASTORE200', promoBody);
  await savePromotion('DISCOUNT10', { type: 'percent', value: 10, active: true, createOnly: true }, {}, { kind: 'discount' });
  const original = db.collection;
  let indexMissing = false;
  function query(filters = [], ordered = false, limit = 100) {
    return { where: (field, operator, value) => query([...filters, [field, operator, value]], ordered, limit), orderBy: () => query(filters, true, limit), limit: (count) => query(filters, ordered, count), get: async () => {
      if (ordered && indexMissing) throw Object.assign(new Error('index needed'), { code: 9 });
      return { docs: [...records].filter(([path, row]) => path.startsWith('storePromotions/') && filters.every(([field, op, value]) => op === 'in' ? value.includes(row[field]) : row[field] === value)).slice(0, limit).map(([path]) => snap(ref(path))) };
    } };
  }
  db.collection = (name) => name === 'storePromotions' ? query() : original(name);
  try {
    for (const unavailable of [false, true]) {
      indexMissing = unavailable;
      assert.deepEqual((await listBalanceCodes()).map((row) => row.code), ['ZENTRASTORE200']);
      assert.deepEqual((await listPromotions({ kind: 'discount' })).map((row) => row.code), ['DISCOUNT10']);
    }
  } finally { db.collection = original; }
});
test('dedicated promotion edits retain usage history and lock used credit values', async () => {
  reset(); await saveBalanceCode('ZENTRASTORE200', promoBody); await redeemBalanceCode('member', { code: 'ZENTRASTORE200' });
  await assert.rejects(saveBalanceCode('ZENTRASTORE200', { ...promoBody, value: 30000, createOnly: false }), { code: 'BALANCE_CODE_VALUE_LOCKED' });
  const row = await saveBalanceCode('ZENTRASTORE200', { ...promoBody, title: 'Kapanmış kampanya', active: false, createOnly: false });
  assert.equal(row.usedCount, 1); assert.equal(row.value, 20000); assert.equal(row.status, 'inactive');
});
test('simultaneous promotion creation cannot overwrite a code with a second credit amount', async () => {
  reset();
  const results = await Promise.allSettled([saveBalanceCode('ZENTRASTORE200', promoBody), saveBalanceCode('ZENTRASTORE200', { ...promoBody, value: 30000 })]);
  assert.equal(results.filter((row) => row.status === 'fulfilled').length, 1);
  assert.equal(results.find((row) => row.status === 'rejected').reason.code, 'STORE_PROMOTION_CODE_EXISTS');
  assert.equal(records.get('storePromotions/ZENTRASTORE200').value, 20000);
});

test('promotion routes enforce financial permission, admin gate and reauthentication independently of coupon access', async () => {
  reset();
  const express = require('express');
  const security = require('../server/core/security');
  mock('../server/core/security', { ...security, strictLimiter: (_req, _res, next) => next(), adminActionLimiter: (_req, _res, next) => next(), requireAuth: (req, res, next) => {
    const role = req.get('Authorization');
    if (!role) return res.status(401).json({ ok: false, error: 'AUTH_REQUIRED' });
    req.user = { uid: role, email: `${role}@example.test`, email_verified: true };
    req.adminPolicy = { permissions: role === 'finance' ? ['store.wallet.write'] : role === 'wallet-reader' ? ['store.wallet.read'] : ['store.content.read', 'store.content.write'] };
    next();
  }, requireAdmin: (_req, _res, next) => next() });
  mock('../server/routes/admin-auth.routes', { requireAdminGate: (req, res, next) => req.get('X-Test-Gate') === 'valid' ? next() : res.status(403).json({ error: 'ADMIN_GATE_REQUIRED' }) });
  mock('../server/core/adminReauthService', { requireAdminReauth: (req, res, next) => req.get('X-Test-Reauth') === 'valid' ? next() : res.status(401).json({ error: 'ADMIN_REAUTH_REQUIRED' }), writeSupplementalAdminAudit: async () => {}, sanitizeAuditValue: (value) => value });
  mock('../server/core/storeBalanceCodeService', { redeemBalanceCode, saveBalanceCode, listBalanceCodes: async () => [] });
  // This test isolates the role/gate/reauth chain; action proofs have real transaction tests in admin-action-regression.
  mock('../server/core/adminActionService', { requireAdminAction: (_req, _res, next) => next(), createAdminAction: () => ({}) });
  const app = express(); app.use(express.json()); app.use('/api', require('../server/routes/store.routes'));
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ error: error.code }));
  const server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.on('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: 'finance', 'Content-Type': 'application/json', 'X-Test-Gate': 'valid', 'X-Test-Reauth': 'valid' };
  try {
    for (const role of ['content-editor', 'wallet-reader']) for (const method of ['GET', 'PUT']) {
      const response = await fetch(`${origin}/api/admin/store/balance-codes${method === 'PUT' ? '/ZENTRASTORE200' : ''}`, { method, headers: { ...headers, Authorization: role }, ...(method === 'PUT' ? { body: JSON.stringify(promoBody) } : {}) });
      assert.equal(response.status, 403); assert.equal((await response.json()).error, 'ADMIN_PERMISSION_REQUIRED');
    }
    assert(!records.has('storePromotions/ZENTRASTORE200'));
    const noGate = await fetch(`${origin}/api/admin/store/balance-codes`, { headers: { ...headers, 'X-Test-Gate': '' } }); assert.equal(noGate.status, 403);
    const noReauth = await fetch(`${origin}/api/admin/store/balance-codes/ZENTRASTORE200`, { method: 'PUT', headers: { ...headers, 'X-Test-Reauth': '' }, body: JSON.stringify(promoBody) }); assert.equal(noReauth.status, 401);
    const saved = await fetch(`${origin}/api/admin/store/balance-codes/ZENTRASTORE200`, { method: 'PUT', headers, body: JSON.stringify(promoBody) }); assert.equal(saved.status, 200);
    assert.equal((await saved.json()).promotion.type, 'balance'); assert.equal(records.get('storePromotions/ZENTRASTORE200').value, 20000);
    assert.equal(saved.headers.get('cache-control').includes('no-store'), true);
    const forged = await fetch(`${origin}/api/admin/store/promotions/ZENTRASTORE200`, { method: 'PUT', headers: { ...headers, Authorization: 'content-editor' }, body: JSON.stringify({ ...body, createOnly: false }) }); assert.equal(forged.status, 409);
    assert.equal((await forged.json()).error, 'STORE_PROMOTION_TYPE_LOCKED');
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
