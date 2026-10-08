'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { test, after } = require('node:test');

process.env.NODE_ENV = 'development';
process.env.RATE_LIMIT_STORE = 'memory';
process.env.APP_CHECK_MODE = 'monitor';
process.env.PUBLIC_BACKEND_ORIGIN = 'http://127.0.0.1';
process.env.PUBLIC_BASE_URL = 'http://127.0.0.1';
process.env.ADMIN_UIDS = 'owner-uid';
process.env.ADMIN_EMAILS = 'owner@zentra.test';
process.env.STORE_KEY_ENCRYPTION_SECRET = crypto.randomBytes(64).toString('hex');
process.env.STORE_KEY_FINGERPRINT_SECRET = crypto.randomBytes(64).toString('hex');
process.env.ADMIN_GATE_SIGNING_SECRET = crypto.randomBytes(64).toString('hex');

const clone = (value) => value === undefined ? undefined : structuredClone(value);
let sequence = 0;
let beforeTransaction = null;
class MemoryStore {
  constructor() { this.rows = new Map(); this.tail = Promise.resolve(); }
  collection(name) { return { doc: (id = `record-${++sequence}`) => this.ref(`${name}/${id}`) }; }
  ref(location) {
    return { path: location, id: location.split('/').at(-1), get: async () => this.snapshot(location), set: async (data, options) => this.write(location, data, options) };
  }
  snapshot(location) { const data = clone(this.rows.get(location)); return { exists: data !== undefined, id: location.split('/').at(-1), data: () => clone(data) }; }
  write(location, data, options) {
    const current = this.rows.get(location) || {};
    const value = clone(data);
    for (const [key, entry] of Object.entries(value)) if (entry?.__increment !== undefined) value[key] = Number(current[key] || 0) + entry.__increment;
    this.rows.set(location, options?.merge ? { ...current, ...value } : value);
  }
  async runTransaction(callback) {
    const pending = this.tail.then(async () => {
      if (beforeTransaction) { const action = beforeTransaction; beforeTransaction = null; action(); }
      const writes = [];
      const transaction = {
        get: async (ref) => this.snapshot(ref.path),
        set: (ref, data, options) => writes.push({ ref, data, options }),
        create: (ref, data) => {
          if (this.rows.has(ref.path) || writes.some((write) => write.ref.path === ref.path)) throw new Error('DUPLICATE_CREATE');
          writes.push({ ref, data });
        },
        update: (ref, data) => writes.push({ ref, data, options: { merge: true } })
      };
      const result = await callback(transaction);
      for (const write of writes) this.write(write.ref.path, write.data, write.options);
      return result;
    });
    this.tail = pending.catch(() => {});
    return pending;
  }
  reset() { this.rows.clear(); beforeTransaction = null; }
}
const db = new MemoryStore();
const principal = { uid: 'customer-uid', email: 'customer@zentra.test', auth_time: Math.floor(Date.now() / 1000), firebase: { sign_in_provider: 'password' } };
const auth = {
  verifyIdToken: async (token) => { if (token !== 'valid-customer-token') throw new Error('INVALID_TOKEN'); return { ...principal }; },
  verifySessionCookie: async (token) => { if (token !== 'valid-cookie') throw new Error('INVALID_COOKIE'); return { ...principal }; },
  getUser: async (uid) => ({ uid, email: uid === 'customer-uid' ? principal.email : 'owner@zentra.test', displayName: 'Zentra Üye', disabled: false }),
  createSessionCookie: async () => 'new-cookie'
};
const firebase = { db, auth, admin: { firestore: { FieldValue: { increment: (value) => ({ __increment: value }) } } }, enabled: true, appCheck: null };
function mock(relative, exports) {
  const filename = require.resolve(path.resolve(__dirname, '..', relative));
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
mock('server/config/firebaseAdmin.js', { initFirebaseAdmin: () => firebase });
const liveCatalog = require('../server/core/storeCatalogService');
const validator = require('../server/core/storeProductValidation');
const sampleProduct = { id: 'sample-product', name: 'ZENTRA Paket', platform: 'android', game: 'pubg', fulfillmentMode: 'automatic', plans: [{ key: 'weekly', label: 'Haftalık', duration: '7 gün', priceKurus: 10000 }] };
const catalog = { version: 67, products: [sampleProduct], telegramUsername: '', storefront: { services: { automaticDelivery: true, balancePayment: true, telegramSupport: true } } };
mock('server/core/storeCatalogService.js', { ...liveCatalog, getEffectiveCatalog: async () => clone(catalog) });
mock('server/core/storeInventoryService.js', {
  decorateCatalogWithStock: async (value) => value, invalidateStockCache() {},
  allocateInventoryInTransaction: async ({ tx, items }) => {
    const ref = db.ref('testStock/current');
    const stock = (await tx.get(ref)).data()?.count || 0;
    const requested = items.reduce((total, item) => total + item.quantity, 0);
    if (stock < requested) throw Object.assign(new Error('STORE_OUT_OF_STOCK'), { code: 'STORE_OUT_OF_STOCK' });
    tx.set(ref, { count: stock - requested });
    return items.map((item) => ({ productId: item.productId }));
  },
  attachManualDeliveryInTransaction: async () => []
});
mock('server/core/firestorePagination.js', { createdAtPage: async () => ({ docs: [], hasMore: false, nextCursor: '' }), invalidateCreatedAtPageCache() {} });
const service = require('../server/core/storeService');
const vault = require('../server/core/storeKeyVault');
const security = require('../server/core/requestSecurity');
const profile = { username: 'zentrauye', email: principal.email, storeBalanceKurus: 20000, storeProfile: { avatarId: '1' }, storeAccountStatus: 'active' };
function seed(balance = 20000, stock = 4) { db.reset(); db.rows.set('users/customer-uid', { ...profile, storeBalanceKurus: balance }); db.rows.set('testStock/current', { count: stock }); }
const orderInput = (key = 'unique-order-key-12345', extra = {}) => ({ uid: principal.uid, authUser: principal, paymentMethod: 'wallet', idempotencyKey: key, rawItems: [{ productId: sampleProduct.id, planKey: 'weekly', quantity: 1 }], ...extra });
const errorCode = (code) => (error) => error.code === code;

test('request payload rejects prototype keys, deep nesting and invalid numbers', () => {
  assert.equal(security.inspectBody(JSON.parse('{"__proto__":{"balanceKurus":999999}}')), false);
  assert.equal(security.inspectBody({ price: Infinity }), false);
  assert.equal(security.inspectQuery({ constructor: 'attack' }), false);
  assert.equal(security.inspectBody({ items: [{ productId: 'titan', quantity: 1 }] }), true);
});
test('session creation rejects old or disabled identities and sets protected cookies', async () => {
  const sessions = require('../server/core/userSessionService');
  const previousAuthTime = principal.auth_time;
  const getUser = auth.getUser;
  try {
    principal.auth_time = Math.floor(Date.now() / 1000) - 301;
    await assert.rejects(sessions.createUserSession('valid-customer-token'), errorCode('AUTH_FRESH_TOKEN_REQUIRED'));
    principal.auth_time = Math.floor(Date.now() / 1000);
    auth.getUser = async (uid) => ({ uid, disabled: true });
    await assert.rejects(sessions.createUserSession('valid-customer-token'), errorCode('AUTH_INVALID'));
    auth.getUser = getUser;
    const session = await sessions.createUserSession('valid-customer-token', true);
    assert.equal(session.sessionCookie, 'new-cookie');
    assert.equal(session.expiresIn, 14 * 24 * 60 * 60 * 1000);
    const cookie = sessions.sessionCookieHeader(session.sessionCookie, true);
    assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
    assert.match(sessions.clearSessionCookieHeader(), /Max-Age=0/);
  } finally { principal.auth_time = previousAuthTime; auth.getUser = getUser; }
});
test('account synchronization preserves concurrent wallet credit and account restrictions', async () => {
  db.reset(); db.rows.set('users/customer-uid', { username: 'zentrauye', email: 'stale@zentra.test', storeWallet: { balanceKurus: 100 } });
  beforeTransaction = () => db.rows.set('users/customer-uid', { ...profile, storeBalanceKurus: 76543, storeAccountStatus: 'purchase_blocked' });
  const account = await service.readAccount(principal.uid, principal);
  assert.equal(account.balanceKurus, 76543); assert.equal(account.accountStatus, 'purchase_blocked');
  assert.equal(db.rows.get('users/customer-uid').storeBalanceKurus, 76543);
});
test('modified client prices and negative quantities cannot alter order totals', async () => {
  seed();
  await assert.rejects(service.createOrder(orderInput('malicious-price-1234', { rawItems: [{ productId: sampleProduct.id, planKey: 'weekly', quantity: 1, unitPriceKurus: 1 }] })), errorCode('STORE_CART_INVALID'));
  await assert.rejects(service.createOrder(orderInput('negative-quantity-1234', { rawItems: [{ productId: sampleProduct.id, planKey: 'weekly', quantity: -2 }] })), errorCode('STORE_CART_INVALID'));
  assert.equal(db.rows.get('users/customer-uid').storeBalanceKurus, 20000);
});
test('concurrent retries debit the wallet and consume stock exactly once', async () => {
  seed(); const [first, replay] = await Promise.all([service.createOrder(orderInput()), service.createOrder(orderInput())]);
  assert.equal(first.order.id, replay.order.id); assert.equal(first.order.totalKurus, 10000);
  assert.equal(db.rows.get('users/customer-uid').storeBalanceKurus, 10000);
  assert.equal(db.rows.get('testStock/current').count, 3);
  assert.equal([...db.rows.keys()].filter((key) => key.startsWith('storeWalletLedger/')).length, 1);
});
test('conflicting retries are rejected and insufficient funds or stock commit no writes', async () => {
  seed(); await service.createOrder(orderInput());
  await assert.rejects(service.createOrder(orderInput(undefined, { rawItems: [{ productId: sampleProduct.id, planKey: 'weekly', quantity: 2 }] })), errorCode('STORE_ORDER_CONFLICT'));
  seed(9999); await assert.rejects(service.createOrder(orderInput()), errorCode('STORE_INSUFFICIENT_BALANCE')); assert.equal(db.rows.get('users/customer-uid').storeBalanceKurus, 9999);
  seed(20000, 0); await assert.rejects(service.createOrder(orderInput()), errorCode('STORE_OUT_OF_STOCK')); assert.equal(db.rows.get('users/customer-uid').storeBalanceKurus, 20000);
});
test('wallet adjustment retries are idempotent and reject mismatched amounts', async () => {
  seed(); const input = { targetUid: principal.uid, amountKurus: 10000, type: 'CREDIT', reason: 'Doğrulanmış ödeme', actor: { uid: 'owner-uid', email: 'owner@zentra.test' }, idempotencyKey: 'wallet-request-12345' };
  await Promise.all([service.adjustStoreBalance(input), service.adjustStoreBalance(input)]);
  assert.equal(db.rows.get('users/customer-uid').storeBalanceKurus, 30000);
  await assert.rejects(service.adjustStoreBalance({ ...input, amountKurus: 15000 }), errorCode('STORE_BALANCE_ADJUSTMENT_CONFLICT'));
});
test('encrypted delivery rejects changed ciphertext and changed ownership context', () => {
  const context = { recordType: 'delivery', recordId: 'delivery-1', productId: 'titan', planKey: 'weekly', orderId: 'order-1', uid: principal.uid };
  const encrypted = vault.encryptSecret('ZENTRA-PRIVATE-LICENSE-1234', context);
  assert.equal(vault.decryptSecret(encrypted, context), 'ZENTRA-PRIVATE-LICENSE-1234');
  assert.throws(() => vault.decryptSecret(encrypted, { ...context, uid: 'another-customer' }), errorCode('STORE_KEY_DECRYPTION_FAILED'));
  const changed = Buffer.from(encrypted.ciphertext, 'base64url'); changed[0] ^= 1;
  assert.throws(() => vault.decryptSecret({ ...encrypted, ciphertext: changed.toString('base64url') }, context), errorCode('STORE_KEY_DECRYPTION_FAILED'));
});
test('new products require valid local assets, prices and unique plan keys', () => {
  const input = { id: 'new-zentra-product', name: 'Zentra Ürün', platform: 'android', game: 'pubg', image: '/public/assets/products/titan.jpeg', plans: [{ key: 'weekly', label: 'Haftalık', duration: '7 gün', priceKurus: 10000 }] };
  assert.equal(validator.normalizeCustomProduct(input).id, input.id);
  assert.throws(() => validator.normalizeCustomProduct({ ...input, image: '/server/config/env.js' }), errorCode('STORE_PRODUCT_IMAGE_INVALID'));
  assert.throws(() => validator.normalizeCustomProduct({ ...input, plans: [input.plans[0], input.plans[0]] }), errorCode('STORE_PRODUCT_PRICE_INVALID'));
  assert.throws(() => validator.normalizeCustomProduct({ ...input, balanceKurus: 1000000 }), errorCode('STORE_PRODUCT_SETTINGS_INVALID'));
});
test('official support links migrate once without changing products or store controls', async () => {
  seed();
  const links = require('../server/core/storeLinks');
  const products = Object.fromEntries(require('../server/core/storeCatalog').STORE_CATALOG.products.map(product => [product.id, {}]));
  const reference = 'storefrontSettings/main';
  db.rows.set(reference, { channelLinksRevision: 70, quickLinks: links.DEFAULT_QUICK_LINKS.slice(0, 6), support: { telegramUsername: 'OLD_STORE', note: 'keep' }, maintenance: true, services: { balancePayment: false }, catalog: { schemaVersion: 1, sourceVersion: 67, products } });
  const refreshed = await liveCatalog.getEffectiveCatalog({ fresh: true });
  assert.equal(refreshed.telegramUsername, 'ZENTRA_STORE');
  assert.equal(refreshed.storefront.quickLinks.length, 7);
  assert.equal(refreshed.storefront.quickLinks.find(link => link.id === 'telegram-support').url, 'https://t.me/ZENTRA_STORE');
  const saved = db.rows.get(reference);
  assert.equal(saved.channelLinksRevision, links.CHANNEL_LINKS_REVISION);
  assert.equal(saved.maintenance, true); assert.equal(saved.services.balancePayment, false);
  assert.equal(saved.support.note, 'keep'); assert.deepEqual(saved.catalog.products, products);
  const edited = { ...saved, support: { telegramUsername: 'OWNER_EDITED' } };
  assert.equal(links.channelLinksMigration(edited), null);
  assert.equal(links.normalizeQuickLinks(links.DEFAULT_QUICK_LINKS).length, 7);
});
test('manual orders target the official Telegram support and do not debit the wallet', async () => {
  seed();
  const result = await service.createOrder(orderInput('official-support-order-12345', { paymentMethod: 'telegram' }));
  const target = new URL(result.telegramUrl);
  assert.equal(target.origin, 'https://t.me'); assert.equal(target.pathname, '/ZENTRA_STORE');
  assert.match(target.searchParams.get('text'), /ZENTRA STORE/);
  assert.ok(target.searchParams.get('text').includes(result.order.orderNumber));
  assert.equal(result.order.status, 'awaiting_payment');
  assert.equal(result.balanceKurus, 20000); assert.equal(db.rows.get('testStock/current').count, 4);
  assert.equal([...db.rows.keys()].filter(key => key.startsWith('storeWalletLedger/')).length, 0);
});
test('custom products persist and remain editable after catalog refresh', async () => {
  seed(); const { DEFAULT_QUICK_LINKS, CHANNEL_LINKS_REVISION } = require('../server/core/storeLinks');
  db.rows.set('storefrontSettings/main', { channelLinksRevision: CHANNEL_LINKS_REVISION, quickLinks: DEFAULT_QUICK_LINKS, catalog: { schemaVersion: 1, sourceVersion: 67, products: Object.fromEntries(require('../server/core/storeCatalog').STORE_CATALOG.products.map((product) => [product.id, {}])) } });
  const input = { id: 'new-zentra-product', name: 'Zentra Ürün', platform: 'android', game: 'pubg', image: '/public/assets/products/titan.jpeg', plans: [{ key: 'weekly', label: 'Haftalık', duration: '7 gün', priceKurus: 10000 }] };
  const actor = { uid: 'owner-uid', email: 'owner@zentra.test' };
  await liveCatalog.createProduct(input, actor);
  const refreshed = await liveCatalog.getEffectiveCatalog({ includeInactive: true, fresh: true });
  assert.equal(refreshed.products.find((product) => product.id === input.id)?.name, input.name);
  await liveCatalog.updateProductSettings(input.id, { name: 'Güncel Zentra' }, actor);
  assert.equal((await liveCatalog.getEffectiveCatalog({ fresh: true })).products.find((product) => product.id === input.id)?.name, 'Güncel Zentra');
  await assert.rejects(liveCatalog.createProduct(input, actor), errorCode('STORE_PRODUCT_EXISTS'));
});
test('promotion scope accepts custom catalog products and rejects unknown IDs', async () => {
  seed(); const promotions = require('../server/core/storePromotionService');
  const result = await promotions.savePromotion('ZENTRA10', { type: 'percent', value: 10, productIds: [sampleProduct.id] }, { uid: 'owner-uid' });
  assert.deepEqual(result.productIds, [sampleProduct.id]);
  assert.deepEqual(db.rows.get('storePromotions/ZENTRA10').productIds, [sampleProduct.id]);
  await assert.rejects(promotions.savePromotion('ZENTRA20', { type: 'percent', value: 10, productIds: ['unknown-product'] }), errorCode('STORE_PROMOTION_SCOPE_INVALID'));
  assert.equal(db.rows.has('storePromotions/ZENTRA20'), false);
});
let httpServer;
after(() => new Promise((resolve) => httpServer ? httpServer.close(resolve) : resolve()));
test('HTTP endpoints deny forged identities, cross-origin writes and customer admin access', async () => {
  db.reset();
  const { app } = require('../server');
  httpServer = app.listen(0, '127.0.0.1'); await new Promise((resolve) => httpServer.once('listening', resolve));
  const base = `http://127.0.0.1:${httpServer.address().port}`;
  const post = (pathname, headers = {}, body = {}) => fetch(base + pathname, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), redirect: 'manual' });
  assert.equal((await post('/api/admin/store/wallet/adjust')).status, 401);
  assert.equal((await post('/api/admin/store/wallet/adjust', { Authorization: 'Bearer valid-customer-token' })).status, 403);
  assert.equal((await post('/api/store/orders', { Origin: 'https://attacker.invalid', Authorization: 'Bearer valid-customer-token' })).status, 403);
  assert.equal((await fetch(base + '/api/store/account', { headers: { Authorization: 'Bearer invalid-token', Cookie: 'zentra_session=valid-cookie' } })).status, 401);
  const injected = await post('/api/store/orders', { Authorization: 'Bearer valid-customer-token' }, { items: [], balanceKurus: 999999 }); assert.equal(injected.status, 400);
  const runtime = await fetch(base + '/api/public/runtime-config'); const publicData = await runtime.json();
  assert.equal(publicData.brand, 'ZENTRA STORE'); assert.equal(JSON.stringify(publicData).includes(process.env.STORE_KEY_ENCRYPTION_SECRET), false);
  const home = await fetch(base); assert.equal(home.headers.get('x-content-type-options'), 'nosniff'); assert.match(home.headers.get('content-security-policy'), /script-src-attr 'none'/);
});
