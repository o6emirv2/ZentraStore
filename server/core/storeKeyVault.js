'use strict';

const crypto = require('crypto');
const env = require('../config/env');

const AAD_V1 = Buffer.from('shelby-ios-store-inventory:v1', 'utf8');
const MAX_SECRET_LENGTH = 512;
const SAFE_KEY_ID = /^[a-z0-9][a-z0-9._-]{1,63}$/;

function vaultError(code, statusCode = 400) {
  return Object.assign(new Error(code), { code, statusCode });
}

function configured() {
  return env.storeKeys?.configured === true;
}

function assertConfigured() {
  if (!configured()) throw vaultError('STORE_KEY_VAULT_UNAVAILABLE', 503);
}

function normalizeSecret(value = '') {
  const secret = String(value ?? '').normalize('NFKC').trim();
  if (secret.length < 4 || secret.length > MAX_SECRET_LENGTH || /[\u0000-\u001f\u007f]/.test(secret)) {
    throw vaultError('STORE_INVENTORY_KEY_INVALID', 400);
  }
  return secret;
}

function activeKeyId() {
  const value = String(env.storeKeys?.activeKeyId || 'vault-2026-v1').trim().toLowerCase();
  return SAFE_KEY_ID.test(value) ? value : 'vault-2026-v1';
}

function keyring() {
  assertConfigured();
  const ring = new Map();
  const configuredKeys = env.storeKeys?.decryptionSecrets && typeof env.storeKeys.decryptionSecrets === 'object'
    ? env.storeKeys.decryptionSecrets
    : {};
  Object.entries(configuredKeys).forEach(([id, secret]) => {
    const normalizedId = String(id || '').trim().toLowerCase();
    const normalizedSecret = String(secret || '').trim();
    if (SAFE_KEY_ID.test(normalizedId) && normalizedSecret.length >= 64) ring.set(normalizedId, normalizedSecret);
  });
  if (String(env.storeKeys?.encryptionSecret || '').length >= 64) ring.set(activeKeyId(), env.storeKeys.encryptionSecret);
  return ring;
}

function deriveV1Key(secret = '') {
  return crypto.createHash('sha256')
    .update('shelby-ios-key-encryption:v1\u0000')
    .update(secret)
    .digest();
}

function deriveV2Key(secret = '', id = '') {
  return crypto.createHash('sha256')
    .update('shelby-ios-key-encryption:v2\u0000')
    .update(String(id))
    .update('\u0000')
    .update(secret)
    .digest();
}

function aadV2(id = '') {
  return Buffer.from(`shelby-ios-store-inventory:v2:${id}`, 'utf8');
}

function contextAad(id = '', context = {}) {
  const requestedRecordType = String(context.recordType || '').trim().toLowerCase();
  const inferredRecordType = context.orderId && context.uid ? 'delivery' : 'inventory';
  const recordType = (requestedRecordType || inferredRecordType).slice(0, 20);
  const normalized = {
    recordType,
    recordId: String(context.recordId || context.id || '').trim().slice(0, 160),
    sku: recordType === 'inventory' ? String(context.sku || '').trim().slice(0, 130) : '',
    productId: String(context.productId || '').trim().slice(0, 80),
    planKey: String(context.planKey || '').trim().slice(0, 40),
    orderId: recordType === 'delivery' ? String(context.orderId || '').trim().slice(0, 160) : '',
    uid: recordType === 'delivery' ? String(context.uid || '').trim().slice(0, 160) : ''
  };
  if (!['delivery', 'inventory'].includes(normalized.recordType)
    || !normalized.recordId || !normalized.productId || !normalized.planKey
    || (normalized.recordType === 'delivery' && (!normalized.orderId || !normalized.uid))
    || (normalized.recordType === 'inventory' && !normalized.sku)) {
    throw vaultError('STORE_KEY_CONTEXT_INVALID', 500);
  }
  return Buffer.from(`shelby-ios-store-inventory:v3:${id}:${JSON.stringify(normalized)}`, 'utf8');
}

function encryptSecret(value = '', context = {}) {
  assertConfigured();
  const plaintext = normalizeSecret(value);
  const id = activeKeyId();
  const secret = keyring().get(id);
  if (!secret) throw vaultError('STORE_KEY_VAULT_UNAVAILABLE', 503);
  const aad = contextAad(id, context);
  const dataKey = crypto.randomBytes(32);
  const wrapIv = crypto.randomBytes(12);
  const wrappingCipher = crypto.createCipheriv('aes-256-gcm', deriveV2Key(secret, id), wrapIv);
  wrappingCipher.setAAD(aad);
  const wrappedKey = Buffer.concat([wrappingCipher.update(dataKey), wrappingCipher.final()]);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', dataKey, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  dataKey.fill(0);
  return Object.freeze({
    version: 3,
    keyId: id,
    algorithm: 'A256GCM',
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
    wrappedKey: wrappedKey.toString('base64url'),
    wrapIv: wrapIv.toString('base64url'),
    wrapTag: wrappingCipher.getAuthTag().toString('base64url')
  });
}

function decode(value = '', expectedLength = 0, maxLength = 4096) {
  const raw = String(value || '');
  if (!raw || !/^[A-Za-z0-9_-]+$/.test(raw)) throw vaultError('STORE_KEY_CIPHERTEXT_INVALID', 500);
  const output = Buffer.from(raw, 'base64url');
  if (output.toString('base64url') !== raw || output.length > maxLength || (expectedLength && output.length !== expectedLength)) {
    throw vaultError('STORE_KEY_CIPHERTEXT_INVALID', 500);
  }
  return output;
}

function decryptWith({ payload, key, aad }) {
  const iv = decode(payload.iv, 12, 12);
  const tag = decode(payload.tag, 16, 16);
  const ciphertext = decode(payload.ciphertext, 0, 2048);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function decryptSecret(payload = {}, context = {}) {
  assertConfigured();
  if (payload?.algorithm !== 'A256GCM') throw vaultError('STORE_KEY_CIPHERTEXT_INVALID', 500);
  const version = Number(payload?.version);
  try {
    if (version === 3) {
      const id = String(payload?.keyId || '').trim().toLowerCase();
      if (!SAFE_KEY_ID.test(id)) throw vaultError('STORE_KEY_CIPHERTEXT_INVALID', 500);
      const rootSecret = keyring().get(id);
      if (!rootSecret) throw vaultError('STORE_KEY_DECRYPTION_KEY_MISSING', 503);
      const aad = contextAad(id, context);
      const unwrap = crypto.createDecipheriv('aes-256-gcm', deriveV2Key(rootSecret, id), decode(payload.wrapIv, 12, 12));
      unwrap.setAAD(aad);
      unwrap.setAuthTag(decode(payload.wrapTag, 16, 16));
      const dataKey = Buffer.concat([unwrap.update(decode(payload.wrappedKey, 32, 32)), unwrap.final()]);
      try {
        return normalizeSecret(decryptWith({ payload, key: dataKey, aad }));
      } finally {
        dataKey.fill(0);
      }
    }
    if (version === 2) {
      const id = String(payload?.keyId || '').trim().toLowerCase();
      if (!SAFE_KEY_ID.test(id)) throw vaultError('STORE_KEY_CIPHERTEXT_INVALID', 500);
      const secret = keyring().get(id);
      if (!secret) throw vaultError('STORE_KEY_DECRYPTION_KEY_MISSING', 503);
      return normalizeSecret(decryptWith({ payload, key: deriveV2Key(secret, id), aad: aadV2(id) }));
    }
    if (version === 1) {
      let lastError = null;
      const candidates = [...new Set([String(env.storeKeys?.encryptionSecret || ''), ...keyring().values()].filter((secret) => secret.length >= 64))];
      for (const secret of candidates) {
        try { return normalizeSecret(decryptWith({ payload, key: deriveV1Key(secret), aad: AAD_V1 })); }
        catch (error) { lastError = error; }
      }
      throw lastError || new Error('no-v1-key');
    }
    throw vaultError('STORE_KEY_CIPHERTEXT_INVALID', 500);
  } catch (error) {
    if (['STORE_KEY_CIPHERTEXT_INVALID', 'STORE_KEY_DECRYPTION_KEY_MISSING', 'STORE_KEY_CONTEXT_INVALID'].includes(String(error?.code || ''))) throw error;
    throw vaultError('STORE_KEY_DECRYPTION_FAILED', 500);
  }
}

function needsRotation(payload = {}) {
  return Number(payload?.version) !== 3 || String(payload?.keyId || '').trim().toLowerCase() !== activeKeyId();
}

function rotationStatus() {
  const ring = configured() ? keyring() : new Map();
  return {
    activeKeyId: activeKeyId(),
    decryptKeyCount: ring.size,
    legacyDecryptKeys: Math.max(0, ring.size - 1),
    configured: configured()
  };
}

function fingerprintSecret(value = '') {
  assertConfigured();
  return crypto.createHmac('sha256', env.storeKeys.fingerprintSecret)
    .update('shelby-ios-key-fingerprint:v1\u0000')
    .update(normalizeSecret(value))
    .digest('hex');
}

function maskSecret(value = '') {
  const secret = normalizeSecret(value);
  return `${secret.slice(0, Math.min(2, secret.length))}${'•'.repeat(Math.max(6, Math.min(12, secret.length - 2)))}`;
}

module.exports = {
  configured,
  activeKeyId,
  rotationStatus,
  needsRotation,
  normalizeSecret,
  encryptSecret,
  decryptSecret,
  fingerprintSecret,
  maskSecret,
  vaultError
};
