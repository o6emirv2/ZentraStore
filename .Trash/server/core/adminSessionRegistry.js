'use strict';

const crypto = require('crypto');
const { initFirebaseAdmin } = require('../config/firebaseAdmin');

const cache = new Map();
const CACHE_TTL_MS = 3_000;

function sessionError(code = 'ADMIN_SESSION_UNAVAILABLE', statusCode = 503) {
  return Object.assign(new Error(code), { code, statusCode });
}

function sessionId(value = '') {
  const raw = String(value || '').trim();
  if (raw.length < 16 || raw.length > 120) throw sessionError('ADMIN_GATE_ACCESS_INVALID', 401);
  return crypto.createHash('sha256').update(`shelby-admin-session\u0000${raw}`).digest('hex');
}

function sessionReference(value) {
  const { db } = initFirebaseAdmin();
  if (!db) throw sessionError();
  return db.collection('storeAdminSessions').doc(sessionId(value));
}

async function registerAdminSession({ uid = '', email = '', session = '', expiresAt = 0 } = {}) {
  const now = Date.now();
  const expiry = Math.max(0, Number(expiresAt || 0));
  if (expiry <= now) throw sessionError('ADMIN_GATE_ACCESS_INVALID', 401);
  const reference = sessionReference(session);
  const row = {
    uid: String(uid || '').trim().slice(0, 160),
    email: String(email || '').trim().toLowerCase().slice(0, 254),
    expiresAt: expiry,
    purgeAfter: new Date(expiry + 86_400_000),
    revokedAt: 0,
    createdAt: now
  };
  await reference.set(row, { merge: false });
  cache.set(reference.id, { value: row, until: now + CACHE_TTL_MS });
  return row;
}

async function isAdminSessionActive({ uid = '', email = '', session = '' } = {}) {
  try {
    const reference = sessionReference(session);
    const cached = cache.get(reference.id);
    const row = cached && cached.until > Date.now()
      ? cached.value
      : await reference.get().then((snapshot) => snapshot.exists ? snapshot.data() : null);
    if (!row || row.revokedAt || Number(row.expiresAt || 0) <= Date.now()) return false;
    const matches = row.uid === String(uid || '').trim()
      && row.email === String(email || '').trim().toLowerCase();
    if (matches) cache.set(reference.id, { value: row, until: Date.now() + CACHE_TTL_MS });
    return matches;
  } catch (_) {
    return false;
  }
}

async function revokeAdminSession(session = '') {
  const reference = sessionReference(session);
  cache.delete(reference.id);
  await reference.set({ revokedAt: Date.now(), purgeAfter: new Date(Date.now() + 86_400_000) }, { merge: true });
}

async function revokeAdminSessionsForUser(uid = '') {
  const safeUid = String(uid || '').trim().slice(0, 160);
  const { db } = initFirebaseAdmin();
  if (!db || !safeUid) return 0;
  const snapshot = await db.collection('storeAdminSessions').where('uid', '==', safeUid).limit(300).get();
  if (snapshot.empty) return 0;
  const batch = db.batch();
  snapshot.docs.forEach((document) => {
    cache.delete(document.id);
    batch.set(document.ref, { revokedAt: Date.now(), purgeAfter: new Date(Date.now() + 86_400_000) }, { merge: true });
  });
  await batch.commit();
  return snapshot.size;
}

module.exports = { registerAdminSession, isAdminSessionActive, revokeAdminSession, revokeAdminSessionsForUser };
