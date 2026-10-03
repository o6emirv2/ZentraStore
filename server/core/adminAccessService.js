'use strict';

const crypto = require('crypto');
const env = require('../config/env');

const COOKIE_NAME = env.nodeEnv === 'production' ? '__Host-shelby_admin_access' : 'shelby_admin_access';
const GATE_FACTOR_COOKIE_NAME = env.nodeEnv === 'production' ? '__Host-shelby_admin_gate' : 'shelby_admin_gate';
const TTL_MS = env.security.adminSessionTtlMinutes * 60 * 1000;
const GATE_FACTOR_TTL_MS = 7 * 60 * 1000;

function base64(value) { return Buffer.from(String(value), 'utf8').toString('base64url'); }
function unbase64(value) { return Buffer.from(String(value), 'base64url').toString('utf8'); }

function signingSecret() {
  const dedicated = String(process.env.ADMIN_GATE_SIGNING_SECRET || '').trim();
  if (dedicated.length >= 64 && !env.isPlaceholder(dedicated)) return dedicated;
  const error = new Error('ADMIN_SIGNING_SECRET_NOT_CONFIGURED');
  error.code = 'ADMIN_SIGNING_SECRET_NOT_CONFIGURED';
  error.statusCode = 503;
  throw error;
}

function purposeKey(purpose = '') {
  return Buffer.from(crypto.hkdfSync(
    'sha256',
    Buffer.from(signingSecret(), 'utf8'),
    Buffer.from('shelby-ios-admin-root:v42', 'utf8'),
    Buffer.from(String(purpose || 'default'), 'utf8'),
    32
  ));
}

function encryptionKey() {
  return purposeKey('step-ticket-encryption');
}

function signPurposePayload(payload = {}, purpose = 'access-token-signing') {
  const body = base64(JSON.stringify(payload));
  const signature = crypto.createHmac('sha256', purposeKey(purpose)).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function verifyPurposePayload(token = '', purpose = 'access-token-signing') {
  const raw = String(token || '').trim();
  const index = raw.lastIndexOf('.');
  if (index < 1) return null;
  const body = raw.slice(0, index);
  const signature = raw.slice(index + 1);
  let expected;
  try { expected = crypto.createHmac('sha256', purposeKey(purpose)).update(body).digest('base64url'); }
  catch (_) { return null; }
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null;
  try {
    const payload = JSON.parse(unbase64(body));
    if (!payload || Number(payload.expiresAt || 0) <= Date.now()) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

function signPayload(payload = {}) {
  return signPurposePayload(payload, 'access-token-signing');
}

function verifySignedPayload(token = '') {
  return verifyPurposePayload(token, 'access-token-signing');
}

function sealAdminStep(payload = {}) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), ciphertext.toString('base64url'), tag.toString('base64url')].join('.');
}

function decodeCanonicalBase64Url(value = '') {
  if (!/^[A-Za-z0-9_-]+$/.test(String(value || ''))) return null;
  const decoded = Buffer.from(String(value), 'base64url');
  return decoded.toString('base64url') === value ? decoded : null;
}

function readAdminStep(token = '') {
  const [version, ivValue, ciphertextValue, tagValue, ...extra] = String(token || '').trim().split('.');
  if (version !== 'v1' || !ivValue || !ciphertextValue || !tagValue || extra.length) return null;
  try {
    const iv = decodeCanonicalBase64Url(ivValue);
    const ciphertext = decodeCanonicalBase64Url(ciphertextValue);
    const tag = decodeCanonicalBase64Url(tagValue);
    if (!iv || !ciphertext || !tag) return null;
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length > 4096) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    const payload = JSON.parse(plaintext);
    if (!payload || payload.type !== 'shelby-admin-step-v42' || Number(payload.expiresAt || 0) <= Date.now()) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

function issueAdminAccess({ uid = '', email = '', gateSession = '' } = {}) {
  const issuedAt = Date.now();
  const claims = {
    type: 'shelby-admin-access-v42',
    uid: String(uid || '').trim().slice(0, 160),
    email: String(email || '').trim().toLowerCase().slice(0, 254),
    gateSession: String(gateSession || '').trim().slice(0, 120),
    issuedAt,
    expiresAt: issuedAt + TTL_MS,
    nonce: crypto.randomBytes(18).toString('hex')
  };
  return { ...claims, accessToken: signPayload(claims) };
}

function issueAdminGateFactor({ uid = '', email = '', gateSession = '', expiresAt = 0 } = {}) {
  const issuedAt = Date.now();
  const requestedExpiry = Math.max(0, Number(expiresAt || 0) || 0);
  const claims = {
    type: 'shelby-admin-gate-factor-v45',
    uid: String(uid || '').trim().slice(0, 160),
    email: String(email || '').trim().toLowerCase().slice(0, 254),
    gateSession: String(gateSession || '').trim().slice(0, 120),
    issuedAt,
    expiresAt: Math.min(issuedAt + GATE_FACTOR_TTL_MS, requestedExpiry || issuedAt + GATE_FACTOR_TTL_MS),
    nonce: crypto.randomBytes(18).toString('hex')
  };
  if (!claims.uid || !claims.email || !claims.gateSession || claims.expiresAt <= issuedAt) {
    throw Object.assign(new Error('ADMIN_GATE_FACTOR_REQUIRED'), { code: 'ADMIN_GATE_FACTOR_REQUIRED', statusCode: 401 });
  }
  return { ...claims, factorToken: signPurposePayload(claims, 'gate-factor-proof-signing') };
}

function parseCookies(header = '') {
  return String(header || '').split(';').reduce((output, part) => {
    const index = part.indexOf('=');
    if (index < 1) return output;
    const key = part.slice(0, index).trim();
    try { output[key] = decodeURIComponent(part.slice(index + 1).trim()); }
    catch (_) { output[key] = part.slice(index + 1).trim(); }
    return output;
  }, Object.create(null));
}

function getRequestAdminAccessToken(req) {
  const cookies = parseCookies(req?.headers?.cookie || '');
  return String(cookies[COOKIE_NAME] || '').trim().slice(0, 2400);
}

function getRequestAdminGateFactorToken(req) {
  const cookies = parseCookies(req?.headers?.cookie || '');
  return String(cookies[GATE_FACTOR_COOKIE_NAME] || '').trim().slice(0, 2400);
}

function readAdminAccess(token = '') {
  const payload = verifySignedPayload(token);
  return payload?.type === 'shelby-admin-access-v42' && payload.gateSession ? payload : null;
}

function readAdminGateFactor(token = '') {
  const payload = verifyPurposePayload(token, 'gate-factor-proof-signing');
  return payload?.type === 'shelby-admin-gate-factor-v45'
    && payload.uid && payload.email && payload.gateSession ? payload : null;
}

function adminAccessCookie(token = '') {
  const production = env.nodeEnv === 'production';
  return [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/', 'HttpOnly', production ? 'Secure' : '', 'SameSite=Strict', 'Priority=High',
    `Max-Age=${Math.floor(TTL_MS / 1000)}`
  ].filter(Boolean).join('; ');
}

function adminGateFactorCookie(token = '', expiresAt = 0) {
  const production = env.nodeEnv === 'production';
  const remainingSeconds = Math.max(0, Math.ceil((Number(expiresAt || 0) - Date.now()) / 1000));
  return [
    `${GATE_FACTOR_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/', 'HttpOnly', production ? 'Secure' : '', 'SameSite=Strict', 'Priority=High',
    `Max-Age=${Math.min(Math.ceil(GATE_FACTOR_TTL_MS / 1000), remainingSeconds)}`
  ].filter(Boolean).join('; ');
}

function clearAdminGateFactorCookie() {
  const production = env.nodeEnv === 'production';
  return [
    `${GATE_FACTOR_COOKIE_NAME}=`, 'Path=/', 'HttpOnly', production ? 'Secure' : '', 'SameSite=Strict', 'Priority=High',
    'Max-Age=0', 'Expires=Thu, 01 Jan 1970 00:00:00 GMT'
  ].filter(Boolean).join('; ');
}

function clearAdminAccessCookie() {
  const production = env.nodeEnv === 'production';
  return [
    `${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', production ? 'Secure' : '', 'SameSite=Strict', 'Priority=High',
    'Max-Age=0', 'Expires=Thu, 01 Jan 1970 00:00:00 GMT'
  ].filter(Boolean).join('; ');
}

function adminAccessCookiePolicy() {
  return Object.freeze({
    name: COOKIE_NAME,
    path: '/',
    httpOnly: true,
    secure: env.nodeEnv === 'production',
    sameSite: 'Strict',
    ttlMs: TTL_MS
  });
}

module.exports = {
  COOKIE_NAME,
  GATE_FACTOR_COOKIE_NAME,
  GATE_FACTOR_TTL_MS,
  signingSecret,
  purposeKey,
  signPayload,
  verifySignedPayload,
  sealAdminStep,
  readAdminStep,
  issueAdminAccess,
  issueAdminGateFactor,
  readAdminAccess,
  readAdminGateFactor,
  getRequestAdminAccessToken,
  getRequestAdminGateFactorToken,
  adminAccessCookie,
  adminGateFactorCookie,
  clearAdminAccessCookie,
  clearAdminGateFactorCookie,
  adminAccessCookiePolicy
};
