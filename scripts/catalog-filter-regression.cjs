'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const source = fs.readFileSync(path.join(__dirname, '../public/js/store/products.js'), 'utf8');
const moduleSource = source.replace(/^import \{ normalizeQuickLinks \} from .*;\s*/m, 'const normalizeQuickLinks = (value) => value;\n');
const catalog = require('../public/data/store-products.json').products;
const modulePromise = import(`data:text/javascript;base64,${Buffer.from(moduleSource).toString('base64')}`);
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
