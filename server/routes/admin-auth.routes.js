'use strict';

const crypto = require('crypto');
const { createRouter } = require('../core/asyncRouter');
const env = require('../config/env');
const { requireAuth, requireAdmin, adminAuthLimiter, adminBootstrapLimiter } = require('../core/security');
const { trustedOrigin } = require('../core/userSessionService');
const { initFirebaseAdmin } = require('../config/firebaseAdmin');
const { resolveStaffPolicy } = require('../core/adminStoreService');
const { writeAdminAudit } = require('../core/adminReauthService');
const { verifyAdminTotp } = require('../core/adminTotpService');
const { registerAdminSession, isAdminSessionActive, revokeAdminSession } = require('../core/adminSessionRegistry');
const { verifyBrowserRegistration, verifyBrowserStep, resolveBrowserAccess } = require('../core/adminBrowserSessionService');
const {
  signingSecret,
  sealAdminStep,
  readAdminStep,
  issueAdminAccess,
  issueAdminGateFactor,
  readAdminAccess,
  getRequestAdminAccessToken,
  adminAccessCookie,
  adminGateFactorCookie,
  clearAdminAccessCookie,
  clearAdminGateFactorCookie
} = require('../core/adminAccessService');
const {
  securityPosture,
  resolveAutomaticAdminIdentity,
  verifyFirebasePassword,
  verifyAdminGateFactorProof,
  verifyGateFactor
} = require('../core/adminGateService');

const router = createRouter();
const STEP_TTL_MS = 7 * 60_000;
const { credentialRevision } = require('../core/adminSessionPolicy');

router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  next();
});

function requireGateOrigin(req, res, next) {
  if (!trustedOrigin(req)) return res.status(403).json({ ok: false, error: 'ORIGIN_NOT_ALLOWED' });
  return next();
}

function createStepTicket(identity = {}, stage = 0, { gateSession = '', factorExpiresAt = 0 } = {}) {
  const issuedAt = Date.now();
  const verifiedFactorExpiry = Math.max(0, Number(factorExpiresAt || 0) || 0);
  const expiresAt = verifiedFactorExpiry
    ? Math.min(issuedAt + STEP_TTL_MS, verifiedFactorExpiry)
    : issuedAt + STEP_TTL_MS;
  if (expiresAt <= issuedAt) {
    throw Object.assign(new Error('ADMIN_GATE_FACTOR_REQUIRED'), { code: 'ADMIN_GATE_FACTOR_REQUIRED', statusCode: 401 });
  }
  return sealAdminStep({
    type: 'zentra-admin-step-v82',
    stage: Number(stage),
    policyVersion: Number(identity.policyVersion || 0), credentialRevision: credentialRevision(),
    uid: String(identity.uid || '').trim(),
    email: String(identity.email || '').trim().toLowerCase(),
    ...(identity.browserKey ? { browserKey: identity.browserKey } : {}),
    gateSession: String(gateSession || '').trim().slice(0, 80),
    issuedAt,
    expiresAt,
    nonce: crypto.randomBytes(18).toString('hex')
  });
}

async function readStepTicket(raw = '', stage = 0, req) {
  const payload = readAdminStep(raw);
  if (!payload || Number(payload.stage) !== Number(stage) || payload.credentialRevision !== credentialRevision()) return null;
  const policy = await strictAdminPrincipal(payload.uid, payload.email);
  if (!policy || Number(policy.policyVersion || 0) !== payload.policyVersion) return null;
  if (payload.browserKey) await verifyBrowserStep(req, payload.browserKey);
  return payload;
}

function principalMatches(req, payload) {
  const uid = String(req.user?.uid || '').trim();
  const email = String(req.user?.email || '').trim().toLowerCase();
  return !!uid && !!email && payload?.uid === uid && String(payload?.email || '').toLowerCase() === email;
}

async function strictAdminPrincipal(uid = '', email = '') {
  return resolveStaffPolicy(String(uid || '').trim(), String(email || '').trim().toLowerCase());
}

async function activeAdminIdentity(req) {
  const uid = String(req.user?.uid || '').trim();
  const email = String(req.user?.email || '').trim().toLowerCase();
  const policy = uid && email ? await strictAdminPrincipal(uid, email) : null;
  if (!policy) {
    throw Object.assign(new Error('ADMIN_ACTIVE_SESSION_MISMATCH'), { code: 'ADMIN_ACTIVE_SESSION_MISMATCH', statusCode: 403 });
  }
  const { auth } = initFirebaseAdmin();
  if (!auth) throw Object.assign(new Error('AUTH_UNAVAILABLE'), { code: 'AUTH_UNAVAILABLE', statusCode: 503 });
  let user;
  try { user = await auth.getUser(uid); } catch (_) { user = null; }
  const liveEmail = String(user?.email || '').trim().toLowerCase();
  if (!user?.uid || user.uid !== uid || liveEmail !== email || user.disabled === true || user.emailVerified !== true) {
    throw Object.assign(new Error('ADMIN_ACTIVE_SESSION_MISMATCH'), { code: 'ADMIN_ACTIVE_SESSION_MISMATCH', statusCode: 403 });
  }
  if (policy.systemOwner === true) {
    const configured = await resolveAutomaticAdminIdentity();
    if (configured.uid !== uid || configured.email !== email) {
      throw Object.assign(new Error('ADMIN_ACTIVE_SESSION_MISMATCH'), { code: 'ADMIN_ACTIVE_SESSION_MISMATCH', statusCode: 403 });
    }
  }
  return {
    uid,
    email,
    role: policy.role,
    policyVersion: Number(policy.policyVersion || 0),
    permissions: policy.permissions,
    systemOwner: policy.systemOwner === true
  };
}

async function adminContext(uid = '', email = '') {
  const policy = await strictAdminPrincipal(uid, email);
  if (!policy) return null;
  return {
    uid: policy.uid,
    email: policy.email,
    role: policy.role,
    permissions: Array.isArray(policy.permissions) ? policy.permissions : [],
    systemOwner: policy.systemOwner === true,
    verification: ['email', 'uid', 'firebase-password', 'fourth-factor', 'fifth-factor', 'totp'],
    security: securityPosture()
  };
}

async function gateFailure(req, res, error, stage = 'gate') {
  const security = securityPosture();
  const code = String(error?.code || 'ADMIN_GATE_UNAVAILABLE');
  const status = Math.max(400, Math.min(503, Number(error?.statusCode || 409) || 409));
  const messages = {
    ADMIN_EMAIL_CONFIGURATION_INVALID: 'Yönetici e-posta yetkisi tamamlanmamış.',
    ADMIN_UID_CONFIGURATION_INVALID: 'Yönetici hesap yetkisi tamamlanmamış.',
    ADMIN_IDENTITY_NOT_FOUND: 'Tanımlanan yönetici hesabı bulunamadı.',
    ADMIN_IDENTITY_MISMATCH: 'Yönetici e-postası ile hesap kimliği eşleşmiyor.',
    ADMIN_ACCOUNT_DISABLED: 'Yönetici hesabı devre dışı.',
    ADMIN_FIREBASE_PASSWORD_INVALID: 'Yönetici hesap şifresi doğrulanamadı.',
    ADMIN_GATE_FOUR_NOT_CONFIGURED: 'Dördüncü doğrulama adımı kullanıma hazır değil.',
    ADMIN_GATE_FIVE_NOT_CONFIGURED: 'Beşinci doğrulama adımı kullanıma hazır değil.',
    ADMIN_GATE_FACTOR_REQUIRED: 'Güvenli yönetici doğrulamasının süresi dolmuş. Hesap şifresi adımından yeniden başlayın.',
    ADMIN_GATE_ACCESS_INVALID: 'Yönetici erişim oturumu geçersiz veya süresi dolmuş.',
    ADMIN_TOTP_NOT_CONFIGURED: 'Google Authenticator anahtarı henüz yapılandırılmamış.',
    ADMIN_TOTP_INVALID: 'Google Authenticator’daki altı haneli kod hatalı veya süresi dolmuş.',
    ADMIN_TOTP_REPLAY: 'Bu doğrulama kodu daha önce kullanılmış. Yeni kodu bekleyin.',
    ADMIN_TOTP_UNAVAILABLE: 'Tek kullanımlık doğrulama şu anda tamamlanamadı.',
    ADMIN_SIGNING_SECRET_NOT_CONFIGURED: 'Güvenli yönetici oturumu kullanıma hazır değil.',
    ADMIN_HANDOFF_INVALID: 'Güvenli yönetici geçişi doğrulanamadı. Lütfen son adımı yeniden deneyin.',
    ADMIN_HANDOFF_UNAVAILABLE: 'Güvenli yönetici geçişi şu anda hazırlanamadı.',
    ID_TOKEN_REQUIRED: 'Yönetici hesap oturumu doğrulanamadı. Lütfen sayfayı yenileyin.',
    AUTH_UNAVAILABLE: 'Güvenli hesap hizmetine şu anda ulaşılamıyor.',
    ADMIN_ACTIVE_SESSION_MISMATCH: 'Ana sayfadaki aktif oturum yetkili yönetici hesabıyla eşleşmiyor.'
  };
  try {
    await writeAdminAudit(req, 'admin.gate.login.failure', { stage, error: code, status });
  } catch (auditError) {
    return res.status(503).json({
      ok: false,
      error: String(auditError?.code || 'ADMIN_AUDIT_FAILED'),
      message: 'Zorunlu yönetici güvenlik kaydı oluşturulamadı.',
      security
    });
  }
  return res.status(status).json({ ok: false, error: code, message: messages[code] || 'Yönetici doğrulaması tamamlanamadı.', security });
}

async function resolveAdminAccessProof(req) {
  const uid = String(req.user?.uid || '').trim();
  const email = String(req.user?.email || '').trim().toLowerCase();
  if (!uid || !email) return null;
  if (req.headers?.['x-zentra-admin-proof']) return resolveBrowserAccess(req);

  const cookieAccess = readAdminAccess(getRequestAdminAccessToken(req));
  if (cookieAccess && cookieAccess.uid === uid && cookieAccess.email === email
    && await isAdminSessionActive({ uid, email, session: cookieAccess.gateSession })) {
    return { mode: 'httpOnly-cookie', expiresAt: Number(cookieAccess.expiresAt || 0), gateSession: cookieAccess.gateSession };
  }

  return null;
}

router.get('/auth/admin/gate/status', requireAuth, async (req, res) => {
  const uid = String(req.user?.uid || '').trim();
  const email = String(req.user?.email || '').trim().toLowerCase();
  const security = securityPosture();
  if (!(await strictAdminPrincipal(uid, email))) {
    return res.status(403).json({ ok: false, authenticated: false, error: 'ADMIN_REQUIRED' });
  }
  const proof = await resolveAdminAccessProof(req);
  if (!proof) return res.json({ ok: true, authenticated: false, redirectTo: '/admin/index.html', security });
  return res.json({
    ok: true,
    authenticated: true,
    user: { uid, email },
    admin: await adminContext(uid, email),
    access: { mode: proof.mode, expiresAt: proof.expiresAt },
    security
  });
});

router.get('/auth/admin/gate/identity', requireAuth, async (req, res) => {
  const uid = String(req.user?.uid || '').trim();
  const email = String(req.user?.email || '').trim().toLowerCase();
  const admin = await strictAdminPrincipal(uid, email);
  if (!admin) return res.status(403).json({ ok: false, authenticated: true, admin: false, error: 'ADMIN_REQUIRED' });
  return res.json({ ok: true, authenticated: true, admin: true, user: { uid, email }, adminContext: await adminContext(uid, email), security: securityPosture() });
});

router.post('/auth/admin/gate/step-email', requireGateOrigin, adminBootstrapLimiter, requireAuth, async (req, res) => {
  try {
    const identity = await activeAdminIdentity(req);
    if (req.body?.browserKey) identity.browserKey = await verifyBrowserRegistration(req);
    return res.json({
      ok: true,
      ticket: createStepTicket(identity, 2),
      verification: { step: 1, key: 'email', label: 'Yetkili e-posta eşleşmesi', verified: true, value: identity.email },
      security: securityPosture()
    });
  } catch (error) {
    return gateFailure(req, res, error, 'step-email');
  }
});

router.post('/auth/admin/gate/step-uid', requireGateOrigin, adminBootstrapLimiter, requireAuth, async (req, res) => {
  try {
    const payload = await readStepTicket(req.body?.ticket, 2, req);
    if (!payload) return res.status(401).json({ ok: false, error: 'ADMIN_STEP_SESSION_INVALID', security: securityPosture() });
    const identity = await activeAdminIdentity(req);
    if (payload.browserKey) identity.browserKey = payload.browserKey;
    if (identity.uid !== payload.uid || identity.email !== payload.email) {
      return res.status(401).json({ ok: false, error: 'ADMIN_STEP_SESSION_INVALID', security: securityPosture() });
    }
    return res.json({
      ok: true,
      ticket: createStepTicket(identity, 3),
      verification: { step: 2, key: 'uid', label: 'UID doğrulaması', verified: true, value: identity.uid },
      security: securityPosture()
    });
  } catch (error) {
    return gateFailure(req, res, error, 'step-uid');
  }
});

router.post('/auth/admin/gate/step-firebase-password', requireGateOrigin, adminAuthLimiter, requireAuth, async (req, res) => {
  try {
    const payload = await readStepTicket(req.body?.ticket, 3, req);
    if (!payload) return res.status(401).json({ ok: false, error: 'ADMIN_STEP_SESSION_INVALID', security: securityPosture() });
    const identity = await activeAdminIdentity(req);
    if (payload.browserKey) identity.browserKey = payload.browserKey;
    if (!principalMatches(req, payload) || identity.uid !== payload.uid || identity.email !== payload.email) {
      return res.status(401).json({ ok: false, error: 'ADMIN_STEP_SESSION_INVALID', security: securityPosture() });
    }
    const authentication = await verifyFirebasePassword(identity, req.body?.password);
    const factorAccess = issueAdminGateFactor({
      uid: identity.uid,
      email: identity.email,
      gateSession: authentication.gateSession,
      expiresAt: authentication.expiresAt
    });
    res.setHeader('Set-Cookie', adminGateFactorCookie(factorAccess.factorToken, factorAccess.expiresAt));
    return res.json({
      ok: true,
      ticket: createStepTicket(identity, 4, {
        gateSession: authentication.gateSession,
        factorExpiresAt: factorAccess.expiresAt
      }),
      factor: { mode: 'sealed-step-ticket', expiresAt: factorAccess.expiresAt },
      verification: { step: 3, key: 'firebase-password', label: 'Hesap şifresi', verified: true },
      security: securityPosture()
    });
  } catch (error) {
    return gateFailure(req, res, error, 'step-firebase-password');
  }
});

router.post('/auth/admin/gate/step-four', requireGateOrigin, adminAuthLimiter, requireAuth, requireAdmin, async (req, res) => {
  try {
    const payload = await readStepTicket(req.body?.ticket, 4, req);
    if (!payload || !principalMatches(req, payload) || !(await strictAdminPrincipal(payload.uid, payload.email))) {
      return res.status(401).json({ ok: false, error: 'ADMIN_STEP_SESSION_INVALID', security: securityPosture() });
    }
    const factorProof = verifyAdminGateFactorProof(req, {
      identity: payload,
      gateSession: payload.gateSession,
      ticket: req.body?.ticket
    });
    if (!factorProof) return res.status(401).json({ ok: false, error: 'ADMIN_GATE_FACTOR_REQUIRED', security: securityPosture() });
    if (!(await verifyGateFactor(4, req.body?.password))) {
      await writeAdminAudit(req, 'admin.gate.login.failure', { stage: 'step-four', error: 'ADMIN_GATE_FOUR_INVALID', status: 403 });
      return res.status(403).json({ ok: false, error: 'ADMIN_GATE_FOUR_INVALID', security: securityPosture() });
    }
    return res.json({
      ok: true,
      ticket: createStepTicket(payload, 5, {
        gateSession: factorProof.gateSession,
        factorExpiresAt: factorProof.expiresAt
      }),
      verification: { step: 4, key: 'fourth-factor', label: 'Dördüncü güvenlik şifresi', verified: true },
      security: securityPosture()
    });
  } catch (error) {
    return gateFailure(req, res, error, 'step-four');
  }
});

router.post('/auth/admin/gate/step-five', requireGateOrigin, adminAuthLimiter, requireAuth, requireAdmin, async (req, res) => {
  try {
    const security = securityPosture();
    const payload = await readStepTicket(req.body?.ticket, 5, req);
    if (!payload || !principalMatches(req, payload) || !(await strictAdminPrincipal(payload.uid, payload.email))) {
      return res.status(401).json({ ok: false, error: 'ADMIN_STEP_SESSION_INVALID', security });
    }
    const factorProof = verifyAdminGateFactorProof(req, {
      identity: payload,
      gateSession: payload.gateSession,
      ticket: req.body?.ticket
    });
    if (!factorProof) return res.status(401).json({ ok: false, error: 'ADMIN_GATE_FACTOR_REQUIRED', security });
    if (!(await verifyGateFactor(5, req.body?.password))) {
      await writeAdminAudit(req, 'admin.gate.login.failure', { stage: 'step-five', error: 'ADMIN_GATE_FIVE_INVALID', status: 403 });
      return res.status(403).json({ ok: false, error: 'ADMIN_GATE_FIVE_INVALID', security });
    }
    return res.json({ ok: true,
      ticket: createStepTicket(payload, 6, { gateSession: factorProof.gateSession, factorExpiresAt: factorProof.expiresAt }),
      verification: { step: 5, key: 'fifth-factor', label: 'Beşinci güvenlik şifresi', verified: true }, security });
  } catch (error) { return gateFailure(req, res, error, 'step-five'); }
});

router.post('/auth/admin/gate/step-six', requireGateOrigin, adminAuthLimiter, requireAuth, requireAdmin, async (req, res) => {
  try {
    const security = securityPosture();
    const payload = await readStepTicket(req.body?.ticket, 6, req);
    if (!payload || !principalMatches(req, payload) || !(await strictAdminPrincipal(payload.uid, payload.email))) {
      return res.status(401).json({ ok: false, error: 'ADMIN_STEP_SESSION_INVALID', security });
    }
    const factorProof = verifyAdminGateFactorProof(req, { identity: payload, gateSession: payload.gateSession, ticket: req.body?.ticket });
    if (!factorProof) return res.status(401).json({ ok: false, error: 'ADMIN_GATE_FACTOR_REQUIRED', security });
    if (!security.ready) {
      return res.status(409).json({ ok: false, error: 'ADMIN_SECURITY_CONFIGURATION_INCOMPLETE', message: `Güvenlik skoru ${security.minimum}/100 eşiğinin altında.`, security });
    }

    const sourceOrigin = env.normalizeOrigin(req.headers?.origin || '');
    if (!payload.browserKey && sourceOrigin !== env.serviceOrigin) {
      return res.status(409).json({ ok: false, error: 'ADMIN_BROWSER_SERVER_UPDATE_REQUIRED', message: 'Mağaza ve yönetim sunucusunu birlikte güncelleyin, ardından sayfayı yenileyin.' });
    }
    const totp = await verifyAdminTotp({
      uid: payload.uid,
      code: req.body?.totpCode,
      gateSession: factorProof.gateSession
    });
    if (totp.verified !== true) throw Object.assign(new Error('ADMIN_TOTP_NOT_CONFIGURED'), { code: 'ADMIN_TOTP_NOT_CONFIGURED', statusCode: 503 });
    if (totp.replayed && !(await isAdminSessionActive({
      uid: payload.uid,
      email: payload.email,
      session: factorProof.gateSession
    }))) {
      throw Object.assign(new Error('ADMIN_TOTP_REPLAY'), { code: 'ADMIN_TOTP_REPLAY', statusCode: 401 });
    }
    const cookieAccess = issueAdminAccess({ uid: payload.uid, email: payload.email, gateSession: factorProof.gateSession });
    await registerAdminSession({ uid: payload.uid, email: payload.email, session: cookieAccess.gateSession, expiresAt: cookieAccess.expiresAt, browserKey: payload.browserKey || null, expectedPolicyVersion: payload.policyVersion, expectedCredentialRevision: payload.credentialRevision });
    await writeAdminAudit(req, 'admin.gate.login.success', {
      stage: 'complete', accessModes: [payload.browserKey ? 'browser-key' : 'httpOnly-cookie'],
      possessionFactor: totp.verified === true ? 'totp' : 'not-configured',
      factorTransport: factorProof.mode,
      sessionTransport: payload.browserKey ? 'origin-bound-browser-key' : 'same-origin-cookie',
      resumedCompletion: totp.replayed === true,
      expiresAt: cookieAccess.expiresAt
    });
    res.setHeader('Set-Cookie', [adminAccessCookie(cookieAccess.accessToken), clearAdminGateFactorCookie()]);
    return res.json({
      ok: true,
      redirectTo: '/admin/',
      gateExpiresAt: cookieAccess.expiresAt,
      ...(payload.browserKey ? { browserSession: { keyId: payload.browserKey.keyId, session: cookieAccess.gateSession, expiresAt: cookieAccess.expiresAt } } : {}),
      admin: await adminContext(payload.uid, payload.email),
      security
    });
  } catch (error) {
    return gateFailure(req, res, error, 'step-six');
  }
});

router.post('/auth/admin/gate/logout', requireGateOrigin, requireAuth, async (req, res) => {
  try {
    const proof = await resolveAdminAccessProof(req);
    if (proof?.gateSession) await revokeAdminSession(proof.gateSession);
    res.setHeader('Set-Cookie', [clearAdminAccessCookie(), clearAdminGateFactorCookie()]);
    return res.json({ ok: true, revoked: !!proof?.gateSession });
  } catch (_) {
    res.setHeader('Set-Cookie', [clearAdminAccessCookie(), clearAdminGateFactorCookie()]);
    return res.status(503).json({ ok: false, error: 'ADMIN_SESSION_REVOCATION_FAILED' });
  }
});

async function requireAdminGate(req, res, next) {
  const uid = String(req.user?.uid || '').trim();
  const email = String(req.user?.email || '').trim().toLowerCase();
  const policyVerified = req.adminPolicy?.uid === uid && req.adminPolicy?.email === email && req.adminPolicy?.active === true;
  if (!policyVerified && !(await strictAdminPrincipal(uid, email))) return res.status(403).json({ ok: false, error: 'ADMIN_REQUIRED' });
  try {
    const proof = await resolveAdminAccessProof(req);
    if (!proof) return res.status(401).json({ ok: false, error: 'ADMIN_GATE_REQUIRED' });
    req.adminAccess = proof;
    return next();
  } catch (error) {
    if (Number(error?.statusCode) === 503) return res.status(503).json({ ok: false, error: 'ADMIN_SESSION_UNAVAILABLE' });
    return res.status(401).json({ ok: false, error: 'ADMIN_GATE_ACCESS_INVALID' });
  }
}

router.securityPosture = securityPosture;
router.requireAdminGate = requireAdminGate;
router.signingSecret = signingSecret;

module.exports = router;
