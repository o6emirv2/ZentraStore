'use strict';
const crypto = require('node:crypto');
const env = require('../config/env');
const { initFirebaseAdmin } = require('../config/firebaseAdmin');
const WINDOW_MS = 60000;
const fail = (code = 'SECURITY_DEVICE_INVALID', statusCode = 403) => { throw Object.assign(new Error(code), { code, statusCode, storeSecurityError: true }); };
function decode(value, length) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) fail();
  const buffer = Buffer.from(value, 'base64url');
  if (buffer.toString('base64url') !== value || (length && buffer.length !== length)) fail();
  return buffer;
}
function cleanKey(key) {
  if (!key || typeof key !== 'object' || Array.isArray(key) || Object.keys(key).some(k => !['kty','crv','x','y'].includes(k)) || key.kty !== 'EC' || key.crv !== 'P-256') fail();
  decode(key.x, 32); decode(key.y, 32);
  const result = { kty: 'EC', crv: 'P-256', x: key.x, y: key.y };
  try { crypto.createPublicKey({ key: result, format: 'jwk' }); } catch (_) { fail(); }
  return result;
}
function requestOrigin(req) {
  const origin = env.normalizeOrigin(req.headers?.origin || '');
  if (origin && env.allowedOrigins.includes(origin)) return origin;
  const host = String(req.headers?.host || '').toLowerCase();
  if (req.headers?.['sec-fetch-site'] === 'same-origin') {
    const match = env.allowedOrigins.find(value => new URL(value).host.toLowerCase() === host);
    if (match) return match;
  }
  fail('ORIGIN_NOT_ALLOWED');
}
async function registerDevice(req) {
  const key = cleanKey(req.body?.publicKey), origin = requestOrigin(req);
  const deviceId = crypto.createHash('sha256').update(JSON.stringify([origin, key])).digest('hex');
  const { db } = initFirebaseAdmin(); if (!db) fail('STORE_STORAGE_UNAVAILABLE', 503);
  const ref = db.collection('storeDevices').doc(deviceId);
  await db.runTransaction(async tx => {
    const doc = await tx.get(ref);
    if (!doc.exists) tx.create(ref, { publicKey: key, origin, ownerUid: '', blocked: false, createdAt: Date.now() });
    else if (doc.data().blocked === true) fail('SECURITY_DEVICE_BLOCKED');
  });
  return { deviceId };
}
async function verifyDevice(req) {
  if (req.storeDevice) return req.storeDevice;
  const raw = req.headers?.['x-zentra-device-proof'];
  if (typeof raw !== 'string' || raw.length > 2048) fail('SECURITY_DEVICE_REQUIRED');
  let proof;
  try { proof = JSON.parse(decode(raw).toString('utf8')); } catch (_) { fail(); }
  if (!proof || Object.keys(proof).some(key => !['v','deviceId','ts','nonce','sig'].includes(key)) || proof.v !== 1
    || !/^[a-f0-9]{64}$/.test(String(proof.deviceId)) || !Number.isSafeInteger(proof.ts) || Math.abs(Date.now() - proof.ts) > WINDOW_MS) fail();
  decode(proof.nonce, 18);
  const { db } = initFirebaseAdmin(); if (!db) fail('STORE_STORAGE_UNAVAILABLE', 503);
  const ref = db.collection('storeDevices').doc(proof.deviceId), doc = await ref.get();
  if (!doc.exists || doc.data().origin !== requestOrigin(req)) fail();
  const data = doc.data();
  if (data.blocked === true) fail('SECURITY_DEVICE_BLOCKED');
  const bodyHash = crypto.createHash('sha256').update(JSON.stringify(req.body || {})).digest('hex');
  const message = JSON.stringify(['zentra-store-device-v1', proof.deviceId, data.origin, req.method, req.originalUrl, bodyHash, proof.ts, proof.nonce]);
  let valid = false;
  try { valid = crypto.verify('sha256', Buffer.from(message), { key: crypto.createPublicKey({ key: cleanKey(data.publicKey), format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, decode(proof.sig, 64)); } catch (_) { fail(); }
  if (!valid) fail();
  const id = crypto.createHash('sha256').update(`${proof.deviceId}:${proof.nonce}`).digest('hex');
  await db.runTransaction(async tx => {
    const nonceRef = db.collection('storeDeviceNonces').doc(id), previous = await tx.get(nonceRef);
    if (previous.exists) fail('SECURITY_DEVICE_REPLAY', 409);
    tx.create(nonceRef, { deviceId: proof.deviceId, createdAt: Date.now(), expiresAt: new Date(Date.now() + WINDOW_MS * 3) });
  });
  req.storeDevice = { deviceId: proof.deviceId, ref, data }; return req.storeDevice;
}
module.exports = { registerDevice, verifyDevice };
