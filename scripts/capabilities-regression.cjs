'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const { mockModule } = require('./helpers/memory-firestore.cjs');
const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
Object.assign(process.env, {
  NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://store.zentra.invalid', PUBLIC_BACKEND_ORIGIN: 'https://api.zentra.invalid',
  FIREBASE_KEY: JSON.stringify({ type: 'service_account', project_id: 'zentra-scope', client_email: 'svc@zentra-scope.iam.gserviceaccount.com', private_key: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) }),
  PUBLIC_FIREBASE_CONFIG: JSON.stringify({ apiKey: crypto.randomBytes(30).toString('base64url'), authDomain: 'zentra-scope.firebaseapp.com', projectId: 'zentra-scope', appId: '1:100:web:scope' }),
  ADMIN_EMAILS: 'owner@zentra.invalid', ADMIN_UIDS: 'owneruid', APP_CHECK_MODE: 'monitor', ADMIN_TOTP_MODE: 'optional',
  ADMIN_GATE_FOUR_SALT_HEX: crypto.randomBytes(32).toString('hex'), ADMIN_GATE_FOUR_HASH_HEX: crypto.randomBytes(32).toString('hex'),
  ADMIN_GATE_FIVE_SALT_HEX: crypto.randomBytes(32).toString('hex'), ADMIN_GATE_FIVE_HASH_HEX: crypto.randomBytes(32).toString('hex'), ADMIN_GATE_SIGNING_SECRET: crypto.randomBytes(48).toString('base64url')
});
for (const key of ['STORE_KEY_ENCRYPTION_SECRET', 'STORE_KEY_FINGERPRINT_SECRET', 'STORE_KEY_DECRYPTION_KEYS_JSON']) delete process.env[key];
const env = require('../server/config/env');
mockModule('../../server/config/firebaseAdmin', { initFirebaseAdmin: () => ({ enabled: true, db: {}, auth: {} }) });
const { sensitiveConfigurationGuard } = require('../server/core/runtimeHealth');
function guard(path, body = {}) {
  let called = false, status = 0, payload;
  sensitiveConfigurationGuard({ method: 'POST', originalUrl: path, body, requestId: 'controlled-scope' }, { status(value) { status = value; return this; }, json(value) { payload = value; } }, () => { called = true; });
  return { called, status, payload };
}
test('real production configuration separates administrator readiness from a missing key vault', () => {
  const result = env.configurationReport(); assert.equal(result.ready, false); assert.equal(result.capabilities.identity, true); assert.equal(result.capabilities.admin, true); assert.equal(result.capabilities.vault, false);
  assert(result.missing.includes('STORE_KEY_ENCRYPTION_SECRET')); assert(result.warnings.includes('APP_CHECK_NOT_ENFORCED'));
});
test('product and content operations are not blocked by an unrelated missing stock secret', () => {
  assert.equal(guard('/api/admin/store/products').called, true);
  assert.equal(guard('/api/admin/action-proof', { path: '/api/admin/store/products' }).called, true);
  assert.equal(guard('/api/admin/store/content').called, true);
});
test('stock proof, import and automatic purchases still fail closed without their vault', () => {
  for (const [path, body] of [['/api/admin/store/inventory/import', {}], ['/api/admin/action-proof', { path: '/api/admin/store/inventory/import' }], ['/api/store/orders', {}]]) {
    const result = guard(path, body); assert.equal(result.called, false); assert.equal(result.status, 503); assert.equal(result.payload.error, 'SERVICE_NOT_READY');
  }
});
