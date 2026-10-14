'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { browserModule } = require('./helpers/browser-module.cjs');
async function scenario(provider, fetcher, check) {
  const prior = { window: global.window, document: global.document, fetch: global.fetch }; let calls = 0;
  global.window = { location: { href: 'https://store.zentra.invalid/', origin: 'https://store.zentra.invalid' }, setTimeout, clearTimeout,
    __ZENTRA_RUNTIME__: { version: 78, apiBase: 'https://store.zentra.invalid' } };
  global.document = { querySelector: () => null };
  global.fetch = async (...args) => { calls++; return fetcher(...args); };
  try { const module = await browserModule('public/js/store/api.js'); module.setStoreTokenProvider(provider); await check(module, () => calls); }
  finally { Object.assign(global, prior); }
}
const request = module => module.storeApi('/api/store/balance-codes/redeem', { method: 'POST', body: { code: 'TEST200' } });
test('a revoked SDK identity cannot fall back to a cookie or submit a financial request', async () => scenario(
  async () => { throw Object.assign(new Error('revoked identity'), { code: 'auth/user-token-expired' }); },
  async () => { throw new Error('request must not be sent'); },
  async (module, calls) => { await assert.rejects(request(module), { code: 'AUTH_INVALID', mutationNotSent: true }); assert.equal(calls(), 0); }
));
test('provider connection failure before sending is distinct from a lost financial response', async () => scenario(
  async () => { throw Object.assign(new Error('provider unavailable'), { code: 'auth/network-request-failed' }); },
  async () => { throw new Error('request must not be sent'); },
  async (module, calls) => { await assert.rejects(request(module), { code: 'NETWORK_ERROR', mutationNotSent: true }); assert.equal(calls(), 0); }
));
test('loss after sending retains an uncertain result and does not automatically send a second write', async () => scenario(
  async () => 'verified-fixture-token', async () => { throw new TypeError('lost response'); },
  async (module, calls) => { await assert.rejects(request(module), { code: 'NETWORK_ERROR', mutationNotSent: false }); assert.equal(calls(), 1); }
));
