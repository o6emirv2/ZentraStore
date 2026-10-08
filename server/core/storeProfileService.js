'use strict';

const crypto = require('crypto');
const { initFirebaseAdmin } = require('../config/firebaseAdmin');
const { readAccount } = require('./storeService');

const PROFILE_CHANGE_LIMITS = Object.freeze({ username: 3, fullName: 1, birthDate: 1 });
const RESERVED_USERNAMES = new Set(['admin', 'administrator', 'support', 'moderator', 'system', 'shelby', 'shelbyios', 'root', 'owner', 'official', 'staff', 'yonetici', 'yönetici', 'destek', 'sistem']);

function profileError(code, statusCode = 400, message = '') {
  return Object.assign(new Error(message || code), { code, statusCode });
}

function safeProfileText(value = '', max = 200) {
  return String(value || '').trim().replace(/[<>\u0000-\u001f\u007f]/g, '').slice(0, max);
}

function usernameKeys(value = '') {
  const raw = safeProfileText(value, 20).replace(/\s+/g, '');
  return [...new Set([raw.toLocaleLowerCase('tr-TR'), raw.toLowerCase()].filter(Boolean))];
}

function usernameRegistryId(key = '') {
  return crypto.createHash('sha256').update(String(key)).digest('hex');
}

function validateUsername(value = '') {
  const username = safeProfileText(value, 20).replace(/\s+/g, '');
  if (!/^[\p{L}\p{N}._-]{5,20}$/u.test(username)) {
    throw profileError('INVALID_USERNAME', 400, 'Kullanıcı adı 5-20 karakter olmalı; harf, sayı, nokta, alt çizgi ve tire kullanılabilir.');
  }
  if (usernameKeys(username).some((key) => RESERVED_USERNAMES.has(key))) {
    throw profileError('USERNAME_RESERVED', 409, 'Bu kullanıcı adı sistem tarafından ayrılmıştır.');
  }
  return username;
}

function validatePersonName(value = '', label = 'İsim') {
  const name = safeProfileText(value, 50).replace(/\s+/g, ' ');
  if (name.length < 2 || !/^[\p{L}]+(?:[ .'’\-][\p{L}]+)*$/u.test(name)) {
    throw profileError('INVALID_PERSON_NAME', 400, `${label} en az 2 karakter olmalı; harf, boşluk, kesme işareti ve tire kullanılabilir.`);
  }
  return name;
}

function validateBirthDate(value = '') {
  const raw = safeProfileText(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw profileError('BIRTH_DATE_INVALID', 400, 'Geçerli bir doğum tarihi seçmelisin.');
  const date = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== raw || date.getTime() > Date.now() || date.getUTCFullYear() < 1900) {
    throw profileError('BIRTH_DATE_INVALID', 400, 'Geçerli bir doğum tarihi seçmelisin.');
  }
  return raw;
}

function exactInput(input = {}, allowed = []) {
  return !!input && typeof input === 'object' && !Array.isArray(input)
    && Object.keys(input).length === allowed.length
    && Object.keys(input).every((key) => allowed.includes(key));
}

function usedProfileChanges(profile = {}, field = '') {
  const raw = Number(profile.profileChangeCounts?.[field] || 0);
  return Number.isSafeInteger(raw) && raw >= 0 ? raw : PROFILE_CHANGE_LIMITS[field];
}

function requireActiveProfile(snapshot, uid = '') {
  if (!snapshot?.exists) throw profileError('STORE_ACCOUNT_NOT_FOUND', 404);
  const profile = snapshot.data() || {};
  if (profile.storeAccountStatus === 'suspended') throw profileError('STORE_ACCOUNT_SUSPENDED', 403);
  if (!String(uid || '').trim()) throw profileError('AUTH_REQUIRED', 401);
  return profile;
}

async function updateProfileUsername(uid = '', authUser = {}, input = {}) {
  if (!exactInput(input, ['username'])) throw profileError('PROFILE_INPUT_INVALID', 400);
  const username = validateUsername(input.username);
  const safeUid = safeProfileText(uid, 160);
  const { db } = initFirebaseAdmin();
  if (!db) throw profileError('STORE_STORAGE_UNAVAILABLE', 503);
  const userRef = db.collection('users').doc(safeUid);
  await db.runTransaction(async (transaction) => {
    const profileSnapshot = await transaction.get(userRef);
    const profile = requireActiveProfile(profileSnapshot, safeUid);
    const oldUsername = safeProfileText(profile.username, 20);
    if (oldUsername === username) throw profileError('USERNAME_UNCHANGED', 409);
    const used = usedProfileChanges(profile, 'username');
    if (used >= PROFILE_CHANGE_LIMITS.username) throw profileError('USERNAME_CHANGE_LIMIT_REACHED', 409);
    const oldKeys = usernameKeys(oldUsername);
    const newKeys = usernameKeys(username);
    const registryKeys = [...new Set([...oldKeys, ...newKeys])];
    const registryEntries = await Promise.all(registryKeys.map(async (key) => {
      const ref = db.collection('usernameRegistry').doc(usernameRegistryId(key));
      return { key, ref, snapshot: await transaction.get(ref) };
    }));
    for (const entry of registryEntries) {
      if (newKeys.includes(entry.key) && entry.snapshot.exists && String(entry.snapshot.data()?.uid || '') !== safeUid) {
        throw profileError('USERNAME_TAKEN', 409, 'Bu kullanıcı adı kullanılıyor.');
      }
    }
    const now = Date.now();
    for (const entry of registryEntries) {
      if (newKeys.includes(entry.key)) {
        transaction.set(entry.ref, { uid: safeUid, username, usernameLower: entry.key, updatedAt: now }, { merge: true });
      } else if (entry.snapshot.exists && String(entry.snapshot.data()?.uid || '') === safeUid) {
        transaction.delete(entry.ref);
      }
    }
    transaction.set(userRef, {
      username,
      usernameLower: newKeys[0],
      profileChangeCounts: { ...(profile.profileChangeCounts || {}), username: used + 1 },
      storeUpdatedAt: now,
      updatedAt: now
    }, { merge: true });
  });
  return readAccount(safeUid, authUser);
}

async function updateProfileFullName(uid = '', authUser = {}, input = {}) {
  if (!exactInput(input, ['firstName', 'lastName'])) throw profileError('PROFILE_INPUT_INVALID', 400);
  const firstName = validatePersonName(input.firstName, 'İsim');
  const lastName = validatePersonName(input.lastName, 'Soyisim');
  const safeUid = safeProfileText(uid, 160);
  const { db } = initFirebaseAdmin();
  if (!db) throw profileError('STORE_STORAGE_UNAVAILABLE', 503);
  const userRef = db.collection('users').doc(safeUid);
  await db.runTransaction(async (transaction) => {
    const profile = requireActiveProfile(await transaction.get(userRef), safeUid);
    if (profile.firstName === firstName && profile.lastName === lastName) throw profileError('FULL_NAME_UNCHANGED', 409);
    const used = usedProfileChanges(profile, 'fullName');
    if (used >= PROFILE_CHANGE_LIMITS.fullName) throw profileError('FULL_NAME_CHANGE_LIMIT_REACHED', 409);
    const now = Date.now();
    transaction.set(userRef, {
      firstName, lastName, fullName: `${firstName} ${lastName}`,
      profileChangeCounts: { ...(profile.profileChangeCounts || {}), fullName: used + 1 },
      storeUpdatedAt: now, updatedAt: now
    }, { merge: true });
  });
  return readAccount(safeUid, authUser);
}

async function updateProfileBirthDate(uid = '', authUser = {}, input = {}) {
  if (!exactInput(input, ['birthDate'])) throw profileError('PROFILE_INPUT_INVALID', 400);
  const birthDate = validateBirthDate(input.birthDate);
  const safeUid = safeProfileText(uid, 160);
  const { db } = initFirebaseAdmin();
  if (!db) throw profileError('STORE_STORAGE_UNAVAILABLE', 503);
  const userRef = db.collection('users').doc(safeUid);
  await db.runTransaction(async (transaction) => {
    const profile = requireActiveProfile(await transaction.get(userRef), safeUid);
    if (profile.birthDate === birthDate) throw profileError('BIRTH_DATE_UNCHANGED', 409);
    const used = usedProfileChanges(profile, 'birthDate');
    if (used >= PROFILE_CHANGE_LIMITS.birthDate) throw profileError('BIRTH_DATE_CHANGE_LIMIT_REACHED', 409);
    const now = Date.now();
    transaction.set(userRef, {
      birthDate,
      profileChangeCounts: { ...(profile.profileChangeCounts || {}), birthDate: used + 1 },
      storeUpdatedAt: now, updatedAt: now
    }, { merge: true });
  });
  return readAccount(safeUid, authUser);
}

async function updateProfileEmail(uid = '', authUser = {}, input = {}) {
  if (!exactInput(input, ['email'])) throw profileError('PROFILE_INPUT_INVALID', 400);
  const email = safeProfileText(input.email, 160).toLowerCase();
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) throw profileError('EMAIL_INVALID', 400);
  const safeUid = safeProfileText(uid, 160);
  const { db, auth } = initFirebaseAdmin();
  if (!db || !auth) throw profileError('STORE_STORAGE_UNAVAILABLE', 503);
  const userRef = db.collection('users').doc(safeUid);
  const [account, snapshot] = await Promise.all([
    auth.getUser(safeUid).catch(() => { throw profileError('STORE_ACCOUNT_NOT_FOUND', 404); }),
    userRef.get()
  ]);
  requireActiveProfile(snapshot, safeUid);
  if (account.disabled) throw profileError('STORE_ACCOUNT_DISABLED', 403);
  const previousEmail = safeProfileText(account.email, 160).toLowerCase();
  if (previousEmail === email) throw profileError('EMAIL_UNCHANGED', 409);
  try {
    const existing = await auth.getUserByEmail(email);
    if (existing?.uid && String(existing.uid) !== safeUid) throw profileError('EMAIL_ALREADY_IN_USE', 409);
  } catch (error) {
    if (error?.code === 'EMAIL_ALREADY_IN_USE') throw error;
    if (!['auth/user-not-found', 'auth/user-not-found-by-email'].includes(String(error?.code || ''))) {
      throw profileError('EMAIL_UPDATE_UNAVAILABLE', 503);
    }
  }
  try {
    await auth.updateUser(safeUid, { email });
  } catch (error) {
    if (String(error?.code || '') === 'auth/email-already-exists') throw profileError('EMAIL_ALREADY_IN_USE', 409);
    throw profileError('EMAIL_UPDATE_UNAVAILABLE', 503);
  }
  try {
    const now = Date.now();
    await userRef.set({ email, storeUpdatedAt: now, updatedAt: now }, { merge: true });
  } catch (_) {
    await auth.updateUser(safeUid, { email: previousEmail }).catch(() => null);
    throw profileError('EMAIL_UPDATE_UNAVAILABLE', 503);
  }
  return readAccount(safeUid, { ...authUser, email });
}

module.exports = {
  PROFILE_CHANGE_LIMITS,
  usernameKeys,
  usernameRegistryId,
  validateUsername,
  validatePersonName,
  validateBirthDate,
  updateProfileUsername,
  updateProfileFullName,
  updateProfileBirthDate,
  updateProfileEmail
};
