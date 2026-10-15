'use strict';
const { requireEconomicAccount } = require('./storeAccountPolicy');

const crypto = require('crypto');
const { initFirebaseAdmin } = require('../config/firebaseAdmin');
const { findUsernameProfiles, validateUsername, usernameKeys } = require('./storeUsername');
const { readStoredBalance, MAX_STORE_BALANCE_KURUS } = require('./storeMoney');
const { debtOf } = require('./storeAffiliateService');
const { createdAtPage, invalidateCreatedAtPageCache } = require('./firestorePagination');
const fail = (code, statusCode = 400) => { throw Object.assign(new Error(code), { code, statusCode }); };
const MAX_TRANSFER_KURUS = 100_000_000;
function transferAmounts(amountKurus) {
  if (!Number.isSafeInteger(amountKurus) || amountKurus < 4 || amountKurus > MAX_TRANSFER_KURUS) fail('TRANSFER_AMOUNT_INVALID');
  // Never over-credit the recipient: any sub-kuruş remainder belongs to the fee.
  const netKurus = Math.floor(amountKurus / 4);
  return { amountKurus, netKurus, feeKurus: amountKurus - netKurus, feePercent: 75 };
}
function storage() {
  const { db, auth } = initFirebaseAdmin();
  if (!db || !auth) fail('STORE_STORAGE_UNAVAILABLE', 503);
  return { db, auth };
}
async function resolveRecipient(db, auth, uid, username) {
  const matches = await findUsernameProfiles(db, username);
  if (matches.length !== 1 || matches[0].id === uid) fail('TRANSFER_RECIPIENT_INVALID', 409);
  const doc = matches[0], profile = doc.data();
  let identity;
  try { identity = await auth.getUser(doc.id); } catch (error) {
    if (error.code === 'auth/user-not-found') fail('TRANSFER_RECIPIENT_INVALID', 409);
    throw error;
  }
  if (identity.disabled || (profile.storeAccountStatus && profile.storeAccountStatus !== 'active') || profile.profileInitializationPending === true) fail('TRANSFER_RECIPIENT_INVALID', 409);
  requireEconomicAccount(profile);
  return { uid: doc.id, username: profile.username };
}
async function previewTransfer(uid, input = {}) {
  const amounts = transferAmounts(input.amountKurus), { db, auth } = storage();
  const recipient = await resolveRecipient(db, auth, uid, validateUsername(input.recipientUsername));
  const senderDoc = await db.collection('users').doc(uid).get(), sender = senderDoc.data() || {};
  requireEconomicAccount(sender);
  if (!senderDoc.exists || (sender.storeAccountStatus && sender.storeAccountStatus !== 'active') || sender.profileInitializationPending === true || debtOf(sender)) fail('TRANSFER_ACCOUNT_BLOCKED', 403);
  if (readStoredBalance(sender) < amounts.amountKurus) fail('STORE_INSUFFICIENT_BALANCE', 409);
  return { recipient, ...amounts };
}
async function transferBalance(uid, input = {}, requestId = '') {
  if (!uid) fail('AUTH_REQUIRED', 401);
  const amounts = transferAmounts(input.amountKurus), username = validateUsername(input.recipientUsername);
  if (typeof input.idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{16,160}$/.test(input.idempotencyKey)
    || typeof input.recipientUid !== 'string' || !input.recipientUid || input.recipientUid.length > 128 || /[\/\u0000-\u001f]/.test(input.recipientUid)) fail('TRANSFER_INPUT_INVALID');
  const { db, auth } = storage();
  const id = crypto.createHash('sha256').update(`transfer:${uid}:${input.idempotencyKey}`).digest('hex');
  const requestHash = crypto.createHash('sha256').update(JSON.stringify({ username, recipientUid: input.recipientUid, amountKurus: amounts.amountKurus })).digest('hex');
  const ref = db.collection('storeTransfers').doc(id);
  const replay = await ref.get();
  if (replay.exists) {
    if (replay.data().requestHash !== requestHash) fail('TRANSFER_CONFLICT', 409);
    return { transfer: replay.data().receipt, idempotentReplay: true };
  }
  const recipient = await resolveRecipient(db, auth, uid, username);
  if (recipient.uid !== input.recipientUid) fail('TRANSFER_RECIPIENT_CHANGED', 409);
  let result;
  await db.runTransaction(async tx => {
    const previous = await tx.get(ref);
    if (previous.exists) {
      if (previous.data().requestHash !== requestHash) fail('TRANSFER_CONFLICT', 409);
      result = { transfer: previous.data().receipt, idempotentReplay: true }; return;
    }
    const senderRef = db.collection('users').doc(uid), recipientRef = db.collection('users').doc(recipient.uid);
    const [senderDoc, recipientDoc] = await Promise.all([tx.get(senderRef), tx.get(recipientRef)]);
    const sender = senderDoc.data() || {}, receiver = recipientDoc.data() || {};
    requireEconomicAccount(sender); requireEconomicAccount(receiver);
    if (!senderDoc.exists || (sender.storeAccountStatus && sender.storeAccountStatus !== 'active') || sender.profileInitializationPending === true || debtOf(sender)) fail('TRANSFER_ACCOUNT_BLOCKED', 403);
    if (!recipientDoc.exists || receiver.profileInitializationPending === true || (receiver.storeAccountStatus && receiver.storeAccountStatus !== 'active') || !usernameKeys(receiver.username).some(k => usernameKeys(username).includes(k))) fail('TRANSFER_RECIPIENT_CHANGED', 409);
    const senderBalance = readStoredBalance(sender), recipientBalance = readStoredBalance(receiver);
    if (senderBalance < amounts.amountKurus) fail('STORE_INSUFFICIENT_BALANCE', 409);
    if (recipientBalance + amounts.netKurus > MAX_STORE_BALANCE_KURUS) fail('STORE_BALANCE_LIMIT_EXCEEDED', 409);
    const now = Date.now(), receipt = { id, senderUid: uid, senderUsername: sender.username, recipientUid: recipient.uid,
      recipientUsername: receiver.username, ...amounts, createdAt: now };
    tx.set(senderRef, { storeBalanceKurus: senderBalance - amounts.amountKurus, storeUpdatedAt: now }, { merge: true });
    tx.set(recipientRef, { storeBalanceKurus: recipientBalance + amounts.netKurus, storeUpdatedAt: now }, { merge: true });
    tx.create(ref, { uid, requestHash, receipt, createdAt: now });
    for (const [suffix, targetUid, type, delta, before, after, counterparty] of [
      ['out', uid, 'TRANSFER_OUT', -amounts.amountKurus, senderBalance, senderBalance - amounts.amountKurus, receiver.username],
      ['in', recipient.uid, 'TRANSFER_IN', amounts.netKurus, recipientBalance, recipientBalance + amounts.netKurus, sender.username]
    ]) tx.create(db.collection('storeWalletLedger').doc(`transfer_${id}_${suffix}`), {
      uid: targetUid, type, amountKurus: delta, balanceBeforeKurus: before, balanceAfterKurus: after,
      feeKurus: amounts.feeKurus, netKurus: amounts.netKurus, transactionId: id,
      reason: `${type === 'TRANSFER_OUT' ? 'Gönderilen' : 'Alınan'} bakiye transferi · ${counterparty} · %75 kesinti`,
      actor: { uid, source: 'customer-transfer' }, createdAt: now
    });
    tx.create(db.collection('audit').doc(`transfer_${id}`), { uid, type: 'store-wallet-transfer', ...receipt, requestId, at: now });
    result = { transfer: receipt, idempotentReplay: false };
  });
  invalidateCreatedAtPageCache('storeWalletLedger');
  return result;
}
async function customerWalletHistory(uid, cursor = '') {
  const { db } = storage();
  const page = await createdAtPage({ db, collection: 'storeWalletLedger', filters: [['uid', uid]], limit: 20, cursor });
  return { entries: page.docs.map(doc => { const row = doc.data(); return { id: doc.id, type: row.type,
    amountKurus: row.amountKurus, feeKurus: row.feeKurus || 0, netKurus: row.netKurus || 0, reason: row.reason,
    transactionId: row.transactionId || doc.id, createdAt: row.createdAt }; }), nextCursor: page.nextCursor, hasMore: page.hasMore };
}
module.exports = { transferAmounts, previewTransfer, transferBalance, customerWalletHistory };
