'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { browserModule } = require('./helpers/browser-module.cjs');

test('redirect requires verified provider payment and committed wallet settlement', async () => {
  const { verifiedPaymentComplete, paymentNeedsRefresh } = await browserModule('public/js/store/shopier-payment-state.js');
  const paid = { paymentMethod: 'shopier', paymentState: 'paid', orderType: 'wallet_topup', paidAt: Date.now(),
    shopier: { state: 'paid', orderId: 'provider-123', verifiedAt: Date.now(), refundStatus: 'none' }, walletTopup: { settledAt: Date.now() } };
  assert.equal(verifiedPaymentComplete(paid), true);
  for (const patch of [{ paymentState: 'pending' }, { paidAt: 0 }, { shopier: { ...paid.shopier, state: 'paid_review' } },
    { walletTopup: { settledAt: 0 } }, { shopier: { ...paid.shopier, refundedKurus: 1 } }, { shopier: { ...paid.shopier, refundStatus: 'pending' } }]) {
    assert.equal(verifiedPaymentComplete({ ...paid, ...patch }), false);
  }
  assert.equal(verifiedPaymentComplete({ status: 'paid', paymentState: 'paid' }), false);
  assert.equal(paymentNeedsRefresh({ paymentState: 'pending' }), true);
  assert.equal(paymentNeedsRefresh(paid), false);
  assert.equal(paymentNeedsRefresh({ ...paid, walletTopup: {} }), true);
});

test('payment return never accepts a query redirect or an insecure arbitrary destination', async () => {
  const { paymentReturnUrl } = await browserModule('public/js/store/shopier-payment-state.js');
  assert.equal(paymentReturnUrl({ canonicalOrigin: 'https://zentrastore.com.tr' }), 'https://zentrastore.com.tr/');
  for (const canonicalOrigin of ['javascript:alert(1)', 'https://evil.invalid/path', 'https://evil.invalid', 'https://name:password@evil.invalid', 'http://evil.invalid', 'https://zentrastore.com.tr/?next=evil']) {
    assert.equal(paymentReturnUrl({ canonicalOrigin }), 'https://zentrastore.com.tr/');
  }
  assert.equal(paymentReturnUrl({ canonicalOrigin: 'http://127.0.0.1:1234' }, 'http://127.0.0.1:1234'), 'http://127.0.0.1:1234/');
});
