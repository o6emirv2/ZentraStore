'use strict';

const express = require('express');
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

const router = express.Router();

router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  next();
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
