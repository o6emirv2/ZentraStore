'use strict';

const crypto = require('node:crypto');
const { initFirebaseAdmin } = require('../config/firebaseAdmin');
const { requireShopierConfig } = require('../config/shopier');
const { definitiveCreationRejection, createShopierClient, shopierError, providerId, decimalKurus, money, paymentUrl } = require('./shopierClient');
const { normalizeCartIntent, normalizeCart, orderNumber, publicOrder, normalizeStoreProfile, readAccount } = require('./storeService');
const { getEffectiveCatalog, catalogRevision } = require('./storeCatalogService');
const { allocateInventoryInTransaction, releaseShopierReservationInTransaction, invalidateStockCache } = require('./storeInventoryService');
const { readPromotionInTransaction, applyPromotionInTransaction, readPromotionReleaseInTransaction, releasePromotionInTransaction } = require('./storePromotionService');
const { invalidateCreatedAtPageCache } = require('./firestorePagination');
const { topupAmount, readWalletSettlement, applyWalletSettlement } = require('./shopierWallet');
const { checkedBalance } = require('./storeMoney');
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const FINAL_TIME = 8640000000000000;
function database() {
  const firebase = initFirebaseAdmin();
  if (!firebase.db || !firebase.admin) throw shopierError('STORE_STORAGE_UNAVAILABLE');
  return firebase;
}
function identifier(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(value)) throw shopierError('STORE_ORDER_NOT_FOUND', 404);
  return value;
}
function customerUid(value) {
  if (typeof value !== 'string' || !value || value.length > 128 || value !== value.trim()
    || /[/\\<>\u0000-\u001f\u007f]/.test(value) || ['.', '..'].includes(value)) throw shopierError('AUTH_REQUIRED', 401);
  return value;
}
function attemptId(uid, key) {
  if (typeof key !== 'string' || !/^[A-Za-z0-9_.:-]{12,160}$/.test(key)) throw shopierError('IDEMPOTENCY_KEY_REQUIRED', 400);
  return hash(`shopier:${uid}:${key}`);
}
function refresh() { invalidateStockCache(); invalidateCreatedAtPageCache('storeOrders'); invalidateCreatedAtPageCache('storeWalletLedger'); require('./adminStoreService').invalidateAdminStoreCaches(); }
function audit(tx, db, order, type, extra = {}) {
  tx.create(db.collection('audit').doc(), { type, orderId: order.id, orderNumber: order.orderNumber,
    uid: order.uid, paymentMethod: 'shopier', at: Date.now(), ...extra });
}
function queueJob(tx, db, { id, kind, resourceId = '', orderId = '', availableAt = Date.now() }) {
  tx.set(db.collection('shopierJobs').doc(id), { id, kind, resourceId, orderId, availableAt,
    createdAt: Date.now(), attempts: 0, lease: '', completedAt: 0, failedAt: 0 });
}
function listingTitle(order) { return `ZENTRA STORE ${order.orderNumber} ${order.id}`; }
function listingDescription(order) {
  if (order.orderType === 'wallet_topup') return [`WEQ:${order.id}:${order.manifestHash}`, `İşlem: ${order.orderNumber}`,
    `ZENTRA STORE hesabına ${money(order.totalKurus)} TRY mağaza bakiyesi yükleme.`,
    'Bu işlem ürün satın almaz veya stok ayırmaz. Ürün satın alımı mağazada ayrıca yapılır.',
    'Bakiye yalnızca doğrulanmış ödeme sonrasında işlemi başlatan hesaba eklenir.',
    'Shopier ödeme e-postanız mağaza hesabınızla aynı olmalıdır.'].join('\n');
  return [`WEQ:${order.id}:${order.manifestHash}`, `Sipariş: ${order.orderNumber}`,
    ...order.items.map((item) => `${item.productName} | ${item.platform} | ${item.planLabel} (${item.duration}) | ${item.quantity} adet | ${item.productId}:${item.planKey}`),
    'Dijital teslimat yalnızca bu siparişin ZENTRA STORE hesabına yapılır. Shopier ödeme e-postanız mağaza hesabınızla aynı olmalıdır.',
    `Ödeme durumunu hesabınızdaki Siparişlerim bölümünden kontrol edin.`].join('\n');
}
function productRequest(order, config) {
  return { title: listingTitle(order), description: listingDescription(order), type: 'digital',
    media: [{ type: 'image', url: `${config.publicBaseUrl}/public/assets/images/apple-touch-icon.png`, placement: 1 }],
    priceData: { currency: 'TRY', price: money(order.totalKurus), shippingPrice: '0.00', discount: false },
    stockQuantity: 1, shippingPayer: 'sellerPays', customListing: true };
}
function validateProduct(product, order, { newListing = false } = {}) {
  providerId(product?.id);
  if (product.type !== 'digital' || product.title !== listingTitle(order) || typeof product.description !== 'string'
    || !product.description.includes(`WEQ:${order.id}:${order.manifestHash}`)
    || product.priceData?.currency !== 'TRY' || decimalKurus(product.priceData.price) !== order.totalKurus
    || product.priceData.discount === true || decimalKurus(product.priceData.shippingPrice ?? '0') !== 0
    || product.shippingPayer !== 'sellerPays' || product.customListing !== true
    || (newListing && product.stockQuantity !== 1)) throw shopierError('SHOPIER_PRODUCT_MISMATCH', 409);
  paymentUrl(product.url);
  return product;
}
async function bindProduct(orderId, product) {
  const { db } = database(), ref = db.collection('storeOrders').doc(orderId);
  await db.runTransaction(async (tx) => {
    const [snap, mapping] = await Promise.all([tx.get(ref), tx.get(db.collection('shopierProducts').doc(hash(product.id)))]);
    const order = snap.data();
    if (!order || order.paymentMethod !== 'shopier') throw shopierError('STORE_ORDER_NOT_FOUND', 404);
    validateProduct(product, order);
    if ((order.shopier.productId && order.shopier.productId !== product.id) || (mapping.exists && mapping.data().orderId !== orderId)) throw shopierError('SHOPIER_PRODUCT_MISMATCH', 409);
    if (order.shopier.productId) return;
    tx.set(db.collection('shopierProducts').doc(hash(product.id)), { productId: product.id, orderId, createdAt: Date.now() });
    tx.update(ref, { shopier: { ...order.shopier, productId: product.id, paymentUrl: paymentUrl(product.url),
      state: 'pending', lastError: '' }, updatedAt: Date.now() });
    queueJob(tx, db, { id: `reconcile_${orderId}`, kind: 'reconcile', orderId, availableAt: Date.now() + 60_000 });
    audit(tx, db, order, 'shopier.link.created', { productId: product.id });
  });
  refresh();
}
async function rejectCreation(orderId, error) {
  const { db } = database(), ref = db.collection('storeOrders').doc(orderId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref), order = snap.data();
    if (!order || order.shopier.productId || order.shopier.state !== 'creating') return;
    const uncertain = !definitiveCreationRejection(error);
    const now = Date.now();
    const release = uncertain ? null : await readPromotionReleaseInTransaction({ transaction: tx, db, order, orderId });
    if (!uncertain) await releaseShopierReservationInTransaction({ tx, db, order, now });
    const promotionReleased = releasePromotionInTransaction({ transaction: tx, release, reason: 'shopier-create-rejected', now });
    tx.update(ref, { status: uncertain ? 'payment_review' : 'payment_rejected', paymentState: uncertain ? 'pending' : 'failed',
      shopier: { ...order.shopier, state: uncertain ? 'creation_uncertain' : 'creation_failed', lastError: error.code || 'SHOPIER_API_ERROR' },
      ...(!uncertain ? { inventoryReservations: [], shopierOpen: false } : {}),
      ...(promotionReleased ? { promotion: { ...order.promotion, releasedAt: now } } : {}), updatedAt: now });
    if (uncertain) queueJob(tx, db, { id: `recover_${orderId}`, kind: 'recover', orderId, availableAt: now + 60_000 });
    audit(tx, db, order, uncertain ? 'shopier.create.uncertain' : 'shopier.create.rejected', { code: error.code || 'SHOPIER_API_ERROR' });
  });
  refresh();
}
async function createShopierPayment({ uid, authUser = {}, items = [], idempotencyKey, promotionCode = '', purpose = 'purchase', amountKurus }) {
  const config = requireShopierConfig({ creating: true });
  if (!['purchase', 'wallet_topup'].includes(purpose)) throw shopierError('SHOPIER_PURPOSE_INVALID', 400);
  const topup = purpose === 'wallet_topup';
  if (topup) topupAmount(amountKurus);
  const safeUid = customerUid(uid), id = attemptId(safeUid, idempotencyKey);
  const { db, admin } = database(), attemptRef = db.collection('shopierCheckoutAttempts').doc(id);
  const intent = topup ? [] : normalizeCartIntent(items);
  const requestHash = hash(JSON.stringify(topup ? { purpose, amountKurus } : { intent, promotionCode: String(promotionCode).trim().toUpperCase() }));
  const previous = await attemptRef.get();
  if (previous.exists) {
    if (previous.data().requestHash !== requestHash) throw shopierError('STORE_ORDER_CONFLICT', 409);
    return getShopierPayment({ uid: safeUid, orderId: previous.data().orderId });
  }
  const catalog = await getEffectiveCatalog({ includeInactive: false, fresh: true });
  if (catalog.storefront?.maintenance) throw shopierError('STORE_MAINTENANCE', 503);
  if (!topup && catalog.storefront?.services?.automaticDelivery === false) throw shopierError('STORE_AUTOMATIC_DELIVERY_DISABLED', 409);
  const cart = topup ? { items: [], totalKurus: amountKurus } : normalizeCart(items, catalog);
  if (!topup && cart.items.some((item) => item.fulfillmentMode === 'telegram_only' || !item.automaticEnabled)) throw shopierError('STORE_AUTOMATIC_DELIVERY_DISABLED', 409);
  await readAccount(safeUid, authUser);
  const ref = db.collection('storeOrders').doc();
  let orderId = '', created = false, order;
  await db.runTransaction(async (tx) => {
    const existing = await tx.get(attemptRef);
    if (existing.exists) {
      if (existing.data().requestHash !== requestHash) throw shopierError('STORE_ORDER_CONFLICT', 409);
      orderId = existing.data().orderId; return;
    }
    const settings = await tx.get(db.collection('storefrontSettings').doc('main'));
    if (catalog.revision && catalogRevision(settings.data() || {}) !== catalog.revision) throw shopierError('STORE_CATALOG_CHANGED', 409);
    const userRef = db.collection('users').doc(safeUid), user = await tx.get(userRef);
    const account = normalizeStoreProfile(user.data() || {}, authUser);
    if (topup ? !account.walletTopupAllowed : account.accountStatus !== 'active') throw shopierError('STORE_PURCHASE_BLOCKED', 403);
    if (topup) checkedBalance(account.balanceKurus + Math.max(0, amountKurus - account.walletDebtKurus));
    const open = await tx.get(db.collection('storeOrders').where('uid', '==', safeUid).where('shopierOpen', '==', true).limit(2));
    if (open.size >= 2) throw shopierError('SHOPIER_PENDING_LIMIT', 409);
    const promotion = topup ? null : await readPromotionInTransaction({ transaction: tx, db, uid: safeUid, code: promotionCode, cart });
    const totalKurus = promotion?.result.totalKurus ?? cart.totalKurus;
    if (!Number.isSafeInteger(totalKurus) || totalKurus < 1) throw shopierError('STORE_ORDER_TOTAL_INVALID', 409);
    const now = Date.now();
    const inventoryReservations = topup ? [] : await allocateInventoryInTransaction({ tx, db, admin, items: cart.items, orderId: ref.id, uid: safeUid, now, reserveOnly: true });
    order = { id: ref.id, uid: safeUid, email: account.email, username: account.username, orderNumber: orderNumber(),
      status: 'awaiting_payment', paymentMethod: 'shopier', paymentState: 'pending', currency: 'TRY',
      orderType: topup ? 'wallet_topup' : 'purchase',
      ...(topup ? { walletTopup: { requestedKurus: amountKurus, netAppliedKurus: 0, balanceAddedKurus: 0, debtSettledKurus: 0, settledAt: 0 } } : {}),
      salesChannel: 'automatic', fulfillmentStatus: 'ODEME_BEKLIYOR', items: cart.items,
      subtotalKurus: cart.totalKurus, totalKurus, discountKurus: promotion?.result.discountKurus || 0,
      promotion: promotion ? { code: promotion.result.code, title: promotion.result.title, discountKurus: promotion.result.discountKurus } : null,
      inventoryReservations, manifestHash: hash(JSON.stringify({ items: cart.items, totalKurus, currency: 'TRY' })),
      shopierOpen: true, shopier: { state: 'creating', productId: '', orderId: '', lastError: '', createdAt: now },
      delivery: { status: 'locked', itemCount: 0, deliveredAt: 0, automatic: !topup },
      approvedAt: 0, paidAt: 0, createdAt: now, updatedAt: now, catalogVersion: catalog.version };
    applyPromotionInTransaction({ transaction: tx, promotion, uid: safeUid, orderId: ref.id, now });
    tx.create(ref, order);
    tx.create(attemptRef, { uid: safeUid, orderId: ref.id, requestHash, createdAt: now });
    tx.set(userRef, { [topup ? 'storeTopupCount' : 'storeOrderCount']: admin.firestore.FieldValue.increment(1), storeUpdatedAt: now }, { merge: true });
    // Crash recovery is durable before the non-idempotent remote POST is attempted.
    queueJob(tx, db, { id: `recover_${ref.id}`, kind: 'recover', orderId: ref.id, availableAt: now + 60_000 });
    audit(tx, db, order, 'shopier.order.pending', { totalKurus });
    orderId = ref.id; created = true;
  });
  refresh();
  if (created) {
    try {
      const product = await createShopierClient({ config }).createProduct(productRequest(order, config));
      validateProduct(product, order, { newListing: true });
      await bindProduct(orderId, product);
    } catch (error) {
      await rejectCreation(orderId, error);
      // The response carries the persisted order; the client can recover without repeating the POST.
    }
  }
  return getShopierPayment({ uid: safeUid, orderId });
}
async function getShopierPayment({ uid, orderId, idempotencyKey }) {
  const { db } = database();
  if (idempotencyKey) {
    const attempt = await db.collection('shopierCheckoutAttempts').doc(attemptId(customerUid(uid), idempotencyKey)).get();
    if (!attempt.exists) return { found: false };
    orderId = attempt.data().orderId;
  }
  const snap = await db.collection('storeOrders').doc(identifier(orderId)).get(), order = snap.data();
  if (!order || order.uid !== uid || order.paymentMethod !== 'shopier') throw shopierError('STORE_ORDER_NOT_FOUND', 404);
  const config = require('../config/shopier').getShopierConfig();
  return { found: true, order: publicOrder(order, snap.id),
    paymentUrl: order.shopier.state === 'pending' && !order.shopier.linkClosedAt && order.paymentState === 'pending' && order.shopier.paymentUrl ? paymentUrl(order.shopier.paymentUrl) : '',
    resultUrl: config.successUrl, cancelUrl: config.cancelUrl };
}
async function recoverShopierProduct(orderId) {
  const { db } = database(), snap = await db.collection('storeOrders').doc(identifier(orderId)).get(), order = snap.data();
  if (!order || order.paymentMethod !== 'shopier') throw shopierError('STORE_ORDER_NOT_FOUND', 404);
  if (order.shopier.productId || order.shopier.state === 'creation_failed') return;
  const client = createShopierClient();
  const candidates = [];
  for (let page = 1; page <= 5; page++) {
    const products = await client.listProducts({ customListing: 'true', productType: 'digital', dateStart: new Date(order.createdAt - 60_000).toISOString(), limit: '50', page: String(page) });
    candidates.push(...products.filter((row) => row.title === listingTitle(order)));
    if (products.length < 50) break;
  }
  if (candidates.length !== 1) throw shopierError('SHOPIER_CREATION_REVIEW_REQUIRED', 409);
  await bindProduct(orderId, validateProduct(candidates[0], order));
}
function validateProviderOrder(remote, local) {
  providerId(remote?.id);
  if (!['fulfilled', 'unfulfilled'].includes(remote.status) || !['debitCard', 'creditCard'].includes(remote.paymentMethod)) throw shopierError('SHOPIER_RESPONSE_INVALID', 502);
  if (!['paid', 'unpaid'].includes(remote.paymentStatus)) throw shopierError('SHOPIER_PAYMENT_STATUS_INVALID', 409);
  if (remote.currency !== 'TRY') throw shopierError('SHOPIER_CURRENCY_MISMATCH', 409);
  if (decimalKurus(remote.totals?.total) !== local.totalKurus || decimalKurus(remote.totals?.subtotal) !== local.totalKurus
    || decimalKurus(remote.totals?.shipping) !== 0 || decimalKurus(remote.totals?.discount) !== 0) throw shopierError('SHOPIER_AMOUNT_MISMATCH', 409);
  const lines = remote.lineItems;
  if (!Array.isArray(lines) || lines.length !== 1 || lines[0].productId !== local.shopier.productId
    || lines[0].type !== 'digital' || lines[0].quantity !== 1 || lines[0].title !== listingTitle(local)
    || decimalKurus(lines[0].price) !== local.totalKurus || decimalKurus(lines[0].total) !== local.totalKurus
    || (lines[0].options && (!Array.isArray(lines[0].options) || lines[0].options.length))
    || (lines[0].selection && (!Array.isArray(lines[0].selection) || lines[0].selection.length))) throw shopierError('SHOPIER_PRODUCT_MISMATCH', 409);
  if (typeof remote.shippingInfo?.email !== 'string' || remote.shippingInfo.email.trim().toLowerCase() !== local.email.toLowerCase()) throw shopierError('SHOPIER_CUSTOMER_MISMATCH', 409);
  if (!Array.isArray(remote.refunds)) throw shopierError('SHOPIER_RESPONSE_INVALID', 502);
  let refundedKurus = 0, pendingRefund = false, failedRefund = false;
  const ids = new Set();
  for (const refund of remote.refunds) {
    providerId(refund.id);
    if (ids.has(refund.id) || !['pending', 'failed', 'succeeded'].includes(refund.status)) throw shopierError('SHOPIER_RESPONSE_INVALID', 502);
    ids.add(refund.id);
    const amount = decimalKurus(refund.total);
    if (refund.status === 'succeeded') refundedKurus += amount;
    if (refund.status === 'pending') pendingRefund = true;
    if (refund.status === 'failed') failedRefund = true;
  }
  if (refundedKurus > local.totalKurus) throw shopierError('SHOPIER_AMOUNT_MISMATCH', 409);
  return { refundedKurus, refundPending: pendingRefund, refundStatus: refundedKurus === local.totalKurus ? 'full' : refundedKurus ? 'partial' : pendingRefund ? 'pending' : failedRefund ? 'failed' : 'none' };
}
async function applyShopierOrder(remote) {
  const { db } = database();
  const productId = remote?.lineItems?.[0]?.productId;
  providerId(productId);
  const mapping = await db.collection('shopierProducts').doc(hash(productId)).get();
  if (!mapping.exists) throw shopierError('SHOPIER_ORDER_UNMAPPED', 409);
  const orderRef = db.collection('storeOrders').doc(mapping.data().orderId), receiptRef = db.collection('shopierPayments').doc(hash(providerId(remote.id)));
  await db.runTransaction(async (tx) => {
    const [snap, receipt] = await Promise.all([tx.get(orderRef), tx.get(receiptRef)]), order = snap.data();
    if (!order || order.paymentMethod !== 'shopier') throw shopierError('SHOPIER_ORDER_UNMAPPED', 409);
    const refund = validateProviderOrder(remote, order);
    if ((receipt.exists && receipt.data().orderId !== snap.id) || (order.shopier.orderId && order.shopier.orderId !== remote.id)) throw shopierError('SHOPIER_PAYMENT_ALREADY_BOUND', 409);
    if (remote.paymentStatus === 'unpaid') return; // Never downgrade an earlier paid state.
    if (refund.refundedKurus < Number(order.shopier.refundedKurus || 0) || (order.paymentState === 'refunded' && refund.refundStatus !== 'full')) return;
    const now = Date.now(), alreadyPaid = Number(order.paidAt || 0) > 0;
    const fullRefund = refund.refundStatus === 'full';
    const late = order.paymentState === 'cancelled' || order.shopier.state === 'creation_failed' || order.shopier.state === 'paid_review' || !!order.cancelledAt;
    const paymentState = fullRefund ? 'refunded' : 'paid';
    const walletSettlement = await readWalletSettlement({ tx, db, order, refund, late, now });
    const walletReady = walletSettlement?.settled && walletSettlement.wallet.netAppliedKurus > 0;
    const status = fullRefund ? 'refunded' : walletReady || order.status === 'delivered' ? 'delivered' : 'paid';
    const release = fullRefund && !order.promotion?.releasedAt ? await readPromotionReleaseInTransaction({ transaction: tx, db, order, orderId: snap.id }) : null;
    const shouldRelease = fullRefund && order.inventoryReservations?.length && !order.delivery?.itemCount;
    if (shouldRelease) await releaseShopierReservationInTransaction({ tx, db, order, now });
    const promotionReleased = releasePromotionInTransaction({ transaction: tx, release, reason: 'shopier-refunded', now });
    const shopier = { ...order.shopier, orderId: remote.id, state: fullRefund ? 'refunded' : late ? 'paid_review' : 'paid',
      verifiedAt: now, lastError: late ? 'SHOPIER_LATE_PAYMENT_REVIEW' : '', ...refund };
    applyWalletSettlement({ tx, db, order, settlement: walletSettlement });
    tx.set(receiptRef, { orderId: snap.id, providerOrderId: remote.id, productId, amountKurus: order.totalKurus, currency: 'TRY', verifiedAt: now }, { merge: true });
    tx.update(orderRef, { status, paymentState, shopierOpen: false, shopier, approvedAt: order.approvedAt || now,
      approvedBy: { uid: 'system', source: 'shopier-api-verified' }, paidAt: order.paidAt || now,
      ...(shouldRelease ? { inventoryReservations: [] } : {}), ...(fullRefund ? { refundedAt: order.refundedAt || now } : {}),
      ...(walletSettlement ? { walletTopup: walletSettlement.wallet, fulfillmentStatus: fullRefund ? 'BAKIYE_IADE_EDILDI' : walletReady ? 'BAKIYE_YUKLENDI' : 'BAKIYE_ONAY_BEKLIYOR' } : {}),
      ...(promotionReleased ? { promotion: { ...order.promotion, releasedAt: now } } : {}), updatedAt: now });
    if (!alreadyPaid || refund.refundStatus !== order.shopier.refundStatus) audit(tx, db, order, fullRefund ? 'shopier.payment.refunded' : 'shopier.payment.verified', { providerOrderId: remote.id, ...refund });
    if (!walletSettlement && !fullRefund && !late && !['partial', 'pending'].includes(refund.refundStatus) && !order.delivery?.itemCount) {
      queueJob(tx, db, { id: `delivery_${snap.id}`, kind: 'delivery', orderId: snap.id });
    }
  });
  refresh();
  return orderRef.id;
}
async function deliverShopierOrder(orderId, { actor = { uid: 'system', source: 'shopier-worker' } } = {}) {
  const { db, admin } = database(), ref = db.collection('storeOrders').doc(identifier(orderId));
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref), order = snap.data();
      if (!order || order.paymentMethod !== 'shopier') throw shopierError('STORE_ORDER_NOT_FOUND', 404);
      if (order.orderType === 'wallet_topup') throw shopierError('SHOPIER_TOPUP_RECONCILE_REQUIRED', 409);
      const payment = order.shopier.orderId ? await tx.get(db.collection('shopierPayments').doc(hash(order.shopier.orderId))) : null;
      if (!payment?.exists || payment.data().orderId !== orderId || order.paymentState !== 'paid' || !order.paidAt) throw shopierError('SHOPIER_PAYMENT_NOT_VERIFIED', 409);
      if (order.delivery?.itemCount > 0 || order.status === 'delivered') return;
      if (['partial', 'pending', 'full'].includes(order.shopier.refundStatus) || order.shopier.state === 'paid_review') throw shopierError('SHOPIER_DELIVERY_REVIEW_REQUIRED', 409);
      const now = Date.now();
      const allocations = await allocateInventoryInTransaction({ tx, db, admin, items: order.items, reservations: order.inventoryReservations || [], orderId, uid: order.uid, now });
      tx.update(ref, { status: 'delivered', fulfillmentStatus: 'TESLIM_EDILDI', delivery: { status: 'delivered', title: 'Otomatik teslimat hazır',
        message: 'Shopier ödemeniz doğrulandı. Dijital teslimat bilgileriniz güvenli teslimat ekranında hazır.',
        deliveredAt: now, itemCount: allocations.length, automatic: true }, updatedAt: now });
      audit(tx, db, order, 'shopier.delivery.completed', { count: allocations.length, actor });
    });
  } catch (error) {
    if (['STORE_STOCK_CONFLICT', 'STORE_OUT_OF_STOCK', 'SHOPIER_DELIVERY_REVIEW_REQUIRED'].includes(error.code)) {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref), order = snap.data();
        if (!order || order.paymentState !== 'paid' || order.delivery?.itemCount > 0) return;
        tx.update(ref, { status: 'delivery_pending', fulfillmentStatus: 'TESLIMAT_BEKLIYOR', shopier: { ...order.shopier, lastError: error.code }, updatedAt: Date.now() });
        audit(tx, db, order, 'shopier.delivery.review', { code: error.code, actor });
      });
    }
    throw error;
  } finally { refresh(); }
}
async function reconcileShopierOrder(orderId) {
  const { db } = database();
  let order = (await db.collection('storeOrders').doc(identifier(orderId)).get()).data();
  if (!order || order.paymentMethod !== 'shopier') throw shopierError('STORE_ORDER_NOT_FOUND', 404);
  if (!order.shopier.productId) {
    await recoverShopierProduct(orderId);
    order = (await db.collection('storeOrders').doc(orderId).get()).data();
    if (!order.shopier.productId) return false;
  }
  const client = createShopierClient();
  if (order.shopier.orderId) { await applyShopierOrder(await client.getOrder(order.shopier.orderId)); return true; }
  const orders = await client.listOrders({ productId: order.shopier.productId, limit: '50', page: '1' });
  if (orders.length > 1) throw shopierError('SHOPIER_MULTIPLE_PAYMENTS_REVIEW', 409);
  if (!orders.length) return false;
  await applyShopierOrder(await client.getOrder(providerId(orders[0].id)));
  return true;
}
async function closeShopierOrder(orderId, actor) {
  const { db } = database(), ref = db.collection('storeOrders').doc(identifier(orderId));
  let order = (await ref.get()).data();
  if (!order || order.paymentMethod !== 'shopier') throw shopierError('STORE_ORDER_NOT_FOUND', 404);
  if (order.paidAt || order.shopier.orderId) throw shopierError('SHOPIER_PROVIDER_ACTION_REQUIRED', 409);
  if (!order.shopier.productId) { await recoverShopierProduct(orderId); order = (await ref.get()).data(); }
  if (!order.shopier.productId) throw shopierError('SHOPIER_CREATION_REVIEW_REQUIRED', 409);
  const client = createShopierClient();
  validateProduct(await client.getProduct(order.shopier.productId), order);
  const closed = await client.updateProduct(order.shopier.productId, { stockQuantity: 0 });
  if (closed.id !== order.shopier.productId || closed.stockQuantity !== 0) throw shopierError('SHOPIER_LINK_CLOSE_UNVERIFIED', 409);
  // This closes the listing only; it is not a refund or proof that an in-flight card payment was cancelled.
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref), current = snap.data();
    if (current.paidAt) throw shopierError('SHOPIER_PROVIDER_ACTION_REQUIRED', 409);
    tx.update(ref, { shopier: { ...current.shopier, linkClosedAt: current.shopier.linkClosedAt || Date.now() }, updatedAt: Date.now() });
    audit(tx, db, current, 'shopier.link.closed', { actor });
  });
  const found = await reconcileShopierOrder(orderId);
  if (found) throw shopierError('SHOPIER_PROVIDER_ACTION_REQUIRED', 409);
  // Require a second explicit check after a grace interval before making reserved keys available again.
  order = (await ref.get()).data();
  if (Date.now() - order.shopier.linkClosedAt < 10 * 60_000) return { closed: true, released: false, reviewAfter: order.shopier.linkClosedAt + 10 * 60_000 };
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref), current = snap.data();
    if (current.paidAt || !current.shopier.linkClosedAt || current.paymentState === 'cancelled') return;
    const now = Date.now(), release = await readPromotionReleaseInTransaction({ transaction: tx, db, order: current, orderId });
    await releaseShopierReservationInTransaction({ tx, db, order: current, now });
    const promotionReleased = releasePromotionInTransaction({ transaction: tx, release, reason: 'shopier-link-closed', now });
    tx.update(ref, { status: 'cancelled', paymentState: 'cancelled', shopierOpen: false, cancelledAt: now,
      inventoryReservations: [], shopier: { ...current.shopier, state: 'cancelled' },
      ...(promotionReleased ? { promotion: { ...current.promotion, releasedAt: now } } : {}), updatedAt: now });
    audit(tx, db, current, 'shopier.order.closed', { actor });
  });
  refresh();
  return { closed: true, released: true };
}
module.exports = { hash, FINAL_TIME, queueJob, createShopierPayment, getShopierPayment, recoverShopierProduct,
  reconcileShopierOrder, validateProviderOrder, applyShopierOrder, deliverShopierOrder, closeShopierOrder, productRequest, listingTitle, listingDescription };
