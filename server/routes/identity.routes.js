'use strict';

const { createRouter } = require('../core/asyncRouter');
const env = require('../config/env');
const { initFirebaseAdmin } = require('../config/firebaseAdmin');
const { registrationContext, enforceIdentityAccess, legacyIdentity, readRegistrationSecurity, applyRegistrationSecurity, auditSecurityFailure } = require('../core/storeAccountSecurity');
const { readAffiliateRegistration, applyAffiliateRegistration } = require('../core/storeAffiliateService');
const { readStoredBalance } = require('../core/storeMoney');
const { authLoginLimiter, authAccountLimiter, resetAccountLimiter, passwordResetLimiter, requireAuth, strictLimiter } = require('../core/security');
const { trustedOrigin } = require('../core/userSessionService');
const {
  validatePersonName, validateBirthDate
} = require('../core/storeProfileService');

const { usernameKeys, usernameRegistryId, validateUsername, findUsernameProfiles } = require('../core/storeUsername');

const router = createRouter();

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
  const registry = await Promise.all(keys.map((key) => db.collection('usernameRegistry').doc(usernameRegistryId(key)).get()));
  if (registry.some((doc) => doc.exists)) {
    return { available: false, username, code: 'USERNAME_TAKEN', message: 'Bu kullanıcı adı kullanılıyor.' };
  }
  const profiles = await findUsernameProfiles(db, username, { includeRegistry: false });
  const taken = profiles.length > 0;
  return { available: !taken, username, code: taken ? 'USERNAME_TAKEN' : '', message: taken ? 'Bu kullanıcı adı kullanılıyor.' : '' };
}

function authInvalid() {
  return serviceError('LOGIN_CREDENTIALS_INVALID', 401, 'Giriş bilgileri doğrulanamadı. E-posta/kullanıcı adı ve şifreni kontrol et.');
}

function validEmail(value = '') {
  const email = text(value, 254).toLowerCase();
  return /^\S+@\S+\.\S+$/.test(email) ? email : '';
}

async function activeIdentity(auth, uid) {
  let user;
  try { user = await auth.getUser(uid); } catch (error) {
    if (error?.code === 'auth/user-not-found') throw authInvalid();
    throw serviceError('AUTH_UNAVAILABLE', 503);
  }
  if (!user || user.disabled) throw authInvalid();
  return user;
}

async function resolvePrivateLogin(identifier = '') {
  const normalized = String(identifier || '').trim();
  if (normalized.length > 254 || /[<>\u0000-\u001f\u007f]/.test(normalized)) throw authInvalid();
  const { db, auth } = initFirebaseAdmin();
  if (!db || !auth) throw serviceError('AUTH_UNAVAILABLE', 503, 'Hesap hizmetine şu anda ulaşılamıyor. Lütfen kısa süre sonra tekrar dene.');
  if (normalized.includes('@')) {
    const email = validEmail(normalized);
    if (!email) throw authInvalid();
    return { email, expectedUid: '' };
  }
  let username;
  try { username = validateUsername(normalized); } catch (_) { throw authInvalid(); }
  const profiles = await findUsernameProfiles(db, username);
  if (profiles.length !== 1) throw authInvalid();
  const doc = profiles[0];
  const authUser = await activeIdentity(auth, doc.id);
  const email = validEmail(authUser.email);
  if (!email) throw authInvalid();
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

router.post('/auth/login', authLoginLimiter, authAccountLimiter, async (req, res, next) => {
  try {
    if (!trustedOrigin(req)) throw serviceError('ORIGIN_NOT_ALLOWED', 403);
    if (!req.body || Object.keys(req.body).some((key) => !['identifier', 'password'].includes(key))
      || typeof req.body.identifier !== 'string' || typeof req.body.password !== 'string') throw authInvalid();
    const identifier = req.body.identifier.trim();
    const password = req.body.password;
    if (!identifier || !password || password.length > 4096) throw authInvalid();
    const { email, expectedUid } = await resolvePrivateLogin(identifier);
    const result = await identityToolkit('signInWithPassword', { email, password, returnSecureToken: true });
    const uid = String(result.payload?.localId || '').trim();
    if (result.status === 429 || result.payload?.error?.message === 'TOO_MANY_ATTEMPTS_TRY_LATER') throw serviceError('TOO_MANY_REQUESTS', 429);
    if (result.status >= 500) throw serviceError('AUTH_UNAVAILABLE', 503);
    if (!result.ok || !uid || (expectedUid && uid !== expectedUid)) throw authInvalid();
    const { auth } = initFirebaseAdmin();
    req.storeAuthIdentity = await activeIdentity(auth, uid);
    req.user = { uid, email };
    const access = await enforceIdentityAccess(req);
    const customToken = await auth.createCustomToken(uid, { zentraLogin: true });
    return res.json({ ok: true, customToken, accountSecurity: { uid, exempt: access.exempt } });
  } catch (error) {
    if (error.storeSecurityError) return next(error);
    if (['LOGIN_CREDENTIALS_INVALID', 'AUTH_UNAVAILABLE', 'ORIGIN_NOT_ALLOWED', 'TOO_MANY_REQUESTS'].includes(String(error?.code || ''))) return next(error);
    return next(serviceError('AUTH_UNAVAILABLE', 503));
  }
});

router.post('/auth/password-reset', passwordResetLimiter, resetAccountLimiter, async (req, res) => {
  if (!trustedOrigin(req)) return res.status(403).json({ ok: false, error: 'ORIGIN_NOT_ALLOWED' });
  try {
    const identifier = text(req.body?.identifier, 254);
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
    const { db, auth } = initFirebaseAdmin();
    if (!db || !auth) throw serviceError('STORE_STORAGE_UNAVAILABLE', 503);
    const securityContext = await registrationContext(req);
    const affiliateCode = req.body?.affiliateCode || '';
    const identity = affiliateCode ? await auth.getUser(uid) : null;
    const identityCreatedAt = Date.parse(identity?.metadata?.creationTime || '');
    const userRef = db.collection('users').doc(uid);
    const preliminary = await userRef.get();
    const isLegacy = preliminary.exists && await legacyIdentity(uid, preliminary.data() || {});
    const registryRefs = keys.map((entry) => ({ key: entry, ref: db.collection('usernameRegistry').doc(usernameRegistryId(entry)) }));
    let publicUser = null;
    await db.runTransaction(async (transaction) => {
      const [userSnapshot, ...registrySnapshots] = await Promise.all([transaction.get(userRef), ...registryRefs.map((entry) => transaction.get(entry.ref))]);
      const current = userSnapshot.exists ? (userSnapshot.data() || {}) : {};
      if (registrySnapshots.some((snapshot) => snapshot.exists && String(snapshot.data()?.uid || '') !== uid)) {
        throw serviceError('USERNAME_TAKEN', 409, 'Bu kullanıcı adı kullanılıyor.');
      }
      if (current.profileInitializationPending !== true && ((current.username && current.username !== username)
        || (current.firstName && current.firstName !== firstName)
        || (current.lastName && current.lastName !== lastName)
        || (current.birthDate && current.birthDate !== birthDate))) {
        throw serviceError('PROFILE_INITIALIZATION_LOCKED', 409, 'Hesap bilgilerini yalnızca korumalı hesap ayarlarından değiştirebilirsin.');
      }
      const legacy = await findUsernameProfiles(db, username, { transaction, includeRegistry: false });
      if (legacy.some((doc) => doc.id !== uid)) throw serviceError('USERNAME_TAKEN', 409, 'Bu kullanıcı adı kullanılıyor.');
      const claim = await readRegistrationSecurity({ tx: transaction, db, uid, current, context: securityContext, legacy: isLegacy });
      const registration = await readAffiliateRegistration({ tx: transaction, db, uid, current, code: affiliateCode, createdAt: identityCreatedAt });
      const now = Date.now();
      const patch = {
        ...applyRegistrationSecurity({ tx: transaction, db, uid, claim }),
        ...applyAffiliateRegistration({ tx: transaction, db, uid, registration, now }),
        profileInitializationPending: false,
        email,
        firstName: current.firstName || firstName,
        lastName: current.lastName || lastName,
        fullName: current.fullName || `${firstName} ${lastName}`,
        username,
        usernameLower: key,
        birthDate: current.birthDate || birthDate,
        ...(current.storeBalanceKurus === undefined ? { storeBalanceKurus: readStoredBalance(current) } : {}),
        storeProfile: current.storeProfile || { avatarId: '1' },
        createdAt: Number(current.createdAt || now),
        updatedAt: now
      };
      registryRefs.forEach((entry) => transaction.set(entry.ref, { uid, username, usernameLower: entry.key, updatedAt: now }, { merge: true }));
      transaction.set(userRef, patch, { merge: true });
      publicUser = { uid, email, firstName: patch.firstName, lastName: patch.lastName, fullName: patch.fullName, username, birthDate: patch.birthDate };
    });
    return res.json({ ok: true, user: publicUser });
  } catch (error) {
    if (error.storeSecurityError) { try { await auditSecurityFailure(req, error); } catch (recorded) { return next(recorded); } }
    return next(error);
  }
});

module.exports = router;
