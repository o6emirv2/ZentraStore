'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../public/js/store/products.js'), 'utf8');
const moduleSource = source.replace(/^import \{ normalizeQuickLinks \} from .*;\s*/m, 'const normalizeQuickLinks = (value) => value;\n');
const catalog = require('../public/data/store-products.json').products;
const fieldsSource = fs.readFileSync(path.join(__dirname, '../public/js/store/product-fields.js'), 'utf8');
const fieldsUrl = `data:text/javascript;base64,${Buffer.from(fieldsSource).toString('base64')}`;
const linkedSource = moduleSource.replace(/from ['"]\.\/product-fields\.js[^'"]*['"]/, `from '${fieldsUrl}'`);
const modulePromise = import(`data:text/javascript;base64,${Buffer.from(linkedSource).toString('base64')}`);
test('GBox iOS variants appear in PUBG iOS and Oxide iOS but not Android collections', async () => {
  const { productMatchesCatalogFilter } = await modulePromise;
  const gboxes = catalog.filter((product) => product.id.startsWith('ios-gbox-'));
  assert.equal(gboxes.length, 2);
  for (const product of gboxes) {
    assert.equal(productMatchesCatalogFilter(product, 'pubg-ios'), true);
    assert.equal(productMatchesCatalogFilter(product, 'oxide-ios'), true);
    assert.equal(productMatchesCatalogFilter(product, 'pubg-android'), false);
    assert.equal(productMatchesCatalogFilter(product, 'oxide-android'), false);
    assert.equal(productMatchesCatalogFilter(product, 'pubg-ios', new Set(), { ios: false }), false);
  }
});
test('unrelated products stay in their own platform and game collections', async () => {
  const { productMatchesCatalogFilter } = await modulePromise;
  const pubgAndroid = catalog.find((p) => p.platform === 'android' && p.game === 'pubg');
  const oxideIos = catalog.find((p) => p.platform === 'ios' && p.game === 'oxide');
  assert.equal(productMatchesCatalogFilter(pubgAndroid, 'oxide-ios'), false);
  assert.equal(productMatchesCatalogFilter(oxideIos, 'pubg-ios'), false);
});
test('six admin category presets and mobile top-position notifications are defined', () => {
  const admin = fs.readFileSync(path.join(__dirname, '../admin/admin-dashboard.js'), 'utf8');
  const markup = fs.readFileSync(path.join(__dirname, '../admin/admin.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../public/css/notifications.css'), 'utf8');
  for (const key of ['pubg-android', 'pubg-ios', 'gbox', 'random-account', 'oxide-android', 'oxide-ios']) {
    assert.match(admin, new RegExp(`\\b${key.replace(/-/g, '\\-')}\\b`));
    assert.ok(markup.includes(`value="${key}"`));
  }
  assert.match(css, /@media\(max-width:560px\)[\s\S]*?\.notification-center\s*\{[^}]*top:max\(/);
});

test('new GBox listings follow both iOS game filters and their own GBox category', async () => {
  const { productMatchesCatalogFilter: matches } = await modulePromise;
  const created = { id: 'custom-gbox-premium', platform: 'ios', game: 'other', category: 'GBox', inventoryType: 'license' };
  for (const key of ['ios', 'gbox', 'pubg-ios', 'oxide-ios']) assert.equal(matches(created, key), true, key);
  for (const key of ['random-account', 'pubg-android', 'oxide-android']) assert.equal(matches(created, key), false, key);
});

test('Random Hesaplar collection uses category or account inventory rather than platform alone', async () => {
  const { productMatchesCatalogFilter: matches } = await modulePromise;
  const categoryAssigned = { id: 'random-ios', platform: 'ios', game: 'other', category: 'Random Hesap' };
  const accountType = { id: 'a1', platform: 'android', game: 'pubg', category: 'PUBG Android', inventoryType: 'account' };
  const ordinary = { id: 'normal', platform: 'android', game: 'pubg', category: 'PUBG Android', inventoryType: 'license' };
  assert.equal(matches(categoryAssigned, 'random-account'), true);
  assert.equal(matches(accountType, 'random-account'), true);
  assert.equal(matches(ordinary, 'random-account'), false);
  assert.equal(matches(categoryAssigned, 'gbox'), false);
});

test('category settings can disable a shortcut without disabling unrelated categories', async () => {
  const { resolveCatalogFilter, productMatchesCatalogFilter: matches } = await modulePromise;
  const visibility = { ios: true, android: true, gbox: false, 'random-account': true };
  assert.equal(resolveCatalogFilter('gbox', visibility), 'all');
  assert.equal(resolveCatalogFilter('random-account', visibility), 'random-account');
  assert.equal(resolveCatalogFilter('oxide-ios', visibility), 'oxide-ios');
  assert.equal(resolveCatalogFilter('oxide-ios', { ios: false }), 'all');
  assert.equal(matches({ id: 'sample', platform: 'android', game: 'pubg', inventoryType: 'account' }, 'random-account', new Set(), { android: false }), false);
});

test('six storefront category cards and six admin visibility controls are wired together', () => {
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const admin = fs.readFileSync(path.join(__dirname, '../admin/admin.html'), 'utf8');
  const client = fs.readFileSync(path.join(__dirname, '../public/js/store/storefront.js'), 'utf8');
  const adminClient = fs.readFileSync(path.join(__dirname, '../admin/admin-dashboard.js'), 'utf8');
  for (const key of ['pubg-ios', 'pubg-android', 'oxide-ios', 'oxide-android', 'random-account', 'gbox']) {
    assert.ok(html.includes(`data-filter="${key}"`), `missing storefront card ${key}`);
    assert.ok(admin.includes(`data-category-visibility="${key}"`), `missing admin control ${key}`);
  }
  assert.match(client, /function renderCategoryNavigation\(\)/);
  assert.match(client, /control\.hidden = visibility\[key\] === false/);
  assert.match(adminClient, /\[data-category-visibility\]/);
});

test('updated client bundles use fresh cache versions rather than stale immutable URLs', () => {
  const index = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '../script.js'), 'utf8');
  const storefront = fs.readFileSync(path.join(__dirname, '../public/js/store/storefront.js'), 'utf8');
  const admin = fs.readFileSync(path.join(__dirname, '../admin/admin.html'), 'utf8');
  assert.match(index, /\/style\.css\?v=zentra-app-v69/);
  assert.match(index, /\/script\.js\?v=zentra-app-v69/);
  assert.match(script, /\/storefront\.js\?v=zentra-app-v69/);
  assert.match(storefront, /products\.js\?v=zentra-app-v69/);
  assert.match(storefront, /notification-center\.js\?v=zentra-app-v69/);
  assert.match(admin, /admin-dashboard\.js\?v=zentra-app-v69/);
});
