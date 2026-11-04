'use strict';

const crypto = require('node:crypto');
const { initFirebaseAdmin } = require('../config/firebaseAdmin');
const { getShopierConfig } = require('../config/shopier');
const { createShopierClient, shopierError, providerId } = require('./shopierClient');
const { applyShopierOrder, deliverShopierOrder, recoverShopierProduct, reconcileShopierOrder, FINAL_TIME } = require('./shopierService');
const { logError } = require('./errorLogger');
let timer = null, enabled = false, running = false;

async function processShopierJob(db, ref) {
  const lease = crypto.randomBytes(16).toString('hex'), now = Date.now();
  const job = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref), row = snap.data();
    if (!row || row.completedAt || row.failedAt || row.availableAt > now) return null;
    if (!['order.created', 'refund.updated', 'reconcile', 'recover', 'delivery', 'close', 'cancel'].includes(row.kind)) throw shopierError('SHOPIER_JOB_INVALID', 500);
    tx.update(ref, { lease, availableAt: now + 5 * 60_000 });
    return row;
  });
  if (!job) return;
  let repeat = false, reviewAfter = 0;
  try {
    if (job.requestedBy?.uid) {
      const auth = initFirebaseAdmin().auth;
      if (!auth) throw shopierError('ADMIN_IDENTITY_UNAVAILABLE');
      const identity = await auth.getUser(job.requestedBy.uid);
      const { resolveStaffPolicy, staffHasPermission } = require('./adminStoreService');
      const policy = await resolveStaffPolicy(identity.uid, identity.email);
      if (identity.disabled || !identity.emailVerified || !staffHasPermission(policy, 'store.orders.write')) throw shopierError('ADMIN_PERMISSION_REQUIRED', 403);
      if ((Date.parse(identity.tokensValidAfterTime || '') || 0) > job.authorizedAt) throw shopierError('ADMIN_JOB_AUTHORIZATION_REVOKED', 403);
    }
    if (job.kind === 'close' || job.kind === 'cancel') {
      const operations = require('./shopierOperations');
      const result = await (job.kind === 'cancel' ? operations.cancelShopierOrder(job.orderId, { uid: 'system', source: 'shopier-worker' }) : operations.closeShopierOrder(job.orderId));
      repeat = result.pending === true;
      reviewAfter = result.reviewAfter || Date.now() + 60_000;
      if (repeat && Date.now() - job.createdAt > 24 * 60 * 60_000) throw shopierError('SHOPIER_PROVIDER_MANUAL_REVIEW_REQUIRED', 409);
    } else if (job.kind === 'delivery') await deliverShopierOrder(job.orderId);
    else if (job.kind === 'recover') await recoverShopierProduct(job.orderId);
    else if (job.kind === 'reconcile') {
      await reconcileShopierOrder(job.orderId);
      const order = (await db.collection('storeOrders').doc(job.orderId).get()).data();
      repeat = order?.shopierOpen === true;
    } else {
      const client = createShopierClient();
      let orderId = providerId(job.resourceId), refund = null;
      if (job.kind === 'refund.updated') {
        refund = await client.getRefund(orderId);
        if (refund?.id !== job.resourceId) throw shopierError('SHOPIER_REFUND_MISMATCH', 409);
        orderId = providerId(refund.orderId);
      }
      const remote = await client.getOrder(orderId);
      if (remote?.id !== orderId) throw shopierError('SHOPIER_ORDER_MISMATCH', 409);
      if (refund && (refund.currency !== remote.currency || !remote.refunds?.some((entry) => entry.id === refund.id && entry.total === refund.total && entry.status === refund.status))) throw shopierError('SHOPIER_REFUND_MISMATCH', 409);
      await applyShopierOrder(remote);
    }
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref), current = snap.data();
      if (current?.lease !== lease) return;
      tx.update(ref, { lease: '', availableAt: repeat ? Math.max(Date.now() + 30_000, reviewAfter || Date.now() + 5 * 60_000) : FINAL_TIME,
        completedAt: repeat ? 0 : Date.now(), lastError: '', attempts: 0 });
    });
  } catch (error) {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref), current = snap.data();
      if (current?.lease !== lease) return;
      const attempts = (current.attempts || 0) + 1;
      const terminal = attempts >= 10 || ['SHOPIER_PROVIDER_MANUAL_REVIEW_REQUIRED', 'ADMIN_PERMISSION_REQUIRED', 'ADMIN_JOB_AUTHORIZATION_REVOKED'].includes(error.code);
      tx.update(ref, { lease: '', attempts, lastError: error.code || 'SHOPIER_JOB_FAILED',
        availableAt: terminal ? FINAL_TIME : Date.now() + Math.max(Math.min(3600_000, 30_000 * 2 ** (attempts - 1)), (error.retryAfter || 0) * 1000),
        failedAt: terminal ? Date.now() : 0 });
    });
    if (job.orderId) await db.runTransaction(async (tx) => {
      const ref = db.collection('storeOrders').doc(job.orderId), snap = await tx.get(ref), order = snap.data();
      if (order?.paymentMethod === 'shopier') tx.update(ref, { shopier: { ...order.shopier, lastError: error.code || 'SHOPIER_JOB_FAILED' } });
    });
    logError(error, { event: 'shopier.job.failed', code: error.code || 'SHOPIER_JOB_FAILED' });
  }
}
async function drainShopierJobs() {
  // Disabling new checkouts must not stop verification of already-issued payment links.
  if (!getShopierConfig().managementConfigured) return;
  const { db } = initFirebaseAdmin();
  if (!db) return;
  const jobs = await db.collection('shopierJobs').where('availableAt', '<=', Date.now()).orderBy('availableAt').limit(4).get();
  for (const doc of jobs.docs) await processShopierJob(db, doc.ref);
}
function wakeShopierWorker() {
  if (!enabled || running) return;
  clearTimeout(timer);
  timer = setTimeout(async () => {
    running = true;
    try { await drainShopierJobs(); } catch (error) { logError(error, { event: 'shopier.worker.failed', code: error.code || 'SHOPIER_WORKER_FAILED' }); }
    finally { running = false; if (enabled) { timer = setTimeout(wakeShopierWorker, 5000); timer.unref?.(); } }
  }, 20);
  timer.unref?.();
}
function startShopierWorker() { enabled = true; wakeShopierWorker(); }
function stopShopierWorker() { enabled = false; clearTimeout(timer); }
async function shopierJobStatus() {
  const { db } = initFirebaseAdmin();
  if (!db) throw shopierError('STORE_STORAGE_UNAVAILABLE');
  const [failed, due, reviews] = await Promise.all([
    db.collection('shopierJobs').where('failedAt', '>', 0).orderBy('failedAt', 'desc').limit(10).get(),
    db.collection('shopierJobs').where('availableAt', '<=', Date.now()).orderBy('availableAt').limit(20).get(),
    db.collection('storeLatePaymentReviews').where('resolved', '==', false).limit(10).get()
  ]);
  return { dueSample: due.size, dueSampleLimit: 20, reviews: reviews.docs.map(doc => {
    const row = doc.data(); return { orderId: row.orderId, providerOrderId: row.providerOrderId, amountKurus: row.amountKurus, createdAt: row.createdAt };
  }), failed: failed.docs.map((doc) => {
    const row = doc.data(); return { id: doc.id, kind: row.kind, orderId: row.orderId, resourceId: row.resourceId,
      attempts: row.attempts, lastError: row.lastError, failedAt: row.failedAt };
  }) };
}
async function retryShopierJob(id, actor) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,180}$/.test(id)) throw shopierError('SHOPIER_JOB_INVALID', 400);
  const { db } = initFirebaseAdmin();
  if (!db) throw shopierError('STORE_STORAGE_UNAVAILABLE');
  const ref = db.collection('shopierJobs').doc(id);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref), row = snap.data();
    if (!row || !row.failedAt || row.availableAt !== FINAL_TIME) throw shopierError('SHOPIER_JOB_NOT_FAILED', 409);
    tx.update(ref, { failedAt: 0, completedAt: 0, attempts: 0, lease: '', availableAt: Date.now(),
      ...(['close', 'cancel'].includes(row.kind) ? { requestedBy: { uid: actor.uid }, authorizedAt: Date.now() } : {}) });
    tx.create(db.collection('audit').doc(), { type: 'shopier.job.retry', jobId: id, orderId: row.orderId || '',
      actor: { uid: actor.uid, source: 'admin' }, at: Date.now() });
  });
  wakeShopierWorker();
}
module.exports = { processShopierJob, drainShopierJobs, wakeShopierWorker, startShopierWorker, stopShopierWorker, shopierJobStatus, retryShopierJob };
