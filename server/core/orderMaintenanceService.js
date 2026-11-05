'use strict';

const crypto = require('node:crypto');
const { initFirebaseAdmin } = require('../config/firebaseAdmin');
const { sanitizeAuditValue } = require('./adminReauthService');
const { invalidateCreatedAtPageCache } = require('./firestorePagination');
const { paymentChannel, hasPaymentEvidence } = require('./orderChannel');
const FINAL_TIME = 8640000000000000;
const OPERATIONS = Object.freeze({
  cancel_telegram: { channels: ['telegram'], remove: false },
  cancel_delete_telegram: { channels: ['telegram'], remove: true },
  delete_refunded: { channels: ['telegram', 'wallet'], remove: true, status: 'refunded' },
  delete_cancelled: { channels: ['telegram', 'wallet'], remove: true, status: 'cancelled' },
  delete_audit: { remove: true, audit: true }
});
function failure(code, statusCode = 409) { throw Object.assign(new Error(code), { code, statusCode }); }
function database() {
  const firebase = initFirebaseAdmin();
  if (!firebase.db) failure('STORE_STORAGE_UNAVAILABLE', 503);
  return firebase;
}
function safeId(id) { if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(id)) failure('BULK_JOB_INVALID', 400); return id; }
function permission(op) { return OPERATIONS[op]?.audit ? 'store.audit.delete' : 'store.orders.bulk'; }
function fingerprint(row, version = 3) {
  const values = [row.status, row.paymentState, row.updatedAt, row.paidAt, row.approvedAt, row.totalKurus, row.delivery?.itemCount, row.walletRefundedKurus];
  if (version >= 2) values.push(paymentChannel(row), row.legalHold, row.retentionUntil);
  return crypto.createHash('sha256').update(JSON.stringify(values)).digest('hex');
}
function auditPolicy(row, now = Date.now()) {
  const name = `${row.type || ''} ${row.action || ''}`;
  const days = Number(process.env.AUDIT_RETENTION_DAYS || 90);
  if (!Number.isInteger(days) || days < 90 || days > 36500) return { eligible: false, reason: 'RETENTION_CONFIGURATION_INVALID' };
  if (row.legalHold === true || row.protected === true || /payment|refund|wallet|balance|order|inventory|delivery|auth|login|gate|security|staff|permission|purge|delete|cancel|bulk|maintenance/i.test(name)) return { eligible: false, reason: 'PROTECTED_SECURITY_OR_FINANCIAL_RECORD' };
  if (row.orderId || row.amountKurus || row.totalKurus || row.details?.orderId || row.details?.amountKurus) return { eligible: false, reason: 'PROTECTED_SECURITY_OR_FINANCIAL_RECORD' };
  if (!/^store[.-](?:content|links|catalog|product)[.-](?:update|create|bulk[.-]update)$/.test(name.trim().split(' ')[0])) return { eligible: false, reason: 'UNKNOWN_RECORD_RETENTION_REQUIRED' };
  const at = Number(row.at || row.createdAt || 0);
  return at > 0 && at <= now - days * 86400_000 ? { eligible: true, reason: '' } : { eligible: false, reason: 'RETENTION_PERIOD_ACTIVE' };
}
function deletionPolicy(row) {
  const channel = paymentChannel(row);
  if (channel === 'unknown') return { eligible: false, reason: 'STORE_PAYMENT_CHANNEL_REVIEW_REQUIRED' };
  if (row.legalHold || row.retentionUntil > Date.now()) return { eligible: false, reason: 'RETENTION_HOLD' };
  if (!['cancelled', 'refunded'].includes(row.status)) return { eligible: false, reason: 'ORDER_NOT_FINAL' };
  if (row.inventoryReservations?.length && !row.delivery?.itemCount) return { eligible: false, reason: 'RESERVATION_ACTIVE' };
  if (channel === 'wallet') {
    if (!row.walletRefundedAt || row.walletRefundedKurus !== row.totalKurus) return { eligible: false, reason: 'WALLET_REFUND_NOT_VERIFIED' };
  } else if ((hasPaymentEvidence(row) || row.status === 'refunded') && !row.manualRefund?.verifiedAt) return { eligible: false, reason: 'EXTERNAL_REFUND_NOT_VERIFIED' };
  return { eligible: true, reason: '' };
}
function orderPolicy(row, op) {
  const spec = OPERATIONS[op];
  const channel = paymentChannel(row);
  if (!spec || !spec.channels.includes(channel) || (spec.status && spec.status !== row.status)) return { targeted: false };
  if (spec.status) return { targeted: true, ...deletionPolicy(row), deletable: true };
  if (['cancelled', 'refunded'].includes(row.status)) return spec.remove ? { targeted: true, ...deletionPolicy(row), deletable: true } : { targeted: true, eligible: false, reason: 'ALREADY_FINAL' };
  if (row.legalHold || row.delivery?.itemCount || row.status === 'delivered') return { targeted: true, eligible: false, reason: 'DELIVERED_OR_PROTECTED' };
  if (channel === 'telegram' && (hasPaymentEvidence(row) || !['awaiting_payment', 'payment_review', 'payment_rejected'].includes(row.status))) return { targeted: true, eligible: false, reason: 'EXTERNAL_PAYMENT_REVIEW_REQUIRED' };
  return { targeted: true, eligible: true, cancellable: true, deletable: spec.remove };
}
function jobView(row, id) {
  return { id, operation: row.operation, state: row.state, createdAt: row.createdAt, updatedAt: row.updatedAt,
    expiresAt: row.expiresAt, total: row.total, eligible: row.eligible, excluded: row.excluded,
    cancellable: row.cancellable, deletable: row.deletable, refunds: row.refunds,
    completed: row.completed, succeeded: row.succeeded, failed: row.failed, skipped: row.skipped,
    channels: row.channels, error: row.error || '', permanent: OPERATIONS[row.operation]?.remove === true };
}
async function createPreview({ operation, actor, idempotencyKey }) {
  if (!Object.hasOwn(OPERATIONS, operation) || typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{12,100}$/.test(idempotencyKey)) failure('BULK_OPERATION_INVALID', 400);
  const { db } = database();
  const id = crypto.createHash('sha256').update(`${actor.uid}:${idempotencyKey}`).digest('hex'), ref = db.collection('storeMaintenanceJobs').doc(id);
  await db.runTransaction(async tx => {
    const existing = (await tx.get(ref)).data();
    if (existing) { if (existing.policyVersion !== 3) failure('BULK_JOB_VERSION_REVIEW_REQUIRED'); if (existing.operation !== operation || existing.actor.uid !== actor.uid) failure('BULK_JOB_CONFLICT'); return; }
    const now = Date.now();
    tx.create(ref, { operation, policyVersion: 3, actor: { uid: actor.uid, email: actor.email || '' }, state: 'preparing',
      createdAt: now, updatedAt: now, expiresAt: now + 30 * 60_000, scanCursor: '', scanSource: 0,
      total: 0, eligible: 0, excluded: 0, cancellable: 0, deletable: 0, refunds: 0,
      completed: 0, succeeded: 0, failed: 0, skipped: 0, channels: {}, lease: '', availableAt: now });
  });
  return getJob(id, actor);
}
async function getJob(id, actor, cursor = '', { includeResults = true } = {}) {
  const { db } = database(), ref = db.collection('storeMaintenanceJobs').doc(safeId(id)), row = (await ref.get()).data();
  if (!row || row.actor.uid !== actor.uid) failure('BULK_JOB_NOT_FOUND', 404);
  if (row.policyVersion !== 3 || !Object.hasOwn(OPERATIONS, row.operation)) failure('BULK_JOB_VERSION_REVIEW_REQUIRED');
  if (!includeResults) return { job: jobView(row, id) };
  let query = ref.collection('items').orderBy('__name__').limit(100);
  if (cursor) query = query.startAfter(safeId(cursor));
  const snapshot = await query.get();
  return { job: jobView(row, id), results: snapshot.docs.map(doc => ({ id: doc.id, channel: doc.data().channel, reference: doc.data().reference,
    state: doc.data().state, code: doc.data().code || '', result: doc.data().result || '',
    nextCheckAt: doc.data().state === 'waiting' ? doc.data().availableAt : 0 })), nextCursor: snapshot.size === 100 ? snapshot.docs.at(-1).id : '' };
}
async function confirmJob(id, actor, confirmation = '') {
  const { db } = database(), ref = db.collection('storeMaintenanceJobs').doc(safeId(id));
  await db.runTransaction(async tx => {
    const row = (await tx.get(ref)).data();
    if (!row || row.actor.uid !== actor.uid) failure('BULK_JOB_NOT_FOUND', 404);
    if (row.policyVersion !== 3 || !Object.hasOwn(OPERATIONS, row.operation)) failure('BULK_JOB_VERSION_REVIEW_REQUIRED');
    if (row.state === 'running' || row.state === 'completed') return;
    if (!['ready', 'paused'].includes(row.state) || row.state === 'ready' && row.expiresAt < Date.now()) failure('BULK_PREVIEW_EXPIRED');
    if (OPERATIONS[row.operation].remove && confirmation !== 'KALICI SIL') failure('BULK_CONFIRMATION_REQUIRED', 400);
    const now = Date.now();
    tx.update(ref, { state: 'running', error: '', firstConfirmedAt: row.firstConfirmedAt || row.confirmedAt || now, confirmedAt: now, availableAt: now, updatedAt: now });
    tx.create(db.collection('protectedSecurityAudit').doc(), { action: 'maintenance.confirmed', jobId: id, operation: row.operation,
      actor: row.actor, total: row.total, eligible: row.eligible, at: now });
  });
  return getJob(id, actor);
}
async function preparePage(db, admin, ref, job, lease) {
  const sources = OPERATIONS[job.operation].audit ? ['audit', 'adminAudit'] : ['storeOrders'];
  const source = sources[job.scanSource];
  let query = db.collection(source).orderBy(admin.firestore.FieldPath.documentId()).limit(150);
  if (job.scanCursor) query = query.startAfter(job.scanCursor);
  const snapshot = await query.get();
  const items = [];
  for (const doc of snapshot.docs) {
    const row = doc.data(), at = Number(row.createdAt || row.at || 0);
    if (at > job.createdAt) continue;
    const policy = OPERATIONS[job.operation].audit ? { targeted: true, ...auditPolicy(row, job.createdAt), deletable: true } : orderPolicy(row, job.operation);
    if (!policy.targeted) continue;
    items.push({ id: `${source}_${doc.id}`, source, targetId: doc.id, reference: row.orderNumber || doc.id,
      channel: OPERATIONS[job.operation].audit ? source : paymentChannel(row), fingerprintVersion: job.policyVersion || 1, fingerprint: fingerprint(row, job.policyVersion || 1),
      state: policy.eligible ? 'queued' : 'skipped', availableAt: policy.eligible ? 0 : FINAL_TIME,
      code: policy.reason || '', ...policy });
  }
  await db.runTransaction(async tx => {
    const current = (await tx.get(ref)).data();
    if (current.lease !== lease || current.state !== 'preparing') return;
    const patch = { updatedAt: Date.now(), scanCursor: snapshot.docs.at(-1)?.id || '',
      total: current.total + items.length, eligible: current.eligible + items.filter(i => i.eligible).length,
      excluded: current.excluded + items.filter(i => !i.eligible).length,
      completed: current.completed + items.filter(i => !i.eligible).length,
      skipped: current.skipped + items.filter(i => !i.eligible).length,
      cancellable: current.cancellable + items.filter(i => i.eligible && i.cancellable).length,
      deletable: current.deletable + items.filter(i => i.eligible && i.deletable).length,
      refunds: current.refunds + items.filter(i => i.eligible && i.refundRequired).length,
      channels: { ...current.channels }, lease: '', availableAt: Date.now() };
    for (const item of items) {
      const before = patch.channels[item.channel] || { total: 0, succeeded: 0, failed: 0, skipped: 0 };
      patch.channels[item.channel] = { ...before, total: before.total + 1, skipped: before.skipped + (item.eligible ? 0 : 1) };
      tx.set(ref.collection('items').doc(item.id), item);
    }
    if (snapshot.size < 150) {
      patch.scanSource = current.scanSource + 1; patch.scanCursor = '';
      if (patch.scanSource >= sources.length) { patch.state = 'ready'; patch.availableAt = FINAL_TIME; }
    }
    tx.update(ref, patch);
  });
}
async function deleteOrder(id, actor) {
  const { db } = database(), ref = db.collection('storeOrders').doc(id);
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref), row = snap.data();
    if (!row) return;
    const channel = paymentChannel(row);
    const policy = deletionPolicy(row);
    if (!policy.eligible) failure(policy.reason);
    const archived = await tx.get(db.collection('storeOrderArchives').doc(id));
    const accountRef = row.uid ? db.collection('users').doc(row.uid) : null;
    const account = accountRef ? await tx.get(accountRef) : null;
    for (const entry of row.inventoryReservations || []) {
      if (!/^storeInventory\/[a-z0-9-]{1,130}\/items\/[A-Za-z0-9_-]{1,160}$/.test(String(entry.inventoryPath))) failure('STORE_STOCK_CONFLICT');
      const reserved = (await tx.get(db.doc(entry.inventoryPath))).data();
      if (reserved?.status === 'reserved') failure('RESERVATION_ACTIVE');
    }
    const deliveries = await tx.get(db.collection('storeDeliveries').doc(id).collection('items').limit(101));
    const receipts = await tx.get(db.collection('storeOrderIdempotency').where('orderId', '==', id).limit(101));
    const walletRefund = channel === 'wallet' ? await tx.get(db.collection('storeWalletLedger').doc(`refund_${id}`)) : null;
    if (walletRefund && (!walletRefund.exists || walletRefund.data().uid !== row.uid || walletRefund.data().amountKurus !== row.totalKurus)) failure('WALLET_REFUND_NOT_VERIFIED');
    if (deliveries.size > 100 || receipts.size > 100) failure('ORDER_RELATED_RECORD_LIMIT');
    // Financial evidence and idempotency receipts are intentionally retained, outside active order lists.
    if (!archived.exists) tx.create(db.collection('storeOrderArchives').doc(id), {
      order: { ...row, paymentMethod: channel, username: '', delivery: { status: row.delivery?.status || '', itemCount: row.delivery?.itemCount || 0 } },
      deletedAt: Date.now(), deletedBy: actor, protected: true, financialEvidenceRetained: true
    });
    for (const doc of deliveries.docs) tx.delete(doc.ref);
    tx.delete(db.collection('storeDeliveries').doc(id));
    for (const doc of receipts.docs) tx.update(doc.ref, { status: 'archived', archiveId: id, archivedAt: Date.now() });
    if (account?.exists) {
      const counter = 'storeOrderCount';
      const value = Number(account.data()[counter]);
      if (Number.isSafeInteger(value) && value > 0) tx.update(accountRef, { [counter]: value - 1, storeUpdatedAt: Date.now() });
    }
    tx.delete(ref);
    tx.create(db.collection('protectedSecurityAudit').doc(), { action: 'order.permanently_removed', orderId: id,
      previousStatus: row.status, actor, at: Date.now(), financialEvidenceRetained: true });
  });
  if ((await ref.get()).exists) failure('ORDER_DELETE_UNVERIFIED');
  invalidateCreatedAtPageCache('storeOrders');
  require('./adminStoreService').invalidateAdminStoreCaches();
}
async function executeItem(db, job, item) {
  const ref = db.collection(item.source).doc(item.targetId);
  let row = (await ref.get()).data();
  if (!row) return { state: 'skipped', code: 'RECORD_NO_LONGER_EXISTS' };
  if (!item.startedAt && fingerprint(row, item.fingerprintVersion || 1) !== item.fingerprint) return { state: 'skipped', code: 'STATE_CHANGED_AFTER_PREVIEW' };
  if (OPERATIONS[job.operation].audit) {
    await db.runTransaction(async tx => {
      const current = (await tx.get(ref)).data();
      if (!current) return;
      const policy = auditPolicy(current);
      if (!policy.eligible) failure(policy.reason);
      tx.create(db.collection('protectedSecurityAudit').doc(), { action: 'audit.permanently_removed',
        targetId: item.targetId, source: item.source, digest: crypto.createHash('sha256').update(JSON.stringify(sanitizeAuditValue(current))).digest('hex'), actor: job.actor, at: Date.now() });
      tx.delete(ref);
    });
    if ((await ref.get()).exists) failure('AUDIT_DELETE_UNVERIFIED');
    return { state: 'succeeded', result: 'DELETED' };
  }
  if (item.startedAt && ['cancelled', 'refunded'].includes(row.status) && !OPERATIONS[job.operation].remove) {
    if (['cancelled', 'refunded'].includes(row.status)) return { state: 'succeeded', result: row.status === 'refunded' ? 'REFUNDED' : 'CANCELLED' };
  }
  const policy = orderPolicy(row, job.operation);
  if (!policy.eligible) return { state: 'skipped', code: policy.reason || 'NO_LONGER_ELIGIBLE' };
  if (!['cancelled', 'refunded'].includes(row.status) && !OPERATIONS[job.operation].status) {
    if (paymentChannel(row) === 'telegram') {
      await require('./storeService').updateOrderByAdmin({ orderId: item.targetId,
        input: { status: 'cancelled', cancellationReason: `Toplu işlem ${job.id}`, expectedUpdatedAt: row.updatedAt || 0 }, actor: job.actor });

    }
  }
  const final = (await ref.get()).data();
  if (!['cancelled', 'refunded'].includes(final?.status)) return { state: 'failed', code: 'STORE_ORDER_CONFLICT' };
  if (OPERATIONS[job.operation].remove) {
    await deleteOrder(item.targetId, job.actor);
  }
  return { state: 'succeeded', result: OPERATIONS[job.operation].remove ? 'DELETED_FINANCIAL_EVIDENCE_RETAINED' : final.status === 'refunded' ? 'REFUNDED' : 'CANCELLED' };
}
async function processMaintenanceJob(db, admin, ref) {
  const lease = crypto.randomUUID();
  const job = await db.runTransaction(async tx => {
    const row = (await tx.get(ref)).data();
    if (!row || !['preparing', 'running'].includes(row.state) || row.availableAt > Date.now()) return null;
    if (row.policyVersion !== 3 || !Object.hasOwn(OPERATIONS, row.operation)) {
      tx.update(ref, { state: 'paused', error: 'BULK_JOB_VERSION_REVIEW_REQUIRED', lease: '', availableAt: FINAL_TIME, updatedAt: Date.now() });
      return null;
    }
    tx.update(ref, { lease, availableAt: Date.now() + 5 * 60_000 });
    return { ...row, id: ref.id };
  });
  if (!job) return;
  try {
    const auth = initFirebaseAdmin().auth;
    if (!auth) failure('ADMIN_IDENTITY_UNAVAILABLE', 503);
    const identity = await auth.getUser(job.actor.uid);
    if (identity.disabled || !identity.emailVerified || String(identity.email || '').toLowerCase() !== String(job.actor.email).toLowerCase()) failure('ADMIN_ACCOUNT_DISABLED', 403);
    const revokedAt = Date.parse(identity.tokensValidAfterTime || '') || 0;
    if (revokedAt > (job.confirmedAt || job.createdAt)) failure('ADMIN_JOB_AUTHORIZATION_REVOKED', 403);
    const { resolveStaffPolicy, staffHasPermission } = require('./adminStoreService');
    const policy = await resolveStaffPolicy(job.actor.uid, job.actor.email);
    if (!staffHasPermission(policy, permission(job.operation))) failure('ADMIN_PERMISSION_REQUIRED', 403);
    if (job.state === 'preparing') return await preparePage(db, admin, ref, job, lease);
    const queued = await ref.collection('items').where('availableAt', '<=', Date.now()).orderBy('availableAt').limit(4).get();
    if (!queued.size) {
      const next = await ref.collection('items').orderBy('availableAt').limit(1).get();
      const availableAt = next.docs[0]?.data().availableAt || FINAL_TIME;
      await ref.update({ lease: '', state: job.completed >= job.total ? 'completed' : 'running', availableAt, updatedAt: Date.now() });
      return;
    }
    const outcomes = await Promise.allSettled(queued.docs.map(async doc => {
      const item = doc.data();
      let outcome;
      // Mark the first attempt only AFTER checking the preview fingerprint.
      const current = (await db.collection(item.source).doc(item.targetId).get()).data();
      if (!item.startedAt && current && fingerprint(current, item.fingerprintVersion || 1) !== item.fingerprint) outcome = { state: 'skipped', code: 'STATE_CHANGED_AFTER_PREVIEW' };
      else {
        await doc.ref.update({ startedAt: item.startedAt || Date.now() });
        try { outcome = await executeItem(db, job, { ...item, startedAt: item.startedAt || Date.now() }); }
        catch (error) {

          outcome = { state: 'failed', code: error.code || 'BULK_ITEM_FAILED' };
        }
      }
      await db.runTransaction(async tx => {
        const row = (await tx.get(ref)).data(), previous = (await tx.get(doc.ref)).data();
        if (row.lease !== lease || ['succeeded', 'failed', 'skipped'].includes(previous.state)) return;
        const terminal = outcome.state !== 'waiting', channels = { ...row.channels };
        if (terminal) channels[item.channel] = { ...channels[item.channel], [outcome.state]: (channels[item.channel]?.[outcome.state] || 0) + 1 };
        tx.update(doc.ref, { ...outcome, attempts: (previous.attempts || 0) + 1, updatedAt: Date.now(), availableAt: terminal ? FINAL_TIME : outcome.availableAt });
        tx.update(ref, { channels, completed: row.completed + (terminal ? 1 : 0),
          succeeded: row.succeeded + (outcome.state === 'succeeded' ? 1 : 0), failed: row.failed + (outcome.state === 'failed' ? 1 : 0),
          skipped: row.skipped + (outcome.state === 'skipped' ? 1 : 0), updatedAt: Date.now() });
      });
    }));
    const rejected = outcomes.find(outcome => outcome.status === 'rejected');
    if (rejected) throw rejected.reason;
    await db.runTransaction(async tx => {
      const row = (await tx.get(ref)).data();
      if (row.lease !== lease) return;
      const completed = row.completed >= row.total;
      tx.update(ref, { lease: '', state: completed ? 'completed' : 'running', availableAt: completed ? FINAL_TIME : Date.now(), updatedAt: Date.now() });
    });
    require('./adminStoreService').invalidateAdminStoreCaches();
  } catch (error) {
    await ref.update({ lease: '', state: 'paused', error: error.code || 'BULK_JOB_FAILED', availableAt: FINAL_TIME, updatedAt: Date.now() });
  }
}
async function drainMaintenanceJobs() {
  const { db, admin } = initFirebaseAdmin();
  if (!db) return;
  const jobs = await db.collection('storeMaintenanceJobs').where('availableAt', '<=', Date.now()).orderBy('availableAt').limit(2).get();
  for (const doc of jobs.docs) await processMaintenanceJob(db, admin, doc.ref);
}
let timer, enabled = false, running = false;
function wakeMaintenanceWorker() {
  if (!enabled || running) return;
  clearTimeout(timer);
  timer = setTimeout(async () => {
    running = true;
    try { await drainMaintenanceJobs(); } catch (error) { require('./errorLogger').logError(error, { event: 'maintenance.worker', code: error.code || 'MAINTENANCE_FAILED' }); }
    finally { running = false; if (enabled) { timer = setTimeout(wakeMaintenanceWorker, 1000); timer.unref?.(); } }
  }, 20);
  timer.unref?.();
}
function startMaintenanceWorker() { enabled = true; wakeMaintenanceWorker(); }
function stopMaintenanceWorker() { enabled = false; clearTimeout(timer); }
module.exports = { OPERATIONS, permission, createPreview, confirmJob, getJob, orderPolicy, deletionPolicy, auditPolicy,
  deleteOrder, processMaintenanceJob, drainMaintenanceJobs, wakeMaintenanceWorker, startMaintenanceWorker, stopMaintenanceWorker };
