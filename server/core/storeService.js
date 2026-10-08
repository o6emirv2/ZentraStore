'use strict';

const crypto = require('crypto');
const env = require('../config/env');
const { initFirebaseAdmin } = require('../config/firebaseAdmin');
const { STORE_CATALOG } = require('./storeCatalog');
const { getEffectiveCatalog } = require('./storeCatalogService');
const { createdAtPage, invalidateCreatedAtPageCache } = require('./firestorePagination');
const { AVATAR_IDS, getAvatarById, publicAvatarCatalog } = require('./storeAvatars');
const {
  previewPromotion, readPromotionInTransaction, applyPromotionInTransaction,
  readPromotionReleaseInTransaction, releasePromotionInTransaction
} = require('./storePromotionService');
const {
  decorateCatalogWithStock,
  allocateInventoryInTransaction,
  attachManualDeliveryInTransaction,
  invalidateStockCache
} = require('./storeInventoryService');
const MAX_CART_LINES = 20;
const MAX_LINE_QUANTITY = 5;
const MAX_ORDER_TOTAL_KURUS = 100_000_000;
const MAX_STORE_BALANCE_KURUS = 1_000_000_000_000;
const MAX_ADMIN_ADJUSTMENT_KURUS = 100_000_000;
const ORDER_STATUSES = Object.freeze([
  'awaiting_payment',
  'payment_review',
  'paid',
  'processing',
  'delivery_pending',
  'delivered',
  'payment_rejected',
  'refunded',
  'cancelled'
]);
const ORDER_TRANSITIONS = Object.freeze({
  awaiting_payment: Object.freeze(['awaiting_payment', 'payment_review', 'paid', 'payment_rejected', 'cancelled']),
  payment_review: Object.freeze(['payment_review', 'paid', 'payment_rejected', 'cancelled']),
  paid: Object.freeze(['paid', 'processing', 'delivery_pending', 'delivered', 'refunded', 'cancelled']),
  processing: Object.freeze(['processing', 'delivery_pending', 'delivered', 'refunded', 'cancelled']),
  delivery_pending: Object.freeze(['delivery_pending', 'delivered', 'refunded', 'cancelled']),
  delivered: Object.freeze(['delivered', 'refunded']),
  payment_rejected: Object.freeze(['payment_rejected', 'cancelled']),
  refunded: Object.freeze(['refunded']),
  cancelled: Object.freeze(['cancelled'])
});
const ACCOUNT_STATUSES = Object.freeze(['active', 'purchase_blocked', 'suspended']);

function serviceError(code, statusCode = 400, details = {}) {
  return Object.assign(new Error(code), { code, statusCode, ...details });
}

function firebaseStore() {
  const firebase = initFirebaseAdmin();
  if (!firebase.db || !firebase.admin) throw serviceError('STORE_STORAGE_UNAVAILABLE', 503);
  return firebase;
}

function safeText(value = '', max = 120) {
  return String(value || '').replace(/[\u0000-\u001F\u007F<>]/g, '').trim().slice(0, max);
}

function maskEmail(value = '') {
  const email = safeText(value, 254).toLowerCase();
  const separator = email.lastIndexOf('@');
  if (separator < 1) return '';
  const local = email.slice(0, separator);
  return `${local.slice(0, Math.min(2, local.length))}${'•'.repeat(Math.max(3, Math.min(7, local.length - 1)))}${email.slice(separator)}`;
}

function clampBalance(value = 0) {
  const amount = Math.trunc(Number(value) || 0);
  return Math.max(0, Math.min(amount, MAX_STORE_BALANCE_KURUS));
}

function requireIdempotencyKey(value = '') {
  const key = safeText(value, 160);
  if (key.length < 12) throw serviceError('IDEMPOTENCY_KEY_REQUIRED', 400);
  return key;
}

function hashIdempotency(scope = '', actor = '', key = '') {
  return crypto.createHash('sha256').update(`${scope}:${actor}:${key}`).digest('hex');
}

function normalizeAvatarId(value, allowed, fallback = '1') {
  const id = String(value || '').trim();
  return allowed.includes(id) ? id : fallback;
}

function normalizeStoreProfile(profile = {}, authUser = {}) {
  const storeProfile = profile.storeProfile && typeof profile.storeProfile === 'object' ? profile.storeProfile : {};
  const username = safeText(profile.username || profile.displayName || authUser.name || authUser.email || 'SHELBY STORE Üyesi', 40);
  const accountStatus = ACCOUNT_STATUSES.includes(profile.storeAccountStatus) ? profile.storeAccountStatus : 'active';
  const avatarId = normalizeAvatarId(storeProfile.avatarId || profile.storeAvatarId, AVATAR_IDS);
  const avatar = getAvatarById(avatarId);
  const changes = profile.profileChangeCounts && typeof profile.profileChangeCounts === 'object'
    ? profile.profileChangeCounts : {};
  const changeStatus = (field, limit) => {
    const raw = Number(changes[field] || 0);
    const used = Number.isSafeInteger(raw) && raw >= 0 ? Math.min(raw, limit) : limit;
    return { used, limit, remaining: Math.max(0, limit - used) };
  };
  const firstName = safeText(profile.firstName || '', 50);
  const lastName = safeText(profile.lastName || '', 50);
  return {
    username,
    email: safeText(authUser.email || profile.email || '', 160),
    firstName,
    lastName,
    fullName: safeText(profile.fullName || `${firstName} ${lastName}`.trim(), 110),
    birthDate: /^\d{4}-\d{2}-\d{2}$/.test(String(profile.birthDate || '')) ? profile.birthDate : '',
    avatarId,
    avatarUrl: avatar?.image || '',
    balanceKurus: clampBalance(profile.storeBalanceKurus ?? profile.storeWallet?.balanceKurus ?? 0),
    accountStatus,
    profileChanges: {
      username: changeStatus('username', 3),
      fullName: changeStatus('fullName', 1),
      birthDate: changeStatus('birthDate', 1)
    }
  };
}

async function readAccount(uid, authUser = {}) {
  const safeUid = safeText(uid, 160);
  if (!safeUid) throw serviceError('AUTH_REQUIRED', 401);
  const { db } = firebaseStore();
  const ref = db.collection('users').doc(safeUid);
  const snap = await ref.get();
  const profile = snap.exists ? (snap.data() || {}) : {};
  const account = normalizeStoreProfile(profile, authUser);
  const authEmail = safeText(authUser.email || '', 160).toLowerCase();
  const profileEmail = safeText(profile.email || '', 160).toLowerCase();
  const profileNeedsSync = !snap.exists
    || !profile.storeProfile
    || profile.storeBalanceKurus === undefined
    || (!!authEmail && authEmail !== profileEmail);
  if (profileNeedsSync) {
    await ref.set({
      email: account.email,
      username: account.username,
      usernameLower: account.username.toLocaleLowerCase('tr-TR'),
      storeAccountStatus: account.accountStatus,
      storeBalanceKurus: account.balanceKurus,
      storeProfile: { avatarId: account.avatarId },
      storeCreatedAt: profile.storeCreatedAt || Date.now(),
      storeUpdatedAt: Date.now()
    }, { merge: true });
  }
  return account;
}


async function updateProfileAvatar(uid, authUser = {}, input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some((key) => key !== 'avatarId')
    || !AVATAR_IDS.includes(String(input.avatarId || ''))) {
    throw serviceError('STORE_AVATAR_INVALID', 400);
  }
  const account = await readAccount(uid, authUser);
  const avatarId = normalizeAvatarId(input.avatarId, AVATAR_IDS, account.avatarId);
  const { db } = firebaseStore();
  await db.collection('users').doc(uid).set({
    storeProfile: { avatarId },
    storeAvatarId: avatarId,
    storeUpdatedAt: Date.now()
  }, { merge: true });
  return { ...account, avatarId, avatarUrl: getAvatarById(avatarId)?.image || '' };
}

function normalizeCart(rawItems = [], catalog = null) {
  if (!Array.isArray(rawItems) || rawItems.length < 1 || rawItems.length > MAX_CART_LINES) {
    throw serviceError('STORE_CART_INVALID', 400);
  }
  const combined = new Map();
  for (const raw of rawItems) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw serviceError('STORE_CART_INVALID', 400);
    const productId = safeText(raw?.productId, 80).toLowerCase();
    const planKey = safeText(raw?.planKey, 40).toLowerCase();
    const quantity = raw.quantity === undefined ? 1 : Number(raw.quantity);
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_LINE_QUANTITY) throw serviceError('STORE_CART_INVALID', 400);
    const product = catalog?.products?.find((item) => item.id === productId && item.active !== false);
    const plan = product?.plans?.find((item) => item.key === planKey && item.active !== false);
    if (!product || !plan) throw serviceError('STORE_ITEM_UNAVAILABLE', 409);
    const key = `${product.id}:${plan.key}`;
    const previous = combined.get(key);
    const nextQuantity = quantity + Number(previous?.quantity || 0);
    if (nextQuantity > MAX_LINE_QUANTITY) throw serviceError('STORE_CART_INVALID', 400);
    combined.set(key, {
      productId: product.id,
      productName: product.name,
      platform: product.platform,
      inventoryPoolId: String(product.inventoryPoolId || '').trim().toLowerCase(),
      fulfillmentMode: product.fulfillmentMode === 'telegram_only' ? 'telegram_only' : 'automatic',
      telegramEnabled: product.telegramEnabled !== false,
      planKey: plan.key,
      planLabel: plan.label,
      inventoryType: product.inventoryType === 'account' ? 'account' : 'license',
      duration: plan.duration,
      quantity: nextQuantity,
      unitPriceKurus: plan.priceKurus,
      lineTotalKurus: plan.priceKurus * nextQuantity
    });
  }
  const items = [...combined.values()];
  const totalKurus = items.reduce((total, item) => total + item.lineTotalKurus, 0);
  if (totalKurus < 1 || totalKurus > MAX_ORDER_TOTAL_KURUS) throw serviceError('STORE_ORDER_TOTAL_INVALID', 400);
  return { items, totalKurus };
}

function orderNumber() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `SH-${date}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
}

function currency(value = 0) {
  return (Math.max(0, Number(value) || 0) / 100).toLocaleString('tr-TR', {
    style: 'currency', currency: 'TRY', minimumFractionDigits: 2, maximumFractionDigits: 2
  });
}

function buildTelegramMessage(order) {
  const lines = ['Merhaba, SHELBY STORE üzerinden Telegram ile sipariş vermek istiyorum.', `Sipariş No: ${order.orderNumber}`];
  order.items.forEach((item, index) => {
    const prefix = order.items.length > 1 ? `${index + 1}. ` : '';
    lines.push(
      `${prefix}Ürün: ${item.productName}`,
      `${prefix}Paket: ${item.planLabel}`,
      `${prefix}Adet: ${item.quantity}`,
      `${prefix}Tutar: ${currency(item.lineTotalKurus)}`,
      `${prefix}Platform: ${item.platform === 'ios' ? 'iOS' : 'Android'}`
    );
  });
  if (Number(order.discountKurus || 0) > 0) {
    lines.push(`Ara toplam: ${currency(order.subtotalKurus)}`);
    lines.push(`İndirim (${safeText(order.promotion?.code, 32)}): -${currency(order.discountKurus)}`);
  }
  lines.push(`Ödenecek toplam: ${currency(order.totalKurus)}`);
  lines.push('Siparişimin ödeme ve stok durumunun kontrol edilmesini rica ederim.');
  return lines.join('\n');
}

function telegramUrl(message = '', telegramUsername = STORE_CATALOG.telegramUsername) {
  const username = safeText(telegramUsername, 80).replace(/^@+/, '') || STORE_CATALOG.telegramUsername;
  return `https://t.me/${username}?text=${encodeURIComponent(String(message || ''))}`;
}

function publicOrder(data = {}, id = '') {
  const delivery = data.delivery && typeof data.delivery === 'object' ? data.delivery : {};
  const status = ORDER_STATUSES.includes(data.status) ? data.status : 'awaiting_payment';
  const deliveryItemCount = Math.max(0, Math.min(100, Math.trunc(Number(delivery.itemCount || 0) || 0)));
  const deliveryVisible = deliveryItemCount > 0 && Number(data.approvedAt || 0) > 0 && ['paid', 'processing', 'delivery_pending', 'delivered'].includes(status);
  const cancellable = status === 'awaiting_payment';
  return {
    id: id || safeText(data.id, 160),
    orderNumber: safeText(data.orderNumber, 40),
    status,
    paymentMethod: data.paymentMethod === 'wallet' ? 'wallet' : 'telegram',
    items: Array.isArray(data.items) ? data.items.map((item) => ({
      productId: safeText(item.productId, 80),
      productName: safeText(item.productName, 80),
      platform: item.platform === 'ios' ? 'ios' : 'android',
      fulfillmentMode: item.fulfillmentMode === 'telegram_only' ? 'telegram_only' : 'automatic',
      planKey: safeText(item.planKey, 40),
      planLabel: safeText(item.planLabel, 50),
      duration: safeText(item.duration, 50),
      quantity: Math.max(1, Math.min(MAX_LINE_QUANTITY, Math.trunc(Number(item.quantity) || 1))),
      unitPriceKurus: clampBalance(item.unitPriceKurus),
      lineTotalKurus: clampBalance(item.lineTotalKurus)
    })) : [],
    subtotalKurus: clampBalance(data.subtotalKurus || data.totalKurus),
    discountKurus: clampBalance(data.discountKurus),
    promotion: data.promotion?.code ? {
      code: safeText(data.promotion.code, 32),
      title: safeText(data.promotion.title, 100),
      discountKurus: clampBalance(data.promotion.discountKurus)
    } : null,
    totalKurus: clampBalance(data.totalKurus),
    paymentState: data.paymentMethod === 'wallet' ? 'captured' : 'external',
    deliveryVisible,
    cancellable,
    approvedAt: Math.max(0, Number(data.approvedAt || 0) || 0),
    cancelledAt: Math.max(0, Number(data.cancelledAt || 0) || 0),
    delivery: deliveryVisible ? {
      status: safeText(delivery.status || (status === 'delivered' ? 'delivered' : 'pending'), 30),
      title: safeText(delivery.title || '', 100),
      message: safeText(delivery.message || '', 500),
      deliveredAt: Math.max(0, Number(delivery.deliveredAt || 0) || 0),
      itemCount: deliveryItemCount,
      automatic: delivery.automatic === true,
      canOpen: status === 'delivered' && delivery.status === 'delivered'
    } : null,
    createdAt: Math.max(0, Number(data.createdAt || 0) || 0),
    salesChannel: data.salesChannel === 'telegram' || data.paymentMethod === 'telegram' ? 'telegram' : 'automatic',
    fulfillmentStatus: safeText(data.fulfillmentStatus || (data.paymentMethod === 'telegram' ? 'TELEGRAM_ILETISIM_BEKLIYOR' : 'TESLIM_EDILDI'), 40),
    updatedAt: Math.max(0, Number(data.updatedAt || data.createdAt || 0) || 0)
  };
}

async function readIdempotentOrder({ db, uid, idempotencyRef, requestHash }) {
  const snapshot = await idempotencyRef.get();
  if (!snapshot.exists) return null;
  const data = snapshot.data() || {};
  if (data.requestHash && data.requestHash !== requestHash) throw serviceError('STORE_ORDER_CONFLICT', 409);
  const orderId = safeText(data.orderId, 160);
  if (!orderId) throw serviceError('STORE_ORDER_CONFLICT', 409);
  const orderSnapshot = await db.collection('storeOrders').doc(orderId).get();
  if (!orderSnapshot.exists || safeText(orderSnapshot.data()?.uid, 160) !== uid) throw serviceError('STORE_ORDER_CONFLICT', 409);
  return publicOrder(orderSnapshot.data(), orderSnapshot.id);
}

async function orderResponse({ uid, authUser, order, catalog, fulfillmentOutcome = '' }) {
  const freshAccount = await readAccount(uid, authUser);
  const message = order.paymentMethod === 'telegram' ? buildTelegramMessage(order) : '';
  return {
    order,
    balanceKurus: freshAccount.balanceKurus,
    telegramMessage: message,
    telegramUrl: message ? telegramUrl(message, catalog.telegramUsername) : '',
    ...(fulfillmentOutcome ? { fulfillmentOutcome } : {})
  };
}

async function createOrder({ uid, authUser = {}, rawItems = [], paymentMethod = 'telegram', idempotencyKey = '', promotionCode = '' }) {
  const safeUid = safeText(uid, 160);
  if (!safeUid) throw serviceError('AUTH_REQUIRED', 401);
  const method = String(paymentMethod || '').trim().toLowerCase();
  if (method !== 'telegram' && method !== 'wallet') throw serviceError('STORE_PAYMENT_METHOD_INVALID', 400);
  const key = requireIdempotencyKey(idempotencyKey);
  const safePromotionCode = safeText(promotionCode, 32).toLocaleUpperCase('en-US');
  const catalog = await getEffectiveCatalog({ includeInactive: false, fresh: true });
  if (catalog.storefront?.maintenance === true) throw serviceError('STORE_MAINTENANCE_ACTIVE', 503);
  if (method === 'telegram' && catalog.storefront?.services?.telegramSupport === false) throw serviceError('STORE_TELEGRAM_CHANNEL_DISABLED', 409);
  if (method === 'wallet' && (catalog.storefront?.services?.automaticDelivery === false || catalog.storefront?.services?.balancePayment === false)) throw serviceError('STORE_AUTOMATIC_CHANNEL_DISABLED', 409);
  const cart = normalizeCart(rawItems, catalog);
  const hasTelegramOnlyProduct = cart.items.some((item) => item.fulfillmentMode === 'telegram_only');
  if (method === 'telegram' && cart.items.some((item) => item.telegramEnabled === false) ) throw serviceError('STORE_TELEGRAM_PRODUCT_DISABLED', 409);
  if (method !== 'telegram' && hasTelegramOnlyProduct) throw serviceError('STORE_TELEGRAM_ONLY_PRODUCT', 409);
  const account = await readAccount(safeUid, authUser);
  if (account.accountStatus !== 'active') throw serviceError('STORE_PURCHASE_BLOCKED', 403);
  const { db, admin } = firebaseStore();
  const userRef = db.collection('users').doc(safeUid);
  const idempotencyId = hashIdempotency('store-order', safeUid, key);
  const requestHash = crypto.createHash('sha256').update(JSON.stringify({
    paymentMethod: method,
    promotionCode: safePromotionCode,
    items: cart.items.map((item) => ({ productId: item.productId, planKey: item.planKey, quantity: item.quantity }))
      .sort((a, b) => `${a.productId}:${a.planKey}`.localeCompare(`${b.productId}:${b.planKey}`))
  })).digest('hex');
  const idempotencyRef = db.collection('storeOrderIdempotency').doc(idempotencyId);

  const replay = await readIdempotentOrder({ db, uid: safeUid, idempotencyRef, requestHash });
  if (replay) return orderResponse({ uid: safeUid, authUser, order: replay, catalog });

  const orderRef = db.collection('storeOrders').doc();
  let result = null;
  let stockChanged = false;
  await db.runTransaction(async (tx) => {
    const existing = await tx.get(idempotencyRef);
    if (existing.exists) {
      const existingData = existing.data() || {};
      if (existingData.requestHash && existingData.requestHash !== requestHash) throw serviceError('STORE_ORDER_CONFLICT', 409);
      const existingOrderId = safeText(existingData.orderId, 160);
      if (!existingOrderId) throw serviceError('STORE_ORDER_CONFLICT', 409);
      const existingOrder = await tx.get(db.collection('storeOrders').doc(existingOrderId));
      if (!existingOrder.exists || existingOrder.data()?.uid !== safeUid) throw serviceError('STORE_ORDER_CONFLICT', 409);
      result = publicOrder(existingOrder.data(), existingOrder.id);
      return;
    }
    const userSnapshot = await tx.get(userRef);
    const userData = userSnapshot.exists ? (userSnapshot.data() || {}) : {};
    const liveAccount = normalizeStoreProfile(userData, authUser);
    if (liveAccount.accountStatus !== 'active') throw serviceError('STORE_PURCHASE_BLOCKED', 403);
    const promotion = await readPromotionInTransaction({
      transaction: tx, db, uid: safeUid, code: safePromotionCode, cart
    });
    const totalKurus = promotion?.result.totalKurus || cart.totalKurus;
    let balanceKurus = liveAccount.balanceKurus;
    if (method === 'wallet' && balanceKurus < totalKurus) throw serviceError('STORE_INSUFFICIENT_BALANCE', 409, { balanceKurus });
    const now = Date.now();
    let allocations = [];
    if (method === 'wallet') {
      allocations = await allocateInventoryInTransaction({ tx, db, admin, items: cart.items, orderId: orderRef.id, uid: safeUid, now });
      balanceKurus -= totalKurus;
      stockChanged = true;
    }
    const isAutomaticDelivery = method === 'wallet';
    const rawOrder = {
      id: orderRef.id, uid: safeUid, email: liveAccount.email, username: liveAccount.username, orderNumber: orderNumber(),
      status: isAutomaticDelivery ? 'delivered' : 'awaiting_payment', paymentMethod: method,
      salesChannel: isAutomaticDelivery ? 'automatic' : 'telegram',
      fulfillmentStatus: isAutomaticDelivery ? 'TESLIM_EDILDI' : 'TELEGRAM_ILETISIM_BEKLIYOR', currency: 'TRY', items: cart.items,
      subtotalKurus: cart.totalKurus,
      discountKurus: promotion?.result.discountKurus || 0,
      promotion: promotion ? {
        code: promotion.result.code, title: promotion.result.title,
        discountKurus: promotion.result.discountKurus
      } : null,
      totalKurus,
      delivery: isAutomaticDelivery
        ? { status: 'delivered', title: 'Otomatik teslimat hazır', message: 'Dijital teslimat bilgileriniz güvenli teslimat ekranında hazır.', deliveredAt: now, itemCount: allocations.length, automatic: true }
        : { status: 'locked', title: '', message: '', deliveredAt: 0, itemCount: 0, automatic: false },
      approvedAt: isAutomaticDelivery ? now : 0,
      approvedBy: isAutomaticDelivery ? { uid: 'system', email: '', source: 'wallet-auto-delivery' } : null,
      catalogVersion: catalog.version, createdAt: now, updatedAt: now
    };
    tx.set(userRef, {
      email: liveAccount.email, username: liveAccount.username, usernameLower: liveAccount.username.toLocaleLowerCase('tr-TR'),
      ...(isAutomaticDelivery ? { storeBalanceKurus: balanceKurus } : {}),
      storeOrderCount: admin.firestore.FieldValue.increment(1), storeUpdatedAt: now
    }, { merge: true });
    if (isAutomaticDelivery) {
      tx.create(db.collection('storeWalletLedger').doc(`purchase_${orderRef.id}`), {
        uid: safeUid, type: 'DEBIT', amountKurus: -totalKurus, balanceBeforeKurus: liveAccount.balanceKurus,
        balanceAfterKurus: balanceKurus, reason: 'Bakiye ile mağaza satın alımı', orderId: orderRef.id,
        actor: { uid: safeUid, email: liveAccount.email, source: 'customer' }, createdAt: now
      });
    }
    applyPromotionInTransaction({ transaction: tx, promotion, uid: safeUid, orderId: orderRef.id, now });
    tx.create(orderRef, rawOrder);
    tx.create(idempotencyRef, {
      uid: safeUid, orderId: orderRef.id, keyHash: idempotencyId, requestHash,
      createdAt: now, expiresAt: new Date(now + 30 * 86_400_000)
    });
    tx.create(db.collection('audit').doc(`store_order_${orderRef.id}`), {
      uid: safeUid, type: 'store-order', orderId: orderRef.id, orderNumber: rawOrder.orderNumber, paymentMethod: method,
      salesChannel: rawOrder.salesChannel, totalKurus: rawOrder.totalKurus, balanceAfterKurus: balanceKurus, at: now
    });
    result = publicOrder(rawOrder, orderRef.id);
  });
  if (!result) throw serviceError('STORE_ORDER_CREATE_FAILED', 500);
  if (stockChanged) invalidateStockCache();
  invalidateCreatedAtPageCache('storeOrders');
  if (method === 'wallet') invalidateCreatedAtPageCache('storeWalletLedger');
  return orderResponse({ uid: safeUid, authUser, order: result, catalog });
}

async function previewStorePromotion({ uid = '', rawItems = [], code = '' } = {}) {
  const safeUid = safeText(uid, 160);
  if (!safeUid) throw serviceError('AUTH_REQUIRED', 401);
  const catalog = await getEffectiveCatalog({ includeInactive: false, fresh: true });
  const cart = normalizeCart(rawItems, catalog);
  return previewPromotion({ uid: safeUid, code, cart });
}

async function listOrders(uid, limit = 30, cursor = '') {
  const safeUid = safeText(uid, 160);
  if (!safeUid) throw serviceError('AUTH_REQUIRED', 401);
  const { db } = firebaseStore();
  const safeLimit = Math.max(1, Math.min(60, Math.trunc(Number(limit) || 30)));
  const page = await createdAtPage({ db, collection: 'storeOrders', filters: [['uid', safeUid]], limit: safeLimit, cursor });
  const orders = page.docs
    .map((doc) => publicOrder(doc.data(), doc.id))
    .sort((a, b) => b.createdAt - a.createdAt);
  return { orders, nextCursor: page.nextCursor, hasMore: page.hasMore };
}

function adminOrder(data = {}, id = '') {
  const order = publicOrder(data, id);
  const status = order.status;
  const delivery = data.delivery && typeof data.delivery === 'object' ? data.delivery : {};
  const deliveryItemCount = Math.max(0, Math.min(100, Math.trunc(Number(delivery.itemCount || 0) || 0)));
  return {
    ...order,
    uid: safeText(data.uid, 160),
    email: maskEmail(data.email),
    username: safeText(data.username, 80),
    availableTransitions: ORDER_TRANSITIONS[status] || [status],
    delivery: {
      status: safeText(delivery.status || (status === 'delivered' ? 'delivered' : 'pending'), 30),
      title: safeText(delivery.title || '', 100),
      message: safeText(delivery.message || '', 500),
      deliveredAt: Math.max(0, Number(delivery.deliveredAt || 0) || 0),
      itemCount: deliveryItemCount,
      automatic: delivery.automatic === true,
      canOpen: status === 'delivered' && delivery.status === 'delivered'
    },
    walletRefundedAt: Math.max(0, Number(data.walletRefundedAt || 0) || 0),
    walletRefundedKurus: clampBalance(data.walletRefundedKurus)
  };
}

async function listOrdersForAdmin({ limit = 80, status = '', uid = '', cursor = '' } = {}) {
  const { db } = firebaseStore();
  const safeLimit = Math.max(1, Math.min(200, Math.trunc(Number(limit) || 80)));
  const requestedStatus = safeText(status, 30).toLowerCase();
  const requestedUid = safeText(uid, 160);
  if (requestedStatus && !ORDER_STATUSES.includes(requestedStatus)) throw serviceError('STORE_ORDER_STATUS_INVALID', 400);
  const filters = [
    ...(requestedUid ? [['uid', requestedUid]] : []),
    ...(requestedStatus ? [['status', requestedStatus]] : [])
  ];
  const page = await createdAtPage({ db, collection: 'storeOrders', filters, limit: safeLimit, cursor });
  const orders = page.docs
    .map((doc) => adminOrder(doc.data(), doc.id))
    .sort((a, b) => b.createdAt - a.createdAt);
  return { orders, nextCursor: page.nextCursor, hasMore: page.hasMore };
}

async function cancelOrderByUser({ uid = '', orderId = '', reason = '' } = {}) {
  const safeUid = safeText(uid, 160);
  const safeOrderId = safeText(orderId, 160);
  const safeReason = safeText(reason || 'Kullanıcı talebi', 200);
  if (!safeUid) throw serviceError('AUTH_REQUIRED', 401);
  if (!safeOrderId) throw serviceError('STORE_ORDER_ID_REQUIRED', 400);
  const { db } = firebaseStore();
  const orderRef = db.collection('storeOrders').doc(safeOrderId);
  const userRef = db.collection('users').doc(safeUid);
  let result = null;
  let balanceKurus = null;
  let balanceBeforeKurus = null;

  await db.runTransaction(async (tx) => {
    const orderSnapshot = await tx.get(orderRef);
    if (!orderSnapshot.exists) throw serviceError('STORE_ORDER_NOT_FOUND', 404);
    const current = orderSnapshot.data() || {};
    if (safeText(current.uid, 160) !== safeUid) throw serviceError('STORE_ORDER_ACCESS_DENIED', 403);
    const currentStatus = ORDER_STATUSES.includes(current.status) ? current.status : 'awaiting_payment';
    if (currentStatus === 'cancelled') {
      result = publicOrder(current, safeOrderId);
      return;
    }
    const canCancel = currentStatus === 'awaiting_payment' || (currentStatus === 'paid' && current.paymentMethod === 'wallet');
    if (!canCancel) throw serviceError('STORE_ORDER_CANCELLATION_NOT_ALLOWED', 409);
    const promotionRelease = await readPromotionReleaseInTransaction({
      transaction: tx, db, order: current, orderId: safeOrderId
    });

    const shouldRefund = current.paymentMethod === 'wallet' && currentStatus === 'paid' && !current.walletRefundedAt;
    if (shouldRefund) {
      const userSnapshot = await tx.get(userRef);
      if (!userSnapshot.exists) throw serviceError('STORE_ACCOUNT_NOT_FOUND', 404);
      const currentBalance = normalizeStoreProfile(userSnapshot.data() || {}, {}).balanceKurus;
      balanceBeforeKurus = currentBalance;
      balanceKurus = currentBalance + clampBalance(current.totalKurus);
      if (balanceKurus > MAX_STORE_BALANCE_KURUS) throw serviceError('STORE_BALANCE_LIMIT_EXCEEDED', 409);
      tx.set(userRef, { storeBalanceKurus: balanceKurus, storeUpdatedAt: Date.now() }, { merge: true });
    }

    const now = Date.now();
    const patch = {
      status: 'cancelled',
      cancelledAt: now,
      cancelledBy: { uid: safeUid, source: 'customer' },
      cancellationReason: safeReason,
      delivery: { status: 'cancelled', title: '', message: '', deliveredAt: 0 },
      updatedAt: now
    };
    if (releasePromotionInTransaction({ transaction: tx, release: promotionRelease, reason: 'customer-cancelled', now })) {
      patch.promotion = { ...current.promotion, releasedAt: now };
    }
    if (shouldRefund) {
      patch.walletRefundedAt = now;
      patch.walletRefundedKurus = clampBalance(current.totalKurus);
      tx.create(db.collection('storeWalletLedger').doc(`refund_${safeOrderId}`), {
        uid: safeUid,
        type: 'REFUND',
        amountKurus: clampBalance(current.totalKurus),
        balanceBeforeKurus,
        balanceAfterKurus: balanceKurus,
        reason: `Sipariş iptali: ${safeReason}`,
        orderId: safeOrderId,
        actor: { uid: safeUid, email: '', source: 'customer' },
        createdAt: now
      });
    }
    tx.set(orderRef, patch, { merge: true });
    tx.create(db.collection('audit').doc(`store_order_cancel_${safeOrderId}_${crypto.randomBytes(5).toString('hex')}`), {
      uid: safeUid,
      type: 'store-order-cancelled-by-customer',
      orderId: safeOrderId,
      orderNumber: safeText(current.orderNumber, 40),
      previousStatus: currentStatus,
      refundedKurus: shouldRefund ? clampBalance(current.totalKurus) : 0,
      reason: safeReason,
      at: now
    });
    result = publicOrder({ ...current, ...patch }, safeOrderId);
  });

  if (!result) throw serviceError('STORE_ORDER_UPDATE_FAILED', 500);
  if (balanceKurus === null) {
    const account = await readAccount(safeUid, {});
    balanceKurus = account.balanceKurus;
  }
  invalidateCreatedAtPageCache('storeOrders');
  invalidateCreatedAtPageCache('storeWalletLedger');
  return { order: result, balanceKurus };
}

async function adjustStoreBalance({ targetUid = '', amountKurus = 0, type = 'CORRECTION', reason = '', actor = {}, idempotencyKey = '', requestId = '' } = {}) {
  const safeUid = safeText(targetUid, 160);
  const actorUid = safeText(actor.uid, 160);
  const actorEmail = safeText(actor.email, 160);
  const numericAmount = Number(amountKurus);
  const ledgerType = safeText(type, 30).toUpperCase();
  const safeReason = safeText(reason, 200);
  if (!safeUid) throw serviceError('STORE_TARGET_UID_REQUIRED', 400);
  if (!actorUid) throw serviceError('ADMIN_REQUIRED', 403);
  if (!Number.isSafeInteger(numericAmount) || numericAmount === 0 || Math.abs(numericAmount) > MAX_ADMIN_ADJUSTMENT_KURUS) {
    throw serviceError('STORE_BALANCE_ADJUSTMENT_INVALID', 400);
  }
  if (!['CREDIT', 'DEBIT', 'REFUND', 'CORRECTION'].includes(ledgerType)) throw serviceError('STORE_BALANCE_TYPE_INVALID', 400);
  if (['CREDIT', 'REFUND'].includes(ledgerType) && numericAmount < 0) throw serviceError('STORE_BALANCE_TYPE_AMOUNT_MISMATCH', 400);
  if (ledgerType === 'DEBIT' && numericAmount > 0) throw serviceError('STORE_BALANCE_TYPE_AMOUNT_MISMATCH', 400);
  if (safeReason.length < 3) throw serviceError('STORE_BALANCE_REASON_REQUIRED', 400);
  const key = requireIdempotencyKey(idempotencyKey);
  const safeRequestId = safeText(requestId, 180);
  const { db, auth } = firebaseStore();
  let targetAuthUser;
  try {
    targetAuthUser = await auth.getUser(safeUid);
  } catch (_) {
    throw serviceError('STORE_ACCOUNT_NOT_FOUND', 404);
  }
  if (targetAuthUser.disabled === true) throw serviceError('STORE_ACCOUNT_DISABLED', 409);
  const userRef = db.collection('users').doc(safeUid);
  const adjustmentId = hashIdempotency('store-wallet-adjustment', actorUid, key);
  const adjustmentRef = db.collection('storeWalletAdjustments').doc(adjustmentId);
  let result = null;

  await db.runTransaction(async (tx) => {
    const existing = await tx.get(adjustmentRef);
    if (existing.exists) {
      const data = existing.data() || {};
      if (data.uid !== safeUid || Number(data.amountKurus) !== numericAmount || String(data.type || 'CORRECTION') !== ledgerType || safeText(data.reason, 200) !== safeReason) throw serviceError('STORE_BALANCE_ADJUSTMENT_CONFLICT', 409);
      result = {
        uid: safeUid,
        type: ledgerType,
        amountKurus: Number(data.amountKurus),
        balanceBeforeKurus: clampBalance(data.balanceBeforeKurus),
        balanceAfterKurus: clampBalance(data.balanceAfterKurus),
        balanceKurus: clampBalance(data.balanceAfterKurus),
        transactionId: adjustmentId,
        requestId: safeText(data.requestId || safeRequestId, 180),
        idempotentReplay: true
      };
      return;
    }

    const userSnapshot = await tx.get(userRef);
    const existingProfile = userSnapshot.exists ? (userSnapshot.data() || {}) : {};
    const currentBalance = normalizeStoreProfile(existingProfile, targetAuthUser).balanceKurus;
    const nextBalance = currentBalance + numericAmount;
    if (nextBalance < 0) throw serviceError('STORE_BALANCE_WOULD_BE_NEGATIVE', 409, { balanceKurus: currentBalance });
    if (nextBalance > MAX_STORE_BALANCE_KURUS) throw serviceError('STORE_BALANCE_LIMIT_EXCEEDED', 409);
    const now = Date.now();
    tx.set(userRef, {
      ...(userSnapshot.exists ? {} : {
        email: safeText(targetAuthUser.email || '', 160).toLowerCase(),
        username: safeText(targetAuthUser.displayName || targetAuthUser.email?.split('@')[0] || 'SHELBY STORE Üyesi', 40),
        usernameLower: safeText(targetAuthUser.displayName || targetAuthUser.email?.split('@')[0] || '', 40).toLocaleLowerCase('tr-TR'),
        storeAccountStatus: 'active',
        storeProfile: { avatarId: '1' },
        storeCreatedAt: now
      }),
      storeBalanceKurus: nextBalance,
      storeUpdatedAt: now
    }, { merge: true });
    tx.create(adjustmentRef, {
      uid: safeUid,
      type: ledgerType,
      amountKurus: numericAmount,
      balanceBeforeKurus: currentBalance,
      balanceAfterKurus: nextBalance,
      reason: safeReason,
      actor: { uid: actorUid, email: actorEmail },
      requestId: safeRequestId,
      transactionId: adjustmentId,
      createdAt: now
    });
    tx.create(db.collection('storeWalletLedger').doc(adjustmentId), {
      uid: safeUid,
      type: ledgerType,
      amountKurus: numericAmount,
      balanceBeforeKurus: currentBalance,
      balanceAfterKurus: nextBalance,
      reason: safeReason,
      orderId: '',
      actor: { uid: actorUid, email: actorEmail, source: 'admin' },
      requestId: safeRequestId,
      transactionId: adjustmentId,
      username: safeText(existingProfile.username || targetAuthUser.displayName || '', 80),
      createdAt: now
    });
    tx.create(db.collection('audit').doc(`store_wallet_${adjustmentId}`), {
      uid: safeUid,
      type: 'store-wallet-adjustment',
      amountKurus: numericAmount,
      balanceBeforeKurus: currentBalance,
      balanceAfterKurus: nextBalance,
      reason: safeReason,
      actor: { uid: actorUid, email: actorEmail },
      requestId: safeRequestId,
      transactionId: adjustmentId,
      at: now
    });
    result = { uid: safeUid, type: ledgerType, amountKurus: numericAmount, balanceBeforeKurus: currentBalance, balanceAfterKurus: nextBalance, balanceKurus: nextBalance, transactionId: adjustmentId, requestId: safeRequestId, idempotentReplay: false };
  });

  if (!result) throw serviceError('STORE_BALANCE_ADJUSTMENT_FAILED', 500);
  invalidateCreatedAtPageCache('storeWalletLedger');
  return { ...result, committed: true };
}

async function updateOrderByAdmin({ orderId = '', input = {}, actor = {} } = {}) {
  const safeOrderId = safeText(orderId, 160);
  const actorUid = safeText(actor.uid, 160);
  const actorEmail = safeText(actor.email, 160);
  const requestedStatus = safeText(input.status, 30).toLowerCase();
  const deliveryTitle = safeText(input.deliveryTitle ?? input.delivery?.title, 100);
  const deliveryMessage = safeText(input.deliveryMessage ?? input.delivery?.message, 500);
  const manualDeliveryValues = Array.isArray(input.manualDeliveryValues)
    ? input.manualDeliveryValues.map((value) => String(value ?? '').trim()).filter(Boolean).slice(0, 100)
    : String(input.manualDeliveryText || '').split(/\r?\n/).map((value) => value.trim()).filter(Boolean).slice(0, 100);
  if (!safeOrderId) throw serviceError('STORE_ORDER_ID_REQUIRED', 400);
  if (!actorUid) throw serviceError('ADMIN_REQUIRED', 403);
  if (!ORDER_STATUSES.includes(requestedStatus)) throw serviceError('STORE_ORDER_STATUS_INVALID', 400);
  const { db, admin } = firebaseStore();
  const orderRef = db.collection('storeOrders').doc(safeOrderId);
  let result = null;
  let stockChanged = false;
  let previousStatus = '';

  await db.runTransaction(async (tx) => {
    const orderSnapshot = await tx.get(orderRef);
    if (!orderSnapshot.exists) throw serviceError('STORE_ORDER_NOT_FOUND', 404);
    const current = orderSnapshot.data() || {};
    const currentStatus = ORDER_STATUSES.includes(current.status) ? current.status : 'awaiting_payment';
    previousStatus = currentStatus;
    if (!ORDER_TRANSITIONS[currentStatus].includes(requestedStatus)) throw serviceError('STORE_ORDER_TRANSITION_INVALID', 409);
    if (currentStatus === 'cancelled' && requestedStatus === 'cancelled') {
      result = adminOrder(current, safeOrderId);
      return;
    }
    const promotionRelease = ['cancelled', 'payment_rejected', 'refunded'].includes(requestedStatus)
      ? await readPromotionReleaseInTransaction({ transaction: tx, db, order: current, orderId: safeOrderId })
      : null;

    const customerUid = safeText(current.uid, 160);
    const refundAmountKurus = clampBalance(current.totalKurus);
    const shouldRefundWallet = ['cancelled', 'refunded'].includes(requestedStatus)
      && current.paymentMethod === 'wallet'
      && ['paid', 'processing', 'delivery_pending', 'delivered'].includes(currentStatus)
      && !Number(current.walletRefundedAt || 0)
      && refundAmountKurus > 0;
    let refundBalanceBeforeKurus = 0;
    let refundBalanceAfterKurus = 0;
    let customerRef = null;
    if (shouldRefundWallet) {
      if (!customerUid) throw serviceError('STORE_ACCOUNT_NOT_FOUND', 404);
      customerRef = db.collection('users').doc(customerUid);
      const customerSnapshot = await tx.get(customerRef);
      if (!customerSnapshot.exists) throw serviceError('STORE_ACCOUNT_NOT_FOUND', 404);
      refundBalanceBeforeKurus = normalizeStoreProfile(customerSnapshot.data() || {}, {}).balanceKurus;
      refundBalanceAfterKurus = refundBalanceBeforeKurus + refundAmountKurus;
      if (refundBalanceAfterKurus > MAX_STORE_BALANCE_KURUS) throw serviceError('STORE_BALANCE_LIMIT_EXCEEDED', 409);
    }

    const now = Date.now();
    const previousDelivery = current.delivery && typeof current.delivery === 'object' ? current.delivery : {};
    const approvalRequested = ['paid', 'processing', 'delivery_pending', 'delivered'].includes(requestedStatus);
    const isTelegramOrder = current.paymentMethod === 'telegram' || current.salesChannel === 'telegram';
    const currentItems = (Array.isArray(current.items) ? current.items : []).map((item) => {
      const baseProduct = STORE_CATALOG.products.find((product) => product.id === item.productId);
      return {
        ...item,
        inventoryPoolId: String(item.inventoryPoolId || baseProduct?.inventoryPoolId || '').trim().toLowerCase(),
        inventoryType: item.inventoryType === 'account' || baseProduct?.inventoryType === 'account' ? 'account' : 'license'
      };
    });
    let allocations = [];
    if (isTelegramOrder) {
      if (manualDeliveryValues.length && !approvalRequested) throw serviceError('STORE_MANUAL_DELIVERY_PAYMENT_REQUIRED', 409);
      if (manualDeliveryValues.length && Math.max(0, Number(previousDelivery.itemCount) || 0) > 0) throw serviceError('STORE_MANUAL_DELIVERY_ALREADY_ATTACHED', 409);
      if (manualDeliveryValues.length) {
        allocations = await attachManualDeliveryInTransaction({
          tx, db, items: currentItems, values: manualDeliveryValues,
          orderId: safeOrderId, uid: safeText(current.uid, 160), now
        });
      }
    } else {
      const needsAllocation = approvalRequested && previousDelivery.status !== 'delivered';
      if (needsAllocation) {
        allocations = await allocateInventoryInTransaction({
          tx, db, admin, items: currentItems, orderId: safeOrderId,
          uid: safeText(current.uid, 160), now
        });
        stockChanged = true;
      }
    }
    const previousItemCount = Math.max(0, Number(previousDelivery.itemCount) || 0);
    const deliveryItemCount = previousItemCount || allocations.length;
    if (isTelegramOrder && requestedStatus === 'delivered' && deliveryItemCount < currentItems.reduce((total, item) => total + Math.max(1, Number(item.quantity) || 1), 0)) {
      throw serviceError('STORE_MANUAL_DELIVERY_REQUIRED', 409);
    }
    const finalStatus = !isTelegramOrder && allocations.length ? 'delivered' : requestedStatus;
    const fulfillmentStatus = isTelegramOrder
      ? ({
          awaiting_payment: 'TELEGRAM_ILETISIM_BEKLIYOR',
          payment_review: 'ODEME_KONTROL_EDILIYOR',
          paid: 'ODEME_ONAYLANDI',
          processing: 'URUN_TEMIN_EDILIYOR',
          delivery_pending: 'TESLIMAT_BEKLIYOR',
          delivered: 'TESLIM_EDILDI',
          payment_rejected: 'ODEME_REDDI',
          refunded: 'IADE_EDILDI',
          cancelled: 'IPTAL_EDILDI'
        }[finalStatus] || 'TELEGRAM_ILETISIM_BEKLIYOR')
      : (finalStatus === 'delivered' ? 'TESLIM_EDILDI' : safeText(current.fulfillmentStatus, 40));
    const patch = {
      status: finalStatus,
      salesChannel: isTelegramOrder ? 'telegram' : 'automatic',
      fulfillmentStatus,
      delivery: finalStatus === 'delivered'
        ? {
            status: 'delivered',
            title: deliveryTitle || safeText(previousDelivery.title, 100) || (isTelegramOrder ? 'Manuel teslimat hazır' : 'Otomatik teslimat hazır'),
            message: deliveryMessage || safeText(previousDelivery.message, 500) || 'Ödemeniz onaylandı. Dijital teslimat bilginiz güvenli teslimat ekranında hazır.',
            deliveredAt: Number(previousDelivery.deliveredAt) || now,
            itemCount: deliveryItemCount,
            automatic: !isTelegramOrder
          }
        : finalStatus === 'cancelled'
          ? { status: 'cancelled', title: '', message: '', deliveredAt: 0, itemCount: 0, automatic: !isTelegramOrder }
          : { ...previousDelivery, status: deliveryItemCount > 0 ? 'ready' : (previousDelivery.status || 'locked'), itemCount: deliveryItemCount, automatic: !isTelegramOrder },
      updatedAt: now,
      updatedBy: { uid: actorUid, email: actorEmail }
    };
    if (approvalRequested && !Number(current.approvedAt || 0)) {
      patch.approvedAt = now;
      patch.approvedBy = { uid: actorUid, email: actorEmail, source: 'admin' };
    }
    if (finalStatus === 'cancelled') {
      patch.cancelledAt = now;
      patch.cancelledBy = { uid: actorUid, email: actorEmail, source: 'admin' };
      patch.cancellationReason = safeText(input.cancellationReason || input.reason || 'Admin kararı', 200);
    }
    if (finalStatus === 'refunded') {
      patch.refundedAt = now;
      patch.refundedBy = { uid: actorUid, email: actorEmail, source: 'admin' };
      patch.refundReason = safeText(input.refundReason || input.reason || 'Admin iade işlemi', 200);
    }
    if (releasePromotionInTransaction({ transaction: tx, release: promotionRelease, reason: finalStatus, now })) {
      patch.promotion = { ...current.promotion, releasedAt: now };
    }
    if (shouldRefundWallet) {
      patch.walletRefundedAt = now;
      patch.walletRefundedKurus = refundAmountKurus;
      tx.set(customerRef, { storeBalanceKurus: refundBalanceAfterKurus, storeUpdatedAt: now }, { merge: true });
      tx.create(db.collection('storeWalletLedger').doc(`refund_${safeOrderId}`), {
        uid: customerUid,
        type: 'REFUND',
        amountKurus: refundAmountKurus,
        balanceBeforeKurus: refundBalanceBeforeKurus,
        balanceAfterKurus: refundBalanceAfterKurus,
        reason: requestedStatus === 'refunded' ? `Yönetici sipariş iadesi: ${patch.refundReason}` : `Yönetici sipariş iptali: ${patch.cancellationReason}`,
        orderId: safeOrderId,
        actor: { uid: actorUid, email: actorEmail, source: 'admin' },
        createdAt: now
      });
    }
    tx.set(orderRef, patch, { merge: true });
    tx.create(db.collection('audit').doc(`store_order_update_${safeOrderId}_${crypto.randomBytes(5).toString('hex')}`), {
      uid: safeText(current.uid, 160),
      type: 'store-order-update',
      orderId: safeOrderId,
      orderNumber: safeText(current.orderNumber, 40),
      previousStatus: currentStatus,
      requestedStatus,
      status: finalStatus,
      salesChannel: isTelegramOrder ? 'telegram' : 'automatic',
      deliveryItemCount: allocations.length,
      manualDeliveryAttached: isTelegramOrder && allocations.length > 0,
      refundedKurus: shouldRefundWallet ? refundAmountKurus : 0,
      actor: { uid: actorUid, email: actorEmail },
      at: now
    });
    result = adminOrder({ ...current, ...patch }, safeOrderId);
  });

  if (!result) throw serviceError('STORE_ORDER_UPDATE_FAILED', 500);
  if (stockChanged) invalidateStockCache();
  invalidateCreatedAtPageCache('storeOrders');
  invalidateCreatedAtPageCache('storeWalletLedger');
  return { ...result, previousStatus };
}

async function publicCatalog() {
  const catalog = await getEffectiveCatalog({ includeInactive: false });
  const firebase = initFirebaseAdmin();
  let stockVerified = true;
  let stocked;
  try {
    stocked = await decorateCatalogWithStock(catalog);
  } catch (error) {
    if (String(error?.code || error?.message) !== 'STORE_STORAGE_UNAVAILABLE') throw error;
    stockVerified = false;
    stocked = {
      ...catalog,
      products: catalog.products.map((product) => ({
        ...product,
        stock: { available: 0, state: 'unverified' },
        plans: product.plans.map((plan) => ({ ...plan, stock: { available: 0, delivered: 0, revoked: 0, state: 'unverified' } }))
      }))
    };
  }
  const backendReady = firebase.enabled === true && !!firebase.db && !!firebase.admin;
  const deliveryReady = backendReady && env.storeKeys.configured === true;
  const configuredServices = stocked.storefront?.services || {};
  const storefront = {
    ...(stocked.storefront || {}),
    services: {
      automaticDelivery: configuredServices.automaticDelivery !== false && deliveryReady,
      telegramSupport: configuredServices.telegramSupport !== false && backendReady,
      balancePayment: configuredServices.balancePayment !== false && deliveryReady
    }
  };
  const publicStock = (stock = {}, automaticDelivery = true) => {
    const available = Math.max(0, Math.trunc(Number(stock.available) || 0));
    const state = ['in_stock', 'low_stock', 'out_of_stock', 'not_applicable', 'unverified'].includes(String(stock.state || ''))
      ? String(stock.state)
      : available < 1 ? 'out_of_stock' : available <= 3 ? 'low_stock' : 'in_stock';
    return { available, state, automaticDelivery: automaticDelivery !== false };
  };
  const products = (stocked.products || []).map((product) => ({
    id: safeText(product.id, 80),
    platform: product.platform === 'ios' ? 'ios' : 'android',
    game: ['pubg', 'oxide'].includes(product.game) ? product.game : 'other',
    inventoryType: product.inventoryType === 'account' ? 'account' : 'license',
    fulfillmentMode: product.fulfillmentMode === 'telegram_only' ? 'telegram_only' : 'automatic',
    automaticEnabled: product.automaticEnabled !== false && product.fulfillmentMode !== 'telegram_only',
    telegramEnabled: product.telegramEnabled !== false,
    name: safeText(product.name, 80),
    category: safeText(product.category, 50),
    badgeKey: safeText(product.badgeKey, 40).toLowerCase().replace(/[^a-z0-9-]/g, ''),
    badge: safeText(product.badge, 40),
    badgeIcon: safeText(product.badgeIcon, 50).replace(/[^a-z0-9-]/gi, ''),
    badgeTone: safeText(product.badgeTone, 32).toLowerCase().replace(/[^a-z0-9-]/g, ''),
    icon: safeText(product.icon, 50),
    image: safeText(product.image, 300),
    accent: safeText(product.accent, 20),
    description: safeText(product.description, 240),
    featured: product.featured === true,
    tags: (Array.isArray(product.tags) ? product.tags : []).map((tag) => safeText(tag, 20)).filter(Boolean).slice(0, 8),
    stock: publicStock(product.stock, product.automaticEnabled !== false),
    plans: (Array.isArray(product.plans) ? product.plans : []).map((plan) => ({
      key: safeText(plan.key, 40),
      label: safeText(plan.label, 50),
      duration: safeText(plan.duration, 50),
      priceKurus: Math.max(1, Math.trunc(Number(plan.priceKurus) || 0)),
      stock: publicStock(plan.stock, product.automaticEnabled !== false)
    }))
  }));
  return {
    version: Math.max(1, Math.trunc(Number(stocked.version) || 1)),
    currency: 'TRY',
    telegramUsername: safeText(stocked.telegramUsername, 40).replace(/^@+/, '').replace(/[^a-zA-Z0-9_]/g, ''),
    storefront,
    stockVerified,
    badgeOptions: (Array.isArray(stocked.badgeOptions) ? stocked.badgeOptions : []).map((badge) => ({
      key: safeText(badge.key, 40).toLowerCase().replace(/[^a-z0-9-]/g, ''),
      label: safeText(badge.label, 40),
      icon: safeText(badge.icon, 50).replace(/[^a-z0-9-]/gi, ''),
      tone: safeText(badge.tone, 32).toLowerCase().replace(/[^a-z0-9-]/g, '')
    })).filter((badge) => badge.key && badge.label && badge.icon),
    avatars: publicAvatarCatalog(),
    products
  };
}

module.exports = {
  publicCatalog,
  readAccount,
  updateProfileAvatar,
  createOrder,
  previewStorePromotion,
  listOrders,
  listOrdersForAdmin,
  cancelOrderByUser,
  adjustStoreBalance,
  updateOrderByAdmin,
  serviceError
};
