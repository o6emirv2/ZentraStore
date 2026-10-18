'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const url = (source) => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const utils = url(fs.readFileSync(path.join(__dirname, '../public/js/request-utils.js'), 'utf8'));
const source = fs.readFileSync(path.join(__dirname, '../admin/admin-core.js'), 'utf8').replace("'../public/js/request-utils.js?v=zentra-ui-v81r1'", JSON.stringify(utils));
const modulePromise = import(url(source));
async function scenario(callback, request = ['/api/admin/store/wallet/adjust', { method: 'POST', body: { uid: 'customer', amountKurus: 20000 } }]) {
  const original = { fetch: global.fetch, window: global.window }; let uid = 'admin-a'; const calls = [], events = [];
  global.window = { location: { href: 'https://store.example.test/admin/admin.html', origin: 'https://store.example.test' },
    dispatchEvent: (event) => events.push(event.type), setTimeout, clearTimeout,
    ZENTRA_ADMIN_AUTH: { currentUser: () => ({ uid }), activeSession: () => ({ uid }), token: async () => 'verified-token',
      consumeActionPassword: () => 'controlled-password', appCheckToken: async () => 'appcheck-token', apiUrl: (value) => 'https://store.example.test' + value } };
  global.fetch = async (target, options) => {
    calls.push({ target, options }); return callback({ target, options, calls, changeIdentity: () => { uid = 'admin-b'; } });
  };
  try { return await (await modulePromise).adminFetch(...request); }
  finally { global.fetch = original.fetch; global.window = original.window; scenario.last = { calls, events }; }
}
const json = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
test('admin client requests one content-bound proof before a mutation and carries its header', async () => {
  const result = await scenario(({ target, options, calls }) => {
    if (target.endsWith('/action-proof')) {
      const input = JSON.parse(options.body); assert.equal(input.method, 'POST'); assert.equal(input.path, '/api/admin/store/wallet/adjust');
      assert.equal(input.bodyHash, crypto.createHash('sha256').update(JSON.stringify({ uid: 'customer', amountKurus: 20000 })).digest('hex'));
      return json({ ok: true, proof: { token: 'controlled-proof' } });
    }
    assert.equal(calls.length, 2); assert.equal(options.headers.get('X-Admin-Action'), 'controlled-proof'); return json({ ok: true, adjustment: {} });
  });
  assert.equal(result.ok, true); assert.equal(scenario.last.calls.length, 2);
});
test('proof rejection invalidates the admin screen and never submits the protected mutation', async () => {
  await assert.rejects(scenario(() => json({ ok: false, error: { code: 'ADMIN_GATE_REQUIRED' }, requestId: 'controlled-request' }, 403)), { code: 'ADMIN_GATE_REQUIRED', requestId: 'controlled-request', mutationNotSent: true });
  assert.equal(scenario.last.calls.length, 1); assert.deepEqual(scenario.last.events, ['zentra:admin-session-invalid']);
});
test('identity changes while a proof is pending stop the mutation', async () => {
  await assert.rejects(scenario(({ changeIdentity }) => { changeIdentity(); return json({ ok: true, proof: { token: 'controlled-proof' } }); }), { code: 'ADMIN_ACTIVE_SESSION_MISMATCH' });
  assert.equal(scenario.last.calls.length, 1);
});
test('identity changes after a committed response prevent another account from rendering it', async () => {
  await assert.rejects(scenario(({ target, changeIdentity }) => {
    if (target.endsWith('/action-proof')) return json({ ok: true, proof: { token: 'controlled-proof' } });
    changeIdentity(); return json({ ok: true, sensitiveResult: 'previous-user-only' });
  }), { code: 'ADMIN_ACTIVE_SESSION_MISMATCH' }); assert.equal(scenario.last.calls.length, 2);
});
test('a lost mutation response never produces an automatic second write', async () => {
  await assert.rejects(scenario(({ target }) => {
    if (target.endsWith('/action-proof')) return json({ ok: true, proof: { token: 'controlled-proof' } });
    throw new TypeError('controlled network loss');
  }), { code: 'NETWORK_ERROR' }); assert.equal(scenario.last.calls.length, 2);
});
test('a failed proof request is not reported as an uncertain financial write', async () => {
  const { isUncertainMutationError } = await import(utils);
  let failure;
  try { await scenario(() => { throw new TypeError('controlled approval network error'); }); } catch (error) { failure = error; }
  assert.equal(failure.code, 'NETWORK_ERROR'); assert.equal(failure.mutationNotSent, true); assert.equal(isUncertainMutationError(failure), false);
  assert.equal(scenario.last.calls.length, 1);
});
test('same-origin private reads carry the current SDK identity instead of relying on a different cookie', async () => {
  await scenario(({ options }) => {
    assert.equal(options.headers.get('Authorization'), 'Bearer verified-token');
    assert.equal(options.redirect, 'error'); return json({ ok: true });
  }, ['/api/admin/store/balance-codes', {}]);
  assert.equal(scenario.last.calls.length, 1);
});
test('token failures stop same-origin reads before any cookie-authorized request is sent', async () => {
  const previous = global.window, fetch = global.fetch; let calls = 0;
  global.window = { location: { href: 'https://store.example.test/admin/', origin: 'https://store.example.test' },
    ZENTRA_ADMIN_AUTH: { currentUser: () => ({ uid: 'sdk-user' }), apiUrl: path => 'https://store.example.test' + path,
      token: async () => { throw Object.assign(new Error('provider rejected identity'), { code: 'AUTH_INVALID' }); } } };
  global.fetch = async () => { calls++; return json({ ok: true }); };
  try { await assert.rejects((await modulePromise).adminFetch('/api/admin/store/balance-codes'), { code: 'AUTH_INVALID', mutationNotSent: true }); assert.equal(calls, 0); }
  finally { global.window = previous; global.fetch = fetch; }
});
