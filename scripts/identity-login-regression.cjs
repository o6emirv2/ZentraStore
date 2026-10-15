'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const { usernameKeys, usernameRegistryId, findUsernameProfiles } = require('../server/core/storeUsername');

let records = new Map(), issued = [], writes = 0, calls = [], providerStatus = 200, providerUid = '';
const accounts = new Map();
function snapshot(collection, id) {
  const path = `${collection}/${id}`;
  return { id, exists: records.has(path), data: () => records.get(path), ref: { set: async () => { writes++; } } };
}
const db = { collection: (name) => ({
  doc: (id) => ({ get: async () => snapshot(name, id) }),
  where: (field, op, values) => ({ limit: (limit) => ({ get: async () => {
    const docs = [...records].filter(([path, row]) => path.startsWith(name + '/') && (op === 'in' ? values.includes(row[field]) : row[field] === values))
      .slice(0, limit).map(([path]) => snapshot(name, path.slice(name.length + 1)));
    return { docs, size: docs.length, empty: docs.length === 0 };
  } }) })
}) };
const auth = {
  getUser: async (uid) => { if (!accounts.has(uid)) throw Object.assign(new Error('missing'), { code: 'auth/user-not-found' }); return accounts.get(uid); },
  createCustomToken: async (uid) => { issued.push(uid); return `private-token-${uid}`; }
};
function mock(name, exports) { const filename = require.resolve(name); require.cache[filename] = { id: filename, filename, loaded: true, exports }; }
mock('../server/config/firebaseAdmin', { initFirebaseAdmin: () => ({ db, auth }) });
mock('../server/config/env', { firebase: { publicConfig: { apiKey: 'test-public-key' } } });
mock('../server/core/security', Object.fromEntries(['authLoginLimiter', 'authAccountLimiter', 'resetAccountLimiter', 'passwordResetLimiter', 'strictLimiter', 'requireAuth'].map((key) => [key, (_req, _res, next) => next()])));
mock('../server/core/userSessionService', { trustedOrigin: () => true });
mock('../server/core/storeService', { readAccount: async () => ({}) });
const router = require('../server/routes/identity.routes');
let server, origin;
const originalFetch = global.fetch;
before(async () => {
  global.fetch = async (url, options) => {
    assert.match(url, /^https:\/\/identitytoolkit\.googleapis\.com\/v1\/accounts:signInWithPassword\?/);
    const input = JSON.parse(options.body); calls.push(input);
    const user = [...accounts.values()].find((account) => account.email === input.email);
    const status = providerStatus !== 200 ? providerStatus : input.password === 'valid-password' && user ? 200 : 400;
    return { ok: status === 200, status, json: async () => status === 200 ? { localId: providerUid || user.uid } : { error: { message: status === 429 ? 'TOO_MANY_ATTEMPTS_TRY_LATER' : 'INVALID_LOGIN_CREDENTIALS' } } };
  };
  const app = express(); app.use(express.json()); app.use('/api', router);
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ ok: false, error: error.code || 'INTERNAL_ERROR' }));
  server = http.createServer(app); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { global.fetch = originalFetch; await new Promise((resolve) => server.close(resolve)); });
function reset(username = 'o6emirxl', profile = {}) {
  records = new Map([['users/member', { username, ...profile }]]);
  accounts.clear(); accounts.set('member', { uid: 'member', email: 'actual@example.test', disabled: false });
  issued = []; writes = 0; calls = []; providerStatus = 200; providerUid = '';
}
async function login(identifier, password = 'valid-password') {
  const response = await originalFetch(origin + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier, password }) });
  return { status: response.status, body: await response.json() };
}
test('username login finds registry ownership when the legacy normalized field is absent', async () => {
  reset('EmirHan');
  records.set('usernameRegistry/' + usernameRegistryId('emirhan'), { uid: 'member' });
  const result = await login('EMIRHAN');
  assert.equal(result.status, 200); assert.deepEqual(issued, ['member']);
  assert.equal(calls[0].email, 'actual@example.test'); assert.equal(writes, 0);
});
test('legacy exact username login works without registry or normalized fields', async () => {
  reset('o6emirxl', { email: 'stale@example.test', storeBalanceKurus: 12345 });
  assert.equal((await login('o6emirxl')).status, 200);
  assert.equal(calls[0].email, 'actual@example.test'); assert.equal(writes, 0);
  assert.equal(records.get('users/member').storeBalanceKurus, 12345);
});
test('indexed username lookup supports Turkish and ordinary case variants', async () => {
  for (const username of ['EMIRHAN', 'İSMAİL', 'ışıklar']) {
    reset(username, { usernameLower: usernameKeys(username)[0] });
    for (const key of usernameKeys(username)) assert.equal((await login(key)).status, 200, key);
  }
});
test('stale username registry cannot authenticate a previous username', async () => {
  reset('NewName'); records.set('usernameRegistry/' + usernameRegistryId('oldname'), { uid: 'member' });
  assert.equal((await login('OldName')).status, 401); assert.equal(calls.length, 0); assert.equal(issued.length, 0);
});
test('ambiguous legacy names fail closed without provider calls or tokens', async () => {
  reset(); records.set('users/other', { username: 'o6emirxl', usernameLower: 'o6emirxl' });
  assert.equal((await login('o6emirxl')).status, 401); assert.equal(calls.length, 0); assert.equal(issued.length, 0);
});
test('wrong password, disabled identity and mismatched provider UID cannot issue tokens', async () => {
  reset(); assert.equal((await login('o6emirxl', 'wrong-password')).status, 401);
  accounts.get('member').disabled = true; assert.equal((await login('o6emirxl')).status, 401);
  accounts.get('member').disabled = false; providerUid = 'other'; assert.equal((await login('o6emirxl')).status, 401);
  assert.equal(issued.length, 0); assert.equal(writes, 0);
});
test('email sign-in keeps identity details off public responses', async () => {
  reset(); const result = await login('actual@example.test'); assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(result.body).sort(), ['customToken', 'ok']);
});
test('long valid email identifiers are passed to the identity provider without truncation', async () => {
  reset(); const email = 'x'.repeat(64) + '@' + 'a'.repeat(63) + '.' + 'b'.repeat(63) + '.test';
  accounts.get('member').email = email;
  assert.equal((await login(email)).status, 200); assert.equal(calls[0].email, email);
});
test('provider throttling and outage report retryable states instead of wrong credentials', async () => {
  reset(); providerStatus = 429; assert.equal((await login('o6emirxl')).status, 429);
  providerStatus = 503; const result = await login('o6emirxl'); assert.equal(result.status, 503); assert.equal(result.body.error, 'AUTH_UNAVAILABLE');
  assert.equal(issued.length, 0);
});
test('username validation does not silently strip interior spaces or truncate long identifiers', async () => {
  reset(); for (const value of ['o6 emirxl', 'o6emirxl' + 'x'.repeat(200), '<o6emirxl>']) assert.equal((await login(value)).status, 401);
  assert.equal(calls.length, 0);
});
test('legacy lookup can participate in an atomic username uniqueness check', async () => {
  reset(); let reads = 0;
  const profiles = await findUsernameProfiles(db, 'o6emirxl', { transaction: { get: (ref) => { reads++; return ref.get(); } } });
  assert.deepEqual(profiles.map((doc) => doc.id), ['member']); assert(reads >= 3); assert.equal(writes, 0);
});
test('username availability rejects legacy and reserved registry ownership without exposing accounts', async () => {
  reset();
  const check = async (name) => (await originalFetch(origin + '/api/auth/check-username?username=' + encodeURIComponent(name))).json();
  assert.equal((await check('o6emirxl')).available, false);
  assert.equal((await check('NewMember')).available, true);
  records.set('usernameRegistry/' + usernameRegistryId('newmember'), { uid: 'other' });
  const result = await check('NewMember'); assert.equal(result.available, false);
  assert.equal(Object.hasOwn(result, 'uid'), false); assert.equal(Object.hasOwn(result, 'email'), false); assert.equal(writes, 0);
});
test('storage outages are retryable and never misreported as wrong passwords', async () => {
  reset(); const original = db.collection;
  try {
    db.collection = () => { throw new Error('storage unavailable'); };
    const result = await login('o6emirxl'); assert.equal(result.status, 503); assert.equal(result.body.error, 'AUTH_UNAVAILABLE');
    assert.equal(issued.length, 0); assert.equal(calls.length, 0);
  } finally { db.collection = original; }
});
test('identity service outages are retryable and cannot issue custom tokens', async () => {
  reset(); const original = auth.getUser;
  try {
    auth.getUser = async () => { throw Object.assign(new Error('identity unavailable'), { code: 'auth/internal-error' }); };
    const result = await login('o6emirxl'); assert.equal(result.status, 503); assert.equal(result.body.error, 'AUTH_UNAVAILABLE');
    assert.equal(issued.length, 0);
  } finally { auth.getUser = original; }
});
