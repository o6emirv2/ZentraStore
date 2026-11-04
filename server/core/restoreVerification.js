'use strict';
const crypto = require('node:crypto');
const { purposeKey } = require('./adminAccessService');
function canonical(value) {
  if (typeof value === 'number' && !Number.isFinite(value)) return { number: String(value) };
  if (value === null || typeof value !== 'object') return typeof value === 'bigint' ? String(value) : value;
  if (Buffer.isBuffer(value)) return { bytes: value.toString('base64') };
  if (value instanceof Date) return { date: value.toISOString() };
  if (typeof value.toMillis === 'function') return { timestampSeconds: value.seconds, timestampNanoseconds: value.nanoseconds };
  if (typeof value.path === 'string' && typeof value.get === 'function') return { reference: value.path };
  if (Array.isArray(value)) return value.map(canonical);
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}
async function databaseDigest(db) {
  const hash = crypto.createHash('sha256'); let count = 0;
  async function walk(collection) {
    // listDocuments also returns missing parent documents that contain inventory/delivery subcollections.
    const references = (await collection.listDocuments()).sort((a, b) => a.path.localeCompare(b.path, 'en'));
    for (let offset = 0; offset < references.length; offset += 100) {
      const docs = await db.getAll(...references.slice(offset, offset + 100));
      for (const doc of docs.sort((a, b) => a.ref.path.localeCompare(b.ref.path, 'en'))) {
        if (doc.exists) { hash.update(doc.ref.path).update('\0').update(JSON.stringify(canonical(doc.data()))).update('\0'); count++; }
        const children = await doc.ref.listCollections();
        for (const child of children.sort((left, right) => left.id.localeCompare(right.id, 'en'))) await walk(child);
      }
    }
  }
  const collections = await db.listCollections();
  for (const collection of collections.sort((left, right) => left.id.localeCompare(right.id, 'en'))) {
    if (collection.id !== 'storeSecurityEvidence') await walk(collection);
  }
  return { digest: hash.digest('hex'), documents: count };
}
function signature(record) { return crypto.createHmac('sha256', purposeKey('restore-verification-v1')).update(JSON.stringify(canonical(record))).digest('hex'); }
function verifyRestoreEvidence(record, projectId, now = Date.now()) {
  if (!record || typeof record !== 'object') return { verified: false };
  const { signature: supplied, ...payload } = record;
  if (payload.version !== 1 || payload.sourceProject !== projectId || !payload.restoreProject || payload.restoreProject === projectId
    || !Number.isSafeInteger(payload.verifiedAt) || now - payload.verifiedAt > 30 * 86400_000 || payload.verifiedAt > now
    || !Number.isSafeInteger(payload.documents) || payload.documents < 1 || !/^[a-f0-9]{64}$/.test(payload.digest || '')
    || !/^[a-f0-9]{64}$/.test(supplied || '')) return { verified: false };
  const expected = signature(payload);
  return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected)) ? { verified: true, verifiedAt: payload.verifiedAt, documents: payload.documents } : { verified: false };
}
async function recordRestoreVerification({ source, restored, sourceProject, restoreProject, now = Date.now() }) {
  if (!sourceProject || !restoreProject || sourceProject === restoreProject) throw Object.assign(new Error('ISOLATED_RESTORE_PROJECT_REQUIRED'), { code: 'ISOLATED_RESTORE_PROJECT_REQUIRED' });
  const before = await databaseDigest(source), replica = await databaseDigest(restored), after = await databaseDigest(source);
  if (before.documents < 1 || before.digest !== after.digest || before.digest !== replica.digest || before.documents !== replica.documents) throw Object.assign(new Error('RESTORE_DATA_MISMATCH_OR_SOURCE_CHANGED'), { code: 'RESTORE_DATA_MISMATCH_OR_SOURCE_CHANGED' });
  const payload = { version: 1, sourceProject, restoreProject, verifiedAt: now, digest: before.digest, documents: before.documents };
  await source.collection('storeSecurityEvidence').doc('restoreVerification').set({ ...payload, signature: signature(payload) });
  return { verified: true, verifiedAt: now, documents: payload.documents };
}
async function loadRestoreEvidence() {
  try {
    const { db, app } = require('../config/firebaseAdmin').initFirebaseAdmin();
    if (!db) return { verified: false };
    const projectId = app?.options?.projectId || require('../config/env').firebase.projectId;
    return verifyRestoreEvidence((await db.collection('storeSecurityEvidence').doc('restoreVerification').get()).data(), projectId);
  } catch (_) { return { verified: false }; }
}
module.exports = { canonical, databaseDigest, verifyRestoreEvidence, recordRestoreVerification, loadRestoreEvidence };
