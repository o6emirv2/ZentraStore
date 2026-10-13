'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mockModule, memoryFirestore } = require('./helpers/memory-firestore.cjs');
process.env.NODE_ENV = 'development'; process.env.RATE_LIMIT_STORE = 'memory';
let cookieReads = 0, revokedChecks = [], tokenUid = 'bearer-user';
const db = memoryFirestore();
mockModule('../../server/config/firebaseAdmin', { initFirebaseAdmin: () => ({ db, auth: { verifyIdToken: async (token, revoked) => {
  revokedChecks.push(revoked); if (token !== 'valid.token') throw new Error('revoked or invalid token');
  return { uid: tokenUid, email: 'bearer@example.test', email_verified: true, auth_time: Math.floor(Date.now() / 1000), firebase: { sign_in_provider: 'password' } };
} } }) });
mockModule('../../server/core/userSessionService', { verifyUserSession: async () => { cookieReads++; return { uid: 'cookie-user' }; }, trustedOrigin: (req) => req.headers.origin === 'https://store.example.test' });
const security = require('../server/core/security');
async function verify(headers = {}, method = 'GET') {
  const req = { headers, method }, res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
  let allowed = false; await security.requireAuth(req, res, () => { allowed = true; }); return { req, res, allowed };
}
test('an explicit invalid bearer cannot silently authenticate using a different cookie account', async () => {
  cookieReads = 0;
  for (const authorization of ['Bearer revoked.token', 'Basic invalid', '', 'Bearer a b', ['Bearer valid.token'], 'Bearer ' + 'a'.repeat(20000)]) {
    const result = await verify({ authorization, origin: 'https://store.example.test' }, 'POST');
    assert.equal(result.allowed, false); assert.equal(result.res.statusCode, 401);
  }
  assert.equal(cookieReads, 0);
});
test('valid bearer authentication checks revocation and establishes only that identity', async () => {
  revokedChecks = []; const result = await verify({ authorization: 'Bearer valid.token' }, 'POST');
  assert.equal(result.allowed, true); assert.equal(result.req.user.uid, 'bearer-user'); assert.equal(result.req.authSource, 'firebase-bearer');
  assert.deepEqual(revokedChecks, [true]);
});
test('verified but unsafe custom identities cannot be normalized into another profile or nested path', async () => {
  try {
    for (const value of [' member', 'member ', 'member/child/key', '<member>', '..', '.', 'x'.repeat(129), 123]) {
      tokenUid = value; assert.equal((await verify({ authorization: 'Bearer valid.token' })).res.statusCode, 401);
    }
  } finally { tokenUid = 'bearer-user'; }
});
test('cookie mutations require the trusted origin while safe cookie reads remain available', async () => {
  assert.equal((await verify({}, 'GET')).req.user.uid, 'cookie-user');
  assert.equal((await verify({ origin: 'https://attacker.example.test' }, 'POST')).res.statusCode, 403);
  assert.equal((await verify({ origin: 'https://store.example.test' }, 'PATCH')).allowed, true);
});
test('a revoked staff role is rejected on the next request despite an already open admin screen', async () => {
  db.records.set('adminUsers/bearer-user', { email: 'bearer@example.test', role: 'finance', active: true });
  const first = await verify({ authorization: 'Bearer valid.token' }); let permitted = false;
  await security.requireAdmin(first.req, first.res, () => { permitted = true; }); assert(permitted);
  assert(first.req.adminPolicy.permissions.includes('store.wallet.write'));
  db.records.get('adminUsers/bearer-user').active = false;
  const next = await verify({ authorization: 'Bearer valid.token' }); permitted = false;
  await security.requireAdmin(next.req, next.res, () => { permitted = true; }); assert.equal(permitted, false); assert.equal(next.res.statusCode, 403);
});
test('recent authentication cannot be substituted with cookie, stale, future or unsupported provider claims', () => {
  const now = Math.floor(Date.now() / 1000);
  for (const patch of [{ authSource: 'secure-cookie' }, { user: { auth_time: now - 1000 } }, { user: { auth_time: now + 1000 } },
    { user: { auth_time: now, firebase: { sign_in_provider: 'anonymous' } } }]) {
    const req = { authSource: 'firebase-bearer', user: { auth_time: now, firebase: { sign_in_provider: 'password' } }, ...patch };
    let allowed = false; const res = { status: () => res, json: () => {} }; security.requireRecentUserAuth(req, res, () => { allowed = true; }); assert.equal(allowed, false);
  }
});
test('profile initialization preserves a legacy nested wallet and existing primary financial value', async () => {
  const express = require('express'), app = express(); app.use(express.json());
  app.use('/api', require('../server/routes/identity.routes'));
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ error: error.code }));
  const server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve));
  try {
    const user = { username: 'legacyname', storeWallet: { balanceKurus: 12345 } }; db.records.set('users/bearer-user', user);
    const body = { username: 'legacyname', firstName: 'Deneme', lastName: 'Kullanıcı', birthDate: '2000-01-01' };
    const send = () => fetch(`http://127.0.0.1:${server.address().port}/api/profile/update`, { method: 'POST', headers: { Authorization: 'Bearer valid.token', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const first = await send(); assert.equal(first.status, 200); assert.equal(db.records.get('users/bearer-user').storeBalanceKurus, 12345);
    db.records.get('users/bearer-user').storeBalanceKurus = 67890;
    assert.equal((await send()).status, 200); assert.equal(db.records.get('users/bearer-user').storeBalanceKurus, 67890);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
