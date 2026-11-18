'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateApiBody } = require('../server/core/apiContracts');
test('financial schemas reject coercible objects, booleans, extra uid and client price fields', () => {
  const path = '/api/admin/store/wallet/adjust', valid = { uid: 'member', amountKurus: 20000, type: 'CREDIT', reason: 'Gerekçe', idempotencyKey: 'stable-request-123' };
  assert(validateApiBody('POST', path, valid));
  for (const amountKurus of [{}, true, '20000', -Infinity, Number.MAX_SAFE_INTEGER, 2.5]) assert(!validateApiBody('POST', path, { ...valid, amountKurus }));
  const cart = { items: [{ productId: 'demo-product', planKey: 'daily', quantity: 1 }], paymentMethod: 'wallet', idempotencyKey: 'stable-request-123' };
  assert(validateApiBody('POST', '/api/store/orders', cart));
  assert(!validateApiBody('POST', '/api/store/orders', { ...cart, uid: 'other-member' }));
  assert(!validateApiBody('POST', '/api/store/orders', { ...cart, items: [{ ...cart.items[0], priceKurus: 1 }] }));
});
test('product, inventory, coupon and balance promotion contracts enforce separate bounded input types', () => {
  const inventory = { productId: 'demo-product', planKey: 'daily', keys: [{ username: 'account', password: ' Ａ-password ' }], idempotencyKey: 'stable-import-123' };
  assert(validateApiBody('POST', '/api/admin/store/inventory/import', inventory));
  for (const keys of [Array(201).fill('KEY-0001'), [false], [{ username: 'account', password: {} }]]) assert(!validateApiBody('POST', '/api/admin/store/inventory/import', { ...inventory, keys }));
  const promotion = { type: 'balance', value: 20000, usageLimit: 1, perUserLimit: 1, active: true, createOnly: true };
  assert(validateApiBody('PUT', '/api/admin/store/balance-codes/ZENTRASTORE200', promotion));
  assert(!validateApiBody('PUT', '/api/admin/store/balance-codes/ZENTRASTORE200', { ...promotion, value: true }));
  assert(!validateApiBody('POST', '/api/store/balance-codes/redeem', { code: 'ZENTRASTORE200', amountKurus: 20000 }));
  const product = { id: 'new-product', name: 'Yeni ürün', plans: [{ key: 'daily', label: 'Günlük', duration: '1 gün', priceKurus: 20000 }] };
  assert(validateApiBody('POST', '/api/admin/store/products', product));
  assert(!validateApiBody('POST', '/api/admin/store/products', { ...product, plans: [{ ...product.plans[0], priceKurus: true }] }));
});
test('login retains long exact passwords and rejects unsupported fields without coercion', () => {
  const body = { identifier: 'member', password: ' Ａ-long-password ' + 'x'.repeat(3000) };
  assert(validateApiBody('POST', '/api/auth/login', body));
  for (const invalid of [{ ...body, password: {} }, { ...body, password: 'x'.repeat(4097) }, { ...body, admin: true }]) assert(!validateApiBody('POST', '/api/auth/login', invalid));
  assert(!validateApiBody('POST', '/api/auth/session', { idToken: 'valid.token', remember: 'true' }));
});
test('nested configuration, prototype keys and malformed action hashes are rejected', () => {
  assert(!validateApiBody('PATCH', '/api/admin/store/content', { services: { unknown: true } }));
  assert(!validateApiBody('PATCH', '/api/admin/store/content', JSON.parse('{"constructor":{}}')));
  assert(!validateApiBody('POST', '/api/admin/action-proof', { method: 'POST', path: '/api/admin/store/wallet/adjust', bodyHash: 'not-a-hash' }));
  assert(validateApiBody('GET', '/api/store/catalog', undefined));
});

test('every category visibility flag accepts booleans and rejects unknown or malformed settings', () => {
  const { CATEGORY_VISIBILITY_KEYS } = require('../public/js/store/catalog-schema.mjs');
  const categoryVisibility = Object.fromEntries(CATEGORY_VISIBILITY_KEYS.map((key) => [key, false]));
  assert(validateApiBody('PATCH', '/api/admin/store/content', { categoryVisibility }));
  for (const key of CATEGORY_VISIBILITY_KEYS) {
    assert(!validateApiBody('PATCH', '/api/admin/store/content', { categoryVisibility: { [key]: 'false' } }));
  }
  assert(!validateApiBody('PATCH', '/api/admin/store/content', { categoryVisibility: { unknown: false } }));
});
