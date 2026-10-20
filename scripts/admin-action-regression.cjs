'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { memoryFirestore, mockModule } = require('./helpers/memory-firestore.cjs');
process.env.NODE_ENV = 'development';
process.env.ADMIN_TRANSIENT_STORE = 'firestore';
process.env.PUBLIC_FIREBASE_API_KEY = 'controlled-action-key';
process.env.ADMIN_GATE_SIGNING_SECRET = crypto.randomBytes(64).toString('hex');
const configuration = require('../server/config/env');
mockModule('../../server/config/env', { ...configuration, configurationReport: () => ({ capabilities: { identity: true } }) });
const db = memoryFirestore();
mockModule('../../server/config/firebaseAdmin', { initFirebaseAdmin: () => ({ db }) });
const action = require('../server/core/adminActionService');
const path = '/api/admin/store/wallet/adjust';
const body = { uid: 'customer', amountKurus: 20000, type: 'CREDIT', reason: 'Test nedeni', idempotencyKey: 'action-test-00001' };
function request(patch = {}) {
  return { user: { uid: 'admin-1', email: 'admin-1@example.test' }, adminPolicy: { permissions: ['store.wallet.write'] },
    adminAccess: { gateSession: 'signed-session-1' }, adminReauth: { ok: true, authTime: 100 },
    method: 'POST', originalUrl: path, body: structuredClone(body), headers: {}, ...patch };
}
async function proof(req = request()) { return (await action.createAdminAction(req, { method: req.method, path: req.originalUrl, bodyHash: action.digest(req.body), password: 'controlled-password' })).token; }
test('action proof binds actor, session, auth time, method, path and exact financial body', async () => {
  const token = await proof();
  const variants = [ { user: { uid: 'other' } }, { adminAccess: { gateSession: 'other' } }, { adminReauth: { ok: true, authTime: 101 } },
    { method: 'PUT' }, { originalUrl: '/api/admin/store/wallet/adjust/other' }, { body: { ...body, amountKurus: 200000 } }, { body: { ...body, uid: 'other-customer' } } ];
  for (const patch of variants) await assert.rejects(action.consumeAdminAction(request({ ...patch, headers: { 'x-admin-action': token } })), { code: 'ADMIN_ACTION_MISMATCH' });
  assert.equal(db.records.size, 0);
  assert.equal((await action.consumeAdminAction(request({ headers: { 'x-admin-action': token } }))).verified, true);
});
test('parallel use and module reload keep a proof single-use in durable storage', async () => {
  const token = await proof(), req = request({ headers: { 'x-admin-action': token } });
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => action.consumeAdminAction(req)));
  assert.equal(results.filter((row) => row.status === 'fulfilled').length, 1);
  assert(results.filter((row) => row.status === 'rejected').every((row) => row.reason.code === 'ADMIN_ACTION_ALREADY_USED'));
  delete require.cache[require.resolve('../server/core/adminActionService')];
  await assert.rejects(require('../server/core/adminActionService').consumeAdminAction(req), { code: 'ADMIN_ACTION_ALREADY_USED' });
  assert(!JSON.stringify([...db.records.values()]).includes(body.reason));
});
test('missing, tampered and expired proofs fail without creating an action receipt', async () => {
  await assert.rejects(action.consumeAdminAction(request()), { code: 'ADMIN_ACTION_REQUIRED' });
  const token = await proof(); await assert.rejects(action.consumeAdminAction(request({ headers: { 'x-admin-action': token.slice(0, -4) + 'xxxx' } })), { code: 'ADMIN_ACTION_INVALID' });
  const now = Date.now; try {
    Date.now = () => now() + 100_000;
    await assert.rejects(action.consumeAdminAction(request({ headers: { 'x-admin-action': token } })), { code: 'ADMIN_ACTION_EXPIRED' });
  } finally { Date.now = now; }
});
test('proof issuing rejects unsupported targets, wrong permission, non-owner roles and unknown fields', async () => {
  for (const [req, input, code] of [
    [request({ adminPolicy: { permissions: ['store.content.write'] } }), { method: 'POST', path, bodyHash: action.digest(body) }, 'ADMIN_PERMISSION_REQUIRED'],
    [request(), { method: 'POST', path: '//untrusted.test', bodyHash: action.digest(body) }, 'ADMIN_PERMISSION_REQUIRED'],
    [request({ adminPolicy: { permissions: ['store.staff.write'] } }), { method: 'PUT', path: '/api/admin/store/staff/other', bodyHash: action.digest(body) }, 'ADMIN_OWNER_REQUIRED'],
    [request(), { method: 'POST', path, bodyHash: action.digest(body), arbitrary: true }, 'ADMIN_ACTION_INPUT_INVALID'],
    [request({ adminReauth: { ok: false } }), { method: 'POST', path, bodyHash: action.digest(body) }, 'ADMIN_REAUTH_REQUIRED']
  ]) await assert.rejects(action.createAdminAction(req, { ...input, password: 'controlled-password' }), { code });
});
test('a failed receipt commit cannot authorize a mutation and permits retry with the same unused proof', async () => {
  const token = await proof(), req = request({ headers: { 'x-admin-action': token } });
  db.setFailure(true); await assert.rejects(action.consumeAdminAction(req), { code: 'CONTROLLED_COMMIT_FAILURE' });
  db.setFailure(false); assert.equal((await action.consumeAdminAction(req)).verified, true);
});

const originalFetch = global.fetch; let passwordChecks = 0, providerMismatch = false;
before(() => { global.fetch = async (url, options) => {
  assert.match(url, /^https:\/\/identitytoolkit\.googleapis\.com\/v1\/accounts:signInWithPassword/);
  passwordChecks++; const input = JSON.parse(options.body), ok = input.password === 'controlled-password';
  return { ok, json: async () => ok ? { localId: providerMismatch ? 'other-uid' : 'admin-1', email: input.email } : { error: { message: 'INVALID_CREDENTIALS' } } };
} });
after(() => { global.fetch = originalFetch; });
test('a fresh bearer alone cannot mint another target approval without the current password', async () => {
  const req = request(), base = { method: 'POST', path, bodyHash: action.digest(body) }, before = passwordChecks;
  await assert.rejects(action.createAdminAction(req, base), { code: 'ADMIN_REAUTH_REQUIRED' });
  assert.equal(passwordChecks, before);
  await assert.rejects(action.createAdminAction(req, { ...base, password: 'wrong-password' }), { code: 'ADMIN_FIREBASE_PASSWORD_INVALID' });
  providerMismatch = true;
  try { await assert.rejects(action.createAdminAction(req, { ...base, password: 'controlled-password' }), { code: 'ADMIN_FIREBASE_PASSWORD_INVALID' }); }
  finally { providerMismatch = false; }
  const issued = await action.createAdminAction(req, { ...base, password: 'controlled-password' });
  const payload = JSON.parse(Buffer.from(issued.token.split('.')[0], 'base64url').toString());
  assert.equal(payload.password, undefined); assert(!JSON.stringify([...db.records.values()]).includes('controlled-password'));
});
