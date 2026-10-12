'use strict';

const crypto = require('crypto');
const { initFirebaseAdmin } = require('../config/firebaseAdmin');
const { normalizeCode, savePromotion, listPromotions } = require('./storePromotionService');
const { invalidateCreatedAtPageCache } = require('./firestorePagination');
const MAX_BALANCE_KURUS = 1_000_000_000_000;
const MAX_CREDIT_KURUS = 100_000_000;

function fail(code, statusCode = 409) { throw Object.assign(new Error(code), { code, statusCode }); }

async function redeemBalanceCode(uid, input = {}, { requestId = '' } = {}) {
  const safeUid = String(uid || '').trim();
  if (!safeUid || safeUid.includes('/') || safeUid.length > 160) fail('AUTH_REQUIRED', 401);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => key !== 'code')
    || typeof input.code !== 'string' || input.code.trim().length > 32) fail('BALANCE_CODE_INPUT_INVALID', 400);
  const code = normalizeCode(input.code);
  const { db } = initFirebaseAdmin();
  if (!db) fail('STORE_PROMOTION_UNAVAILABLE', 503);
  const transactionId = crypto.createHash('sha256').update(`balance-code\0${safeUid}\0${code}`).digest('hex');
  const receiptRef = db.collection('storeBalanceCodeRedemptions').doc(transactionId);
  const codeRef = db.collection('storePromotions').doc(code);
  const userRef = db.collection('users').doc(safeUid);
  let result;
  await db.runTransaction(async (tx) => {
    const [receipt, campaign, user] = await Promise.all([tx.get(receiptRef), tx.get(codeRef), tx.get(userRef)]);
    if (receipt.exists) {
      const row = receipt.data();
      if (row.uid !== safeUid || row.code !== code || row.transactionId !== transactionId
        || !Number.isSafeInteger(row.amountKurus) || row.amountKurus < 1 || row.amountKurus > MAX_CREDIT_KURUS) fail('BALANCE_CODE_RECEIPT_INVALID');
      result = { creditedKurus: row.amountKurus, transactionId, committed: true, idempotentReplay: true };
      return;
    }
    const row = campaign.exists ? campaign.data() || {} : {};
    if (row.type !== 'balance') fail('BALANCE_CODE_NOT_FOUND', 404);
    if (row.active !== true) fail('BALANCE_CODE_INACTIVE');
    const now = Date.now();
    if (Number(row.startsAt || 0) > now) fail('BALANCE_CODE_NOT_STARTED');
    if (Number(row.endsAt || 0) && Number(row.endsAt) <= now) fail('BALANCE_CODE_EXPIRED');
    if (!Number.isSafeInteger(row.usageLimit) || row.usageLimit < 1 || !Number.isSafeInteger(row.usedCount) || row.usedCount < 0) fail('BALANCE_CODE_CONFIGURATION_INVALID');
    if (row.usedCount >= row.usageLimit) fail('BALANCE_CODE_LIMIT_REACHED');
    const amountKurus = row.value;
    if (!Number.isSafeInteger(amountKurus) || amountKurus < 1 || amountKurus > MAX_CREDIT_KURUS) fail('BALANCE_CODE_CONFIGURATION_INVALID');
    const profile = user.exists ? user.data() || {} : {};
    if (profile.storeAccountStatus === 'suspended') fail('STORE_ACCOUNT_SUSPENDED', 403);
    const balance = profile.storeBalanceKurus ?? profile.storeWallet?.balanceKurus ?? 0;
    if (!Number.isSafeInteger(balance) || balance < 0 || balance + amountKurus > MAX_BALANCE_KURUS) fail('STORE_BALANCE_LIMIT_EXCEEDED');
    const entry = { uid: safeUid, code, amountKurus, balanceBeforeKurus: balance, balanceAfterKurus: balance + amountKurus, transactionId, requestId: String(requestId).slice(0, 180), createdAt: now };
    tx.set(userRef, { storeBalanceKurus: balance + amountKurus, storeUpdatedAt: now }, { merge: true });
    tx.update(codeRef, { usedCount: row.usedCount + 1, updatedAt: now });
    tx.create(receiptRef, entry);
    tx.create(db.collection('storeWalletLedger').doc(transactionId), { ...entry, type: 'CREDIT', reason: 'Bakiye kodu kullanımı', orderId: '', username: String(profile.username || '').slice(0, 80), actor: { uid: safeUid, source: 'balance-code' } });
    tx.create(db.collection('audit').doc(`balance_code_${transactionId}`), { uid: safeUid, action: 'store.balance-code.redeem', type: 'store-balance-code-redeem', actor: { uid: safeUid, source: 'customer' }, amountKurus, transactionId, requestId: entry.requestId, at: now, createdAt: now });
    result = { creditedKurus: amountKurus, transactionId, committed: true, idempotentReplay: false };
  });
  invalidateCreatedAtPageCache('storeWalletLedger');
  return result;
}

async function saveBalanceCode(code, input = {}, actor = {}) {
  const fields = ['title', 'value', 'usageLimit', 'perUserLimit', 'startsAt', 'endsAt', 'active', 'createOnly'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((field) => !fields.includes(field))
    || typeof input.title !== 'string' || !input.title.trim() || input.title.length > 100
    || typeof input.createOnly !== 'boolean' || typeof input.active !== 'boolean'
    || !Number.isSafeInteger(input.value) || input.value < 1 || input.value > MAX_CREDIT_KURUS
    || !Number.isSafeInteger(input.usageLimit) || input.usageLimit < 1 || input.usageLimit > 1000000
    || (input.perUserLimit !== undefined && input.perUserLimit !== 1)) fail('BALANCE_CODE_INPUT_INVALID', 400);
  if (typeof code !== 'string' || !/^[A-Z0-9][A-Z0-9_-]{2,31}$/.test(code.trim().toUpperCase())) fail('STORE_PROMOTION_CODE_INVALID', 400);
  if ([input.startsAt, input.endsAt].some((time) => time !== undefined && (!Number.isSafeInteger(time) || time < 0 || time > 8640000000000000))) fail('STORE_PROMOTION_DATE_INVALID', 400);
  return savePromotion(code, { ...input, type: 'balance', perUserLimit: 1, visibleInWallet: false }, actor, { canManageBalance: true, kind: 'balance' });
}

async function listBalanceCodes() { return listPromotions({ kind: 'balance' }); }

module.exports = { redeemBalanceCode, saveBalanceCode, listBalanceCodes };
