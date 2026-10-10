'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '../public/js/store');
const dataModule = (source) => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const utilsUrl = dataModule(fs.readFileSync(path.join(root, 'view-utils.js'), 'utf8'));
const load = (name) => import(dataModule(fs.readFileSync(path.join(root, name), 'utf8').replace(/['"]\.\/view-utils\.js\?v=[^'"]+['"]/g, JSON.stringify(utilsUrl))));
const price = (amount) => `${Number(amount) / 100} TL`;

test('account view keeps unknown funds and edit limits unknown until the server account arrives', async () => {
  const { accountViewModel } = await load('account-view.js');
  const model = accountViewModel({ user: { uid: 'a', email: 'a@example.test' }, account: null });
  assert.equal(model.loaded, false);
  assert.equal(model.canEdit, false);
  assert.equal(model.remaining.username, null);
  assert.equal(model.status, 'Hesap yükleniyor…');
  assert.equal(model.emailStatus, 'Kayıtlı e-posta');
});

test('account view preserves full email, server edit limits and restricted account state', async () => {
  const { accountViewModel } = await load('account-view.js');
  const email = 'long.account.name.for.accessibility@example.test';
  const model = accountViewModel({ user: { uid: 'a', email, emailVerified: true }, account: { username: 'Üye', email, accountStatus: 'purchase_blocked', birthDate: '2001-02-03', profileChanges: { username: { remaining: 0 } } } });
  assert.equal(model.email, email);
  assert.equal(model.emailStatus, 'Doğrulanmış e-posta');
  assert.equal(model.remaining.username, 0);
  assert.equal(model.warning, true);
  assert.equal(model.birthDate, '03.02.2001');
});

test('rebuilt order card includes every item, total and quantity without exposing delivery secrets', async () => {
  const { renderOrderCardView } = await load('order-view.js');
  const order = { id: 'order-a', orderNumber: 'Z-1', status: 'delivered', paymentMethod: 'wallet', totalKurus: 12345, deliveryVisible: true, delivery: { key: 'PRIVATE-KEY-MUST-NOT-RENDER' }, items: [{ productName: 'Birinci', planLabel: 'Aylık', quantity: 2, lineTotalKurus: 12000 }, { productName: 'İkinci', planLabel: 'Günlük', quantity: 1, lineTotalKurus: 345 }] };
  const html = renderOrderCardView(order, { formatPrice: price, status: { label: 'Teslim edildi', icon: 'fa-check' } });
  assert.ok(html.includes('Birinci') && html.includes('İkinci'));
  assert.ok(html.includes('2 adet') && html.includes('123.45 TL'));
  assert.ok(html.includes('data-order-delivery="order-a"'));
  assert.ok(!html.includes('PRIVATE-KEY-MUST-NOT-RENDER'));
  assert.ok(!html.includes('data-order-cancel-start'));
});

test('order text is escaped, unsafe payment links are rejected, and terminal orders cannot claim delivery', async () => {
  const { renderOrderCardView } = await load('order-view.js');
  const html = renderOrderCardView({ id: 'safe', status: 'awaiting_payment', paymentMethod: 'telegram', items: [{ productName: '<img src=x onerror=alert(1)>' }] }, { telegramUrl: () => 'javascript:alert(1)' });
  assert.ok(html.includes('&lt;img'));
  assert.ok(!html.includes('<img') && !html.includes('javascript:'));
  const terminal = renderOrderCardView({ id: 'cancelled', status: 'cancelled', cancellable: true }, { status: { label: 'İptal edildi', icon: 'fa-ban' } });
  assert.ok(terminal.includes('İptal edildi'));
  assert.ok(!terminal.includes('data-order-cancel-start'));
  assert.ok(!terminal.includes('Teslim edildi'));
});

test('product details render only configured features and preserve plan prices and selected state', async () => {
  const { renderProductPlans, renderProductFeatures, renderProductSummary } = await load('product-detail.js');
  const plan = { key: 'm', label: 'Aylık', duration: '30 gün', priceKurus: 12550 };
  const channel = { automaticReady: false, telegramOpen: true };
  const html = renderProductPlans([plan], 'm', { formatPrice: price, channelFor: () => channel });
  assert.ok(html.includes('aria-pressed="true"') && html.includes('125.5 TL'));
  assert.ok(html.includes('Telegram ile sipariş'));
  assert.equal(renderProductFeatures([]), '');
  assert.ok(renderProductFeatures(['<script>test</script>']).includes('&lt;script&gt;'));
  assert.ok(renderProductSummary(plan, { formatPrice: price, channel }).includes('Aylık'));
});

function orderLoader(state, api) {
  const source = fs.readFileSync(path.join(root, 'storefront.js'), 'utf8');
  const code = source.slice(source.indexOf('async function loadOrders('), source.indexOf('async function loadMoreCustomerOrders()'));
  return vm.runInNewContext(code + '\nloadOrders;', { state, Date, storeApi: api, renderOrders() {}, $() { return null; }, beginRegion() { return () => {}; }, friendlyStoreError: (error) => error.message });
}
function initialState() {
  return { auth: { user: { uid: 'a' } }, orders: [], ordersLoadedAt: 0, ordersPromise: null, ordersReload: null, ordersRevision: 0, ordersError: '', ordersRefreshing: false };
}

test('forced order refresh after an old read produces one new read for concurrent refreshes', async () => {
  const state = initialState();
  let reads = 0, release;
  const loadOrders = orderLoader(state, () => ++reads === 1 ? new Promise((resolve) => { release = resolve; }) : Promise.resolve({ orders: [{ id: 'fresh' }] }));
  const old = loadOrders();
  const first = loadOrders(true);
  const second = loadOrders(true);
  release({ orders: [{ id: 'old' }] });
  await old;
  assert.equal((await first)[0].id, 'fresh');
  assert.equal((await second)[0].id, 'fresh');
  assert.equal(reads, 2);
});

test('concurrent initial order reads share one request without scheduling an extra refresh', async () => {
  const state = initialState();
  let reads = 0, release;
  const loadOrders = orderLoader(state, () => { reads += 1; return new Promise((resolve) => { release = resolve; }); });
  const first = loadOrders();
  const second = loadOrders();
  const third = loadOrders();
  release({ orders: [{ id: 'one' }] });
  const results = await Promise.all([first, second, third]);
  assert.equal(reads, 1);
  assert.ok(results.every((orders) => orders[0].id === 'one'));
  assert.equal(state.ordersRefreshing, false);
});

test('a failed order refresh retains known orders and exposes a retryable error', async () => {
  const state = initialState();
  state.orders = [{ id: 'known' }];
  state.ordersLoadedAt = 1;
  const loadOrders = orderLoader(state, async () => { throw new Error('Connection unavailable'); });
  await assert.rejects(loadOrders(true), /Connection unavailable/);
  assert.equal(state.orders[0].id, 'known');
  assert.equal(state.ordersError, 'Connection unavailable');
  assert.equal(state.ordersRefreshing, false);
  assert.equal(state.ordersPromise, null);
});

test('old order responses cannot overwrite a completed mutation or enter another user session', async () => {
  const state = initialState();
  let release;
  const loadOrders = orderLoader(state, () => new Promise((resolve) => { release = resolve; }));
  const old = loadOrders();
  state.ordersRevision += 1;
  state.orders = [{ id: 'updated', status: 'cancelled' }];
  release({ orders: [{ id: 'updated', status: 'awaiting_payment' }] });
  await old;
  assert.equal(state.orders[0].status, 'cancelled');
  const different = loadOrders(true);
  state.auth.user = { uid: 'b' };
  state.orders = [];
  release({ orders: [{ id: 'private-a' }] });
  assert.equal((await different).length, 0);
  assert.equal(state.orders.length, 0);
});

test('cached catalog configuration cannot hide offline, checking or maintenance state changes', () => {
  const source = fs.readFileSync(path.join(root, 'storefront.js'), 'utf8');
  const code = source.slice(source.indexOf('function renderStorefrontStatus()'), source.indexOf('async function subscribeSelectedStock()'));
  const catalog = { stockVerified: true, storefront: {} };
  const state = { catalog, configuredCatalog: catalog };
  const navigator = { onLine: false };
  const host = { dataset: {}, setAttribute() {} };
  const label = { textContent: '', closest: () => host };
  const render = vm.runInNewContext(code + '\nrenderStorefrontConfiguration;', { state, navigator, $: () => label });
  render();
  assert.equal(host.dataset.state, 'offline');
  navigator.onLine = true;
  render();
  assert.equal(host.dataset.state, 'ready');
  catalog.stockVerified = false;
  render();
  assert.equal(host.dataset.state, 'checking');
  catalog.stockVerified = true;
  catalog.storefront.maintenance = true;
  render();
  assert.equal(host.dataset.state, 'maintenance');
});
