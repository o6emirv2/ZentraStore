'use strict';

const crypto = require('crypto');
const env = require('../config/env');
const { initFirebaseAdmin } = require('../config/firebaseAdmin');
const { purposeKey, readAdminAccess } = require('./adminAccessService');

const HANDOFF_TTL_MS = 90_000;
const HANDOFF_PURGE_DELAY_MS = 15 * 60_000;
const HANDOFF_CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const HANDOFF_COLLECTION = 'storeAdminHandoffs';

function handoffError(code = 'ADMIN_HANDOFF_UNAVAILABLE', statusCode = 503) {
  return Object.assign(new Error(code), { code, statusCode });
}

function canonicalCode(value = '') {
  const code = String(value || '').trim();
  if (!HANDOFF_CODE_PATTERN.test(code)) return '';
  try {
    const decoded = Buffer.from(code, 'base64url');
    return decoded.length === 32 && decoded.toString('base64url') === code ? code : '';
  } catch (_) {
    return '';
  }
}

function handoffDocumentId(code = '') {
  const normalized = canonicalCode(code);
  if (!normalized) throw handoffError('ADMIN_HANDOFF_INVALID', 401);
  return crypto.createHmac('sha256', purposeKey('admin-handoff-document-index-v47'))
    .update(normalized, 'utf8').digest('hex');
}

function normalizedIdentity({ uid = '', email = '', gateSession = '', sourceOrigin = '', expiresAt = 0 } = {}) {
  const safe = {
    uid: String(uid || '').trim().slice(0, 160),
    email: String(email || '').trim().toLowerCase().slice(0, 254),
    gateSession: String(gateSession || '').trim().slice(0, 120),
    sourceOrigin: env.normalizeOrigin(sourceOrigin),
    expiresAt: Math.max(0, Number(expiresAt || 0) || 0)
  };
  if (!safe.uid || !safe.email || safe.gateSession.length < 16 || !safe.sourceOrigin
    || !env.allowedOrigins.includes(safe.sourceOrigin) || safe.expiresAt <= Date.now()) {
    throw handoffError('ADMIN_HANDOFF_INVALID', 401);
  }
  return safe;
}

function associatedData(documentId, identity) {
  return Buffer.from([
    'shelby-admin-handoff:v47',
    documentId,
    identity.uid,
    identity.email,
    identity.gateSession,
    identity.sourceOrigin,
    String(identity.expiresAt)
  ].join('\u0000'), 'utf8');
}

function sealHandoffPayload(documentId, identity, payload) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', purposeKey('admin-handoff-encryption-v47'), iv);
  cipher.setAAD(associatedData(documentId, identity));
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(payload), 'utf8')),
    cipher.final()
  ]);
  return ['v1', iv.toString('base64url'), ciphertext.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
}

function decodePart(value = '', requiredLength = 0) {
  const raw = String(value || '');
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  try {
    const result = Buffer.from(raw, 'base64url');
    return result.toString('base64url') === raw && (!requiredLength || result.length === requiredLength)
      ? result : null;
  } catch (_) {
    return null;
  }
}

function openHandoffPayload(documentId, identity, sealed = '') {
  const [version, rawIv, rawCiphertext, rawTag, ...extra] = String(sealed || '').split('.');
  if (version !== 'v1' || extra.length) throw handoffError('ADMIN_HANDOFF_INVALID', 401);
  const iv = decodePart(rawIv, 12);
  const ciphertext = decodePart(rawCiphertext);
  const tag = decodePart(rawTag, 16);
  if (!iv || !ciphertext || !tag || ciphertext.length > 12_288) {
    throw handoffError('ADMIN_HANDOFF_INVALID', 401);
  }
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', purposeKey('admin-handoff-encryption-v47'), iv);
    decipher.setAAD(associatedData(documentId, identity));
    decipher.setAuthTag(tag);
    const payload = JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
    const sessionCookie = String(payload?.sessionCookie || '');
    const accessToken = String(payload?.accessToken || '');
    const access = readAdminAccess(accessToken);
    if (sessionCookie.length < 32 || sessionCookie.length > 8192 || !access
      || access.uid !== identity.uid || access.email !== identity.email || access.gateSession !== identity.gateSession) {
      throw handoffError('ADMIN_HANDOFF_INVALID', 401);
    }
    return { sessionCookie, accessToken, access };
  } catch (error) {
    if (String(error?.code || '').startsWith('ADMIN_HANDOFF_')) throw error;
    throw handoffError('ADMIN_HANDOFF_INVALID', 401);
  }
}

async function issueAdminHandoff({ uid = '', email = '', gateSession = '', sourceOrigin = '', sessionCookie = '', accessToken = '' } = {}) {
  const { db } = initFirebaseAdmin();
  if (!db) throw handoffError();
  const expiresAt = Date.now() + HANDOFF_TTL_MS;
  const identity = normalizedIdentity({ uid, email, gateSession, sourceOrigin, expiresAt });
  const access = readAdminAccess(accessToken);
  if (!access || access.uid !== identity.uid || access.email !== identity.email
    || access.gateSession !== identity.gateSession || String(sessionCookie || '').length < 32) {
    throw handoffError('ADMIN_HANDOFF_INVALID', 401);
  }
  const code = crypto.randomBytes(32).toString('base64url');
  const documentId = handoffDocumentId(code);
  const sealed = sealHandoffPayload(documentId, identity, {
    sessionCookie: String(sessionCookie),
    accessToken: String(accessToken)
  });
  await db.collection(HANDOFF_COLLECTION).doc(documentId).set({
    ...identity,
    createdAt: Date.now(),
    consumedAt: 0,
    purgeAfter: new Date(expiresAt + HANDOFF_PURGE_DELAY_MS),
    sealed
  }, { merge: false });
  return {
    required: true,
    mode: 'single-use-first-party-post',
    action: `${env.serviceOrigin}/admin/session/handoff`,
    code,
    expiresAt
  };
}

async function consumeAdminHandoff({ code = '', sourceOrigin = '' } = {}) {
  const normalizedCode = canonicalCode(code);
  const origin = env.normalizeOrigin(sourceOrigin);
  if (!normalizedCode || !origin || !env.allowedOrigins.includes(origin)) {
    throw handoffError('ADMIN_HANDOFF_INVALID', 401);
  }
  const { db } = initFirebaseAdmin();
  if (!db) throw handoffError();
  const documentId = handoffDocumentId(normalizedCode);
  const reference = db.collection(HANDOFF_COLLECTION).doc(documentId);
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (!snapshot?.exists) throw handoffError('ADMIN_HANDOFF_INVALID', 401);
    const row = snapshot.data() || {};
    if (row.consumedAt || !row.sealed) throw handoffError('ADMIN_HANDOFF_REPLAY', 401);
    if (Number(row.expiresAt || 0) <= Date.now()) throw handoffError('ADMIN_HANDOFF_EXPIRED', 401);
    const identity = normalizedIdentity(row);
    if (identity.sourceOrigin !== origin) throw handoffError('ADMIN_HANDOFF_ORIGIN_INVALID', 403);
    const payload = openHandoffPayload(documentId, identity, row.sealed);
    const consumedAt = Date.now();
    transaction.set(reference, {
      consumedAt,
      sealed: '',
      purgeAfter: new Date(consumedAt + HANDOFF_PURGE_DELAY_MS)
    }, { merge: true });
    return { ...identity, ...payload, consumedAt };
  });
}

module.exports = {
  HANDOFF_TTL_MS,
  HANDOFF_COLLECTION,
  issueAdminHandoff,
  consumeAdminHandoff
};
