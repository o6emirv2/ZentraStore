'use strict';

const rateLimit = require('express-rate-limit');
const { logError } = require('../core/errorLogger');
const { createRouter } = require('../core/asyncRouter');
const env = require('../config/env');
const { requireAuth, strictLimiter } = require('../core/security');
const { initFirebaseAdmin } = require('../config/firebaseAdmin');
const { revokeAdminSessionsForUser } = require('../core/adminSessionRegistry');
const {
  trustedOrigin,
  createUserSession,
  sessionCookieHeader,
  clearSessionCookieHeader,
  verifyUserSession
} = require('../core/userSessionService');

const router = createRouter();

router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  next();
});

const clientErrorLimiter = rateLimit({ windowMs: 5 * 60_000, max: 20, standardHeaders: true, legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ ok: false, error: 'TOO_MANY_REQUESTS' }) });
router.post('/client-errors', clientErrorLimiter, (req, res) => {
  const input = req.body || {};
  const code = String(input.code || '');
  if (!['BROWSER_RUNTIME_ERROR', 'BROWSER_PROMISE_REJECTION', 'BROWSER_ASSET_FAILED'].includes(code)
    || Object.keys(input).some((key) => !['code', 'source', 'line', 'column'].includes(key))
    || typeof input.source !== 'string' || input.source.length > 160
    || (input.source && !/^\/(?:public\/|admin\/|script\.js|style\.css)[A-Za-z0-9_./-]*$/.test(input.source))
    || [input.line, input.column].some((value) => !Number.isSafeInteger(value) || value < 0 || value > 10_000_000)) {
    return res.status(400).json({ ok: false, error: 'CLIENT_ERROR_REPORT_INVALID' });
  }
  logError(null, { event: 'browser.error', code, source: input.source, line: input.line, column: input.column, requestId: req.requestId });
  return res.status(202).json({ ok: true });
});

router.get('/public/runtime-config', (_req, res) => {
  const runtime = env.publicRuntimeConfig();
  const firebaseReady = !!(runtime.firebase.apiKey && runtime.firebase.authDomain && runtime.firebase.projectId && runtime.firebase.appId);
  return res.json({ ok: true, ...runtime, firebaseReady });
});

router.get('/auth/me', requireAuth, (req, res) => res.json({
  ok: true,
  user: { uid: req.user.uid, email: req.user.email || '' },
  authSource: req.authSource
}));

router.post('/auth/session', strictLimiter, async (req, res) => {
  if (!trustedOrigin(req)) return res.status(403).json({ ok: false, error: 'ORIGIN_NOT_ALLOWED' });
  const idToken = String(req.body?.idToken || '').trim();
  if (!idToken) return res.status(400).json({ ok: false, error: 'ID_TOKEN_REQUIRED' });
  try {
    const result = await createUserSession(idToken, req.body?.remember === true);
    res.setHeader('Set-Cookie', sessionCookieHeader(result.sessionCookie, result.remember));
    return res.json({
      ok: true,
      authenticated: true,
      user: {
        uid: result.decoded.uid || result.decoded.sub,
        email: result.decoded.email || ''
      },
      persistent: result.remember,
      expiresIn: result.expiresIn
    });
  } catch (error) {
    res.setHeader('Set-Cookie', clearSessionCookieHeader());
    const unavailable = error?.code === 'AUTH_UNAVAILABLE';
    return res.status(unavailable ? 503 : 401).json({ ok: false, error: unavailable ? 'AUTH_UNAVAILABLE' : 'AUTH_INVALID' });
  }
});

router.get('/auth/session', async (req, res) => {
  const user = await verifyUserSession(req, { checkRevoked: true });
  if (!user?.uid) {
    res.setHeader('Set-Cookie', clearSessionCookieHeader());
    return res.json({ ok: true, authenticated: false, user: null });
  }
  return res.json({
    ok: true,
    authenticated: true,
    user: { uid: user.uid, email: user.email || '' }
  });
});

router.post('/auth/logout', strictLimiter, requireAuth, async (req, res) => {
  if (!trustedOrigin(req)) return res.status(403).json({ ok: false, error: 'ORIGIN_NOT_ALLOWED' });
  try {
    const { auth } = initFirebaseAdmin();
    if (!auth) return res.status(503).json({ ok: false, error: 'AUTH_UNAVAILABLE' });
    await auth.revokeRefreshTokens(req.user.uid);
    await revokeAdminSessionsForUser(req.user.uid);
    res.setHeader('Set-Cookie', clearSessionCookieHeader());
    return res.json({ ok: true, revoked: true });
  } catch (_) {
    res.setHeader('Set-Cookie', clearSessionCookieHeader());
    return res.status(503).json({ ok: false, error: 'SESSION_REVOCATION_FAILED' });
  }
});

module.exports = router;
