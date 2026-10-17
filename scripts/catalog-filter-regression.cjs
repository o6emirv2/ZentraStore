'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { browserModule } = require('./helpers/browser-module.cjs');
const { CATEGORY_PRESETS, CATEGORY_VISIBILITY_KEYS } = require('../public/js/store/catalog-schema.mjs');
const catalog = require('../public/data/store-products.json').products;
const modulePromise = browserModule('public/js/store/products.js');
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
test('shared admin category presets and mobile top-position notifications are defined', () => {
  const admin = fs.readFileSync(path.join(__dirname, '../admin/admin-dashboard.js'), 'utf8');
  const markup = fs.readFileSync(path.join(__dirname, '../admin/admin.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../public/css/notifications.css'), 'utf8');
  assert.match(admin, /CATEGORY_PRESETS as PRODUCT_CATEGORY_PRESETS/);
  for (const key of Object.keys(CATEGORY_PRESETS)) {
    assert.ok(markup.includes(`value="${key}"`));
  }
  assert.match(css, /\.notification-center\s*\{[^}]*top:max\([^}]*safe-area-inset-top/);
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

test('every storefront category card and admin visibility control is wired together', () => {
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const admin = fs.readFileSync(path.join(__dirname, '../admin/admin.html'), 'utf8');
  const client = fs.readFileSync(path.join(__dirname, '../public/js/store/storefront.js'), 'utf8');
  const adminClient = fs.readFileSync(path.join(__dirname, '../admin/admin-dashboard.js'), 'utf8');
  for (const key of Object.keys(CATEGORY_PRESETS)) {
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
  assert.match(index, /\/style\.css\?v=zentra-ui-v79/);
  assert.match(index, /\/script\.js\?v=zentra-ui-v79/);
  assert.match(script, /\/storefront\.js\?v=zentra-ui-v79/);
  assert.match(storefront, /products\.js\?v=zentra-ui-v79/);
  assert.match(storefront, /notification-center\.js\?v=zentra-ui-v79/);
  assert.match(admin, /admin-legacy-entry\.js\?v=zentra-ui-v79/);
  const entry = fs.readFileSync(path.join(__dirname, '../admin/admin-entry.js'), 'utf8');
  assert.match(entry, /admin-dashboard\.js\?v=zentra-ui-v79/);
});

const additions = [
  ['ios-tracex-delta-force', 'delta-force', 'ios', [250, 700, 1500]],
  ['ios-tracex-valorant', 'valorant', 'ios', [250, 700, 1500]],
  ['ios-cloud-codm', 'codm', 'ios', [300, 700, 1500]],
  ['android-gbd-codm', 'codm', 'android', [250, 650, 1300]],
  ['android-bloodstrike', 'bloodstrike', 'android', [300, 700, 1450]],
  ['android-standoff-2', 'standoff-2', 'android', [null, 1000, 2000]],
  ['ios-standoff-2', 'standoff-2', 'ios', [null, 1000, 2000]],
  ['ios-fluorite-mlbb', 'mobile-legends', 'ios', [300, 850, 1600]],
  ['android-king-mod-8ball-pool', '8ball-pool', 'android', [200, 650, 1300]],
  ['ios-wizard-8ball-pool', '8ball-pool', 'ios', [250, 700, 1400]],
  ['android-drip-client-free-fire', 'free-fire', 'android', [250, 600, 1250]],
  ['ios-fluorite-free-fire', 'free-fire', 'ios', [250, 800, 1600]]
];

test('all twelve supplied products retain their exact prices, platforms and available durations', () => {
  for (const [id, game, platform, prices] of additions) {
    const product = catalog.find((row) => row.id === id);
    assert.ok(product, id);
    assert.equal(product.game, game, id);
    assert.equal(product.categoryKey, game, id);
    assert.equal(product.platform, platform, id);
    assert.deepEqual(product.plans.map((row) => [row.key, row.priceKurus]),
      ['daily', 'weekly', 'monthly'].flatMap((key, index) => prices[index] === null ? [] : [[key, prices[index] * 100]]), id);
    assert.ok(fs.existsSync(path.join(__dirname, '..', product.image)), id);
  }
});

test('each new collection selects exactly its own products in both the storefront and admin', async () => {
  const { productMatchesCatalogFilter } = await modulePromise;
  const { matchesAdminProduct } = await browserModule('public/js/ui/list-controls.js');
  for (const game of new Set(additions.map((row) => row[1]))) {
    const expected = additions.filter((row) => row[1] === game).map((row) => row[0]).sort();
    assert.deepEqual(catalog.filter((row) => productMatchesCatalogFilter(row, game)).map((row) => row.id).sort(), expected, game);
    assert.deepEqual(catalog.filter((row) => matchesAdminProduct(row, { category: game })).map((row) => row.id).sort(), expected, game);
    for (const row of additions.filter((row) => row[1] === game)) {
      const legacy = { ...catalog.find((product) => product.id === row[0]), categoryKey: undefined };
      assert.equal(matchesAdminProduct(legacy, { category: game }), true);
    }
  }
});

test('browser catalog normalization preserves new game IDs and visibility settings', async () => {
  const { loadStoreCatalog, resolveCatalogFilter } = await browserModule('public/js/store/products.js');
  const hidden = Object.fromEntries(CATEGORY_VISIBILITY_KEYS.map((key) => [key, false]));
  const normalized = await loadStoreCatalog(async () => ({ products: catalog, storefront: { categoryVisibility: hidden } }));
  assert.deepEqual(normalized.storefront.categoryVisibility, hidden);
  for (const [id, game] of additions) {
    assert.equal(normalized.products.find((product) => product.id === id).game, game);
    assert.equal(resolveCatalogFilter(game, hidden), 'all');
  }
});

test('category navigation assigns boolean visibility for categories spanning both platforms', async () => {
  const vm = require('node:vm');
  const { CATALOG_FILTERS, productMatchesCatalogFilter } = await modulePromise;
  const source = fs.readFileSync(path.join(__dirname, '../public/js/store/storefront.js'), 'utf8');
  const start = source.indexOf('function renderCategoryNavigation()');
  const end = source.indexOf('function updateCatalogFilterControls()', start);
  const controls = Object.keys(CATALOG_FILTERS).map((filter) => {
    let hidden = false;
    return { dataset: { filter }, querySelector: () => null,
      get hidden() { return hidden; },
      set hidden(value) { assert.equal(typeof value, 'boolean', filter); hidden = value; } };
  });
  vm.runInNewContext(source.slice(start, end) + '\nrenderCategoryNavigation();', {
    state: { catalog: { products: catalog, storefront: {} }, favorites: new Set() },
    $$: () => controls, CATALOG_FILTERS, productMatchesCatalogFilter
  });
  for (const key of ['all', 'gbox', 'delta-force', 'codm', '8ball-pool', 'free-fire']) {
    assert.equal(controls.find((control) => control.dataset.filter === key).hidden, false, key);
  }
});
