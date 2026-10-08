'use strict';

const express = require('express');
const env = require('../config/env');
const { initFirebaseAdmin } = require('../config/firebaseAdmin');
const { authLoginLimiter, passwordResetLimiter, requireAuth, strictLimiter } = require('../core/security');
const { trustedOrigin } = require('../core/userSessionService');
const {
  usernameKeys, usernameRegistryId, validateUsername,
  validatePersonName, validateBirthDate
} = require('../core/storeProfileService');

const router = express.Router();

function serviceError(code, statusCode = 400, message = '') {
  return Object.assign(new Error(message || code), { code, statusCode });
}

function text(value = '', max = 200) {
  return String(value || '').trim().replace(/[<>\u0000-\u001f\u007f]/g, '').slice(0, max);
}

async function usernameAvailability(value = '') {
  const username = validateUsername(value);
  const keys = usernameKeys(username);
  const { db } = initFirebaseAdmin();
  if (!db) throw serviceError('STORE_STORAGE_UNAVAILABLE', 503);
  for (const key of keys) {
    const registry = await db.collection('usernameRegistry').doc(usernameRegistryId(key)).get();
    if (registry.exists) {
      return { available: false, username, code: 'USERNAME_TAKEN', message: 'Bu kullanıcı adı kullanılıyor.' };
    }
  }
  const snapshot = await db.collection('users').where('usernameLower', keys.length === 1 ? '==' : 'in', keys.length === 1 ? keys[0] : keys).limit(4).get();
  const taken = !snapshot.empty;
  return { available: !taken, username, code: taken ? 'USERNAME_TAKEN' : '', message: taken ? 'Bu kullanıcı adı kullanılıyor.' : '' };
}

function authInvalid() {
  return serviceError('LOGIN_CREDENTIALS_INVALID', 401, 'Giriş bilgileri doğrulanamadı. E-posta/kullanıcı adı ve şifreni kontrol et.');
}

function validEmail(value = '') {
  const email = text(value, 160).toLowerCase();
  return /^\S+@\S+\.\S+$/.test(email) ? email : '';
}

async function resolvePrivateLogin(identifier = '') {
  const normalized = text(identifier, 160);
  const { db, auth } = initFirebaseAdmin();
  if (!db || !auth) throw serviceError('AUTH_UNAVAILABLE', 503, 'Hesap hizmetine şu anda ulaşılamıyor. Lütfen kısa süre sonra tekrar dene.');
  if (normalized.includes('@')) {
    const email = validEmail(normalized);
    if (!email) throw authInvalid();
    return { email, expectedUid: '' };
  }
  let username;
  try { username = validateUsername(normalized); } catch (_) { throw authInvalid(); }
  const keys = usernameKeys(username);
  const snapshot = await db.collection('users').where('usernameLower', keys.length === 1 ? '==' : 'in', keys.length === 1 ? keys[0] : keys).limit(3).get();
  if (snapshot.size !== 1) throw authInvalid();
  const doc = snapshot.docs[0];
  let authUser;
  try { authUser = await auth.getUser(doc.id); } catch (_) { throw authInvalid(); }
  if (authUser.disabled) throw authInvalid();
  const email = validEmail(authUser.email);
  if (!email) throw authInvalid();
  const stored = doc.data() || {};
  if (String(stored.email || '').trim().toLowerCase() !== email) {
    await doc.ref.set({ email, updatedAt: Date.now() }, { merge: true }).catch(() => null);
  }
  return { email, expectedUid: doc.id };
}

async function identityToolkit(action = '', body = {}) {
  const apiKey = String(env.firebase.publicConfig.apiKey || '').trim();
  if (!apiKey) throw serviceError('AUTH_UNAVAILABLE', 503, 'Hesap hizmetine şu anda ulaşılamıyor. Lütfen kısa süre sonra tekrar dene.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:${action}?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const payload = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, payload };
  } catch (_) {
    throw serviceError('AUTH_UNAVAILABLE', 503, 'Hesap hizmetine şu anda ulaşılamıyor. Lütfen kısa süre sonra tekrar dene.');
  } finally {
    clearTimeout(timeout);
  }
}

router.post('/auth/login', authLoginLimiter, async (req, res, next) => {
  try {
    if (!trustedOrigin(req)) throw serviceError('ORIGIN_NOT_ALLOWED', 403);
    const identifier = text(req.body?.identifier, 160);
    const password = String(req.body?.password || '');
    if (!identifier || !password || password.length > 4096) throw authInvalid();
    const { email, expectedUid } = await resolvePrivateLogin(identifier);
    const result = await identityToolkit('signInWithPassword', { email, password, returnSecureToken: true });
    const uid = String(result.payload?.localId || '').trim();
    if (!result.ok || !uid || (expectedUid && uid !== expectedUid)) throw authInvalid();
    const { auth } = initFirebaseAdmin();
    const authUser = await auth.getUser(uid).catch(() => null);
    if (!authUser || authUser.disabled) throw authInvalid();
    const customToken = await auth.createCustomToken(uid, { shelbyLogin: true });
    return res.json({ ok: true, customToken });
  } catch (error) {
    if (['LOGIN_CREDENTIALS_INVALID', 'AUTH_UNAVAILABLE', 'ORIGIN_NOT_ALLOWED'].includes(String(error?.code || ''))) return next(error);
    return next(authInvalid());
  }
});

router.post('/auth/password-reset', passwordResetLimiter, async (req, res) => {
  if (!trustedOrigin(req)) return res.status(403).json({ ok: false, error: 'ORIGIN_NOT_ALLOWED' });
  try {
    const identifier = text(req.body?.identifier, 160);
    if (identifier) {
      const { email } = await resolvePrivateLogin(identifier);
      await identityToolkit('sendOobCode', { requestType: 'PASSWORD_RESET', email });
    }
  } catch (_) {
  }
  return res.status(202).json({ ok: true, accepted: true });
});

router.get('/auth/check-username', strictLimiter, async (req, res, next) => {
  try {
    const result = await usernameAvailability(req.query.username);
    return res.json({ ok: true, ...result });
  } catch (error) {
    if (error.code === 'INVALID_USERNAME' || error.code === 'USERNAME_RESERVED') {
      return res.json({ ok: true, available: false, username: text(req.query.username, 20), code: error.code, message: error.message });
    }
    return next(error);
  }
});

router.post('/profile/update', requireAuth, strictLimiter, async (req, res, next) => {
  try {
    const uid = String(req.user.uid || '').trim();
    const email = String(req.user.email || '').trim().toLowerCase();
    const firstName = validatePersonName(req.body?.firstName, 'İsim');
    const lastName = validatePersonName(req.body?.lastName, 'Soyisim');
    const username = validateUsername(req.body?.username);
    const birthDate = validateBirthDate(req.body?.birthDate);
    const keys = usernameKeys(username);
    const key = keys[0];
    const { db } = initFirebaseAdmin();
    if (!db) throw serviceError('STORE_STORAGE_UNAVAILABLE', 503);
    const userRef = db.collection('users').doc(uid);
    const registryRefs = keys.map((entry) => ({ key: entry, ref: db.collection('usernameRegistry').doc(usernameRegistryId(entry)) }));
    let publicUser = null;
    await db.runTransaction(async (transaction) => {
      const [userSnapshot, ...registrySnapshots] = await Promise.all([transaction.get(userRef), ...registryRefs.map((entry) => transaction.get(entry.ref))]);
      const current = userSnapshot.exists ? (userSnapshot.data() || {}) : {};
      if (registrySnapshots.some((snapshot) => snapshot.exists && String(snapshot.data()?.uid || '') !== uid)) {
        throw serviceError('USERNAME_TAKEN', 409, 'Bu kullanıcı adı kullanılıyor.');
      }
      if ((current.username && current.username !== username)
        || (current.firstName && current.firstName !== firstName)
        || (current.lastName && current.lastName !== lastName)
        || (current.birthDate && current.birthDate !== birthDate)) {
        throw serviceError('PROFILE_INITIALIZATION_LOCKED', 409, 'Hesap bilgilerini yalnızca korumalı hesap ayarlarından değiştirebilirsin.');
      }
      const now = Date.now();
      const patch = {
        email,
        firstName: current.firstName || firstName,
        lastName: current.lastName || lastName,
        fullName: current.fullName || `${firstName} ${lastName}`,
        username,
        usernameLower: key,
        birthDate: current.birthDate || birthDate,
        storeBalanceKurus: Math.max(0, Number(current.storeBalanceKurus || 0) || 0),
        storeProfile: current.storeProfile || { avatarId: '1' },
        createdAt: Number(current.createdAt || now),
        updatedAt: now
      };
      registryRefs.forEach((entry) => transaction.set(entry.ref, { uid, username, usernameLower: entry.key, updatedAt: now }, { merge: true }));
      transaction.set(userRef, patch, { merge: true });
      publicUser = { uid, email, firstName: patch.firstName, lastName: patch.lastName, fullName: patch.fullName, username, birthDate: patch.birthDate };
    });
    return res.json({ ok: true, user: publicUser });
  } catch (error) { return next(error); }
});

module.exports = router;
