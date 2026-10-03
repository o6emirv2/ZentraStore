'use strict';

const crypto = require('crypto');
const { initFirebaseAdmin } = require('../config/firebaseAdmin');
const { recordMutationAudit } = require('./storeMutationAudit');
const { findProduct } = require('./storeCatalog');

const MAX_DISCOUNT_KURUS = 100_000_000;
const MAX_WALLET_PROMOTIONS = 50;

function promotionError(code, statusCode = 400) {
  return Object.assign(new Error(code), { code, statusCode });
}

function safeText(value = '', limit = 120) {
  return String(value || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, limit);
}

function normalizeCode(value = '') {
  const code = safeText(value, 32).toLocaleUpperCase('en-US');
  if (!/^[A-Z0-9][A-Z0-9_-]{2,31}$/.test(code)) throw promotionError('STORE_PROMOTION_CODE_INVALID');
  return code;
}

function database() {
  const { db, admin } = initFirebaseAdmin();
  if (!db || !admin) throw promotionError('STORE_PROMOTION_UNAVAILABLE', 503);
  return { db, admin };
}

function dateValue(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  const timestamp = typeof value === 'number' ? value : Date.parse(String(value));
  if (!Number.isFinite(timestamp) || timestamp < 0) throw promotionError('STORE_PROMOTION_DATE_INVALID');
  return Math.trunc(timestamp);
}

function positiveInteger(value, fallback = 0, max = MAX_DISCOUNT_KURUS) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > max) throw promotionError('STORE_PROMOTION_VALUE_INVALID');
  return number;
}

function publicPromotion(row = {}, { customer = false } = {}) {
  const now = Date.now();
  const endsAt = Math.max(0, Number(row.endsAt || 0));
  const startsAt = Math.max(0, Number(row.startsAt || 0));
  const exhausted = Number(row.usageLimit || 0) > 0 && Number(row.usedCount || 0) >= Number(row.usageLimit);
  const result = {
    code: safeText(row.code, 32),
    title: safeText(row.title, 100),
    type: row.type === 'fixed' ? 'fixed' : 'percent',
    value: Math.max(0, Number(row.value || 0)),
    minimumSubtotalKurus: Math.max(0, Number(row.minimumSubtotalKurus || 0)),
    maxDiscountKurus: Math.max(0, Number(row.maxDiscountKurus || 0)),
    startsAt,
    endsAt,
    active: row.active === true,
    status: row.active !== true ? 'inactive' : endsAt && endsAt <= now ? 'expired' : startsAt && startsAt > now ? 'scheduled' : exhausted ? 'exhausted' : 'available',
    perUserLimit: Math.max(1, Number(row.perUserLimit || 1)),
    platforms: Array.isArray(row.platforms) ? row.platforms.filter((item) => ['android', 'ios'].includes(item)) : [],
    productIds: Array.isArray(row.productIds) ? row.productIds.map((item) => safeText(item, 80)).filter(Boolean) : []
  };
  if (!customer) Object.assign(result, {
    usageLimit: Math.max(0, Number(row.usageLimit || 0)),
    usedCount: Math.max(0, Number(row.usedCount || 0)),
    visibleInWallet: row.visibleInWallet === true,
    updatedAt: Math.max(0, Number(row.updatedAt || 0))
  });
  return result;
}

function normalizePromotion(code, input = {}, previous = {}) {
  const type = input.type === 'fixed' ? 'fixed' : 'percent';
  const amount = positiveInteger(input.value, 0, type === 'percent' ? 90 : MAX_DISCOUNT_KURUS);
  if (amount < 1) throw promotionError('STORE_PROMOTION_VALUE_INVALID');
  const startsAt = dateValue(input.startsAt);
  const endsAt = dateValue(input.endsAt);
  if (startsAt && endsAt && endsAt <= startsAt) throw promotionError('STORE_PROMOTION_DATE_INVALID');
  const requestedPlatforms = Array.isArray(input.platforms) ? input.platforms : [];
  const requestedProducts = Array.isArray(input.productIds) ? input.productIds : [];
  if (requestedPlatforms.length > 2 || requestedProducts.length > 50) {
    throw promotionError('STORE_PROMOTION_SCOPE_INVALID');
  }
  const platforms = [...new Set(requestedPlatforms.map((value) => safeText(value, 20).toLowerCase()))];
  const productIds = [...new Set(requestedProducts.map((value) => safeText(value, 80).toLowerCase()))];
  if (platforms.some((value) => !['android', 'ios'].includes(value))
    || productIds.some((value) => !/^[a-z0-9][a-z0-9-]{1,79}$/.test(value) || !findProduct(value))) {
    throw promotionError('STORE_PROMOTION_SCOPE_INVALID');
  }
  const usageLimit = positiveInteger(input.usageLimit);
  const usedCount = Math.max(0, Number(previous.usedCount || 0));
  if (usageLimit > 0 && usageLimit < usedCount) throw promotionError('STORE_PROMOTION_LIMIT_INVALID');
  return {
    code,
    title: safeText(input.title || code, 100),
    type,
    value: amount,
    minimumSubtotalKurus: positiveInteger(input.minimumSubtotalKurus),
    maxDiscountKurus: positiveInteger(input.maxDiscountKurus),
    usageLimit,
    perUserLimit: Math.max(1, positiveInteger(input.perUserLimit, 1, 100)),
    startsAt,
    endsAt,
    platforms,
    productIds,
    active: input.active !== false,
    visibleInWallet: input.visibleInWallet === true,
    usedCount,
    createdAt: Math.max(0, Number(previous.createdAt || Date.now())),
    updatedAt: Date.now()
  };
}

function calculatePromotion(row, cart = {}, userUsage = 0) {
  const now = Date.now();
  if (!row || row.active !== true) throw promotionError('STORE_PROMOTION_NOT_FOUND', 404);
  if (Number(row.startsAt || 0) > now || (Number(row.endsAt || 0) > 0 && Number(row.endsAt) <= now)) {
    throw promotionError('STORE_PROMOTION_EXPIRED', 409);
  }
  if (Number(row.usageLimit || 0) > 0 && Number(row.usedCount || 0) >= Number(row.usageLimit)) {
    throw promotionError('STORE_PROMOTION_LIMIT_REACHED', 409);
  }
  if (userUsage >= Math.max(1, Number(row.perUserLimit || 1))) throw promotionError('STORE_PROMOTION_ALREADY_USED', 409);
  const subtotalKurus = Math.max(0, Math.trunc(Number(cart.totalKurus || 0)));
  if (!subtotalKurus || subtotalKurus < Number(row.minimumSubtotalKurus || 0)) throw promotionError('STORE_PROMOTION_MINIMUM_NOT_MET', 409);
  const eligible = (Array.isArray(cart.items) ? cart.items : []).filter((item) => {
    if (Array.isArray(row.platforms) && row.platforms.length && !row.platforms.includes(item.platform)) return false;
    if (Array.isArray(row.productIds) && row.productIds.length && !row.productIds.includes(item.productId)) return false;
    return true;
  });
  const eligibleTotal = eligible.reduce((total, item) => total + Math.max(0, Number(item.lineTotalKurus || 0)), 0);
  if (!eligibleTotal) throw promotionError('STORE_PROMOTION_SCOPE_INVALID', 409);
  let discountKurus = row.type === 'fixed'
    ? Math.min(eligibleTotal, Number(row.value || 0))
    : Math.floor(eligibleTotal * Number(row.value || 0) / 100);
  if (Number(row.maxDiscountKurus || 0) > 0) discountKurus = Math.min(discountKurus, Number(row.maxDiscountKurus));
  discountKurus = Math.max(0, Math.min(subtotalKurus - 1, Math.trunc(discountKurus)));
  if (!discountKurus) throw promotionError('STORE_PROMOTION_VALUE_INVALID', 409);
  return {
    code: normalizeCode(row.code), title: safeText(row.title, 100), type: row.type === 'fixed' ? 'fixed' : 'percent',
    value: Math.max(0, Number(row.value || 0)), subtotalKurus, discountKurus, totalKurus: subtotalKurus - discountKurus
  };
}

function usageReference(db, code, uid) {
  const id = crypto.createHash('sha256').update(`${code}\u0000${String(uid || '').trim()}`).digest('hex');
  return db.collection('storePromotionCustomerUsage').doc(id);
}

async function previewPromotion({ uid = '', code = '', cart = {} } = {}) {
  const normalized = normalizeCode(code);
  const { db } = database();
  const [campaign, usage] = await Promise.all([
    db.collection('storePromotions').doc(normalized).get(),
    usageReference(db, normalized, uid).get()
  ]);
  if (!campaign.exists) throw promotionError('STORE_PROMOTION_NOT_FOUND', 404);
  return calculatePromotion(campaign.data(), cart, Math.max(0, Number(usage.data()?.count || 0)));
}

async function readPromotionInTransaction({ transaction, db, uid, code = '', cart = {} } = {}) {
  if (!String(code || '').trim()) return null;
  const normalized = normalizeCode(code);
  const campaignRef = db.collection('storePromotions').doc(normalized);
  const customerRef = usageReference(db, normalized, uid);
  const [campaign, usage] = await Promise.all([transaction.get(campaignRef), transaction.get(customerRef)]);
  if (!campaign.exists) throw promotionError('STORE_PROMOTION_NOT_FOUND', 404);
  const previousCount = Math.max(0, Number(usage.data()?.count || 0));
  const result = calculatePromotion(campaign.data(), cart, previousCount);
  return { result, campaignRef, customerRef, previousCount, campaign: campaign.data() || {} };
}

function applyPromotionInTransaction({ transaction, promotion, uid, orderId, now = Date.now() } = {}) {
  if (!promotion) return;
  transaction.update(promotion.campaignRef, { usedCount: Math.max(0, Number(promotion.campaign.usedCount || 0)) + 1, updatedAt: now });
  transaction.set(promotion.customerRef, {
    uid: String(uid || '').trim().slice(0, 160), code: promotion.result.code,
    count: promotion.previousCount + 1, lastOrderId: String(orderId || '').trim().slice(0, 160), updatedAt: now
  }, { merge: true });
  transaction.create(promotion.campaignRef.collection('redemptions').doc(String(orderId || '')), {
    uid: String(uid || '').trim().slice(0, 160), orderId: String(orderId || '').trim().slice(0, 160),
    discountKurus: promotion.result.discountKurus, createdAt: now
  });
}

async function readPromotionReleaseInTransaction({ transaction, db, order = {}, orderId = '' } = {}) {
  if (!order.promotion?.code || Number(order.promotion?.releasedAt || 0) > 0) return null;
  const code = normalizeCode(order.promotion.code);
  const uid = String(order.uid || '').trim();
  const campaignRef = db.collection('storePromotions').doc(code);
  const customerRef = usageReference(db, code, uid);
  const redemptionRef = campaignRef.collection('redemptions').doc(String(orderId || ''));
  const [campaign, customer, redemption] = await Promise.all([
    transaction.get(campaignRef), transaction.get(customerRef), transaction.get(redemptionRef)
  ]);
  if (!campaign.exists || !customer.exists || !redemption.exists) throw promotionError('STORE_PROMOTION_REDEMPTION_INVALID', 409);
  if (Number(redemption.data()?.releasedAt || 0) > 0) return null;
  return { campaignRef, customerRef, redemptionRef, campaign: campaign.data() || {}, customer: customer.data() || {} };
}

function releasePromotionInTransaction({ transaction, release, reason = '', now = Date.now() } = {}) {
  if (!release) return false;
  transaction.update(release.campaignRef, {
    usedCount: Math.max(0, Number(release.campaign.usedCount || 0) - 1), updatedAt: now
  });
  transaction.set(release.customerRef, {
    count: Math.max(0, Number(release.customer.count || 0) - 1), updatedAt: now
  }, { merge: true });
  transaction.set(release.redemptionRef, {
    releasedAt: now, releaseReason: safeText(reason, 40)
  }, { merge: true });
  return true;
}

async function listWalletPromotions(uid = '') {
  const { db } = database();
  const snapshot = await db.collection('storePromotions')
    .where('visibleInWallet', '==', true)
    .limit(MAX_WALLET_PROMOTIONS)
    .get();
  const campaigns = snapshot.docs
    .map((document) => ({ id: document.id, row: document.data() || {} }))
    .filter(({ row }) => row.active === true);
  if (!campaigns.length) return [];

  const references = campaigns.map(({ id, row }) => usageReference(db, row.code || id, uid));
  const usage = typeof db.getAll === 'function'
    ? await db.getAll(...references)
    : await Promise.all(references.map((reference) => reference.get()));

  return campaigns.map(({ row }, index) => ({
    ...publicPromotion(row, { customer: true }),
    usedCount: Math.max(0, Number(usage[index]?.data()?.count || 0))
  })).sort((left, right) => right.endsAt - left.endsAt);
}

async function listPromotions() {
  const { db } = database();
  const snapshot = await db.collection('storePromotions').orderBy('updatedAt', 'desc').limit(100).get()
    .catch(() => db.collection('storePromotions').limit(100).get());
  return snapshot.docs.map((doc) => publicPromotion(doc.data())).sort((left, right) => right.updatedAt - left.updatedAt);
}

async function savePromotion(code = '', input = {}, actor = {}) {
  const normalized = normalizeCode(code);
  const { db } = database();
  const reference = db.collection('storePromotions').doc(normalized);
  let result = null;
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const row = normalizePromotion(normalized, input, snapshot.exists ? snapshot.data() : {});
    row.updatedBy = { uid: safeText(actor.uid, 160), email: safeText(actor.email, 254).toLowerCase() };
    transaction.set(reference, row, { merge: false });
    recordMutationAudit(transaction, db, 'store.promotion.update', actor, { code: normalized, before: snapshot.exists ? publicPromotion(snapshot.data()) : null, after: publicPromotion(row) });
    result = publicPromotion(row);
  });
  return result;
}

module.exports = {
  normalizeCode, previewPromotion, readPromotionInTransaction, applyPromotionInTransaction,
  readPromotionReleaseInTransaction, releasePromotionInTransaction,
  listWalletPromotions, listPromotions, savePromotion
};
