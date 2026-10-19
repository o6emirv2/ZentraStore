'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const source = (name) => fs.readFileSync(path.join(root, name), 'utf8');
function functionFrom(file, start, end, context) {
  const text = source(file);
  if (!context.window) context.window = { ZENTRA_ADMIN_AUTH: { clearActionPassword() {} } };
  return vm.runInNewContext(text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start))) + '\n' + start.match(/function (\w+)/)[1] + ';', context);
}
function couponsState() {
  return { auth: { user: { uid: 'a' } }, promotions: [], promotionsLoadedAt: 0, promotionsPromise: null, promotionsReload: null, promotionsRevision: 0, promotionsError: '' };
}
function couponLoader(state, api) {
  return functionFrom('public/js/store/storefront.js', 'async function loadCoupons(', 'function renderOrders()', { state, Date, storeApi: api, renderCouponCollection() {}, $: () => null, beginRegion: () => () => {}, friendlyStoreError: (e) => e.message });
}
test('forced coupon refresh shares one follow-up request after an existing read', async () => {
  const state = couponsState(); let reads = 0, release;
  const load = couponLoader(state, () => ++reads === 1 ? new Promise((resolve) => { release = resolve; }) : Promise.resolve({ promotions: [{ code: 'FRESH' }] }));
  const old = load(), first = load({ force: true }), second = load({ force: true });
  release({ promotions: [{ code: 'OLD' }] });
  await old;
  assert.equal((await first)[0].code, 'FRESH'); assert.equal((await second)[0].code, 'FRESH'); assert.equal(reads, 2);
});
test('failed coupon refresh preserves known coupons and reports a retryable error', async () => {
  const state = couponsState(); state.promotions = [{ code: 'KNOWN' }]; state.promotionsLoadedAt = 1;
  const load = couponLoader(state, async () => { throw new Error('connection lost'); });
  await assert.rejects(load({ force: true }));
  assert.equal(state.promotions[0].code, 'KNOWN'); assert.equal(state.promotionsError, 'connection lost');
});
test('late coupon response cannot replace another session or a newer revision', async () => {
  for (const change of [(s) => { s.auth.user = { uid: 'b' }; }, (s) => { s.promotionsRevision++; }]) {
    const state = couponsState(); let release;
    const load = couponLoader(state, () => new Promise((resolve) => { release = resolve; }));
    const pending = load(); change(state); state.promotions = [{ code: 'NEW-SESSION' }];
    release({ promotions: [{ code: 'PRIVATE-OLD' }] }); await pending;
    assert.equal(state.promotions[0].code, 'NEW-SESSION');
  }
});
test('scheduled coupons are separated from usable, used and expired coupons', () => {
  const text = source('public/js/store/customer-app.js');
  const context = { COUPON_FILTERS: ['available', 'scheduled', 'used', 'expired'] };
  const exports = vm.runInNewContext(text.slice(text.indexOf('function customerCouponGroup('), text.indexOf('function couponAccent(')) + '\n({customerCouponGroup,couponIsUsable,summarizeCustomerCoupons});', context);
  const scheduled = { status: 'scheduled', perUserLimit: 1, usedCount: 0 };
  assert.equal(exports.customerCouponGroup(scheduled), 'scheduled'); assert.equal(exports.couponIsUsable(scheduled), false);
  const counts = exports.summarizeCustomerCoupons([scheduled, { status: 'available' }, { status: 'available', usedCount: 1 }, { status: 'expired' }]);
  for (const key of ['scheduled', 'available', 'used', 'expired', 'usable']) assert.equal(counts[key], 1, key);
});
test('late identity initialization cannot overwrite the current user or readiness', async () => {
  let release, identityRevision = 0;
  const a = { uid: 'a' }, b = { uid: 'b' };
  const state = { auth: { currentUser: a }, ready: false, user: null, account: null };
  const context = { state, identityRevision, setStoreTokenProvider() {}, emit() {}, friendlyStoreError: (e) => e.message,
    uid: user => String(user?.uid || ''), rememberPreference: () => false, bindUser: user => { state.user = user; state.account = null; },
    finishIdentity: async user => { if (user === a) await new Promise(resolve => { release = resolve; }); if (state.auth.currentUser !== user) throw new Error('session changed'); state.user = user; state.account = { uid: user.uid }; },
    storeApi: () => state.auth.currentUser === a ? new Promise((resolve) => { release = resolve; }) : Promise.resolve({ authenticated: true }),
    syncServerSession: async () => {}, refreshStoreAccount: async () => { state.account = { uid: state.user.uid }; } };
  const restore = functionFrom('public/js/store/auth.js', 'async function restoreAuthenticatedState(', 'export function subscribeStoreAuth(', context);
  const first = restore(a); state.auth.currentUser = b; await restore(b);
  release({ authenticated: true }); await first;
  assert.equal(state.user.uid, 'b'); assert.equal(state.account.uid, 'b'); assert.equal(state.ready, true);
});
test('failed admin order save preserves input elements, unlocks the button and does not render success', async () => {
  const card = { status: { value: 'paid' }, message: { value: 'Draft note' }, manual: { value: 'Private draft' }, button: {} };
  const state = { busyOrder: '', orders: [], loaded: new Set() }; let renders = 0, notices = [], body;
  const selectors = { '[data-order-status]': card.status, '[data-delivery-message]': card.message, '[data-manual-delivery]': card.manual, '[data-save-order]': card.button };
  const update = functionFrom('admin/admin-dashboard.js', 'async function updateOrder(', 'function metricCard(', {
    state, requirePermission: () => true, requestAdminReauth: async () => true, $: (selector) => selectors[selector],
    setActionBusy: (button, busy) => { button.busy = busy; }, setFieldError: (field, message) => { field.error = message; },
    adminFetch: async (_url, options) => { body = options.body; throw new Error('save failed'); },
    renderOrders: () => { renders++; }, toast: (type) => notices.push(type), encodeURIComponent
  });
  await update('order-a', card);
  assert.equal(body.manualDeliveryText, 'Private draft'); assert.equal(card.message.value, 'Draft note');
  assert.equal(renders, 0); assert.equal(card.button.busy, false); assert.equal(state.busyOrder, ''); assert.deepEqual(notices, ['error']);
});

test('an uncertain stock import reuses its receipt without being blocked by duplicate preflight', async () => {
  const fields = { '#inventoryProduct': { value: 'new-product' }, '#inventoryPlan': { value: 'daily' }, '#inventoryKeys': { value: 'QA-KEY-0001' }, '#inventoryImportButton': {} };
  const state = { inventoryReadiness: { ready: true }, inventoryImportBusy: false, inventoryImportAttempt: null, loaded: new Set() };
  let checks = 0, saves = 0; const keys = [];
  const run = functionFrom('admin/admin-dashboard.js', 'async function importInventory(', 'async function inspectInventory(', {
    state, $: (id) => fields[id], requirePermission: () => true,
    parseInventoryInput: () => ({ valid: true, values: [fields['#inventoryKeys'].value], inventoryType: 'license' }),
    requestKey: () => 'stable-receipt-0001', requestAdminReauth: async () => true, renderInventoryReadiness() {},
    setActionBusy() {}, renderInventoryParsePreview() {}, setFieldError() {}, toast() {}, loadInventory: async () => {},
    isUncertainMutationError: (error) => error.code === 'NETWORK_ERROR',
    adminFetch: async (url, options) => {
      if (url.endsWith('import-check')) { checks++; return { result: { requiresConfirmation: false } }; }
      saves++; keys.push(options.body.idempotencyKey);
      if (saves === 1) throw Object.assign(new Error('lost response'), { code: 'NETWORK_ERROR' });
      return { result: { imported: 1, available: 1, idempotentReplay: true } };
    }
  });
  await run({ preventDefault() {} });
  assert.equal(fields['#inventoryKeys'].value, 'QA-KEY-0001'); assert.equal(state.inventoryImportBusy, false);
  assert.equal(state.inventoryImportAttempt.submitted, true);
  await run({ preventDefault() {} });
  assert.equal(checks, 1); assert.equal(saves, 2); assert.deepEqual(keys, ['stable-receipt-0001', 'stable-receipt-0001']);
  assert.equal(fields['#inventoryKeys'].value, ''); assert.equal(state.inventoryImportAttempt, null);
});

test('stock import locks the form before reauthentication and releases it when cancelled', async () => {
  const state = { inventoryReadiness: { ready: true }, inventoryImportBusy: false, loaded: new Set() };
  let authCalls = 0, release;
  const run = functionFrom('admin/admin-dashboard.js', 'async function importInventory(', 'async function inspectInventory(', {
    state, $: () => ({ value: 'qa' }), requirePermission: () => true,
    parseInventoryInput: () => ({ valid: true, values: ['QA-KEY-0001'] }), requestKey: () => 'receipt-0001',
    requestAdminReauth: () => { authCalls++; return new Promise((resolve) => { release = resolve; }); },
    renderInventoryReadiness() {}, setActionBusy() {}, renderInventoryParsePreview() {}
  });
  const first = run({ preventDefault() {} });
  assert.equal(state.inventoryImportBusy, true);
  await run({ preventDefault() {} }); assert.equal(authCalls, 1);
  release(false); await first; assert.equal(state.inventoryImportBusy, false);
});
