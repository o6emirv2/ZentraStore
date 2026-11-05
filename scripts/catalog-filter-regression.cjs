'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { browserModule } = require('./helpers/browser-module.cjs');
const { GAME_KEYS, CATEGORY_PRESETS, CATEGORY_VISIBILITY_KEYS, isSupportedProduct } = require('../public/js/store/catalog-schema.mjs');
const catalog = require('../public/data/store-products.json').products;
const modulePromise = browserModule('public/js/store/products.js');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const categories = ['gbox-ios', 'oxide-android', 'oxide-ios', 'pubg-android', 'pubg-ios'];

test('the shared catalog permits the two games and GBOX in their supported platform categories', async () => {
  const { CATALOG_FILTERS } = await modulePromise;
  assert.deepEqual(GAME_KEYS.slice().sort(), ['gbox', 'oxide', 'pubg']);
  assert.deepEqual(Object.keys(CATEGORY_PRESETS).sort(), categories);
  assert.deepEqual(Object.keys(CATALOG_FILTERS).sort(), [...categories, 'all', 'android', 'ios', 'favorites'].sort());
  assert.deepEqual([...CATEGORY_VISIBILITY_KEYS].sort(), [...categories, 'android', 'ios'].sort());
});

test('all remaining products and plans belong to the permitted game scope', () => {
  assert.equal(catalog.length, 27);
  assert.equal(catalog.reduce((sum, product) => sum + product.plans.length, 0), 76);
  for (const product of catalog) {
    assert.equal(isSupportedProduct(product), true, product.id);
    assert.ok(fs.existsSync(path.join(__dirname, '..', product.image)), product.id);
  }
});

test('retained supplied products preserve exact amounts and durations', () => {
  const expected = [
    ['ios-sapphire-oxide', 'SAPPHİRE', [['daily', 25000], ['weekly', 75000], ['monthly', 150000]]],
    ['ios-tracex-oxide', 'OXİDE TRACEX', [['daily', 20000], ['weekly', 75000], ['monthly', 135000]]],
    ['android-magic-oxide', 'MAGİC', [['daily', 35000], ['weekly', 125000], ['biweekly', 190000]]],
    ['ios-tracex-pubg', 'TRACEX', [['daily', 25000], ['weekly', 75000], ['monthly', 135000]]],
    ['ios-lion-pubg', 'LİON', [['daily', 20000], ['weekly', 75000], ['monthly', 135000]]]
  ];
  for (const [id, name, plans] of expected) {
    const product = catalog.find(row => row.id === id);
    assert.equal(product.name, name);
    assert.deepEqual(product.plans.map(plan => [plan.key, plan.priceKurus]), plans);
  }
  assert.equal(catalog.find(row => row.id === 'android-magic-oxide').plans.find(plan => plan.key === 'biweekly').duration, '14 Gün');
});

test('storefront and admin filters isolate every platform and game', async () => {
  const { productMatchesCatalogFilter } = await modulePromise;
  const { matchesAdminProduct } = await browserModule('public/js/ui/list-controls.js');
  for (const [key, preset] of Object.entries(CATEGORY_PRESETS)) {
    const expected = catalog.filter(product => product.game === preset.game && product.platform === preset.platform);
    assert.ok(expected.length > 0, key);
    assert.deepEqual(catalog.filter(product => productMatchesCatalogFilter(product, key)), expected);
    assert.deepEqual(catalog.filter(product => matchesAdminProduct(product, { category: key })), expected);
  }
});

test('unsupported products cannot enter any public or admin collection', async () => {
  const { productMatchesCatalogFilter: matches } = await modulePromise;
  const { matchesAdminProduct } = await browserModule('public/js/ui/list-controls.js');
  const invalid = [null, {}, { ...catalog[0], game: 'unsupported-game' }, { ...catalog[0], platform: 'web' }, { ...catalog[0], categoryKey: 'unsupported-category' }, { ...catalog[0], categoryKey: 'pubg-ios' }];
  for (const product of invalid) {
    assert.equal(isSupportedProduct(product), false);
    for (const key of ['all', 'favorites', ...categories]) assert.equal(matches(product, key, new Set([product?.id])), false);
    assert.equal(matchesAdminProduct(product), false);
  }
});

test('client normalization drops stale products and unsupported visibility fields', async () => {
  const { loadStoreCatalog } = await browserModule('public/js/store/products.js');
  const normalized = await loadStoreCatalog(async () => ({ products: [...catalog, null, { ...catalog[0], id: 'retired-product', game: 'unsupported-game' }], storefront: { categoryVisibility: { 'unused-category': false, 'oxide-ios': false } } }));
  assert.equal(normalized.products.length, catalog.length);
  assert.equal(normalized.products.some(product => product.id === 'retired-product'), false);
  assert.equal(Object.hasOwn(normalized.storefront.categoryVisibility, 'unused-category'), false);
  assert.equal(normalized.storefront.categoryVisibility['oxide-ios'], false);
});

test('category and platform visibility remain independent', async () => {
  const { resolveCatalogFilter, productMatchesCatalogFilter: matches } = await modulePromise;
  assert.equal(resolveCatalogFilter('oxide-ios', { 'oxide-ios': false }), 'all');
  assert.equal(resolveCatalogFilter('oxide-ios', { ios: false }), 'all');
  assert.equal(resolveCatalogFilter('oxide-android', { 'oxide-ios': false }), 'oxide-android');
  assert.equal(resolveCatalogFilter('unsupported-category'), 'all');
  assert.equal(matches(catalog[0], 'all', new Set(), { android: false }), false);
});

test('storefront cards, admin presets, filters and visibility controls use the same allowed categories', () => {
  const html = read('index.html'), admin = read('admin/admin.html');
  const options = selector => {
    const body = admin.match(new RegExp('<select[^>]*' + selector + '[^>]*>([\\s\\S]*?)</select>'))[1];
    return [...body.matchAll(/<option[^>]*value="([^"]+)"/g)].map(match => match[1]).sort();
  };
  assert.deepEqual(options('name="categoryPreset"'), categories);
  assert.deepEqual(options('id="adminProductCategory"'), [...categories, 'all'].sort());
  assert.deepEqual(options('name="game"'), ['gbox', 'oxide', 'pubg']);
  for (const key of categories) {
    assert.ok(html.includes(`data-filter="${key}"`));
    assert.ok(admin.includes(`data-category-visibility="${key}"`));
  }
  const controls = [...admin.matchAll(/data-category-visibility="([^"]+)"/g)].map(match => match[1]).sort();
  assert.deepEqual(controls, categories);
  for (const id of ['contentAndroidVisible', 'contentIosVisible']) assert.ok(admin.includes(`id="${id}"`));
});

test('unsupported category visibility is rejected at the API boundary', () => {
  const { validateApiBody } = require('../server/core/apiContracts');
  assert.equal(validateApiBody('PATCH', '/api/admin/store/content', { categoryVisibility: { 'unsupported-category': true } }), false);
  assert.equal(validateApiBody('PATCH', '/api/admin/store/content', { categoryVisibility: { 'pubg-ios': false, 'oxide-android': true } }), true);
});

test('category navigation keeps hidden categories hidden during initial rendering', async () => {
  const vm = require('node:vm');
  const { CATALOG_FILTERS, productMatchesCatalogFilter } = await modulePromise;
  const source = read('public/js/store/storefront.js');
  const navigation = source.slice(source.indexOf('function renderCategoryNavigation()'), source.indexOf('function updateCatalogFilterControls()'));
  const configuration = source.slice(source.indexOf('function renderStorefrontConfiguration()'), source.indexOf('async function subscribeSelectedStock()'));
  const controls = Object.entries(CATALOG_FILTERS).map(([key, filter]) => ({ dataset: { filter: key, categoryPlatform: filter.platform }, hidden: false, querySelector: () => null }));
  vm.runInNewContext(navigation + configuration + '\nrenderCategoryNavigation();renderStorefrontConfiguration();', {
    state: { catalog: { products: catalog.filter(product => product.game === 'pubg'), storefront: { categoryVisibility: { 'pubg-ios': false } } }, favorites: new Set() },
    $: () => null,
    $$: selector => selector === '#gameCategories .game-category' ? controls : selector.includes('data-category-platform') ? controls.filter(control => selector.includes(`data-category-platform="${control.dataset.categoryPlatform}"`)) : [],
    CATALOG_FILTERS, productMatchesCatalogFilter, showcaseSliderController: null, renderQuickLinks: () => [], renderStorefrontStatus() {}
  });
  for (const key of ['oxide-android', 'oxide-ios', 'pubg-ios']) assert.equal(controls.find(control => control.dataset.filter === key).hidden, true, key);
  assert.equal(controls.find(control => control.dataset.filter === 'pubg-android').hidden, false);
  for (const control of controls) assert.equal(typeof control.hidden, 'boolean');
});

test('every first-party page uses the requested initial minimum and maximum viewport scale', () => {
  for (const name of ['index.html', 'admin/index.html', 'admin/admin.html', 'admin/session/handoff/index.html', ]) {
    const content = read(name).match(/<meta name="viewport" content="([^"]+)"/)[1];
    const fields = Object.fromEntries(content.split(',').map(value => value.trim().split('=')));
    for (const key of ['initial-scale', 'minimum-scale', 'maximum-scale']) assert.equal(Number(fields[key]), 0.8, name + ':' + key);
    assert.equal(fields.width, 'device-width');
    assert.equal(fields['viewport-fit'], 'cover');
  }
});

test('changed client bundles have fresh cache versions', () => {
  assert.match(read('index.html'), /\/script\.js\?v=zentra-ui-v90r1/);
  assert.match(read('script.js'), /\/storefront\.js\?v=zentra-ui-v90r1/);
  assert.match(read('public/js/store/storefront.js'), /products\.js\?v=zentra-ui-v90r1/);
  assert.match(read('admin/admin-entry.js'), /admin-dashboard\.js\?v=zentra-ui-v90r1/);
  assert.match(read('public/js/store/products.js'), /catalog-schema\.mjs\?v=zentra-ui-v90r1/);
});
