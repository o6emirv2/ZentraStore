'use strict';

const crypto = require('crypto');
const { initFirebaseAdmin } = require('../config/firebaseAdmin');
const { logError } = require('./errorLogger');
const PAGE_SIZE = 50, LEASE_MS = 60_000, RETRY_MS = 30_000;
const FINAL_TIME = 8640000000000000;
let timer = null, running = false, enabled = false;

function enqueueRestockJob(tx, db, { id, sourceSkus, product, plan, now }) {
  tx.create(db.collection('storeRestockJobs').doc(id), {
    id, sourceSkus, productId: product.id, productName: product.name, planKey: plan.key, planLabel: plan.label,
    skuIndex: 0, cursor: '', availableAt: now, createdAt: now, lease: '', notified: 0
  });
}
function timestamp(value) { return value?.toMillis?.() ?? (value instanceof Date ? value.getTime() : Number(value || 0)); }

async function processRestockJob(db, admin, ref) {
  const lease = crypto.randomBytes(16).toString('hex');
  const job = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref); const row = snap.data() || {};
    if (!snap.exists || row.completedAt || row.failedAt || row.availableAt > Date.now()) return null;
    if (!Array.isArray(row.sourceSkus) || !row.sourceSkus.length || row.sourceSkus.length > 20
      || row.sourceSkus.some((sku) => !/^[a-z0-9-]{2,80}__[a-z0-9-]{1,40}$/.test(sku))
      || !Number.isSafeInteger(row.skuIndex) || row.skuIndex < 0 || row.skuIndex >= row.sourceSkus.length
      || typeof row.cursor !== 'string' || row.cursor.length > 180) {
      tx.update(ref, { failedAt: Date.now(), availableAt: FINAL_TIME, failureCode: 'RESTOCK_JOB_INVALID' });
      return null;
    }
    tx.update(ref, { lease, availableAt: Date.now() + LEASE_MS });
    return row;
  });
  if (!job) return;
  try {
  const sku = job.sourceSkus[job.skuIndex];
  if (!sku) throw Object.assign(new Error('RESTOCK_JOB_INVALID'), { code: 'RESTOCK_JOB_INVALID' });
  let query = db.collection('storeRestockSubscriptions').where('sku', '==', sku).orderBy(admin.firestore.FieldPath.documentId()).limit(PAGE_SIZE);
  if (job.cursor) query = query.startAfter(job.cursor);
  const page = await query.get();
  const nextIndex = page.docs.length < PAGE_SIZE ? job.skuIndex + 1 : job.skuIndex;
  const cursor = page.docs.length < PAGE_SIZE ? '' : page.docs.at(-1).id;
  const notificationRefs = new Map();
  for (const doc of page.docs) {
    const uid = String(doc.data()?.uid || '');
    if (!uid || uid.includes('/') || uid.length > 160) continue;
    const id = crypto.createHash('sha256').update(`${ref.id}\0${uid}`).digest('hex');
    notificationRefs.set(uid, db.collection('storeUserNotifications').doc(uid).collection('items').doc(id));
  }
  await db.runTransaction(async (tx) => {
    const [state, ...snapshots] = await Promise.all([tx.get(ref),
      ...job.sourceSkus.map((key) => tx.get(db.collection('storeInventorySummary').doc(key))),
      ...page.docs.map((doc) => tx.get(doc.ref)), ...[...notificationRefs.values()].map((target) => tx.get(target))]);
    const current = state.data() || {};
    if (current.lease !== lease || current.cursor !== job.cursor || current.skuIndex !== job.skuIndex) return;
    const stocks = snapshots.slice(0, job.sourceSkus.length);
    const stockAvailable = stocks.some((snap) => Number.isSafeInteger(snap.data()?.availableCount) && snap.data().availableCount > 0);
    const subscriptions = snapshots.slice(job.sourceSkus.length, job.sourceSkus.length + page.docs.length);
    const notices = snapshots.slice(job.sourceSkus.length + page.docs.length);
    const existing = new Map([...notificationRefs.keys()].map((uid, index) => [uid, notices[index]?.exists]));
    let notified = 0;
    const now = Date.now();
    if (stockAvailable) subscriptions.forEach((snap, index) => {
      const row = snap.data() || {}, uid = String(row.uid || '');
      const target = notificationRefs.get(uid);
      if (!snap.exists || row.active !== true || row.sku !== sku || !target
        || (timestamp(row.expiresAt) && timestamp(row.expiresAt) <= now)
        || timestamp(row.createdAt) > timestamp(job.createdAt)) return;
      if (!existing.get(uid)) {
        tx.create(target, { id: target.id, type: 'restock', title: 'Stok yeniden açıldı',
          message: `${job.productName} · ${job.planLabel} paketi yeniden stokta.`, productId: job.productId,
          planKey: job.planKey, read: false, createdAt: now, expiresAt: new Date(now + 7 * 86_400_000) });
        existing.set(uid, true); notified += 1;
      }
      tx.delete(page.docs[index].ref);
    });
    const completed = !stockAvailable || nextIndex >= job.sourceSkus.length;
    tx.update(ref, { lease: '', cursor, skuIndex: nextIndex, notified: Number(current.notified || 0) + notified,
      availableAt: completed ? FINAL_TIME : now, ...(completed ? { completedAt: now, expiresAt: new Date(now + 7 * 86_400_000) } : {}) });
  });
  } catch (error) {
    // An expired worker must never release another worker's lease.
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref); const current = snap.data() || {};
      if (!snap.exists || current.lease !== lease || current.completedAt) return;
      const failures = (Number.isSafeInteger(current.failures) ? current.failures : 0) + 1;
      tx.update(ref, { lease: '', failures, failureCode: 'RESTOCK_JOB_FAILED',
        availableAt: failures >= 5 ? FINAL_TIME : Date.now() + RETRY_MS,
        ...(failures >= 5 ? { failedAt: Date.now() } : {}) });
    }).catch(() => {});
    throw error;
  }
}

async function drainRestockJobs() {
  const { db, admin } = initFirebaseAdmin();
  if (!db || !admin) return;
  const jobs = await db.collection('storeRestockJobs').where('availableAt', '<=', Date.now()).orderBy('availableAt').limit(2).get();
  for (const doc of jobs.docs) {
    try { await processRestockJob(db, admin, doc.ref); }
    catch (error) {
      logError(error, { event: 'restock.job.failed', code: error.code || 'RESTOCK_JOB_FAILED' });
    }
  }
}
function wakeRestockWorker() {
  if (!enabled || running) return;
  clearTimeout(timer);
  timer = setTimeout(async () => {
    running = true;
    try { await drainRestockJobs(); } catch (error) { logError(error, { event: 'restock.worker.failed', code: error.code || 'RESTOCK_WORKER_FAILED' }); }
    finally { running = false; if (enabled) { timer = setTimeout(wakeRestockWorker, 20_000); timer.unref?.(); } }
  }, 0);
  timer.unref?.();
}
function startRestockWorker() { if (!initFirebaseAdmin().db) return; enabled = true; wakeRestockWorker(); }
function stopRestockWorker() { enabled = false; clearTimeout(timer); }

module.exports = { enqueueRestockJob, drainRestockJobs, processRestockJob, startRestockWorker, stopRestockWorker, wakeRestockWorker };
