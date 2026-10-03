'use strict';

const crypto = require('crypto');
const { initFirebaseAdmin } = require('../config/firebaseAdmin');
const { purposeKey } = require('./adminAccessService');

const RECENT_AUTH_MAX_AGE_SECONDS = 180;
const CLOCK_SKEW_SECONDS = 30;
const SECRET_KEY_PATTERN = /(token|secret|password|pass|private|key|authorization|cookie|serviceAccount|hash|salt|thirdFactor|firebase_key|admin_panel|session)/i;

function sanitizeAuditValue(value, depth = 0) {
  if (depth > 4) return '[TRUNCATED]';
  if (value == null) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.replace(/[\u0000-\u001F\u007F<>]/g, '').slice(0, 500);
  if (Array.isArray(value)) return value.slice(0, 40).map((item) => sanitizeAuditValue(item, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value).slice(0, 80)) {
      out[key] = SECRET_KEY_PATTERN.test(key) ? '[MASKED]' : sanitizeAuditValue(entry, depth + 1);
    }
    return out;
  }
  return String(value).slice(0, 200);
}

function adminIdentity(req) {
  return {
    uid: String(req.user?.uid || '').trim(),
    email: String(req.user?.email || '').trim().toLowerCase()
  };
}

function verifyRecentFirebaseAuthentication(req) {
  const { uid, email } = adminIdentity(req);
  if (!uid || !email || req.authSource !== 'firebase-bearer') {
    return { ok: false, error: 'ADMIN_REAUTH_REQUIRED' };
  }
  const now = Math.floor(Date.now() / 1000);
  const authTime = Number(req.user?.auth_time || 0);
  const provider = String(req.user?.firebase?.sign_in_provider || '').trim().toLowerCase();
  if (!Number.isFinite(authTime) || authTime <= 0 || authTime > now + CLOCK_SKEW_SECONDS) {
    return { ok: false, error: 'ADMIN_REAUTH_REQUIRED' };
  }
  if (now - authTime > RECENT_AUTH_MAX_AGE_SECONDS) {
    return { ok: false, error: 'ADMIN_REAUTH_STALE' };
  }
  if (provider && provider !== 'password') {
    return { ok: false, error: 'ADMIN_REAUTH_PROVIDER_INVALID' };
  }
  return { ok: true, method: 'firebase-recent-password-auth', uid, email, authTime };
}

async function requireAdminReauth(req, res, next) {
  try {
    const result = verifyRecentFirebaseAuthentication(req);
    if (!result.ok) {
      const messages = {
        ADMIN_REAUTH_REQUIRED: 'Kritik işlem için hesabınızı mevcut parolanızla yeniden doğrulamalısınız.',
        ADMIN_REAUTH_STALE: 'Kritik işlem doğrulamasının süresi doldu. Hesap parolanızı yeniden doğrulayın.',
        ADMIN_REAUTH_PROVIDER_INVALID: 'Bu kritik işlem parola tabanlı yeniden kimlik doğrulaması gerektirir.'
      };
      return res.status(401).json({ ok: false, error: result.error, message: messages[result.error] || messages.ADMIN_REAUTH_REQUIRED });
    }
    req.adminReauth = result;
    return next();
  } catch (_) {
    return res.status(503).json({ ok: false, error: 'ADMIN_REAUTH_UNAVAILABLE', message: 'Kritik işlem doğrulaması şu anda tamamlanamadı.' });
  }
}

function clientIpHash(req) {
  const value = String(req?.ip || req?.socket?.remoteAddress || '').trim();
  if (!value) return '';
  return crypto.createHmac('sha256', purposeKey('audit-ip-fingerprint')).update(value).digest('hex');
}

function userAgentSummary(req) {
  return String(req?.headers?.['user-agent'] || '').replace(/[\u0000-\u001F\u007F<>]/g, '').trim().slice(0, 240);
}

async function writeAdminAudit(req, action, details = {}) {
  try {
    const { db } = initFirebaseAdmin();
    if (!db) throw Object.assign(new Error('ADMIN_AUDIT_UNAVAILABLE'), { code: 'ADMIN_AUDIT_UNAVAILABLE', statusCode: 503 });
    const id = `audit_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
    const row = {
      id,
      eventId: id,
      action: String(action || 'admin.action').slice(0, 160),
      actor: {
        uid: String(req?.user?.uid || '').slice(0, 160),
        email: String(req?.user?.email || '').toLowerCase().slice(0, 254),
        role: String(req?.adminPolicy?.role || 'owner').slice(0, 30)
      },
      path: String(req?.originalUrl || req?.url || '').slice(0, 300),
      method: String(req?.method || '').slice(0, 10),
      requestId: String(req?.requestId || '').slice(0, 120),
      ipHash: clientIpHash(req),
      userAgent: userAgentSummary(req),
      reauth: req?.adminReauth ? { ok: true, method: req.adminReauth.method || 'unknown', authTime: Number(req.adminReauth.authTime || 0) } : { ok: false },
      details: sanitizeAuditValue(details),
      createdAt: Date.now()
    };
    await db.collection('adminAudit').doc(id).set(row, { merge: false });
    return { ok: true, firestore: true, id };
  } catch (error) {
    if (error?.code === 'ADMIN_AUDIT_UNAVAILABLE') throw error;
    throw Object.assign(new Error('ADMIN_AUDIT_FAILED'), { code: 'ADMIN_AUDIT_FAILED', statusCode: 503 });
  }
}

// Use only after a primary transactional audit has been committed.
async function writeSupplementalAdminAudit(req, action, details = {}) {
  try {
    return await writeAdminAudit(req, action, details);
  } catch (error) {
    console.error('[shelby-store:audit]', JSON.stringify({
      action, requestId: String(req?.requestId || '').slice(0, 120),
      code: String(error?.code || 'ADMIN_AUDIT_FAILED').slice(0, 80), committed: true
    }));
    return { ok: false, primaryAuditRecorded: true };
  }
}

module.exports = {
  RECENT_AUTH_MAX_AGE_SECONDS,
  requireAdminReauth,
  verifyAdminReauth: async (req) => verifyRecentFirebaseAuthentication(req),
  writeAdminAudit,
  writeSupplementalAdminAudit,
  sanitizeAuditValue
};
