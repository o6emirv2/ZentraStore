'use strict';

const crypto = require('crypto');
const { purposeKey } = require('./adminAccessService');
const { initFirebaseAdmin } = require('../config/firebaseAdmin');
const { staffHasPermission } = require('./adminStoreService');
const { verifyFirebasePassword } = require('./adminGateService');
const TTL_MS = 90_000;
const TARGETS = [
  ['POST', /^\/api\/admin\/store\/products(?:\/bulk)?$/, 'store.catalog.write'],
  ['PATCH', /^\/api\/admin\/store\/products\/[^/?#]+$/, 'store.catalog.write'],
  ['PATCH', /^\/api\/admin\/store\/orders\/[^/?#]+$/, 'store.orders.write'],
  ['PUT', /^\/api\/admin\/store\/abuse\/users\/[^/?#]+$/, 'store.users.write'],
  ['PATCH', /^\/api\/admin\/store\/users\/[^/?#]+$/, 'store.users.write'],
  ['POST', /^\/api\/admin\/store\/wallet\/adjust$/, 'store.wallet.write'],
  ['POST', /^\/api\/admin\/store\/affiliate-commissions\/[^/?#]+\/release$/, 'store.wallet.write'],
  ['PUT', /^\/api\/admin\/store\/affiliates\/[^/?#]+$/, 'store.wallet.write'],
  ['PUT', /^\/api\/admin\/store\/balance-codes\/[^/?#]+$/, 'store.wallet.write'],
  ['PUT', /^\/api\/admin\/store\/promotions\/[^/?#]+$/, 'store.content.write'],
  ['PATCH', /^\/api\/admin\/store\/content$/, 'store.content.write'],
  ['PUT', /^\/api\/admin\/store\/links$/, 'store.content.write'],
  ['PUT', /^\/api\/admin\/store\/staff\/[^/?#]+$/, 'store.staff.write'],
  ['POST', /^\/api\/admin\/store\/inventory\/(?:import|migrate-shared-pool|rotate-encryption)$/, 'store.inventory.write'],
  ['POST', /^\/api\/admin\/store\/inventory\/[^/?#]+\/revoke$/, 'store.inventory.write'],
  ['POST', /^\/api\/admin\/store\/inventory\/[^/?#]+\/reveal$/, 'store.inventory.reveal']
];
function failure(code, statusCode = 409) { throw Object.assign(new Error(code), { code, statusCode }); }
function permissionFor(method, path) { return TARGETS.find(([verb, pattern]) => verb === method && pattern.test(path))?.[2] || ''; }
function digest(body) { return crypto.createHash('sha256').update(JSON.stringify(body ?? {})).digest('hex'); }
function signature(value) { return crypto.createHmac('sha256', purposeKey('admin-action-v1')).update(value).digest('base64url'); }

async function createAdminAction(req, input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['method', 'path', 'bodyHash', 'password'].includes(key))
    || typeof input.path !== 'string' || input.path.length > 240 || typeof input.method !== 'string'
    || !/^[a-f0-9]{64}$/.test(String(input.bodyHash))) failure('ADMIN_ACTION_INPUT_INVALID', 400);
  const permission = permissionFor(input.method, input.path);
  if (!permission || !staffHasPermission(req.adminPolicy, permission)) failure('ADMIN_PERMISSION_REQUIRED', 403);
  if (permission === 'store.staff.write' && req.adminPolicy?.systemOwner !== true) failure('ADMIN_OWNER_REQUIRED', 403);
  if (!req.adminAccess?.gateSession || !req.user?.uid || !req.adminReauth?.ok) failure('ADMIN_REAUTH_REQUIRED', 401);
  if (typeof input.password !== 'string' || input.password.length < 6 || input.password.length > 4096) failure('ADMIN_REAUTH_REQUIRED', 401);
  await verifyFirebasePassword({ uid: req.user.uid, email: String(req.user.email || '').toLowerCase() }, input.password);
  const payload = { v: 1, uid: req.user.uid, session: req.adminAccess.gateSession,
    method: input.method, path: input.path, bodyHash: input.bodyHash, authTime: req.adminReauth.authTime,
    nonce: crypto.randomBytes(24).toString('base64url'), expiresAt: Date.now() + TTL_MS };
  const value = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return { token: `${value}.${signature(value)}`, expiresAt: payload.expiresAt };
}

async function consumeAdminAction(req) {
  const token = req.headers?.['x-admin-action'];
  if (typeof token !== 'string' || token.length > 2048) failure('ADMIN_ACTION_REQUIRED', 401);
  const parts = token.split('.');
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) failure('ADMIN_ACTION_INVALID', 401);
  const expected = Buffer.from(signature(parts[0])); const actual = Buffer.from(parts[1]);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) failure('ADMIN_ACTION_INVALID', 401);
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch (_) { failure('ADMIN_ACTION_INVALID', 401); }
  const now = Date.now();
  if (payload.v !== 1 || !Number.isSafeInteger(payload.expiresAt) || payload.expiresAt < now || payload.expiresAt > now + TTL_MS
    || !/^[A-Za-z0-9_-]{32}$/.test(String(payload.nonce))) failure('ADMIN_ACTION_EXPIRED', 401);
  const path = String(req.originalUrl || '').split('?')[0];
  if (payload.uid !== req.user?.uid || payload.session !== req.adminAccess?.gateSession
    || payload.authTime !== req.adminReauth?.authTime || payload.method !== req.method || payload.path !== path
    || payload.bodyHash !== digest(req.body)) failure('ADMIN_ACTION_MISMATCH', 409);
  const { db } = initFirebaseAdmin();
  if (!db) failure('ADMIN_ACTION_UNAVAILABLE', 503);
  const id = crypto.createHash('sha256').update(payload.nonce).digest('hex');
  const ref = db.collection('storeAdminActionReceipts').doc(id);
  await db.runTransaction(async (tx) => {
    const previous = await tx.get(ref);
    if (previous.exists) failure('ADMIN_ACTION_ALREADY_USED', 409);
    tx.create(ref, { uid: payload.uid, method: payload.method, path: payload.path, usedAt: now,
      expiresAt: new Date(now + 86_400_000), requestId: String(req.requestId || '').slice(0, 180) });
  });
  return { verified: true, id };
}

async function requireAdminAction(req, _res, next) {
  try { req.adminAction = await consumeAdminAction(req); next(); } catch (error) { next(error); }
}

module.exports = { createAdminAction, consumeAdminAction, requireAdminAction, permissionFor, digest };
