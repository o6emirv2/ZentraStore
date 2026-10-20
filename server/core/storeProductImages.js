'use strict';

const crypto = require('node:crypto');
const env = require('../config/env');
const { initFirebaseAdmin } = require('../config/firebaseAdmin');
const MAX_IMAGE_BYTES = 1024 * 1024;
const MAX_IMAGE_BASE64 = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
function failure(code, statusCode = 400) { return Object.assign(new Error(code), { code, statusCode }); }

function readImageUpload(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'data')
    || typeof input.data !== 'string' || input.data.length > MAX_IMAGE_BASE64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.data)) throw failure('STORE_PRODUCT_IMAGE_UPLOAD_INVALID');
  const bytes = Buffer.from(input.data, 'base64');
  if (bytes.toString('base64') !== input.data || bytes.length < 32 || bytes.length > MAX_IMAGE_BYTES
    || bytes.readUInt16BE(0) !== 0xffd8 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) throw failure('STORE_PRODUCT_IMAGE_UPLOAD_INVALID');
  let offset = 2, dimensions = null;
  while (offset + 4 < bytes.length) {
    if (bytes[offset++] !== 0xff) throw failure('STORE_PRODUCT_IMAGE_UPLOAD_INVALID');
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9) break;
    if (offset + 2 > bytes.length) throw failure('STORE_PRODUCT_IMAGE_UPLOAD_INVALID');
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) throw failure('STORE_PRODUCT_IMAGE_UPLOAD_INVALID');
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (dimensions || length < 8 || bytes[offset + 2] !== 8) throw failure('STORE_PRODUCT_IMAGE_UPLOAD_INVALID');
      dimensions = { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  if (!dimensions || dimensions.width < 1 || dimensions.height < 1 || dimensions.width > 1600 || dimensions.height > 1600) throw failure('STORE_PRODUCT_IMAGE_UPLOAD_INVALID');
  return bytes;
}

async function uploadProductImage(input) {
  const bytes = readImageUpload(input);
  const bucketName = env.firebase.storageBucket;
  const { app, admin } = initFirebaseAdmin();
  if (!bucketName || !app || !admin?.storage) throw failure('STORE_PRODUCT_IMAGE_STORAGE_UNAVAILABLE', 503);
  const file = admin.storage(app).bucket(bucketName).file(`store-product-images/${crypto.randomUUID()}.jpg`);
  const token = crypto.randomUUID();
  try {
    await file.save(bytes, { resumable: false, timeout: 15000, validation: 'crc32c', preconditionOpts: { ifGenerationMatch: 0 },
      metadata: { contentType: 'image/jpeg', cacheControl: 'public,max-age=31536000,immutable', metadata: { firebaseStorageDownloadTokens: token } } });
  } catch (_) { throw failure('STORE_PRODUCT_IMAGE_STORAGE_UNAVAILABLE', 503); }
  return { url: `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(bucketName)}/o/${encodeURIComponent(file.name)}?alt=media&token=${token}`,
    discard: () => file.delete({ ignoreNotFound: true }) };
}

module.exports = { MAX_IMAGE_BYTES, MAX_IMAGE_BASE64, readImageUpload, uploadProductImage };
