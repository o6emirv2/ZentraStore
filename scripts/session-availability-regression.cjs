'use strict';
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { applicationFixture } = require('./helpers/application-fixture.cjs');
let fixture, cookie;
before(async () => {
  fixture = await applicationFixture();
  const session = await fixture.request('/api/auth/session', { method: 'POST', body: { idToken: fixture.idToken('member') } });
  assert.equal(session.status, 200);
  cookie = session.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
});
after(async () => { await fixture.close(); });
const unavailable = () => { throw Object.assign(new Error('upstream unavailable'), { code: 'app/network-timeout' }); };
test('cookie session read reports provider unavailability without destroying the valid cookie', async () => {
  const saved = fixture.auth.verifySessionCookie; fixture.auth.verifySessionCookie = unavailable;
  try {
    const result = await fixture.request('/api/auth/session', { cookie });
    assert.equal(result.status, 503); assert.equal(result.body.error, 'AUTH_UNAVAILABLE'); assert.equal(result.headers.get('set-cookie'), null);
  } finally { fixture.auth.verifySessionCookie = saved; }
  assert.equal((await fixture.request('/api/auth/session', { cookie })).body.authenticated, true);
});
test('protected cookie account read returns 503 during IAM failure instead of claiming a revoked identity', async () => {
  const saved = fixture.auth.verifySessionCookie;
  fixture.auth.verifySessionCookie = () => { throw Object.assign(new Error('IAM unavailable'), { code: 'auth/insufficient-permission' }); };
  try {
    const result = await fixture.request('/api/store/account', { cookie });
    assert.equal(result.status, 503); assert.equal(result.body.error, 'AUTH_UNAVAILABLE');
  } finally { fixture.auth.verifySessionCookie = saved; }
});
test('session exchange retains an existing cookie when the provider cannot create its replacement', async () => {
  const saved = fixture.auth.createSessionCookie; fixture.auth.createSessionCookie = unavailable;
  try {
    const result = await fixture.request('/api/auth/session', { cookie, method: 'POST', body: { idToken: fixture.idToken('member') } });
    assert.equal(result.status, 503); assert.equal(result.body.error, 'AUTH_UNAVAILABLE'); assert.equal(result.headers.get('set-cookie'), null);
  } finally { fixture.auth.createSessionCookie = saved; }
});
test('session exchange classifies token verification network failure as unavailable', async () => {
  const token = fixture.idToken('member'), saved = fixture.auth.verifyIdToken; fixture.auth.verifyIdToken = unavailable;
  try {
    const result = await fixture.request('/api/auth/session', { cookie, method: 'POST', body: { idToken: token } });
    assert.equal(result.status, 503); assert.equal(result.headers.get('set-cookie'), null);
  } finally { fixture.auth.verifyIdToken = saved; }
});
test('an actually revoked cookie still clears and cannot authenticate', async () => {
  const saved = fixture.auth.verifySessionCookie;
  fixture.auth.verifySessionCookie = async () => { throw Object.assign(new Error('revoked'), { code: 'auth/session-cookie-revoked' }); };
  try {
    const result = await fixture.request('/api/auth/session', { cookie });
    assert.equal(result.status, 200); assert.equal(result.body.authenticated, false); assert.match(result.headers.get('set-cookie'), /Max-Age=0/);
  } finally { fixture.auth.verifySessionCookie = saved; }
});
