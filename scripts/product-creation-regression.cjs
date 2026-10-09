'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const crypto = require('node:crypto');
const modulePath = require.resolve('../server/config/firebaseAdmin');

process.env.PUBLIC_FIREBASE_CONFIG = JSON.stringify({
  apiKey: 'public-demo-key', authDomain: 'demo.firebaseapp.com',
  projectId: 'demo', storageBucket: 'demo.firebasestorage.app', appId: '1:demo:web:abc'
});

let stored = {
  catalog: { schemaVersion: 1, sourceVersion: require('../public/data/store-products.json').version, products: {}, updatedAt: Date.now() }
};
const audit = [];
function snapshot() { return { exists: true, data: () => structuredClone(stored) }; }
const settingsReference = { id: 'main', get: async () => snapshot() };
const db = {
  collection(collection) {
    return {
      doc(id = crypto.randomUUID()) {
        if (collection === 'storefrontSettings') return settingsReference;
        return { id };
      },
      limit() { return { get: async () => ({ docs: [] }) }; }
    };
  },
  async runTransaction(fn) {
    const writes = [];
    const tx = {
      get: async () => snapshot(),
      set: (_, data) => { writes.push({ type: 'settings', data }); },
      create: (_, data) => { writes.push({ type: 'audit', data }); }
    };
    const result = await fn(tx);
    for (const write of writes) {
      if (write.type === 'settings') stored = { ...stored, ...write.data };
      else audit.push(write.data);
    }
    return result;
  }
};

require.cache[modulePath] = {
  id: modulePath,
  filename: modulePath,
  loaded: true,
  exports: { initFirebaseAdmin: () => ({ enabled: true, db }) }
};

const images = require('../server/core/storeProductCreation');
const service = require('../server/core/storeCatalogService');
const actor = { uid: 'test-admin', email: 'test@example.test' };
const valid = {
  id: 'sample-new-product', name: 'Deneme Premium Ürün',
  description: 'Yeni ürün kataloğu için kontrollü ürün açıklaması.',
  platform: 'ios', game: 'other', inventoryType: 'license',
  fulfillmentMode: 'automatic', badgeKey: 'premium',
  plans: [{ key: 'month', label: 'Aylık Plan', duration: '30 Gün', priceKurus: 14990 }]
};

test('create input validates IDs, product types, prices and plan collisions', () => {
  const row = images.normalizeCreatedProduct(valid);
  assert.equal(row.id, valid.id);
  assert.equal(row.plans[0].priceKurus, 14990);
  for (const override of [
    { id: '__proto__' }, { id: 'kötü-ürün' }, { platform: 'web' },
    { inventoryType: 'unknown' }, { game: 'not-a-game' },
    { description: '<div>' },
    { plans: [{ key: 'month', label: 'Aylık', duration: '30 Gün', priceKurus: -1 }] },
    { plans: [valid.plans[0], valid.plans[0]] },
    { image: 'https://evil.test/a.png' },
    { image: '/public/assets/products/../../server.js' }
  ]) assert.throws(() => images.normalizeCreatedProduct({ ...valid, ...override }));
});

test('uploaded image URL must match the configured bucket and token scheme', () => {
  const token = crypto.randomUUID();
  const good = `https://firebasestorage.googleapis.com/v0/b/demo.firebasestorage.app/o/store-product-images%2F${crypto.randomUUID()}.webp?alt=media&token=${token}`;
  assert.equal(images.isValidProductImage(good), true);
  assert.equal(images.isValidProductImage(good.replace('demo.firebasestorage.app', 'other.firebasestorage.app')), false);
  assert.equal(images.isValidProductImage(good + '&redirect=https://evil.test'), false);
  assert.equal(images.isValidProductImage('javascript:alert(1)'), false);
});

test('new products persist atomically, remain visible in the customer catalog, and cannot be duplicated', async () => {
  const created = await service.createProduct(valid, actor);
  assert.equal(created.id, valid.id);
  assert.equal(created.custom, true);
  assert.equal(stored.catalog.customProducts[valid.id].id, valid.id);
  assert.equal(stored.catalog.products[valid.id].plans.month.priceKurus, 14990);
  const catalog = await service.getEffectiveCatalog({ fresh: true });
  assert.ok(catalog.products.some((item) => item.id === valid.id));
  assert.equal(catalog.products.length, require('../public/data/store-products.json').products.length + 1);
  assert.ok(audit.some((entry) => entry.action === 'store.product.create' && entry.details.productId === valid.id));
  await assert.rejects(service.createProduct(valid, actor), (error) => error.code === 'STORE_PRODUCT_ID_EXISTS');
  assert.equal(stored.catalog.products[valid.id].plans.month.priceKurus, 14990);
});

test('newly created products can be edited through the existing bulk management flow', async () => {
  const saved = await service.updateProductsBulk([{
    productId: valid.id,
    settings: { name: 'Deneme Yeni İsim', plans: { month: { priceKurus: 25990 } } }
  }], actor);
  assert.equal(saved.updated, 1);
  assert.equal(saved.products[0].name, 'Deneme Yeni İsim');
  assert.equal(saved.products[0].plans[0].priceKurus, 25990);
  const catalog = await service.getEffectiveCatalog({ includeInactive: true, fresh: true });
  assert.equal(catalog.products.find((item) => item.id === valid.id).plans[0].priceKurus, 25990);
  assert.ok(audit.some((entry) => entry.action === 'store.product.bulk-update'));
  await assert.rejects(service.updateProductsBulk([
    { productId: valid.id, settings: {} }, { productId: valid.id, settings: {} }
  ], actor), (error) => error.code === 'STORE_PRODUCT_BULK_DUPLICATE');
});

test('server normalizes all six category visibility flags with backwards-compatible defaults', () => {
  const defaults = service.normalizeStorefront({});
  for (const key of ['pubg-ios', 'pubg-android', 'oxide-ios', 'oxide-android', 'random-account', 'gbox']) {
    assert.equal(defaults.categoryVisibility[key], true);
  }
  const changed = service.normalizeStorefront({ categoryVisibility: { gbox: false, 'random-account': false, ios: true } });
  assert.equal(changed.categoryVisibility.gbox, false);
  assert.equal(changed.categoryVisibility['random-account'], false);
  assert.equal(changed.categoryVisibility['pubg-ios'], true);
  assert.equal(changed.categoryVisibility.ios, true);
});

test('features survive create, bulk save and public serialization, and can be cleared', async () => {
  const product = await service.createProduct({ ...valid, id: 'features-product',
    categoryKey: 'pubg-android', image: 'public/assets/products/h-kernel.PNG',
    features: '🏆ÖZELLİKLER🏆\n✅ -Özelleştirilebilir ESP\n✅ -Aimbot\n✅ -Aimbot' }, actor);
  assert.deepEqual(product.features, ['Özelleştirilebilir ESP', 'Aimbot']);
  assert.equal(product.platform, 'android');
  assert.equal(product.game, 'pubg');
  assert.equal(product.image, '/public/assets/products/h-kernel.PNG');
  assert.deepEqual(stored.catalog.products[product.id].features, product.features);
  await service.updateProductsBulk([{ productId: product.id, settings: { features: ['Skin Hack', 'İpad Modu'], categoryKey: 'oxide-ios' } }], actor);
  let catalog = await service.getEffectiveCatalog({ fresh: true });
  const edited = catalog.products.find((row) => row.id === product.id);
  assert.equal(edited.game, 'oxide');
  assert.equal(edited.platform, 'ios');
  assert.deepEqual(edited.features, ['Skin Hack', 'İpad Modu']);
  await service.updateProductSettings(product.id, { features: [] }, actor);
  catalog = await service.getEffectiveCatalog({ fresh: true });
  assert.deepEqual(catalog.products.find((row) => row.id === product.id).features, []);
});

test('all six category presets persist their membership and defaults', async () => {
  const { CATEGORY_PRESETS } = require('../server/core/storeProductSchema');
  for (const [key, preset] of Object.entries(CATEGORY_PRESETS)) {
    const created = await service.createProduct({ ...valid, id: `category-${key}`, categoryKey: key }, actor);
    assert.equal(created.categoryKey, key);
    assert.equal(created.category, preset.category);
    if (preset.platform) assert.equal(created.platform, preset.platform);
    if (preset.game) assert.equal(created.game, preset.game);
    if (key === 'gbox') {
      assert.equal(created.fulfillmentMode, 'telegram_only');
      assert.equal(created.image, '/public/assets/products/gbox.jpeg');
      assert.equal(created.automaticEnabled, false);
    }
    if (key === 'random-account') {
      assert.equal(created.inventoryType, 'account');
      assert.equal(created.image, '/public/assets/products/random.jpeg');
    }
  }
});

test('feature limits reject malformed input before any catalog mutation', async () => {
  const before = structuredClone(stored.catalog);
  for (const features of [[{ text: 'invalid' }], Array.from({ length: 41 }, (_, i) => `Feature ${i}`), ['a'.repeat(161)], 123]) {
    await assert.rejects(service.updateProductSettings(valid.id, { features }, actor), (error) => /^STORE_PRODUCT_FEATURES_/.test(error.code));
    assert.deepEqual(stored.catalog, before);
  }
});

test('image paths support Linux case, nested galleries, SVG and PNG and reject traversal or escaped symlinks', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  assert.equal(images.isValidProductImage('public/assets/products/h-kernel.PNG'), true);
  assert.equal(images.isValidProductImage('/public/assets/products/CRY4ME.JPG'), true);
  assert.equal(images.isValidProductImage('/public/assets/products/gallery/kingmod/game-01.jpeg'), true);
  assert.equal(images.isValidProductImage('/public/assets/products/H-KERNEL.png'), false);
  for (const value of ['/public/assets/products/../products/gbox.jpeg', '/public/assets/products/gbox.jpeg?x=1', '/public/assets/products/a.js', '/etc/passwd', 'data:image/svg+xml,evil']) {
    assert.equal(images.isValidProductImage(value), false, value);
  }
  const svg = path.join(__dirname, '../public/assets/products/qa-image.svg');
  const link = path.join(__dirname, '../public/assets/products/qa-link.svg');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zentra-image-'));
  try {
    fs.writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    assert.equal(images.isValidProductImage('public/assets/products/qa-image.svg'), true);
    fs.writeFileSync(path.join(dir, 'outside.svg'), '<svg/>');
    fs.symlinkSync(path.join(dir, 'outside.svg'), link);
    assert.equal(images.isValidProductImage('/public/assets/products/qa-link.svg'), false);
  } finally {
    fs.rmSync(svg, { force: true }); fs.rmSync(link, { force: true }); fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('catalog document capacity is checked before a Firestore write', async () => {
  const previous = structuredClone(stored);
  try {
    stored.padding = 'x'.repeat(850000);
    const before = structuredClone(stored);
    await assert.rejects(service.updateProductSettings(valid.id, { features: ['Yeni özellik'] }, actor), (error) => error.code === 'STORE_CATALOG_SIZE_LIMIT');
    assert.deepEqual(stored, before);
  } finally { stored = previous; service.invalidateCatalogCache(); }
});
