'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { memoryFirestore, mockModule, admin } = require('./helpers/memory-firestore.cjs');
process.env.NODE_ENV = 'development';
let db;
const code = 'ZA-' + 'A'.repeat(24), actor = { uid: 'operator', email: 'admin@example.test' };
const profile = (username, amount = 0) => ({ username, usernameLower: username.toLowerCase(), email: `${username}@example.test`,
  storeBalanceKurus: amount, storeAccountStatus: 'active', storeProfile: { avatarId: '1' } });
const auth = { getUser: async uid => {
  const row = db.records.get(`users/${uid}`);
  if (!row) throw Object.assign(new Error('missing'), { code: 'auth/user-not-found' });
  return { uid, email: row.email, disabled: row.identityDisabled === true };
} };
mockModule('../../server/config/firebaseAdmin', { initFirebaseAdmin: () => ({ db, auth, admin, enabled: true }) });
const catalog = { version: 78, storefront: {}, telegramUsername: 'ZENTRA_STORE', products: [{ id: 'affiliate-product', name: 'Affiliate product', active: true,
  platform: 'android', fulfillmentMode: 'automatic', automaticEnabled: true, telegramEnabled: true, plans: [{ key: 'day', priceKurus: 10000, label: 'Day', duration: '1 day' }] }] };
mockModule('../../server/core/storeCatalogService', { getEffectiveCatalog: async () => structuredClone(catalog) });
mockModule('../../server/core/storeInventoryService', { invalidateStockCache() {}, decorateCatalogWithStock: async x => x,
  allocateInventoryInTransaction: async ({ tx, db, orderId }) => { tx.create(db.collection('testStock').doc(orderId), { orderId }); return [{ id: orderId }]; } });
const affiliate = require('../server/core/storeAffiliateService');
const transfers = require('../server/core/storeTransferService');
const store = require('../server/core/storeService');
const { MAX_STORE_BALANCE_KURUS } = require('../server/core/storeMoney');
function reset(rate = 30) {
  db = memoryFirestore([['users/partner', profile('PartnerOne')], ['users/buyer', profile('BuyerUser', 100000)], ['users/receiver', profile('ReceiverOne')],
    [`storeAffiliateLinks/${code}`, { title: 'Partner campaign', ownerUid: 'partner', ownerUsername: 'PartnerOne', rate, active: true, commissionEnabled: true,
      createdAt: Date.now() - 10000, updatedAt: Date.now() - 10000, referralCount: 0, paidOrders: 0, earnedKurus: 0, reversedKurus: 0 }]]);
  db.records.get('users/buyer').storeAffiliate = { code, ownerUid: 'partner', rate, boundAt: Date.now() };
  catalog.products[0].plans[0].priceKurus = 10000;
}
const purchase = (key = 'affiliate-purchase-0001', method = 'wallet') => store.createOrder({ uid: 'buyer', authUser: { uid: 'buyer', email: 'BuyerUser@example.test' },
  paymentMethod: method, idempotencyKey: key, rawItems: [{ productId: 'affiliate-product', planKey: 'day', quantity: 1 }] });
const transfer = (overrides = {}, uid = 'buyer') => transfers.transferBalance(uid, { recipientUsername: 'ReceiverOne', recipientUid: 'receiver', amountKurus: 10000,
  idempotencyKey: 'transfer-idempotency-0001', ...overrides }, 'test-request');

test('all six affiliate rates credit authoritative paid totals once, including repeated order requests', async () => {
  for (const rate of affiliate.AFFILIATE_RATES) {
    reset(rate); const results = await Promise.all([purchase(), purchase()]);
    assert.equal(results[0].order.id, results[1].order.id);
    assert.equal(db.records.get('users/partner').storeBalanceKurus, rate * 100);
    assert.equal(db.records.get('users/buyer').storeBalanceKurus, 90000);
    assert.equal([...db.records.keys()].filter(x => x.startsWith('storeAffiliateCommissions/')).length, 1);
  }
});
test('manual approval and refund follow existing transition rules without duplicate commissions', async () => {
  reset(); const result = await purchase('affiliate-manual-0002', 'telegram'), id = result.order.id;
  const update = status => store.updateOrderByAdmin({ orderId: id, input: { status }, actor });
  assert.equal(db.records.get('users/partner').storeBalanceKurus, 0);
  await update('paid'); await update('paid'); await update('processing');
  assert.equal(db.records.get('users/partner').storeBalanceKurus, 3000);
  await update('refunded'); await update('refunded');
  assert.equal(db.records.get('users/partner').storeBalanceKurus, 0);
  assert.equal(db.records.get(`storeAffiliateCommissions/${id}`).reversedKurus, 3000);
});
test('a spent commission refund creates recoverable debt and cannot be used for transfers or purchases', async () => {
  reset(); const result = await purchase();
  await transfers.transferBalance('partner', { recipientUsername: 'ReceiverOne', recipientUid: 'receiver', amountKurus: 3000, idempotencyKey: 'partner-send-000001' });
  await store.updateOrderByAdmin({ orderId: result.order.id, input: { status: 'refunded' }, actor });
  assert.equal(db.records.get('users/buyer').storeBalanceKurus, 100000);
  assert.equal(db.records.get('users/partner').storeAffiliateDebtKurus, 3000);
  await assert.rejects(transfer({ amountKurus: 4 }, 'partner'), { code: 'TRANSFER_ACCOUNT_BLOCKED' });
  await assert.rejects(store.createOrder({ uid: 'partner', authUser: { email: 'PartnerOne@example.test' }, paymentMethod: 'wallet', idempotencyKey: 'partner-order-00001', rawItems: [{ productId: 'affiliate-product', planKey: 'day' }] }), { code: 'AFFILIATE_DEBT_OUTSTANDING' });
  await purchase('affiliate-purchase-0002');
  assert.equal(db.records.get('users/partner').storeAffiliateDebtKurus, 0);
  assert.equal(db.records.get('users/partner').storeBalanceKurus, 0);
  db.records.get('users/partner').storeAffiliateDebtKurus = 1000;
  db.records.get('users/partner').storeBalanceKurus = 1500;
  const account = await store.readAccount('partner', { email: 'PartnerOne@example.test' });
  assert.equal(account.balanceKurus, 500); assert.equal(account.affiliateDebtKurus, 0);
});
test('commission failure rolls back buyer, stock, order, ledger and beneficiary together', async () => {
  reset(); const before = structuredClone(db.records); db.setFailure(true);
  await assert.rejects(purchase(), { code: 'CONTROLLED_COMMIT_FAILURE' }); assert.deepEqual(db.records, before);
  db.setFailure(false); db.records.get('users/partner').storeBalanceKurus = MAX_STORE_BALANCE_KURUS;
  await assert.rejects(purchase(), { code: 'STORE_BALANCE_LIMIT_EXCEEDED' });
  assert.equal(db.records.get('users/buyer').storeBalanceKurus, 100000);
});
test('new registrations lock ownership and rate permanently, and paused links reject new registrations', async () => {
  reset(); db.records.get('users/buyer').storeAffiliate = null;
  const bind = current => db.runTransaction(async tx => {
    const registration = await affiliate.readAffiliateRegistration({ tx, db, uid: 'buyer', current, code, createdAt: Date.now() - 5000 });
    const patch = affiliate.applyAffiliateRegistration({ tx, db, uid: 'buyer', registration, now: Date.now() });
    tx.set(db.collection('users').doc('buyer'), patch, { merge: true });
  });
  await bind({ profileInitializationPending: true });
  assert.equal(db.records.get('users/buyer').storeAffiliate.rate, 30);
  assert.equal(db.records.get(`storeAffiliateLinks/${code}`).referralCount, 1);
  db.records.get(`storeAffiliateLinks/${code}`).rate = 5;
  await bind(db.records.get('users/buyer'));
  assert.equal(db.records.get('users/buyer').storeAffiliate.rate, 30);
  assert.equal(db.records.get(`storeAffiliateLinks/${code}`).referralCount, 1);
  db.records.get(`storeAffiliateLinks/${code}`).active = false;
  await assert.rejects(bind({ profileInitializationPending: true }), { code: 'AFFILIATE_UNAVAILABLE' });
});
test('existing accounts, self-referral and forged old identity dates cannot attach a new affiliate', async () => {
  reset();
  const read = options => db.runTransaction(tx => affiliate.readAffiliateRegistration({ tx, db, uid: 'buyer', current: { profileInitializationPending: true }, code, createdAt: Date.now() - 5000, ...options }));
  await assert.rejects(read({ current: { firstName: 'OldUser' } }), { code: 'AFFILIATE_ALREADY_BOUND' });
  await assert.rejects(read({ uid: 'partner' }), { code: 'AFFILIATE_SELF_REFERRAL' });
  await assert.rejects(read({ createdAt: Date.now() - 7200000 }), { code: 'AFFILIATE_REGISTRATION_ONLY' });
});
test('registration pause preserves existing earnings, while commission pause prevents new approved earnings', async () => {
  reset(); db.records.get(`storeAffiliateLinks/${code}`).active = false;
  await purchase(); assert.equal(db.records.get('users/partner').storeBalanceKurus, 3000);
  db.records.get(`storeAffiliateLinks/${code}`).commissionEnabled = false;
  const order = await purchase('affiliate-purchase-0002', 'telegram');
  await store.updateOrderByAdmin({ orderId: order.order.id, input: { status: 'paid' }, actor });
  db.records.get(`storeAffiliateLinks/${code}`).commissionEnabled = true;
  await store.updateOrderByAdmin({ orderId: order.order.id, input: { status: 'processing' }, actor });
  assert.equal(db.records.get('users/partner').storeBalanceKurus, 3000);
});
test('transfer debits 100 TL, credits 25 TL, records 75 TL fee, and concurrent replays execute once', async () => {
  reset(); const results = await Promise.all([transfer(), transfer()]);
  assert.equal(results[0].transfer.id, results[1].transfer.id);
  assert.equal(results[0].transfer.feeKurus, 7500); assert.equal(results[0].transfer.netKurus, 2500);
  assert.equal(db.records.get('users/buyer').storeBalanceKurus, 90000);
  assert.equal(db.records.get('users/receiver').storeBalanceKurus, 2500);
  assert.equal(db.records.get('users/partner').storeBalanceKurus, 0);
  assert.equal([...db.records.keys()].filter(x => x.startsWith('storeWalletLedger/')).length, 2);
  await assert.rejects(transfer({ amountKurus: 20000 }), { code: 'TRANSFER_CONFLICT' });
});
test('simultaneous distinct transfers cannot overspend, and failed commits leave both accounts untouched', async () => {
  reset(); db.records.get('users/buyer').storeBalanceKurus = 10000;
  const results = await Promise.allSettled([transfer(), transfer({ idempotencyKey: 'different-transfer-0001' })]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(results.find(x => x.status === 'rejected').reason.code, 'STORE_INSUFFICIENT_BALANCE');
  reset(); const before = structuredClone(db.records); db.setFailure(true);
  await assert.rejects(transfer(), { code: 'CONTROLLED_COMMIT_FAILURE' }); assert.deepEqual(db.records, before);
  db.setFailure(false); await transfer(); assert.equal(db.records.get('users/receiver').storeBalanceKurus, 2500);
});
test('invalid amounts, self transfers, suspended receivers, stale usernames and balance overflow fail closed', async () => {
  for (const amount of [0, 3, -100, 1.5, '10000', true, NaN, Infinity, 100000001]) {
    reset(); await assert.rejects(transfer({ amountKurus: amount }), { code: 'TRANSFER_AMOUNT_INVALID' });
    assert.equal(db.records.get('users/buyer').storeBalanceKurus, 100000);
  }
  reset(); await assert.rejects(transfer({ recipientUsername: 'BuyerUser', recipientUid: 'buyer' }), { code: 'TRANSFER_RECIPIENT_INVALID' });
  db.records.get('users/receiver').storeAccountStatus = 'suspended'; await assert.rejects(transfer(), { code: 'TRANSFER_RECIPIENT_INVALID' });
  reset(); await assert.rejects(transfer({ recipientUid: 'partner' }), { code: 'TRANSFER_RECIPIENT_CHANGED' });
  db.records.get('users/receiver').storeBalanceKurus = MAX_STORE_BALANCE_KURUS;
  await assert.rejects(transfer(), { code: 'STORE_BALANCE_LIMIT_EXCEEDED' });
  assert.deepEqual(transfers.transferAmounts(101), { amountKurus: 101, netKurus: 25, feeKurus: 76, feePercent: 75 });
});
test('affiliate admin edits reject unsupported rates, preserve immutable owner and log each change', async () => {
  reset(); const body = { title: 'Partner new campaign', ownerUsername: 'PartnerOne', rate: 25, active: true, commissionEnabled: true };
  const saved = await affiliate.saveAffiliateLink(code, body, actor); assert.equal(saved.rate, 25);
  await assert.rejects(affiliate.saveAffiliateLink(code, { ...body, rate: 26 }, actor), { code: 'AFFILIATE_INPUT_INVALID' });
  await assert.rejects(affiliate.saveAffiliateLink(code, { ...body, ownerUsername: 'BuyerUser' }, actor), { code: 'AFFILIATE_OWNER_IMMUTABLE' });
  assert([...db.records.values()].some(row => row.type === 'store-affiliate-link'));
});

test('commission uses the discounted paid total, and customer cancellation reverses legacy paid-wallet commission atomically', async () => {
  reset();
  db.records.set('storePromotions/HALF50', { code: 'HALF50', title: 'Half price', type: 'percent', value: 50, active: true,
    usageLimit: 100, perUserLimit: 1, usedCount: 0, minimumSubtotalKurus: 0, maxDiscountKurus: 0, startsAt: 0, endsAt: 0, platforms: [], productIds: [] });
  const result = await store.createOrder({ uid: 'buyer', authUser: { email: 'BuyerUser@example.test' }, paymentMethod: 'wallet',
    promotionCode: 'HALF50', idempotencyKey: 'affiliate-discount-0001', rawItems: [{ productId: 'affiliate-product', planKey: 'day' }] });
  assert.equal(result.order.totalKurus, 5000); assert.equal(db.records.get('users/partner').storeBalanceKurus, 1500);
  db.records.get(`storeOrders/${result.order.id}`).status = 'paid';
  await store.cancelOrderByUser({ uid: 'buyer', orderId: result.order.id });
  await store.cancelOrderByUser({ uid: 'buyer', orderId: result.order.id });
  assert.equal(db.records.get('users/buyer').storeBalanceKurus, 100000);
  assert.equal(db.records.get('users/partner').storeBalanceKurus, 0);
  assert.equal(db.records.get('storePromotions/HALF50').usedCount, 0);
});

test('security-blocked beneficiaries receive a held commission; release is authorized by state and idempotent', async () => {
  reset(); db.records.get('users/partner').storeSecurity={state:'blocked'};
  const result=await purchase(), id=result.order.id;
  assert.equal(db.records.get('users/partner').storeBalanceKurus,0);
  assert.equal(db.records.get(`storeAffiliateCommissions/${id}`).status,'held');
  assert.equal(db.records.get(`storeAffiliateLinks/${code}`).heldKurus,3000);
  await assert.rejects(affiliate.releaseHeldCommission(id,actor),{code:'AFFILIATE_HOLD_NOT_RELEASABLE'});
  db.records.get('users/partner').storeSecurity.state='active';
  const releases=await Promise.all([affiliate.releaseHeldCommission(id,actor),affiliate.releaseHeldCommission(id,actor)]);
  assert.equal(releases.filter(x=>x.idempotentReplay).length,1);
  assert.equal(db.records.get('users/partner').storeBalanceKurus,3000);
  assert.equal(db.records.get(`storeAffiliateLinks/${code}`).heldKurus,0);
  await store.updateOrderByAdmin({orderId:id,input:{status:'refunded'},actor});
  assert.equal(db.records.get('users/partner').storeBalanceKurus,0);
});
test('refunding an unpaid held commission creates no beneficiary debt and cannot later be released', async () => {
  reset(); db.records.get('users/partner').storeSecurity={state:'blocked'};db.records.get('users/partner').storeBalanceKurus=1000;
  const result=await purchase(),id=result.order.id;
  await store.updateOrderByAdmin({orderId:id,input:{status:'refunded'},actor});
  assert.equal(db.records.get('users/partner').storeBalanceKurus,1000);
  assert.equal(db.records.get('users/partner').storeAffiliateDebtKurus,0);
  assert.equal(db.records.get(`storeAffiliateLinks/${code}`).heldKurus,0);
  db.records.get('users/partner').storeSecurity.state='active';
  await assert.rejects(affiliate.releaseHeldCommission(id,actor),{code:'AFFILIATE_HOLD_NOT_RELEASABLE'});
});
