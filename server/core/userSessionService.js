'use strict';

const env = require('../config/env');
const { initFirebaseAdmin } = require('../config/firebaseAdmin');

const COOKIE_NAME = env.nodeEnv === 'production' ? '__Host-shelby_session' : 'shelby_session';
const REMEMBER_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const BROWSER_TTL_MS = 24 * 60 * 60 * 1000;

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

function readSessionCookie(req) {
  return String(parseCookies(req?.headers?.cookie || '')[COOKIE_NAME] || '').trim();
}

function cookieHeader(value = '', { remember = false, clear = false } = {}) {
  const production = env.nodeEnv === 'production';
  const attributes = [
    `${COOKIE_NAME}=${clear ? '' : encodeURIComponent(String(value || ''))}`,
    'Path=/',
    'HttpOnly',
    production ? 'Secure' : '',
    'SameSite=Strict',
    'Priority=High',
    clear ? 'Max-Age=0' : (remember ? `Max-Age=${Math.floor(REMEMBER_TTL_MS / 1000)}` : ''),
    clear ? 'Expires=Thu, 01 Jan 1970 00:00:00 GMT' : ''
  ].filter(Boolean);
  return attributes.join('; ');
}

function trustedOrigin(req) {
  const origin = env.normalizeOrigin(req?.headers?.origin || '');
  if (!origin) return env.nodeEnv !== 'production' || ['GET', 'HEAD', 'OPTIONS'].includes(String(req?.method || '').toUpperCase());
  return env.allowedOrigins.includes(origin);
}

async function createUserSession(idToken, remember = false) {
  const { auth } = initFirebaseAdmin();
  if (!auth) throw Object.assign(new Error('AUTH_UNAVAILABLE'), { code: 'AUTH_UNAVAILABLE', statusCode: 503 });
  const token = String(idToken || '').trim();
  if (!token) throw Object.assign(new Error('ID_TOKEN_REQUIRED'), { code: 'ID_TOKEN_REQUIRED', statusCode: 400 });
  const expiresIn = remember ? REMEMBER_TTL_MS : BROWSER_TTL_MS;
  const decoded = await auth.verifyIdToken(token, true);
  const sessionCookie = await auth.createSessionCookie(token, { expiresIn });
  return { sessionCookie, decoded, remember: !!remember, expiresIn };
}

async function verifyUserSession(req, { checkRevoked = true } = {}) {
  const cookie = readSessionCookie(req);
  if (!cookie) return null;
  const { auth } = initFirebaseAdmin();
  if (!auth) return null;
  try {
    const decoded = await auth.verifySessionCookie(cookie, checkRevoked);
    return { ...decoded, uid: decoded.uid || decoded.sub };
  } catch (_) {
    return null;
  }
}

module.exports = {
  COOKIE_NAME,
  trustedOrigin,
  createUserSession,
  verifyUserSession,
  sessionCookieHeader: (value, remember) => cookieHeader(value, { remember }),
  clearSessionCookieHeader: () => cookieHeader('', { clear: true })
};
