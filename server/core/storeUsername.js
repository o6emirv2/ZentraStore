'use strict';

const crypto = require('crypto');
const RESERVED_USERNAMES = new Set(['admin', 'administrator', 'support', 'moderator', 'system', 'zentra', 'zentra_store', 'zentrastore', 'root', 'owner', 'official', 'staff', 'yonetici', 'yönetici', 'destek', 'sistem']);

function usernameKeys(value = '') {
  const raw = String(value || '').trim().replace(/[<>\u0000-\u001f\u007f\s]/g, '').slice(0, 20);
  return [...new Set([raw.toLocaleLowerCase('tr-TR'), raw.toLowerCase()].filter(Boolean))];
}

function usernameRegistryId(key = '') {
  return crypto.createHash('sha256').update(String(key)).digest('hex');
}

function validateUsername(value = '') {
  const username = String(value || '').trim().normalize('NFC').replace(/i\u0307/gu, 'i');
  if (!/^[\p{L}\p{N}._-]{5,20}$/u.test(username)) {
    throw Object.assign(new Error('Kullanıcı adı 5-20 karakter olmalı; harf, sayı, nokta, alt çizgi ve tire kullanılabilir.'), { code: 'INVALID_USERNAME', statusCode: 400 });
  }
  if (usernameKeys(username).some((key) => RESERVED_USERNAMES.has(key))) {
    throw Object.assign(new Error('Bu kullanıcı adı sistem tarafından ayrılmıştır.'), { code: 'USERNAME_RESERVED', statusCode: 409 });
  }
  return username;
}

async function findUsernameProfiles(db, value, { transaction = null, includeRegistry = true } = {}) {
  const username = validateUsername(value);
  const keys = usernameKeys(username);
  const variants = [...new Set([username, ...keys, username.toUpperCase(), username.toLocaleUpperCase('tr-TR')])];
  const read = (ref) => transaction ? transaction.get(ref) : ref.get();
  const collection = db.collection('users');
  const query = (field, values) => collection.where(field, values.length === 1 ? '==' : 'in', values.length === 1 ? values[0] : values).limit(4);
  const [lower, legacy, ...registry] = await Promise.all([
    read(query('usernameLower', keys)),
    read(query('username', variants)),
    ...(includeRegistry ? keys.map((key) => read(db.collection('usernameRegistry').doc(usernameRegistryId(key)))) : [])
  ]);
  const documents = new Map([...lower.docs, ...legacy.docs].map((doc) => [doc.id, doc]));
  const registeredUids = [...new Set(registry.filter((doc) => doc.exists).map((doc) => String(doc.data()?.uid || '')).filter((uid) => uid && !uid.includes('/')))];
  await Promise.all(registeredUids.map(async (uid) => {
    if (!documents.has(uid)) {
      const doc = await read(collection.doc(uid));
      if (doc.exists) documents.set(uid, doc);
    }
  }));
  return [...documents.values()].filter((doc) => {
    const profile = doc.data() || {};
    const current = profile.username || profile.usernameLower;
    return usernameKeys(current).some((key) => keys.includes(key));
  });
}

module.exports = { usernameKeys, usernameRegistryId, validateUsername, findUsernameProfiles };
