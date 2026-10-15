'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { browserModule } = require('./helpers/browser-module.cjs');
async function scenario(provider, fetcher, check, runtime = { version: 78, apiBase: 'https://store.zentra.invalid', accountSecurity: { required: true, deviceProofVersion: 1 }, clientCompatibility: { accountSecurity: 2 } }) {
  const prior = { window: global.window, document: global.document, fetch: global.fetch }; let calls = 0;
  global.window = { location: { href: 'https://store.zentra.invalid/', origin: 'https://store.zentra.invalid' }, setTimeout, clearTimeout,
    __ZENTRA_RUNTIME__: runtime };
  global.document = { querySelector: () => null };
  global.fetch = async (...args) => { calls++; return fetcher(...args); };
  try { const module = await browserModule('public/js/store/api.js', { 'export async function storeDeviceHeaders({ url, method, body, headers, signal }) {': 'export async function storeDeviceHeaders({ url, method, body, headers, signal }) { globalThis.__proofCalls = (globalThis.__proofCalls || 0) + 1; return {}; ' }); module.setStoreTokenProvider(provider); await check(module, () => calls); }
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
test('an older runtime cannot silently skip device verification for signup or financial writes',async()=>{
 await scenario(async()=> 'token',async()=>{throw new Error('must not send');},async(module,calls)=>{
  await assert.rejects(module.storeApi('/api/store/security/preflight',{method:'POST',auth:false,body:{}}),{code:'CLIENT_SECURITY_UPDATE_REQUIRED',mutationNotSent:true});
  await assert.rejects(request(module),{code:'CLIENT_SECURITY_UPDATE_REQUIRED',mutationNotSent:true});assert.equal(calls(),0);
 },{version:78,apiBase:'https://store.zentra.invalid'});
});
test('a confirmed exemption is bound to its token owner and is cleared on account change',async()=>{
 const prior=global.__proofCalls;global.__proofCalls=0;
 try {await scenario(async()=> 'owner-token',async()=>new Response(JSON.stringify({ok:true}),{headers:{'content-type':'application/json'}}),async(module,calls)=>{
  module.setStoreTokenProvider(async()=> 'owner-token','owneruid');module.confirmStoreSecurityExemption({uid:'another-user',exempt:true});
  await request(module);assert.equal(global.__proofCalls,1);
  module.confirmStoreSecurityExemption({uid:'owneruid',exempt:true});await request(module);assert.equal(global.__proofCalls,1);
  module.setStoreTokenProvider(async()=> 'member-token','member');await request(module);assert.equal(global.__proofCalls,2);assert.equal(calls(),3);
 });}finally{if(prior===undefined)delete global.__proofCalls;else global.__proofCalls=prior;}
});
