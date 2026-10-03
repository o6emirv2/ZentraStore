'use strict';

const crypto = require('crypto');
const env = require('../config/env');
const { initFirebaseAdmin } = require('../config/firebaseAdmin');
const {
  adminAccessCookiePolicy,
  getRequestAdminGateFactorToken,
  readAdminGateFactor,
  readAdminStep
} = require('./adminAccessService');
const { configuration: totpConfiguration } = require('./adminTotpService');
const { RATE_LIMIT_POLICY } = require('./security');

const EMAIL_PATTERN = /^\S+@\S+\.\S+$/;
const HEX_32_BYTES = /^[0-9a-f]{64}$/i;
const FACTOR_MAX_LENGTH = 256;
const GATE_FACTOR_TTL_MS = 7 * 60_000;

function placeholder(value = '') {
  return env.isPlaceholder(value);
}

function configuredAdminEmails() {
  return [...new Set(env.adminEmails
    .map((email) => String(email || '').trim().toLowerCase())
    .filter((email) => EMAIL_PATTERN.test(email) && !placeholder(email)))];
}

function configuredAdminUids() {
  return [...new Set(env.adminUids
    .map((uid) => String(uid || '').trim())
    .filter((uid) => uid.length >= 8 && uid.length <= 160 && !placeholder(uid)))];
}

function factorConfiguration(step) {
  const prefix = step === 4 ? 'ADMIN_GATE_FOUR' : step === 5 ? 'ADMIN_GATE_FIVE' : '';
  const salt = String(process.env[`${prefix}_SALT_HEX`] || '').trim().toLowerCase();
  const hash = String(process.env[`${prefix}_HASH_HEX`] || '').trim().toLowerCase();
  return {
    salt,
    hash,
    ready: HEX_32_BYTES.test(salt) && HEX_32_BYTES.test(hash) && !placeholder(salt) && !placeholder(hash)
  };
}

function dedicatedSigningReady() {
  const secret = String(process.env.ADMIN_GATE_SIGNING_SECRET || '').trim();
  return secret.length >= 64 && !placeholder(secret);
}

function securityPosture() {
  const firebaseReady = initFirebaseAdmin().enabled === true;
  const emailReady = configuredAdminEmails().length === 1;
  const uidReady = configuredAdminUids().length === 1;
  const fourthReady = factorConfiguration(4).ready;
  const fifthReady = factorConfiguration(5).ready;
  const signingReady = dedicatedSigningReady();
  const cookie = adminAccessCookiePolicy();
  const totp = totpConfiguration();
  const secureSessionReady = cookie.httpOnly === true && cookie.secure === true && String(cookie.sameSite || '').toLowerCase() === 'strict';
  const rateLimitReady = Number(RATE_LIMIT_POLICY?.adminAuth?.windowMs || 0) > 0
    && Number(RATE_LIMIT_POLICY?.adminAuth?.max || 0) > 0 && env.security.rateLimitStore === 'firestore';
  const appCheckReady = env.firebase.appCheckMode === 'enforce' && !!env.firebase.appCheckSiteKey;
  const totpReady = totp.required && totp.configured;
  const checks = [
    { key: 'firebase-admin', label: 'Güvenli yönetim bağlantısı', weight: 12, earned: firebaseReady ? 12 : 0, ok: firebaseReady },
    { key: 'admin-email', label: 'Yetkili e-posta eşleşmesi', weight: 9, earned: emailReady ? 9 : 0, ok: emailReady },
    { key: 'admin-uid', label: 'Otomatik UID doğrulaması', weight: 9, earned: uidReady ? 9 : 0, ok: uidReady },
    { key: 'firebase-password', label: 'Hesap şifresi doğrulaması', weight: 11, earned: firebaseReady && emailReady && uidReady ? 11 : 0, ok: firebaseReady && emailReady && uidReady },
    { key: 'fourth-factor', label: 'Scrypt korumalı yönetici şifresi', weight: 8, earned: fourthReady ? 8 : 0, ok: fourthReady },
    { key: 'fifth-factor', label: 'Scrypt korumalı erişim şifresi', weight: 7, earned: fifthReady ? 7 : 0, ok: fifthReady },
    { key: 'totp-factor', label: 'Tek kullanımlık doğrulama kodu', weight: 14, earned: totpReady ? 14 : 0, ok: totpReady },
    { key: 'signed-access', label: 'İptal edilebilir yönetim oturumu', weight: 8, earned: signingReady ? 8 : 0, ok: signingReady },
    { key: 'strict-csp', label: 'Sıkı içerik güvenliği', weight: 4, earned: env.security.strictCsp ? 4 : 0, ok: env.security.strictCsp },
    { key: 'secure-session', label: 'Korumalı yönetici oturumu', weight: 5, earned: secureSessionReady ? 5 : 0, ok: secureSessionReady },
    { key: 'rate-limit', label: 'Dağıtık giriş deneme sınırı', weight: 6, earned: rateLimitReady ? 6 : 0, ok: rateLimitReady },
    { key: 'app-check', label: 'Zorunlu uygulama doğrulaması', weight: 7, earned: appCheckReady ? 7 : 0, ok: appCheckReady }
  ];
  const score = checks.reduce((total, item) => total + item.earned, 0);
  const minimum = Math.max(86, Number(env.security.adminMinimumScore || 90));
  return {
    score,
    minimum,
    ready: score >= minimum,
    level: score >= 96 ? 'çok güçlü' : score >= minimum ? 'güçlü' : 'yapılandırma gerekli',
    checks: checks.map(({ key, label, weight, earned, ok }) => ({ key, label, weight, earned, ok }))
  };
}

function gateError(code, statusCode = 409) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}


function verifyAdminGateFactorProof(req, { identity = {}, gateSession = '', ticket = '' } = {}) {
  const sealedStep = readAdminStep(ticket);
  const expectedUid = String(identity?.uid || '').trim();
  const expectedEmail = String(identity?.email || '').trim().toLowerCase();
  const expectedSession = String(gateSession || '').trim();
  const now = Date.now();
  const issuedAt = Math.max(0, Number(sealedStep?.issuedAt || 0) || 0);
  const expiresAt = Math.max(0, Number(sealedStep?.expiresAt || 0) || 0);
  const stage = Number(sealedStep?.stage || 0);
  if (!sealedStep || !expectedUid || !expectedEmail || !/^[A-Za-z0-9_-]{32,80}$/.test(expectedSession)) return null;
  if (![4, 5].includes(stage) || !issuedAt || issuedAt > now + 30_000 || expiresAt <= now
    || expiresAt - issuedAt > GATE_FACTOR_TTL_MS + 1_000) return null;
  if (String(sealedStep.uid || '') !== expectedUid
    || String(sealedStep.email || '').trim().toLowerCase() !== expectedEmail
    || String(sealedStep.gateSession || '') !== expectedSession) return null;

  const cookieProof = readAdminGateFactor(getRequestAdminGateFactorToken(req));
  const cookieMatches = !!cookieProof
    && cookieProof.uid === expectedUid
    && cookieProof.email === expectedEmail
    && cookieProof.gateSession === expectedSession;
  return {
    uid: expectedUid,
    email: expectedEmail,
    gateSession: expectedSession,
    expiresAt: cookieMatches ? Math.min(expiresAt, Number(cookieProof.expiresAt || 0)) : expiresAt,
    stage: 'factor',
    mode: cookieMatches ? 'httpOnly-cookie' : 'sealed-step-ticket'
  };
}

async function resolveAutomaticAdminIdentity() {
  const emails = configuredAdminEmails();
  const uids = configuredAdminUids();
  if (emails.length !== 1) throw gateError('ADMIN_EMAIL_CONFIGURATION_INVALID');
  if (uids.length !== 1) throw gateError('ADMIN_UID_CONFIGURATION_INVALID');

  const { auth } = initFirebaseAdmin();
  if (!auth) throw gateError('AUTH_UNAVAILABLE', 503);

  let user;
  try {
    user = await auth.getUser(uids[0]);
  } catch (_) {
    throw gateError('ADMIN_IDENTITY_NOT_FOUND');
  }

  const email = String(user?.email || '').trim().toLowerCase();
  const uid = String(user?.uid || '').trim();
  if (!uid || uid !== uids[0] || email !== emails[0]) throw gateError('ADMIN_IDENTITY_MISMATCH');
  if (user.disabled === true) throw gateError('ADMIN_ACCOUNT_DISABLED', 403);
  return { uid, email };
}

async function verifyFirebasePassword(identity = {}, password = '') {
  const value = String(password || '');
  if (value.length < 6 || value.length > FACTOR_MAX_LENGTH) throw gateError('ADMIN_FIREBASE_PASSWORD_INVALID', 403);
  const apiKey = String(env.firebase.publicConfig.apiKey || '').trim();
  if (!apiKey) throw gateError('AUTH_UNAVAILABLE', 503);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  let response;
  let payload;
  try {
    response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ email: identity.email, password: value, returnSecureToken: true }),
      signal: controller.signal
    });
    payload = await response.json().catch(() => null);
  } catch (_) {
    throw gateError('AUTH_UNAVAILABLE', 503);
  } finally {
    clearTimeout(timer);
  }

  const uid = String(payload?.localId || '').trim();
  const email = String(payload?.email || '').trim().toLowerCase();
  if (!response.ok || uid !== identity.uid || email !== identity.email) throw gateError('ADMIN_FIREBASE_PASSWORD_INVALID', 403);

  return {
    gateSession: crypto.randomBytes(24).toString('base64url'),
    expiresAt: Date.now() + GATE_FACTOR_TTL_MS
  };
}

function deriveScrypt(value, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(value || ''), salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

async function verifyGateFactor(step, value = '') {
  const candidate = String(value || '').normalize('NFKC');
  if (candidate.length < 12 || candidate.length > FACTOR_MAX_LENGTH) return false;
  const configuration = factorConfiguration(step);
  if (!configuration.ready) throw gateError(step === 4 ? 'ADMIN_GATE_FOUR_NOT_CONFIGURED' : 'ADMIN_GATE_FIVE_NOT_CONFIGURED');
  const derived = await deriveScrypt(candidate, Buffer.from(configuration.salt, 'hex'));
  const expected = Buffer.from(configuration.hash, 'hex');
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

module.exports = {
  configuredAdminEmails,
  configuredAdminUids,
  factorConfiguration,
  securityPosture,
  resolveAutomaticAdminIdentity,
  verifyFirebasePassword,
  verifyAdminGateFactorProof,
  verifyGateFactor
};
