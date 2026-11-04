'use strict';

const crypto = require('node:crypto');
const { initFirebaseAdmin } = require('../config/firebaseAdmin');
const { createShopierClient, shopierError, decimalKurus, money, providerId } = require('./shopierClient');
const { requireShopierConfig } = require('../config/shopier');
const { paymentChannel } = require('./orderChannel');
const GRACE_MS = 10 * 60_000;
function storage() {
  const { db } = initFirebaseAdmin();
  if (!db) throw shopierError('STORE_STORAGE_UNAVAILABLE');
  return db;
}
function reference(db, id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(id)) throw shopierError('STORE_ORDER_NOT_FOUND', 404);
  return db.collection('storeOrders').doc(id);
}
function audit(tx, db, order, type, actor, details = {}) {
  tx.create(db.collection('audit').doc(), { type, orderId: order.id, orderNumber: order.orderNumber || '', actor, at: Date.now(), ...details });
}
async function operation(db, ref, kind, actor, callback) {
  const token = crypto.randomUUID();
  await db.runTransaction(async tx => {
    const row = (await tx.get(ref)).data();
    if (!row || paymentChannel(row) !== 'shopier') throw shopierError('STORE_ORDER_NOT_FOUND', 404);
    if (row.shopier?.operation?.until > Date.now()) throw shopierError('SHOPIER_OPERATION_BUSY', 409);
    tx.update(ref, { paymentMethod: 'shopier', shopier: { ...row.shopier, operation: { token, kind, until: Date.now() + 5 * 60_000 } } });
  });
  try { return await callback(); }
  catch (error) {
    await db.runTransaction(async tx => {
      const row = (await tx.get(ref)).data();
      if (!row || row.shopier?.operation?.token !== token) return;
      tx.update(ref, { shopier: { ...row.shopier, lastError: error.code || 'SHOPIER_API_ERROR' }, updatedAt: Date.now() });
      audit(tx, db, row, `shopier.${kind}.failed`, actor, { code: error.code || 'SHOPIER_API_ERROR' });
    });
    throw error;
  } finally {
    await db.runTransaction(async tx => {
      const row = (await tx.get(ref)).data();
      if (row?.shopier?.operation?.token === token) tx.update(ref, { shopier: { ...row.shopier, operation: null } });
    });
    require('./storeInventoryService').invalidateStockCache();
    require('./firestorePagination').invalidateCreatedAtPageCache('storeOrders');
    require('./adminStoreService').invalidateAdminStoreCaches();
  }
}
async function requestShopierOperation(orderId, actor, { cancel = false } = {}) {
  requireShopierConfig({ management: true });
  const db = storage(), ref = reference(db, orderId), service = require('./shopierService');
  let result;
  await db.runTransaction(async tx => {
    const row = (await tx.get(ref)).data();
    if (!row || paymentChannel(row) !== 'shopier') throw shopierError('STORE_ORDER_NOT_FOUND', 404);
    const kind = cancel ? 'cancel' : 'close';
    const jobRef = db.collection('shopierJobs').doc(`${kind}_${orderId}`), job = (await tx.get(jobRef)).data();
    if (!cancel && (row.paidAt || row.shopier?.orderId)) throw shopierError('SHOPIER_PROVIDER_ACTION_REQUIRED', 409);
    if (cancel && row.orderType !== 'wallet_topup' && (row.delivery?.itemCount || row.status === 'delivered')) throw shopierError('SHOPIER_DELIVERED_REFUND_REVIEW_REQUIRED', 409);
    if ((cancel && ['cancelled', 'refunded'].includes(row.status)) || (!cancel && row.shopier?.closureFinalizedAt)) {
      result = { closed: !!row.shopier.linkClosedAt, noLinkIssued: row.shopier.closureReason === 'no_listing_issued', cancelled: row.status === 'cancelled', refunded: row.status === 'refunded', released: true, pending: false }; return;
    }
    const now = Date.now();
    tx.update(ref, { paymentMethod: 'shopier', shopier: { ...row.shopier, ...(cancel
      ? { cancelRequestedAt: row.shopier?.cancelRequestedAt || now, cancelRequestedBy: row.shopier?.cancelRequestedBy || actor }
      : { closeRequestedAt: row.shopier?.closeRequestedAt || now }) }, updatedAt: now });
    if (!job || job.failedAt || job.completedAt) service.queueJob(tx, db, { id: jobRef.id, kind, orderId });
    tx.set(jobRef, { requestedBy: { uid: actor.uid }, authorizedAt: now }, { merge: true });
    if (!(cancel ? row.shopier?.cancelRequestedAt : row.shopier?.closeRequestedAt)) audit(tx, db, row, cancel ? 'shopier.cancellation.requested' : 'shopier.link.close_requested', actor);
    result = { accepted: true, closed: !!row.shopier?.linkClosedAt, released: false, pending: true, jobId: jobRef.id };
  });
  require('./shopierJobs').wakeShopierWorker();
  require('./adminStoreService').invalidateAdminStoreCaches();
  return result;
}
async function markCancellation(orderId, actor) {
  const db = storage(), ref = reference(db, orderId);
  await db.runTransaction(async tx => {
    const row = (await tx.get(ref)).data();
    if (!row || paymentChannel(row) !== 'shopier') throw shopierError('STORE_ORDER_NOT_FOUND', 404);
    if (row.orderType !== 'wallet_topup' && (row.delivery?.itemCount || row.status === 'delivered')) throw shopierError('SHOPIER_DELIVERED_REFUND_REVIEW_REQUIRED', 409);
    if (row.shopier?.cancelRequestedAt) return;
    tx.update(ref, { paymentMethod: 'shopier', shopier: { ...row.shopier, cancelRequestedAt: Date.now(), cancelRequestedBy: actor }, updatedAt: Date.now() });
    audit(tx, db, row, 'shopier.cancellation.requested', actor);
  });
}
function transient(error) {
  return ['SHOPIER_TIMEOUT', 'SHOPIER_CONNECTION_FAILED', 'SHOPIER_RATE_LIMITED'].includes(error.code)
    || [408, 429, 500, 502, 503, 504].includes(error.providerStatus);
}
async function closeShopierOrder(orderId, actor = { uid: 'system', source: 'worker' }, { cancel = false } = {}) {
  const db = storage(), ref = reference(db, orderId), service = require('./shopierService');
  if (cancel) await markCancellation(orderId, actor);
  return operation(db, ref, 'close', actor, async () => {
    let order = (await ref.get()).data();
    if (order.paidAt || order.shopier.orderId) throw shopierError('SHOPIER_PROVIDER_ACTION_REQUIRED', 409);
    // A definitively rejected create never issued a link. This is distinct from a closed provider link.
    const noListing = order.shopier.state === 'creation_failed' && !order.shopier.productId && !order.shopier.paymentUrl && order.shopierOpen === false;
    if (!noListing) {
      if (!order.shopier.productId) {
        await service.recoverShopierProduct(orderId);
        order = (await ref.get()).data();
      }
      if (!order.shopier.productId) throw shopierError('SHOPIER_CREATION_REVIEW_REQUIRED', 409);
      const client = createShopierClient();
      const product = await client.getProduct(order.shopier.productId);
      service.validateProduct(product, order);
      if (product.stockQuantity !== 0) {
        try { await client.updateProduct(order.shopier.productId, { stockQuantity: 0 }); }
        catch (error) { if (!error.uncertain && !transient(error)) throw error; }
      }
      const verified = await client.getProduct(order.shopier.productId);
      service.validateProduct(verified, order);
      if (verified.id !== order.shopier.productId || verified.stockQuantity !== 0) throw shopierError('SHOPIER_LINK_CLOSE_UNVERIFIED', 409);
      await db.runTransaction(async tx => {
        const row = (await tx.get(ref)).data(), now = Date.now();
        const queued = await tx.get(db.collection('shopierJobs').doc(`close_${orderId}`));
        const closedAt = row.shopier.linkClosedAt || now;
        tx.update(ref, { paymentState: row.paidAt ? row.paymentState : 'link_closed',
          shopier: { ...row.shopier, linkClosedAt: closedAt, closeReviewAfter: closedAt + GRACE_MS, closeVerifiedAt: now,
            state: row.paidAt ? row.shopier.state : 'link_closed', lastError: '' }, updatedAt: now });
        if (!queued.exists || queued.data().failedAt) service.queueJob(tx, db, { id: `close_${orderId}`, kind: 'close', orderId, availableAt: closedAt + GRACE_MS });
        if (!row.shopier.linkClosedAt) audit(tx, db, row, 'shopier.link.closed', actor, { providerProductId: verified.id });
      });
      try { await service.reconcileShopierOrder(orderId); }
      catch (error) {
        if (!transient(error)) throw error;
        await db.runTransaction(async tx => {
          const row = (await tx.get(ref)).data();
          tx.update(ref, { shopier: { ...row.shopier, lastError: error.code }, updatedAt: Date.now() });
        });
        return { closed: true, released: false, pending: true, uncertain: true, verificationError: error.code, reviewAfter: Date.now() + 60_000 };
      }
      order = (await ref.get()).data();
      if (order.paidAt) throw shopierError('SHOPIER_PROVIDER_ACTION_REQUIRED', 409);
      if (Date.now() < order.shopier.closeReviewAfter) return { closed: true, released: false, pending: true, reviewAfter: order.shopier.closeReviewAfter };
    }
    let released = false;
    await db.runTransaction(async tx => {
      const row = (await tx.get(ref)).data();
      if (row.paidAt) throw shopierError('SHOPIER_PROVIDER_ACTION_REQUIRED', 409);
      if (row.shopier.closureFinalizedAt && (!cancel || row.status === 'cancelled')) { released = true; return; }
      const now = Date.now();
      const { readPromotionReleaseInTransaction, releasePromotionInTransaction } = require('./storePromotionService');
      const release = await readPromotionReleaseInTransaction({ transaction: tx, db, order: row, orderId });
      await require('./storeInventoryService').releaseShopierReservationInTransaction({ tx, db, order: row, now });
      const promotionReleased = releasePromotionInTransaction({ transaction: tx, release, reason: 'shopier-link-closed', now });
      const cancelled = cancel || !!row.shopier.cancelRequestedAt;
      tx.update(ref, { ...(cancelled ? { status: 'cancelled', cancelledAt: now, cancelledBy: row.shopier.cancelRequestedBy || actor } : {}),
        paymentState: cancelled ? 'cancelled' : noListing ? row.paymentState : 'link_closed', shopierOpen: false, inventoryReservations: [],
        shopier: { ...row.shopier, state: cancelled ? 'cancelled' : noListing ? 'creation_failed' : 'link_closed', closureFinalizedAt: now, ...(noListing ? { closureReason: 'no_listing_issued' } : {}), lastError: '' },
        ...(promotionReleased ? { promotion: { ...row.promotion, releasedAt: now } } : {}), updatedAt: now });
      audit(tx, db, row, cancelled ? 'shopier.order.cancelled' : noListing ? 'shopier.no_listing.confirmed' : 'shopier.link.finalized', actor);
      released = true;
    });
    return { closed: !noListing, noLinkIssued: noListing, released, pending: false };
  });
}
async function refundShopierOrder(orderId, actor) {
  const db = storage(), ref = reference(db, orderId), service = require('./shopierService');
  await markCancellation(orderId, actor);
  return operation(db, ref, 'refund', actor, async () => {
    await service.reconcileShopierOrder(orderId);
    let row = (await ref.get()).data();
    if (row.shopier.refundStatus === 'full' && row.paymentState === 'refunded') return { refunded: true, pending: false };
    if (!row.paidAt || !row.shopier.orderId) throw shopierError('SHOPIER_PAYMENT_NOT_VERIFIED', 409);
    if (row.orderType !== 'wallet_topup' && (row.delivery?.itemCount || row.status === 'delivered')) throw shopierError('SHOPIER_DELIVERED_REFUND_REVIEW_REQUIRED', 409);
    if (row.shopier.refundRequest?.state === 'failed' || row.shopier.refundStatus === 'failed') throw shopierError('SHOPIER_REFUND_FAILED_REVIEW_REQUIRED', 409);
    if (row.shopier.refundRequest || row.shopier.refundPending) return { refunded: false, pending: true, uncertain: row.shopier.refundRequest?.state === 'uncertain' };
    const amountKurus = row.totalKurus - (row.shopier.refundedKurus || 0);
    if (amountKurus <= 0) throw shopierError('SHOPIER_REFUND_MISMATCH', 409);
    await db.runTransaction(async tx => {
      const current = (await tx.get(ref)).data();
      if (current.shopier.refundRequest || (current.orderType !== 'wallet_topup' && current.delivery?.itemCount)) throw shopierError('SHOPIER_REFUND_REVIEW_REQUIRED', 409);
      tx.update(ref, { shopier: { ...current.shopier, cancelRequestedAt: current.shopier.cancelRequestedAt || Date.now(),
        refundRequest: { state: 'requesting', amountKurus, requestedAt: Date.now() } }, updatedAt: Date.now() });
      audit(tx, db, current, 'shopier.refund.requested', actor, { amountKurus });
    });
    const client = createShopierClient();
    let remote, failure;
    try {
      remote = await client.createRefund({ orderId: row.shopier.orderId, amount: money(amountKurus), note: `ZENTRA STORE ${row.orderNumber} yönetici iptali` });
      providerId(remote?.id);
      if (remote.orderId !== row.shopier.orderId || remote.currency !== 'TRY' || decimalKurus(remote.total) !== amountKurus
        || !['pending', 'succeeded', 'failed'].includes(remote.status)) throw shopierError('SHOPIER_REFUND_MISMATCH', 409);
    } catch (error) { failure = error; }
    await db.runTransaction(async tx => {
      const current = (await tx.get(ref)).data();
      tx.update(ref, { shopier: { ...current.shopier,
        refundRequest: { ...current.shopier.refundRequest, state: failure ? 'uncertain' : remote.status, providerRefundId: failure ? '' : remote.id },
        lastError: failure ? failure.code || 'SHOPIER_API_ERROR' : '' }, updatedAt: Date.now() });
      service.queueJob(tx, db, { id: `reconcile_${orderId}`, kind: 'reconcile', orderId, availableAt: Date.now() + 30_000 });
      audit(tx, db, current, failure ? 'shopier.refund.uncertain' : 'shopier.refund.accepted', actor);
    });
    // Even a 500 response may have created a refund. A durable receipt prevents every later POST.
    await service.reconcileShopierOrder(orderId);
    row = (await ref.get()).data();
    if (row.shopier.refundRequest?.state === 'failed' || row.shopier.refundStatus === 'failed') throw shopierError('SHOPIER_REFUND_FAILED_REVIEW_REQUIRED', 409);
    return { refunded: row.paymentState === 'refunded', pending: row.paymentState !== 'refunded', uncertain: !!failure };
  });
}
async function cancelShopierOrder(orderId, actor) {
  await markCancellation(orderId, actor);
  const row = (await reference(storage(), orderId).get()).data();
  if (row.paidAt) return refundShopierOrder(orderId, actor);
  try { return await closeShopierOrder(orderId, actor, { cancel: true }); }
  catch (error) {
    if (error.code !== 'SHOPIER_PROVIDER_ACTION_REQUIRED') throw error;
    return refundShopierOrder(orderId, actor);
  }
}
module.exports = { closeShopierOrder, requestShopierClosure: (id, actor) => requestShopierOperation(id, actor),
  requestShopierCancellation: (id, actor) => requestShopierOperation(id, actor, { cancel: true }), cancelShopierOrder, refundShopierOrder, GRACE_MS };
