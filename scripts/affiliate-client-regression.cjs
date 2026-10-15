'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { browserModule } = require('./helpers/browser-module.cjs');
test('transfer amount input accepts Turkish decimals and rejects rounding, exponential notation and invalid limits', async () => {
  const { parseTransferAmount } = await browserModule('public/js/store/wallet-tools.js');
  for (const [input, expected] of [['100,00', 10000], ['100.25', 10025], ['0,04', 4], ['1000000', 100000000]]) assert.equal(parseTransferAmount(input), expected);
  for (const input of ['1,001', '1.005', '1e3', 'NaN', '-100', '0,03', '1.000,00', '1000000,01', '']) assert.equal(parseTransferAmount(input), null);
});
test('referral capture survives navigation, clears its URL parameter and expires after thirty days', async () => {
  const previous = Object.fromEntries(['localStorage', 'location', 'history'].map(key => [key, global[key]]));
  const rows = new Map(), code = 'ZA-' + 'C'.repeat(24); let navigated;
  global.localStorage = { getItem: key => rows.get(key) ?? null, setItem: (key, value) => rows.set(key, value), removeItem: key => rows.delete(key) };
  global.location = { href: `https://store.example/?ref=${code}&category=ios#catalog` };
  global.history = { state: null, replaceState: (_state, _title, url) => { navigated = url; } };
  try {
    const referral = await browserModule('public/js/store/referral.js');
    assert.equal(referral.captureReferral(), code); assert.equal(navigated, '/?category=ios#catalog');
    assert.equal(referral.currentReferral(), code);
    const freshModule = await browserModule('public/js/store/referral.js'); assert.equal(freshModule.currentReferral(), code);
    rows.set('zentra:referral:v1', JSON.stringify({ code, expiresAt: Date.now() - 1 }));
    assert.equal((await browserModule('public/js/store/referral.js')).currentReferral(), '');
    global.location.href = 'https://store.example/?ref=malformed'; referral.captureReferral(); assert.equal(referral.currentReferral(), '');
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete global[key]; else global[key] = value; }
  }
});
