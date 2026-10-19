'use strict';
const { sessionPolicyMatches } = require('./adminSessionPolicy');
const crypto = require('node:crypto');
const env = require('../config/env');
const { initFirebaseAdmin } = require('../config/firebaseAdmin');
const { readAdminSession } = require('./adminSessionRegistry');
const HEADER = 'x-zentra-admin-proof';
const WINDOW_MS = 60_000;
function fail(code = 'ADMIN_BROWSER_PROOF_INVALID', statusCode = 401) { throw Object.assign(new Error(code), { code, statusCode }); }
function decode(value, length = 0) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) fail();
  const data = Buffer.from(value, 'base64url');
  if (data.toString('base64url') !== value || (length && data.length !== length)) fail();
  return data;
}
function publicKey(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['kty','crv','x','y'].includes(k))
    || value.kty !== 'EC' || value.crv !== 'P-256') fail();
  decode(value.x, 32); decode(value.y, 32);
  try { crypto.createPublicKey({ key: value, format: 'jwk' }); } catch (_) { fail(); }
  return { kty: 'EC', crv: 'P-256', x: value.x, y: value.y };
}
function normalizeBrowserKey(input, origin) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['keyId','publicKey'].includes(k))
    || !/^[a-f0-9-]{36}$/.test(String(input.keyId || ''))) fail();
  const normalized = env.normalizeOrigin(origin);
  if (!normalized || !env.allowedOrigins.includes(normalized) || (env.nodeEnv === 'production' && !normalized.startsWith('https://'))) fail('ADMIN_BROWSER_ORIGIN_INVALID', 403);
  return { keyId: input.keyId, origin: normalized, publicKey: publicKey(input.publicKey) };
}
function parseProof(req) {
  const raw = req.headers?.[HEADER];
  if (typeof raw !== 'string' || raw.length > 2048) fail();
  let proof;
  try { proof = JSON.parse(decode(raw).toString('utf8')); } catch (_) { fail(); }
  if (!proof || typeof proof !== 'object' || Array.isArray(proof) || Object.keys(proof).some(k => !['v','keyId','session','ts','nonce','sig'].includes(k))
    || proof.v !== 1 || !Number.isSafeInteger(proof.ts) || Math.abs(Date.now() - proof.ts) > WINDOW_MS
    || typeof proof.session !== 'string' || proof.session.length > 120 || !/^[A-Za-z0-9_-]{24}$/.test(String(proof.nonce || ''))) fail();
  return proof;
}
async function verifyProof(req, binding, session = '') {
  if (req.authSource !== 'firebase-bearer' || !req.user?.uid) fail();
  const sameOrigin = req.headers?.['sec-fetch-site'] === 'same-origin'
    && String(req.headers?.host || '').toLowerCase() === new URL(binding.origin).host.toLowerCase();
  const origin = env.normalizeOrigin(req.headers?.origin || (sameOrigin ? binding.origin : ''));
  if (origin !== binding.origin || !env.allowedOrigins.includes(origin)) fail('ADMIN_BROWSER_ORIGIN_INVALID', 403);
  const proof = parseProof(req);
  if (proof.keyId !== binding.keyId || proof.session !== session) fail();
  const bodyHash = crypto.createHash('sha256').update(JSON.stringify(req.body || {})).digest('hex');
  const message = JSON.stringify(['zentra-browser-admin-v1', req.user.uid, binding.keyId, session, origin, req.method, req.originalUrl, bodyHash, proof.ts, proof.nonce]);
  let valid = false;
  try { valid = crypto.verify('sha256', Buffer.from(message), { key: crypto.createPublicKey({ key: publicKey(binding.publicKey), format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, decode(proof.sig, 64)); } catch (_) { fail(); }
  if (!valid) fail();
  const { db } = initFirebaseAdmin(); if (!db) fail('ADMIN_SESSION_UNAVAILABLE', 503);
  const id = crypto.createHash('sha256').update(JSON.stringify([binding.keyId, session, proof.nonce])).digest('hex');
  const ref = db.collection('storeAdminBrowserNonces').doc(id);
  try {
    await db.runTransaction(async tx => {
      const prior = await tx.get(ref); if (prior.exists) fail('ADMIN_BROWSER_PROOF_REPLAY', 409);
      tx.create(ref, { uid: req.user.uid, usedAt: Date.now(), expiresAt: new Date(Date.now() + WINDOW_MS * 3) });
    });
  } catch (error) { if (String(error.code || '').startsWith('ADMIN_')) throw error; fail('ADMIN_SESSION_UNAVAILABLE', 503); }
  return binding;
}
async function verifyBrowserRegistration(req) {
  const binding = normalizeBrowserKey(req.body?.browserKey, req.headers?.origin);
  return verifyProof(req, binding);
}
async function verifyBrowserStep(req, binding) { return verifyProof(req, binding); }
async function resolveBrowserAccess(req) {
  if (!req.headers?.[HEADER]) return null;
  const proof = parseProof(req);
  if (!proof.session) fail('ADMIN_GATE_REQUIRED');
  let row;
  try { row = await readAdminSession(proof.session); } catch (_) { fail('ADMIN_SESSION_UNAVAILABLE', 503); }
  if (!row || row.revokedAt || row.expiresAt <= Date.now() || row.uid !== req.user?.uid
    || row.email !== String(req.user?.email || '').trim().toLowerCase() || !row.browserKey || !(await sessionPolicyMatches(row))) fail('ADMIN_GATE_ACCESS_INVALID');
  await verifyProof(req, row.browserKey, proof.session);
  return { mode: 'browser-key', uid: row.uid, email: row.email, expiresAt: row.expiresAt, gateSession: proof.session };
}
module.exports = { normalizeBrowserKey, verifyBrowserRegistration, verifyBrowserStep, resolveBrowserAccess };
