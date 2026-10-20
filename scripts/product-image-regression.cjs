'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { mockModule } = require('./helpers/memory-firestore.cjs');
process.env.PUBLIC_FIREBASE_STORAGE_BUCKET = 'images.firebasestorage.app';
const saved = [];
let failSave = false;
mockModule('../../server/config/firebaseAdmin', { initFirebaseAdmin: () => ({ app: {}, admin: { storage: () => ({ bucket: () => ({ file: name => ({ name,
  save: async (bytes, options) => { if (failSave) throw new Error('storage denied'); saved.push({ bytes, options, name }); },
  delete: async () => {} }) }) }) } }) });
const { readImageUpload, uploadProductImage, MAX_IMAGE_BASE64 } = require('../server/core/storeProductImages');
const jpeg = fs.readFileSync(require('node:path').join(__dirname, '../public/assets/products/gbox.jpeg'));

test('raster upload validates content, dimensions, canonical encoding and size before storage', () => {
  assert.deepEqual(readImageUpload({ data: jpeg.toString('base64') }), jpeg);
  for (const data of [Buffer.from('<svg onload="alert(1)"/>').toString('base64'), jpeg.toString('base64') + '\n', 'a'.repeat(MAX_IMAGE_BASE64 + 1), jpeg.subarray(0, 100).toString('base64')]) {
    assert.throws(() => readImageUpload({ data }), { code: 'STORE_PRODUCT_IMAGE_UPLOAD_INVALID' });
  }
  const large = Buffer.from(jpeg);
  for (let i = 0; i < large.length - 9; i++) if (large[i] === 0xff && [0xc0, 0xc1, 0xc2].includes(large[i + 1])) { large.writeUInt16BE(2000, i + 5); break; }
  assert.throws(() => readImageUpload({ data: large.toString('base64') }), { code: 'STORE_PRODUCT_IMAGE_UPLOAD_INVALID' });
  assert.throws(() => readImageUpload({ data: jpeg.toString('base64'), path: '../private' }), { code: 'STORE_PRODUCT_IMAGE_UPLOAD_INVALID' });
});

test('stored image gets an opaque path, fixed MIME, generation guard and configured bucket URL', async () => {
  const image = await uploadProductImage({ data: jpeg.toString('base64') });
  assert.match(image.url, /^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/images.firebasestorage.app\/o\/store-product-images%2F[a-f0-9-]+\.jpg\?alt=media&token=[a-f0-9-]+$/);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].options.metadata.contentType, 'image/jpeg');
  assert.equal(saved[0].options.preconditionOpts.ifGenerationMatch, 0);
  assert.equal(saved[0].bytes.equals(jpeg), true);
  assert(!saved[0].name.includes('gbox'));
  assert.equal(typeof image.discard, 'function');
  failSave = true;
  await assert.rejects(uploadProductImage({ data: jpeg.toString('base64') }), { code: 'STORE_PRODUCT_IMAGE_STORAGE_UNAVAILABLE' });
});

test('large image allowance is scoped to product creation without widening other body limits', () => {
  const { inspectBody } = require('../server/core/requestSecurity');
  const data = crypto.randomBytes(200000).toString('base64');
  assert.equal(inspectBody({ imageUpload: { data } }), false);
  assert.equal(inspectBody({ imageUpload: { data } }, { allowProductImage: true }), true);
  assert.equal(inspectBody({ description: data }, { allowProductImage: true }), false);
  assert.equal(inspectBody({ extra: { imageUpload: { data } } }, { allowProductImage: true }), false);
});
