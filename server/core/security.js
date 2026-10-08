'use strict';

const rateLimit = require('express-rate-limit');
const env = require('../config/env');
const { initFirebaseAdmin } = require('../config/firebaseAdmin');
const { FirestoreRateLimitStore } = require('./distributedRateLimitStore');
const { verifyUserSession, trustedOrigin } = require('./userSessionService');
const { resolveStaffPolicy, staffHasPermission } = require('./adminStoreService');

function limitedResponse(_req, res) {
  return res.status(429).json({ ok: false, error: 'TOO_MANY_REQUESTS', message: 'Çok fazla deneme yapıldı. Lütfen kısa süre sonra tekrar deneyin.' });
}

const RATE_LIMIT_POLICY = Object.freeze({
  public: Object.freeze({ windowMs: 60_000, max: 600 }),
  api: Object.freeze({ windowMs: 60_000, max: 180 }),
  strict: Object.freeze({ windowMs: 10 * 60_000, max: 40 }),
  authLogin: Object.freeze({ windowMs: 15 * 60_000, max: 12 }),
  passwordReset: Object.freeze({ windowMs: 30 * 60_000, max: 6 }),
  delivery: Object.freeze({ windowMs: 10 * 60_000, max: 18 }),
  adminAuth: Object.freeze({ windowMs: 15 * 60_000, max: 14 }),
  adminBootstrap: Object.freeze({ windowMs: 5 * 60_000, max: 30 })
});
const publicLimiter = rateLimit({ ...RATE_LIMIT_POLICY.public, standardHeaders: true, legacyHeaders: false, skip: (req) => String(req.path || '').startsWith('/api') || ['/healthz', '/readyz'].includes(String(req.path || '')), handler: limitedResponse });
const apiLimiter = rateLimit({ ...RATE_LIMIT_POLICY.api, standardHeaders: true, legacyHeaders: false, handler: limitedResponse });
function protectedLimiter(name, options = {}) {
  return rateLimit({
    ...RATE_LIMIT_POLICY[name],
    standardHeaders: true,
    legacyHeaders: false,
    ...(env.security.rateLimitStore === 'firestore' ? { store: new FirestoreRateLimitStore(name) } : {}),
    ...options,
    handler: limitedResponse
  });
}

const strictLimiter = protectedLimiter('strict');
const authLoginLimiter = protectedLimiter('authLogin', { skipSuccessfulRequests: true });
const passwordResetLimiter = protectedLimiter('passwordReset');
const deliveryLimiter = protectedLimiter('delivery');
const adminAuthLimiter = protectedLimiter('adminAuth', { skipSuccessfulRequests: true });
const adminBootstrapLimiter = protectedLimiter('adminBootstrap');

async function appCheckGuard(req, res, next) {
  const path = String(req.path || '');
  const safePublicRead = ['GET', 'HEAD'].includes(String(req.method || '').toUpperCase()) && path === '/store/catalog';
  if (env.firebase.appCheckMode === 'off' || path === '/public/runtime-config' || path === '/healthz' || safePublicRead) return next();
  const token = String(req.headers['x-firebase-appcheck'] || '').trim();
  const { appCheck } = initFirebaseAdmin();
  if (!token || !appCheck) {
    req.appCheck = { verified: false, reason: !token ? 'missing' : 'unavailable' };
    if (env.firebase.appCheckMode === 'enforce') {
      return res.status(401).json({ ok: false, error: 'APP_CHECK_REQUIRED', message: 'Güvenli uygulama doğrulaması gerekli.' });
    }
    return next();
  }
  try {
    const decoded = await appCheck.verifyToken(token);
    req.appCheck = { verified: true, appId: String(decoded?.app_id || decoded?.appId || '').slice(0, 160) };
    return next();
  } catch (_) {
    req.appCheck = { verified: false, reason: 'invalid' };
    if (env.firebase.appCheckMode === 'enforce') {
      return res.status(401).json({ ok: false, error: 'APP_CHECK_INVALID', message: 'Uygulama doğrulaması geçersiz veya süresi dolmuş.' });
    }
    return next();
  }
}

async function resolveAuthenticatedUser(req) {
  const { auth } = initFirebaseAdmin();
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (auth && bearer) {
    try {
      const decoded = await auth.verifyIdToken(bearer, true);
      req.authSource = 'firebase-bearer';
      req.firebaseIdToken = bearer;
      return { ...decoded, uid: decoded.uid || decoded.sub };
    } catch (_) {}
  }
  const session = await verifyUserSession(req, { checkRevoked: true });
  if (!session?.uid) return null;
  if (!['GET', 'HEAD', 'OPTIONS'].includes(String(req.method || '').toUpperCase()) && !trustedOrigin(req)) return { originBlocked: true };
  req.authSource = 'secure-cookie';
  return session;
}

async function requireAuth(req, res, next) {
  try {
    const user = await resolveAuthenticatedUser(req);
    if (user?.originBlocked) return res.status(403).json({ ok: false, error: 'ORIGIN_NOT_ALLOWED' });
    if (!user?.uid) return res.status(401).json({ ok: false, error: 'AUTH_REQUIRED' });
    req.user = user;
    return next();
  } catch (_) {
    return res.status(401).json({ ok: false, error: 'AUTH_INVALID' });
  }
}

function requireRecentUserAuth(req, res, next) {
  const authTime = Number(req.user?.auth_time || 0);
  const now = Math.floor(Date.now() / 1000);
  const provider = String(req.user?.firebase?.sign_in_provider || '').trim().toLowerCase();
  if (req.authSource !== 'firebase-bearer' || !authTime || authTime > now + 30
    || now - authTime > env.security.sensitiveActionRecentAuthSeconds || (provider && !['password', 'custom'].includes(provider))) {
    return res.status(401).json({ ok: false, error: 'AUTH_FRESH_TOKEN_REQUIRED' });
  }
  return next();
}

async function isAdminPrincipal(uid = '', email = '') {
  return !!(await resolveStaffPolicy(uid, email));
}

async function requireAdmin(req, res, next) {
  try {
    const policy = await resolveStaffPolicy(req.user?.uid, req.user?.email);
    if (policy) {
      req.adminPolicy = policy;
      return next();
    }
    return res.status(403).json({ ok: false, error: 'ADMIN_REQUIRED' });
  } catch (_) {
    return res.status(403).json({ ok: false, error: 'ADMIN_REQUIRED' });
  }
}

function requireStorePermission(permission = '') {
  return (req, res, next) => {
    if (staffHasPermission(req.adminPolicy, permission)) return next();
    return res.status(403).json({ ok: false, error: 'ADMIN_PERMISSION_REQUIRED' });
  };
}

module.exports = {
  RATE_LIMIT_POLICY,
  publicLimiter,
  apiLimiter,
  strictLimiter,
  authLoginLimiter,
  passwordResetLimiter,
  deliveryLimiter,
  adminAuthLimiter,
  adminBootstrapLimiter,
  appCheckGuard,
  requireAuth,
  requireRecentUserAuth,
  requireAdmin,
  requireStorePermission,
  isAdminPrincipal
};
