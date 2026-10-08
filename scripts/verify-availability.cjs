'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test, after } = require('node:test');

process.env.NODE_ENV = 'production';
process.env.RENDER_EXTERNAL_URL = 'https://zentra-store.onrender.com';
process.env.PUBLIC_BASE_URL = 'https://zentrastore.com.tr';
process.env.PUBLIC_BACKEND_ORIGIN = 'https://zentrastore.com.tr';
process.env.PUBLIC_FIREBASE_AUTH_DOMAIN = 'zentra-test.firebaseapp.com';
process.env.APP_CHECK_MODE = 'enforce';
process.env.RATE_LIMIT_STORE = 'memory';
process.env.STORE_KEY_ENCRYPTION_SECRET = crypto.randomBytes(64).toString('hex');
process.env.STORE_KEY_FINGERPRINT_SECRET = crypto.randomBytes(64).toString('hex');

const root = path.resolve(__dirname, '..');
const { STORE_CATALOG } = require('../server/core/storeCatalog');
const { DEFAULT_QUICK_LINKS, CHANNEL_LINKS_REVISION } = require('../server/core/storeLinks');
let settings;
let readMode = 'healthy';
let stockMode = 'healthy';
let stockReads = 0;
let releaseStock;
const snapshot = (id, data) => ({ id, exists: data !== undefined, data: () => structuredClone(data) });
const db = {
  collection: (name) => ({ doc: (id) => ({ id, get: async () => {
    if (name === 'storefrontSettings') {
      if (readMode === 'hanging') return new Promise(() => {});
      if (readMode === 'denied') throw Object.assign(new Error('SECRET-do-not-log'), { code: 7 });
      return snapshot(id, settings);
    }
    return snapshot(id);
  } }) }),
  getAll: async (...refs) => {
    stockReads += 1;
    if (stockMode === 'hanging') return new Promise(() => {});
    if (stockMode === 'delayed') return new Promise((resolve) => { releaseStock = () => resolve(refs.map((ref) => snapshot(ref.id, { availableCount: 99 }))); });
    if (stockMode === 'denied') throw Object.assign(new Error('SECRET-do-not-log'), { code: 7 });
    return refs.map((ref) => snapshot(ref.id, { availableCount: 8 }));
  }
};
const firebase = { enabled: true, db, admin: { firestore: { FieldValue: {} } }, auth: null, appCheck: null };
const firebasePath = require.resolve('../server/config/firebaseAdmin');
require.cache[firebasePath] = { id: firebasePath, filename: firebasePath, loaded: true, exports: { initFirebaseAdmin: () => firebase } };
const catalogService = require('../server/core/storeCatalogService');
const inventory = require('../server/core/storeInventoryService');
const service = require('../server/core/storeService');
const defaults = () => ({ channelLinksRevision: CHANNEL_LINKS_REVISION, quickLinks: DEFAULT_QUICK_LINKS, support: { telegramUsername: 'ZENTRA_STORE' }, catalog: { schemaVersion: 1, sourceVersion: STORE_CATALOG.version, products: Object.fromEntries(STORE_CATALOG.products.map((product) => [product.id, {}])) } });
function reset() {
  settings = defaults(); readMode = 'healthy'; stockMode = 'healthy'; firebase.db = db; firebase.enabled = true;
  catalogService.invalidateCatalogCache(); inventory.invalidateStockCache();
}
function safeCatalog(value) {
  assert.ok(value.products.length >= 22);
  assert.equal(value.stockVerified, false);
  assert.equal(value.stale, true);
  assert.equal(value.storefront.services.automaticDelivery, false);
  assert.equal(value.storefront.services.balancePayment, false);
  assert.equal(value.storefront.services.telegramSupport, false);
  assert.ok(value.products.every((product) => product.stock.available === 0 && product.plans.every((plan) => plan.stock.state === 'unverified')));
}

function httpFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = require('node:http').request(url, { method: options.method || 'GET', headers: options.headers }, (response) => {
      let body = '';
      response.setEncoding('utf8'); response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: { get: (key) => response.headers[key.toLowerCase()] || null }, json: async () => JSON.parse(body) }));
    });
    request.on('error', reject); request.end(options.body);
  });
}

test('installed mandatory Firestore dependency is loadable after clean deployment install', () => {
  assert.equal(typeof require('@google-cloud/firestore').Firestore, 'function');
  const lock = require('../package-lock.json');
  assert.equal(lock.packages['node_modules/tr46'].integrity, 'sha512-N3WMsuqV66lT30CrXNbEjx4GEwlow3v6rr4mCcv6prnfwhS01rkgyFdjPNBYd9br7LpXV1+Emh01fHnq2Gdgrw==');
  assert.equal(lock.packages['node_modules/@google-cloud/firestore'].optional, undefined);
});
test('real Firebase Admin initializes its Firestore client with a valid generated service account', () => {
  const result = spawnSync(process.execPath, ['-e', `
    const crypto = require('node:crypto');
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    process.env.FIREBASE_KEY = JSON.stringify({ type: 'service_account', project_id: 'zentra-sdk-test', client_email: 'sdk@zentra-sdk-test.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) });
    process.env.FIREBASE_PROJECT_ID = 'zentra-sdk-test';
    const value = require(require('node:path').join(process.cwd(),'server/config/firebaseAdmin')).initFirebaseAdmin();
    if (!value.enabled || !value.db || !value.auth) process.exit(1);
    value.db.terminate().then(() => require('firebase-admin').app().delete());
  `], { cwd: root, encoding: 'utf8', timeout: 15_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
});
test('healthy catalog loads real catalog and inventory services and reuses warm reads', async () => {
  reset(); const before = stockReads;
  const first = await service.publicCatalog(); const second = await service.publicCatalog();
  assert.equal(first.stockVerified, true); assert.equal(first.products.length, 22);
  assert.ok(first.products.some((product) => product.stock.available > 0));
  assert.deepEqual(first, second); assert.equal(stockReads - before, 1);
});
test('missing Firebase shows products without enabling orders or financial actions', async () => {
  reset(); firebase.db = null; firebase.enabled = false;
  safeCatalog(await service.publicCatalog());
});
test('Firestore permission failure degrades catalog safely and preserves last saved products', async () => {
  reset(); settings.catalog.products.titan = { name: 'Güncel ürün adı', plans: { weekly: { priceKurus: 54321 } } };
  const healthy = await service.publicCatalog();
  readMode = 'denied'; catalogService.invalidateCatalogCache();
  const failed = await service.publicCatalog(); safeCatalog(failed);
  assert.equal(failed.products.find((product) => product.id === 'titan').name, healthy.products.find((product) => product.id === 'titan').name);
  await assert.rejects(catalogService.getEffectiveCatalog({ fresh: true }), (error) => error.code === 'STORE_CATALOG_PERSISTENCE_UNAVAILABLE');
});
test('hanging settings read returns safe catalog within its bounded read deadline', async () => {
  reset(); readMode = 'hanging'; const started = performance.now();
  safeCatalog(await service.publicCatalog());
  assert.ok(performance.now() - started < 3000);
});
test('hanging stock read times out and does not prevent recovery on the next request', async () => {
  reset(); stockMode = 'hanging'; const started = performance.now();
  safeCatalog(await service.publicCatalog());
  assert.ok(performance.now() - started < 2000);
  stockMode = 'healthy'; assert.equal((await service.publicCatalog()).stockVerified, true);
});
test('stock invalidation cannot be overwritten by a previous in-flight read', async () => {
  reset(); const catalog = await catalogService.getEffectiveCatalog(); stockMode = 'delayed';
  const old = inventory.decorateCatalogWithStock(catalog);
  await new Promise((resolve) => setImmediate(resolve));
  inventory.invalidateStockCache(); stockMode = 'healthy';
  const current = await inventory.decorateCatalogWithStock(catalog); releaseStock(); await old;
  assert.deepEqual(await inventory.decorateCatalogWithStock(catalog), current);
});
test('one corrupt custom product cannot hide all valid products or remove its stored record', async () => {
  reset(); settings.catalog.products['corrupt-product'] = { custom: true, definition: {} };
  const catalog = await catalogService.getEffectiveCatalog({ includeInactive: true });
  assert.equal(catalog.products.length, 22); assert.deepEqual(catalog.invalidProductIds, ['corrupt-product']);
  assert.ok(settings.catalog.products['corrupt-product']);
});

let server;
after(() => new Promise((resolve) => { if (!server) return resolve(); server.closeAllConnections?.(); server.close(resolve); }));
test('Render host passes health checks, public catalog bypasses App Check, forged hosts are rejected', async () => {
  reset(); server = require('../server').app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Host: 'zentra-store.onrender.com' };
  assert.equal((await httpFetch(base + '/healthz', { headers })).status, 200);
  const response = await httpFetch(base + '/api/store/catalog', { headers });
  assert.equal(response.status, 200); assert.equal((await response.json()).catalog.products.length, 22);
  assert.equal((await httpFetch(base + '/api/store/account', { headers })).status, 401);
  assert.equal((await httpFetch(base + '/healthz', { headers: { Host: 'attacker.invalid' } })).status, 421);
  const home = await httpFetch(base, { headers }); assert.match(home.headers.get('content-security-policy'), /https:\/\/zentra-test.firebaseapp.com/);
});
test('all HTTP error statuses are logged with codes while successes and secrets are omitted', async () => {
  const base = `http://127.0.0.1:${server.address().port}`; const records = [];
  const original = process.stderr.write;
  process.stderr.write = function (chunk) { records.push(String(chunk)); return true; };
  try {
    const headers = { Host: 'zentra-store.onrender.com' };
    await httpFetch(base + '/healthz', { headers }); assert.equal(records.length, 0);
    const failed = await httpFetch(base + '/public/missing.js?token=SECRET', { headers });
    assert.equal(failed.status, 404);
    await httpFetch(base + '/api/store/account', { headers });
    const parsed = records.map((record) => JSON.parse(record));
    assert.deepEqual(parsed.map((row) => row.status), [404, 401]);
    assert.ok(parsed.every((row) => row.level === 'error' && row.requestId));
    assert.equal(records.join('').includes('SECRET'), false);
  } finally { process.stderr.write = original; }
});
test('browser diagnostics accept only bounded non-sensitive reports with a trusted origin', async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, origin = 'https://zentrastore.com.tr') => httpFetch(base + '/api/public/client-errors', { method: 'POST', headers: { Host: 'zentra-store.onrender.com', Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const body = { code: 'REQUEST_TIMEOUT', context: 'catalog', page: 'store', requestId: '' };
  assert.equal((await post(body)).status, 202);
  assert.equal((await post({ ...body, password: 'SECRET' })).status, 400);
  assert.equal((await post(body, 'https://attacker.invalid')).status, 403);
});
test('Express 4 async router forwards rejected handlers to error middleware', async () => {
  const express = require('express'); const app = express(); const router = require('../server/core/asyncRouter')();
  router.get('/failure', async () => { throw Object.assign(new Error('FAILURE'), { code: 'ASYNC_FAILURE' }); });
  app.use(router); app.use((error, _req, res, _next) => res.status(503).json({ code: error.code }));
  const listener = app.listen(0, '127.0.0.1'); await new Promise((resolve) => listener.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${listener.address().port}/failure`);
    assert.equal(response.status, 503); assert.equal((await response.json()).code, 'ASYNC_FAILURE');
  } finally { listener.closeAllConnections?.(); await new Promise((resolve) => listener.close(resolve)); }
});
test('public API reads skip a hanging App Check provider; protected writes still require it', async () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs'; import assert from 'node:assert/strict';
    const data = (source) => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
    const utils = data(fs.readFileSync('public/js/request-utils.js','utf8'));
    const source = fs.readFileSync('public/js/store/api.js','utf8').replace('../request-utils.js?v=zentra-20261008-v3', utils);
    globalThis.window = { setTimeout, clearTimeout, location: { origin: 'https://zentrastore.com.tr', href: 'https://zentrastore.com.tr/' }, crypto: globalThis.crypto };
    globalThis.document = { querySelector: () => null };
    let calls = 0; globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ok:true,catalog:{products:[]}}),{headers:{'Content-Type':'application/json'}}); };
    const api = await import(data(source)); api.setStoreAppCheckTokenProvider(() => new Promise(() => {}));
    const start = performance.now(); await api.storeApi('/api/store/catalog', {auth:false});
    assert.ok(performance.now()-start < 300); assert.equal(calls,1);
    await assert.rejects(api.storeApi('/api/store/orders',{body:{},timeoutMs:1500}), error => error.code==='REQUEST_TIMEOUT'); assert.equal(calls,1);
  `], { cwd: root, encoding: 'utf8', timeout: 7000 });
  assert.equal(result.status, 0, result.stderr);
});
test('first-visit API failure falls back to bundled products with all checkout channels closed', async () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs'; import assert from 'node:assert/strict';
    const data = source => 'data:text/javascript;base64,'+Buffer.from(source).toString('base64');
    let source = fs.readFileSync('public/js/store/products.js','utf8');
    source = source.replace('./social-links.js?v=zentra-20261008-v3', data(fs.readFileSync('public/js/store/social-links.js','utf8')));
    globalThis.window = { setTimeout, clearTimeout };
    globalThis.fetch = async () => new Response(fs.readFileSync('public/data/store-products.json'),{headers:{'Content-Type':'application/json'}});
    const products = await import(data(source));
    const value = await products.loadStoreCatalog(async () => { throw Object.assign(new Error('offline'),{code:'NETWORK_ERROR'}); });
    assert.equal(value.products.length,22); assert.equal(value.stockVerified,false); assert.equal(value.stale,true);
    assert.ok(Object.values(value.storefront.services).every(flag=>flag===false));
    assert.ok(value.products.every(product=>product.plans.every(plan=>plan.stock.state==='unverified')));
  `], { cwd: root, encoding: 'utf8', timeout: 7000 });
  assert.equal(result.status, 0, result.stderr);
});


test('admin directory batches profile reads and summaries project only required fields', () => {
  const result = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const profiles = [{ id:'user-one', exists:true, data:()=>({username:'bir',storeBalanceKurus:12345,storeAccountStatus:'active'}) }, { id:'user-two', exists:true, data:()=>({username:'iki',storeWallet:{balanceKurus:23456},storeAccountStatus:'purchase_blocked'}) }];
    let batchCalls=0; let selected;
    const db = {
      collection: name => ({
        doc: id => ({id,get:()=>{throw new Error('UNBATCHED_PROFILE_READ')}}),
        where:()=>({get:async()=>({docs:[]})}),
        select:(...fields)=>{selected=fields;return {get:async()=>({docs:profiles,size:2})};}
      }),
      getAll:async (...refs)=>{batchCalls++;assert.deepEqual(refs.map(ref=>ref.id),['user-one','user-two']);return profiles;}
    };
    const auth = {listUsers:async()=>({users:[{uid:'user-one'},{uid:'user-two'}]})};
    const filename = require.resolve(require('node:path').join(process.cwd(),'server/config/firebaseAdmin'));
    require.cache[filename]={id:filename,filename,loaded:true,exports:{initFirebaseAdmin:()=>({db,auth})}};
    (async()=>{
      const service=require(require('node:path').join(process.cwd(),'server/core/adminStoreService'));
      const result=await service.listStoreUsers();assert.equal(batchCalls,1);assert.deepEqual(result.users.map(user=>user.balanceKurus),[12345,23456]);
      const summary=await service.getUserDirectorySummary();assert.equal(summary.walletLiabilityKurus,35801);assert.equal(summary.purchaseBlocked,1);assert.equal(summary.active,1);
      assert.deepEqual(selected,['storeBalanceKurus','storeWallet','storeAccountStatus']);
    })().catch(error=>{console.error(error);process.exitCode=1});
  `], {cwd:root,encoding:'utf8',timeout:5000});
  assert.equal(result.status,0,result.stderr);
});


test('storefront respects saved names and descriptions instead of overriding them by ID', () => {
  const result=spawnSync(process.execPath,['--input-type=module','-e',`
    import fs from 'node:fs'; import assert from 'node:assert/strict';
    const data=source=>'data:text/javascript;base64,'+Buffer.from(source).toString('base64');
    const source=fs.readFileSync('public/js/store/products.js','utf8').replace('./social-links.js?v=zentra-20261008-v3',data(fs.readFileSync('public/js/store/social-links.js','utf8')));
    globalThis.window={setTimeout,clearTimeout};
    const raw=JSON.parse(fs.readFileSync('public/data/store-products.json','utf8'));
    for(const id of ['contra-hax','ios-dolphin']){
      const product=raw.products.find(row=>row.id===id); product.name='Güncel Zentra Ürün';product.description='Kaydedilen yeni açıklama';
    }
    const products=await import(data(source));
    const value=await products.loadStoreCatalog(async()=>({ok:true,catalog:{...raw,stockVerified:true}}));
    for(const id of ['contra-hax','ios-dolphin']){
      const product=value.products.find(row=>row.id===id);assert.equal(product.name,'Güncel Zentra Ürün');assert.equal(product.description,'Kaydedilen yeni açıklama');
    }
  `],{cwd:root,encoding:'utf8',timeout:5000});
  assert.equal(result.status,0,result.stderr);
});
