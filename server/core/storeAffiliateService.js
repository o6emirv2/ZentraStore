'use strict';

const env = require('../config/env');
const { securityBlocked } = require('./storeAccountPolicy');
const { initFirebaseAdmin } = require('../config/firebaseAdmin');
const { findUsernameProfiles } = require('./storeUsername');
const { readStoredBalance, checkedBalance, MAX_STORE_BALANCE_KURUS } = require('./storeMoney');
const { createdAtPage, invalidateCreatedAtPageCache } = require('./firestorePagination');
const AFFILIATE_RATES = Object.freeze([5, 10, 15, 20, 25, 30]);
const fail = (code, statusCode = 400) => { throw Object.assign(new Error(code), { code, statusCode }); };
const validCode = value => typeof value === 'string' && /^ZA-[A-Z0-9]{24}$/.test(value);
const debtOf = profile => checkedBalance(profile.storeAffiliateDebtKurus ?? 0);

function storage() {
  const { db, auth } = initFirebaseAdmin();
  if (!db || !auth) fail('STORE_STORAGE_UNAVAILABLE', 503);
  return { db, auth };
}
function presentLink(data, code) {
  return { code, title: data.title, ownerUid: data.ownerUid, ownerUsername: data.ownerUsername,
    rate: data.rate, active: data.active === true, commissionEnabled: data.commissionEnabled !== false,
    referralCount: data.referralCount || 0, paidOrders: data.paidOrders || 0,
    heldKurus: data.heldKurus || 0, earnedKurus: data.earnedKurus || 0, reversedKurus: data.reversedKurus || 0,
    createdAt: data.createdAt, updatedAt: data.updatedAt,
    url: `${env.publicBaseUrl}/?ref=${encodeURIComponent(code)}` };
}
async function resolveAffiliateLink(code) {
  if (!validCode(code)) fail('AFFILIATE_UNAVAILABLE', 404);
  const { db } = storage(), doc = await db.collection('storeAffiliateLinks').doc(code).get();
  const data = doc.data();
  if (!doc.exists || data.active !== true) fail('AFFILIATE_UNAVAILABLE', 404);
  return { code, title: data.title, rate: data.rate };
}
async function listAffiliateLinks({ limit = 30, cursor = '' } = {}) {
  const { db } = storage();
  const page = await createdAtPage({ db, collection: 'storeAffiliateLinks', limit: Math.max(1, Math.min(100, Number(limit) || 30)), cursor });
  return { links: page.docs.map(doc => presentLink(doc.data(), doc.id)), nextCursor: page.nextCursor, hasMore: page.hasMore };
}
async function saveAffiliateLink(code, input, actor = {}) {
  const { db, auth } = storage();
  if (!actor.uid) fail('ADMIN_REQUIRED', 403);
  if (!validCode(code) || !AFFILIATE_RATES.includes(input.rate) || typeof input.active !== 'boolean'
    || typeof input.commissionEnabled !== 'boolean' || typeof input.title !== 'string' || input.title.trim().length < 2
    || input.title.length > 80 || /[<>\u0000-\u001f]/.test(input.title)) fail('AFFILIATE_INPUT_INVALID');
  const existing = await db.collection('storeAffiliateLinks').doc(code).get();
  let ownerUid = '', ownerUsername = '';
  if (!existing.exists) {
    const matches = await findUsernameProfiles(db, input.ownerUsername);
    if (matches.length !== 1) fail('AFFILIATE_OWNER_INVALID', 409);
    ownerUid = matches[0].id; ownerUsername = matches[0].data().username;
    let owner;
    try { owner = await auth.getUser(ownerUid); } catch (error) {
      if (error.code === 'auth/user-not-found') fail('AFFILIATE_OWNER_INVALID', 409);
      throw error;
    }
    if (owner.disabled || securityBlocked(matches[0].data())) fail('AFFILIATE_OWNER_INVALID', 409);
  }
  let result;
  await db.runTransaction(async tx => {
    const ref = db.collection('storeAffiliateLinks').doc(code), snapshot = await tx.get(ref), current = snapshot.data() || {};
    if (input.createOnly === true && snapshot.exists) {
      if (current.createdBy !== actor.uid || current.ownerUsername !== input.ownerUsername
        || current.rate !== input.rate || current.title !== input.title.trim()
        || current.active !== input.active || current.commissionEnabled !== input.commissionEnabled) fail('AFFILIATE_LINK_CONFLICT', 409);
      result = presentLink(current, code); return;
    }
    if (!snapshot.exists && !ownerUid) fail('AFFILIATE_LINK_CONFLICT', 409);
    if (snapshot.exists && input.ownerUsername !== current.ownerUsername) fail('AFFILIATE_OWNER_IMMUTABLE', 409);
    const now = Date.now();
    const patch = { title: input.title.trim(), rate: input.rate, active: input.active, commissionEnabled: input.commissionEnabled,
      updatedAt: now, updatedBy: actor.uid, ...(!snapshot.exists ? { ownerUid, ownerUsername, createdBy: actor.uid,
        createdAt: now, referralCount: 0, paidOrders: 0, earnedKurus: 0, reversedKurus: 0 } : {}) };
    tx.set(ref, patch, { merge: true });
    tx.create(db.collection('audit').doc(), { type: 'store-affiliate-link', uid: actor.uid, code,
      before: snapshot.exists ? { rate: current.rate, active: current.active, commissionEnabled: current.commissionEnabled } : null,
      after: patch, at: now });
    result = presentLink({ ...current, ...patch }, code);
  });
  invalidateCreatedAtPageCache('storeAffiliateLinks');
  return result;
}

// Runs during the first profile initialization only. Both the user and link participate in the commit.
async function readAffiliateRegistration({ tx, db, uid, current, code, createdAt }) {
  const locked = current.storeAffiliateLocked === true || (current.profileInitializationPending !== true && !!current.firstName);
  if (locked) {
    if (code && code !== current.storeAffiliate?.code) fail('AFFILIATE_ALREADY_BOUND', 409);
    return null;
  }
  if (!code) return { binding: null };
  if (!validCode(code) || !Number.isFinite(createdAt) || createdAt < Date.now() - 3_600_000 || createdAt > Date.now() + 30_000) fail('AFFILIATE_REGISTRATION_ONLY', 409);
  const ref = db.collection('storeAffiliateLinks').doc(code), doc = await tx.get(ref), link = doc.data() || {};
  if (!doc.exists || link.active !== true || !AFFILIATE_RATES.includes(link.rate) || link.createdAt > createdAt) fail('AFFILIATE_UNAVAILABLE', 409);
  if (link.ownerUid === uid) fail('AFFILIATE_SELF_REFERRAL', 409);
  const owner = await tx.get(db.collection('users').doc(link.ownerUid));
  if (!owner.exists || securityBlocked(owner.data())) fail('AFFILIATE_UNAVAILABLE', 409);
  return { ref, link, binding: { code, ownerUid: link.ownerUid, rate: link.rate, boundAt: Date.now() } };
}
function applyAffiliateRegistration({ tx, db, uid, registration, now }) {
  if (!registration) return {};
  if (registration.binding) {
    tx.set(registration.ref, { referralCount: (registration.link.referralCount || 0) + 1, updatedAt: now }, { merge: true });
    tx.create(db.collection('storeAffiliateReferrals').doc(uid), { uid, ...registration.binding, createdAt: now });
    tx.create(db.collection('audit').doc(), { type: 'store-affiliate-registration', uid, ...registration.binding, at: now });
  }
  return { storeAffiliateLocked: true, storeAffiliate: registration.binding };
}

// Read phase is deliberately separate: inventory and promotions also require reads before any writes.
async function readAffiliateCommission({ tx, db, orderId, order, reverse = false }) {
  const binding = order.affiliate;
  if (!binding?.code || !binding.ownerUid || binding.ownerUid === order.uid || !AFFILIATE_RATES.includes(binding.rate)) return null;
  const receiptRef = db.collection('storeAffiliateCommissions').doc(orderId), receipt = await tx.get(receiptRef);
  if (reverse ? (!receipt.exists || receipt.data().reversedAt) : receipt.exists) return null;
  const linkRef = db.collection('storeAffiliateLinks').doc(binding.code), linkDoc = await tx.get(linkRef), link = linkDoc.data() || {};
  if (!reverse && (!linkDoc.exists || link.ownerUid !== binding.ownerUid || link.commissionEnabled === false)) return null;
  const ownerRef = db.collection('users').doc(binding.ownerUid), ownerDoc = await tx.get(ownerRef);
  if (!ownerDoc.exists) fail('AFFILIATE_OWNER_INVALID', 409);
  const owner = ownerDoc.data(), balance = readStoredBalance(owner), debt = debtOf(owner);
  const buyerDoc = !reverse ? await tx.get(db.collection('users').doc(order.uid)) : null;
  const held = reverse ? receipt.data().status === 'held' : securityBlocked(owner) || securityBlocked(buyerDoc?.data() || {});
  const reversingHold = reverse && held;
  // Integer kuruş only; discard sub-kuruş commission fractions.
  const amount = reverse ? receipt.data().amountKurus : Math.floor(checkedBalance(order.totalKurus) * binding.rate / 100);
  const recoveredDebt = reverse || held ? 0 : Math.min(debt, amount);
  const removed = reverse && !reversingHold ? Math.min(balance, amount) : 0;
  const nextBalance = held ? balance : reverse ? balance - removed : balance + amount - recoveredDebt;
  const nextDebt = held ? debt : reverse ? debt + amount - removed : debt - recoveredDebt;
  if (nextBalance > MAX_STORE_BALANCE_KURUS || nextDebt > MAX_STORE_BALANCE_KURUS) fail('STORE_BALANCE_LIMIT_EXCEEDED', 409);
  return { held, reversingHold, binding, receiptRef, linkRef, link, ownerRef, balance, debt, amount, recoveredDebt, nextBalance, nextDebt, reverse, receipt: receipt.data() };
}
function applyAffiliateCommission({ tx, db, commission: c, orderId, uid, now }) {
  if (!c) return;
  const delta = c.nextBalance - c.balance;
  tx.set(c.ownerRef, { storeBalanceKurus: c.nextBalance, storeAffiliateDebtKurus: c.nextDebt, storeUpdatedAt: now }, { merge: true });
  if (c.reverse) tx.set(c.receiptRef, { reversedAt: now, reversedKurus: c.amount }, { merge: true });
  else tx.create(c.receiptRef, { uid, ownerUid: c.binding.ownerUid, code: c.binding.code, rate: c.binding.rate,
    amountKurus: c.amount, orderId, createdAt: now, reversedAt: 0, status: c.held ? 'held' : 'credited' });
  const linkPatch = c.held
    ? { heldKurus: Math.max(0, (c.link.heldKurus || 0) + (c.reverse ? -c.amount : c.amount)), ...(!c.reverse ? { paidOrders: (c.link.paidOrders || 0) + 1 } : {}) }
    : c.reverse ? { reversedKurus: (c.link.reversedKurus || 0) + c.amount }
      : { earnedKurus: (c.link.earnedKurus || 0) + c.amount, paidOrders: (c.link.paidOrders || 0) + 1 };
  tx.set(c.linkRef, linkPatch, { merge: true });
  const type = c.held ? (c.reverse ? 'AFFILIATE_HOLD_CANCELLED' : 'AFFILIATE_HELD') : c.reverse ? 'AFFILIATE_REVERSAL' : 'AFFILIATE_COMMISSION';
  tx.create(db.collection('storeWalletLedger').doc(`affiliate_${c.reverse ? 'reverse_' : ''}${orderId}`), {
    uid: c.binding.ownerUid, type, amountKurus: delta, commissionKurus: c.amount,
    debtBeforeKurus: c.debt, debtAfterKurus: c.nextDebt, balanceBeforeKurus: c.balance, balanceAfterKurus: c.nextBalance,
    orderId, reason: c.held ? (c.reverse ? 'İptal edilen bekleyen komisyon' : 'Hesap güvenliği incelemesi için bekletilen komisyon') : c.reverse ? 'İade / iptal edilen alışveriş komisyonunun geri alınması' : `%${c.binding.rate} referans alışveriş komisyonu`,
    actor: { uid: 'system', source: 'affiliate' }, createdAt: now
  });
  tx.create(db.collection('audit').doc(), { uid: c.binding.ownerUid, type: type.toLowerCase(), orderId,
    amountKurus: c.amount, debtAfterKurus: c.nextDebt, at: now });
}
async function releaseHeldCommission(orderId, actor) {
  if (!actor?.uid || typeof orderId !== 'string' || !/^[A-Za-z0-9_-]{4,160}$/.test(orderId)) fail('AFFILIATE_INPUT_INVALID');
  const { db } = storage();
  return db.runTransaction(async tx => {
    const receiptRef = db.collection('storeAffiliateCommissions').doc(orderId), receipt = await tx.get(receiptRef);
    const row = receipt.data();
    if (!row) fail('STORE_ORDER_NOT_FOUND', 404);
    if (row.status === 'credited' && row.releasedAt) return { orderId, idempotentReplay: true };
    if (row.status !== 'held' || row.reversedAt) fail('AFFILIATE_HOLD_NOT_RELEASABLE', 409);
    const ownerRef = db.collection('users').doc(row.ownerUid), linkRef = db.collection('storeAffiliateLinks').doc(row.code);
    const [ownerDoc, buyerDoc, orderDoc, linkDoc] = await Promise.all([tx.get(ownerRef), tx.get(db.collection('users').doc(row.uid)), tx.get(db.collection('storeOrders').doc(orderId)), tx.get(linkRef)]);
    if (!ownerDoc.exists || !buyerDoc.exists || securityBlocked(ownerDoc.data()) || securityBlocked(buyerDoc.data())
      || !['paid', 'processing', 'delivery_pending', 'delivered'].includes(orderDoc.data()?.status)
      || linkDoc.data()?.commissionEnabled === false) fail('AFFILIATE_HOLD_NOT_RELEASABLE', 409);
    const owner = ownerDoc.data(), before = readStoredBalance(owner), debt = debtOf(owner), amount = checkedBalance(row.amountKurus);
    const recovered = Math.min(debt, amount), after = before + amount - recovered, now = Date.now();
    if (after > MAX_STORE_BALANCE_KURUS) fail('STORE_BALANCE_LIMIT_EXCEEDED', 409);
    tx.set(ownerRef, { storeBalanceKurus: after, storeAffiliateDebtKurus: debt - recovered, storeUpdatedAt: now }, { merge: true });
    tx.set(receiptRef, { status: 'credited', releasedAt: now, releasedBy: actor.uid }, { merge: true });
    tx.set(linkRef, { heldKurus: Math.max(0, (linkDoc.data()?.heldKurus || 0) - amount), earnedKurus: (linkDoc.data()?.earnedKurus || 0) + amount }, { merge: true });
    tx.create(db.collection('storeWalletLedger').doc(`affiliate_release_${orderId}`), { uid: row.ownerUid, type: 'AFFILIATE_COMMISSION', amountKurus: after - before,
      commissionKurus: amount, balanceBeforeKurus: before, balanceAfterKurus: after, orderId, createdAt: now,
      reason: 'Güvenlik incelemesi sonrası komisyon onayı', actor: { uid: actor.uid, source: 'admin-affiliate-release' } });
    tx.create(db.collection('audit').doc(), { uid: row.ownerUid, type: 'affiliate-release', actor: { uid: actor.uid }, orderId, amountKurus: amount, at: now });
    invalidateCreatedAtPageCache('storeWalletLedger');
    return { orderId, amountKurus: amount, idempotentReplay: false };
  });
}
async function settleAffiliateDebt(uid) {
  const { db } = storage();
  const result = await db.runTransaction(async tx => {
    const ref = db.collection('users').doc(uid), doc = await tx.get(ref), data = doc.data() || {};
    const balance = readStoredBalance(data), debt = debtOf(data), recovered = Math.min(balance, debt);
    if (!recovered) return data;
    const now = Date.now(), patch = { storeBalanceKurus: balance - recovered, storeAffiliateDebtKurus: debt - recovered, storeUpdatedAt: now };
    tx.set(ref, patch, { merge: true });
    tx.create(db.collection('storeWalletLedger').doc(), { uid, type: 'AFFILIATE_RECOVERY', amountKurus: -recovered,
      balanceBeforeKurus: balance, balanceAfterKurus: patch.storeBalanceKurus, debtBeforeKurus: debt, debtAfterKurus: debt - recovered,
      reason: 'İade komisyonu borcunun bakiyeden mahsup edilmesi', actor: { uid: 'system', source: 'affiliate' }, createdAt: now });
    tx.create(db.collection('audit').doc(), { uid, type: 'affiliate-debt-recovery', amountKurus: recovered, at: now });
    return { ...data, ...patch };
  });
  invalidateCreatedAtPageCache('storeWalletLedger');
  return result;
}
async function affiliateDetails(code, { kind = 'referrals', cursor = '' } = {}) {
  if (!validCode(code) || !['referrals', 'commissions'].includes(kind)) fail('AFFILIATE_INPUT_INVALID');
  const { db } = storage();
  const page = await createdAtPage({ db, collection: kind === 'referrals' ? 'storeAffiliateReferrals' : 'storeAffiliateCommissions', filters: [['code', code]], limit: 30, cursor });
  return { rows: page.docs.map(doc => ({ id: doc.id, ...doc.data() })), nextCursor: page.nextCursor, hasMore: page.hasMore };
}
async function customerAffiliateSummary(uid) {
  const { db } = storage(), snapshot = await db.collection('storeAffiliateLinks').where('ownerUid', '==', uid).limit(100).get();
  return { links: snapshot.docs.map(doc => presentLink(doc.data(), doc.id)), capped: snapshot.size === 100 };
}
module.exports = { AFFILIATE_RATES, debtOf, resolveAffiliateLink, listAffiliateLinks, saveAffiliateLink,
  readAffiliateRegistration, applyAffiliateRegistration, readAffiliateCommission, applyAffiliateCommission,
  settleAffiliateDebt, affiliateDetails, customerAffiliateSummary, releaseHeldCommission };
