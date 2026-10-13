'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const legacySecret = crypto.randomBytes(64).toString('hex');
const activeSecret = crypto.randomBytes(64).toString('hex');
const fingerprintSecret = crypto.randomBytes(64).toString('hex');
process.env.NODE_ENV = 'production';
process.env.STORE_KEY_ACTIVE_KEY_ID = 'vault-2026-v2';
process.env.STORE_KEY_ENCRYPTION_SECRET = activeSecret;
process.env.STORE_KEY_FINGERPRINT_SECRET = fingerprintSecret;
process.env.STORE_KEY_DECRYPTION_KEYS_JSON = JSON.stringify({ 'legacy-v1': legacySecret });
process.env.PUBLIC_FIREBASE_CONFIG = JSON.stringify({
  apiKey: 'nonsecret-demo-key',
  authDomain: 'demo.firebaseapp.com',
  projectId: 'demo',
  appId: '1:demo:web:abc'
});

const env = require('../server/config/env');
const vault = require('../server/core/storeKeyVault');
const links = require('../server/core/storeLinks');
const catalog = require('../public/data/store-products.json');

function encryptWithHistoricalV3(plaintext, context) {
  const id = 'legacy-v1';
  // Reference protocol values: existing Firestore ciphertexts cannot be rebranded in-place.
  const aad = Buffer.from(`shelby-ios-store-inventory:v3:${id}:${JSON.stringify(context)}`, 'utf8');
  const wrappingKey = crypto.createHash('sha256')
    .update('shelby-ios-key-encryption:v2\0')
    .update(id).update('\0').update(legacySecret).digest();
  const dataKey = crypto.randomBytes(32);
  const wrapIv = crypto.randomBytes(12);
  const wrapper = crypto.createCipheriv('aes-256-gcm', wrappingKey, wrapIv);
  wrapper.setAAD(aad);
  const wrappedKey = Buffer.concat([wrapper.update(dataKey), wrapper.final()]);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', dataKey, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    version: 3, keyId: id, algorithm: 'A256GCM',
    iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
    wrapIv: wrapIv.toString('base64url'), wrapTag: wrapper.getAuthTag().toString('base64url'),
    wrappedKey: wrappedKey.toString('base64url')
  };
}

test('canonical origins reject malformed URLs, credentials and non-root paths', () => {
  assert.equal(env.normalizeOrigin('https://zentrastore.com.tr/'), 'https://zentrastore.com.tr');
  for (const input of ['https//www.zentrastore.com.tr', 'https://user:pass@zentrastore.com.tr', 'javascript:alert(1)', 'https://zentrastore.com.tr/attack', 'https://zentrastore.com.tr?q=1']) {
    assert.equal(env.normalizeOrigin(input), '', input);
  }
});

test('one structured Firebase public configuration is consumed correctly', () => {
  assert.equal(env.firebase.publicConfigSource, 'structured-environment');
  assert.equal(env.firebase.projectId, 'demo');
  assert.equal(env.firebase.publicConfig.apiKey, 'nonsecret-demo-key');
});

test('missing production credentials never constitute a ready deployment', () => {
  const report = env.configurationReport();
  assert.equal(report.ready, false);
  assert.ok(report.missing.includes('FIREBASE_KEY'));
  assert.ok(report.missing.includes('PUBLIC_FIREBASE_APP_CHECK_SITE_KEY'));
});

test('brand protocol migration retains decrypt access to historically encrypted inventory', () => {
  const context = { recordType: 'inventory', recordId: 'item-1', sku: 'product:month', productId: 'product', planKey: 'month', orderId: '', uid: '' };
  const encrypted = encryptWithHistoricalV3('OLD_STOCK_CODE', context);
  assert.equal(vault.decryptSecret(encrypted, context), 'OLD_STOCK_CODE');
});

test('newly encrypted inventory decrypts with the new active key and context binding', () => {
  const context = { recordType: 'inventory', recordId: 'item-2', sku: 'product:month', productId: 'product', planKey: 'month' };
  const record = vault.encryptSecret('NEW_STOCK_CODE', context);
  assert.equal(record.keyId, 'vault-2026-v2');
  assert.equal(vault.decryptSecret(record, context), 'NEW_STOCK_CODE');
  assert.throws(() => vault.decryptSecret(record, { ...context, productId: 'other' }), /STORE_KEY_DECRYPTION_FAILED/);
});

test('inventory fingerprints preserve historical domain separators for duplicate checks', () => {
  const value = 'STOCK_ITEM_123';
  const historical = crypto.createHmac('sha256', fingerprintSecret)
    .update('shelby-ios-key-fingerprint:v1\0').update(value).digest('hex');
  assert.equal(vault.fingerprintSecret(value), historical);
});

test('user-provided links are complete, unique and limited to permitted platforms', () => {
  assert.equal(links.CHANNEL_LINKS_REVISION, 70);
  assert.equal(links.DEFAULT_QUICK_LINKS.length, 7);
  assert.equal(new Set(links.DEFAULT_QUICK_LINKS.map((link) => link.url)).size, 7);
  for (const link of links.DEFAULT_QUICK_LINKS) assert.equal(links.normalizeQuickLinkUrl(link.platform, link.url), link.url);
  assert.equal(links.TIKTOK_OFFICIAL_URL, 'https://www.tiktok.com/@shelbystorelive');
  assert.throws(() => links.normalizeQuickLinkUrl('telegram', 'javascript:alert(1)'));
  assert.throws(() => links.normalizeQuickLinkUrl('telegram', 'https://t.me@evil.com/+AAAAAAAAAA'));
});

test('product catalog paths exist on case-sensitive Linux filesystems', () => {
  assert.equal(catalog.products.length, 22);
  for (const product of catalog.products) {
    assert.ok(fs.existsSync(path.join(root, product.image)), `${product.id}: ${product.image}`);
    assert.ok(product.plans.every((plan) => Number.isSafeInteger(plan.priceKurus) && plan.priceKurus > 0), product.id);
  }
});

test('Firestore client policy denies balance and order document writes', () => {
  assert.match(fs.readFileSync(path.join(root, 'firestore.rules'), 'utf8'), /allow read, write:\s*if false\s*;/);
});

test('static HTML and server social source agree on link destinations', () => {
  const page = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  for (const link of links.DEFAULT_QUICK_LINKS) assert.ok(page.includes(`href="${link.url}"`), link.id);
  assert.ok(page.includes('<link rel="canonical" href="https://zentrastore.com.tr/"'));
});
