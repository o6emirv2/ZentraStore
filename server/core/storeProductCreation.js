'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const env = require('../config/env');
const { initFirebaseAdmin } = require('../config/firebaseAdmin');
const { normalizeBadgeKey, resolveBadge } = require('./storeBadgeCatalog');

const PRODUCT_ID = /^[a-z][a-z0-9-]{2,63}$/;
const PLAN_ID = /^[a-z][a-z0-9-]{0,39}$/;
const LOCAL_IMAGE = /^\/public\/assets\/products\/[A-Za-z0-9._-]{1,180}$/;
const DEFAULT_IMAGE = '/public/assets/images/zentra-mark.webp';
const MAX_CUSTOM_PRODUCTS = 80;
const MAX_IMAGE_BYTES = 750_000;

function failure(code, statusCode = 400) {
  return Object.assign(new Error(code), { code, statusCode });
}

function safeText(value, max = 80) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max);
}

function isValidProductImage(value) {
  if (typeof value !== 'string' || value.length > 500) return false;
  if (value === DEFAULT_IMAGE) return true;
  if (LOCAL_IMAGE.test(value)) return fs.existsSync(path.join(__dirname, '..', '..', value.slice(1)));
  let parsed;
  try { parsed = new URL(value); } catch (_) { return false; }
  const bucket = String(env.firebase.storageBucket || '').trim();
  if (!bucket || parsed.protocol !== 'https:' || parsed.hostname !== 'firebasestorage.googleapis.com'
    || parsed.username || parsed.password || parsed.port || parsed.hash) return false;
  const match = parsed.pathname.match(/^\/v0\/b\/([^/]+)\/o\/(store-product-images%2F[a-f0-9-]{36}\.(?:png|jpg|webp))$/i);
  if (!match || decodeURIComponent(match[1]) !== bucket || parsed.searchParams.get('alt') !== 'media'
    || !/^[a-f0-9-]{36}$/i.test(parsed.searchParams.get('token') || '')
    || [...parsed.searchParams.keys()].some((key) => !['alt', 'token'].includes(key))) return false;
  return true;
}

function productImage(value = '', fallback = DEFAULT_IMAGE) {
  const image = String(value || '').trim();
  return isValidProductImage(image) ? image : fallback;
}

function normalizeCreatedProduct(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('STORE_PRODUCT_CREATE_INVALID');
  const id = String(value.id || '').trim().toLowerCase();
  if (!PRODUCT_ID.test(id)) throw failure('STORE_PRODUCT_ID_INVALID');
  const name = safeText(value.name, 80);
  const description = safeText(value.description, 240);
  if (name.length < 3 || description.length < 8) throw failure('STORE_PRODUCT_DETAILS_REQUIRED');
  if (!['android', 'ios'].includes(value.platform)) throw failure('STORE_PRODUCT_PLATFORM_INVALID');
  if (!['pubg', 'oxide', 'other'].includes(value.game)) throw failure('STORE_PRODUCT_GAME_INVALID');
  if (!['license', 'account'].includes(value.inventoryType)) throw failure('STORE_PRODUCT_INVENTORY_TYPE_INVALID');
  if (!['automatic', 'telegram_only'].includes(value.fulfillmentMode)) throw failure('STORE_PRODUCT_FULFILLMENT_INVALID');
  if (value.image !== undefined && !isValidProductImage(String(value.image))) throw failure('STORE_PRODUCT_IMAGE_INVALID');
  if (!Array.isArray(value.plans) || value.plans.length < 1 || value.plans.length > 12) throw failure('STORE_PRODUCT_PLANS_INVALID');
  const seen = new Set();
  const plans = value.plans.map((entry) => {
    const key = String(entry?.key || '').trim().toLowerCase();
    const priceKurus = Number(entry?.priceKurus);
    if (!PLAN_ID.test(key) || seen.has(key) || !Number.isSafeInteger(priceKurus) || priceKurus < 1 || priceKurus > 100_000_000) {
      throw failure('STORE_PRODUCT_PLAN_INVALID');
    }
    seen.add(key);
    const label = safeText(entry.label, 50);
    const duration = safeText(entry.duration, 50);
    if (!label || !duration) throw failure('STORE_PRODUCT_PLAN_DETAILS_REQUIRED');
    return { key, label, duration, priceKurus };
  });
  const badgeKey = normalizeBadgeKey(value.badgeKey || 'premium');
  if (!badgeKey) throw failure('STORE_PRODUCT_BADGE_INVALID');
  const badge = resolveBadge({ badgeKey });
  return {
    id,
    name,
    description,
    platform: value.platform,
    game: value.game,
    inventoryType: value.inventoryType,
    inventoryPoolId: '',
    fulfillmentMode: value.fulfillmentMode,
    category: safeText(value.category, 50) || (value.platform === 'ios' ? 'iOS Premium' : 'Android Premium'),
    badgeKey: badge.key,
    badge: badge.label,
    badgeIcon: badge.icon,
    badgeTone: badge.tone,
    icon: 'fa-box',
    image: productImage(value.image),
    accent: '55,165,255',
    featured: value.featured === true,
    sortOrder: 500,
    tags: [],
    plans,
    custom: true
  };
}

function readCustomProducts(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([key, source]) => {
    try {
      const product = normalizeCreatedProduct(source);
      return product.id === key ? [product] : [];
    } catch (_) { return []; }
  });
}

function sniffImage(bytes) {
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString() === 'RIFF'
    && bytes.subarray(8, 12).toString() === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return { ext: 'png', mime: 'image/png' };
  if (bytes.length >= 4 && bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')) && bytes.subarray(-2).equals(Buffer.from('ffd9', 'hex'))) return { ext: 'jpg', mime: 'image/jpeg' };
  return null;
}

async function uploadProductImage(dataUrl) {
  if (typeof dataUrl !== 'string' || dataUrl.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 100) throw failure('STORE_PRODUCT_IMAGE_TOO_LARGE', 413);
  const match = dataUrl.match(/^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) throw failure('STORE_PRODUCT_IMAGE_INVALID');
  const bytes = Buffer.from(match[1], 'base64');
  const detected = sniffImage(bytes);
  if (!detected || bytes.length < 32 || bytes.length > MAX_IMAGE_BYTES) throw failure('STORE_PRODUCT_IMAGE_INVALID');
  const firebase = initFirebaseAdmin();
  const bucketName = String(env.firebase.storageBucket || '').trim();
  if (!firebase.enabled || !firebase.app || !bucketName) throw failure('STORE_PRODUCT_IMAGE_STORAGE_UNAVAILABLE', 503);
  const name = `store-product-images/${crypto.randomUUID()}.${detected.ext}`;
  const token = crypto.randomUUID();
  const file = firebase.admin.storage(firebase.app).bucket(bucketName).file(name);
  await file.save(bytes, {
    resumable: false,
    contentType: detected.mime,
    metadata: { cacheControl: 'public, max-age=31536000, immutable', metadata: { firebaseStorageDownloadTokens: token } }
  });
  return `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(bucketName)}/o/${encodeURIComponent(name)}?alt=media&token=${token}`;
}

module.exports = { MAX_CUSTOM_PRODUCTS, normalizeCreatedProduct, readCustomProducts, isValidProductImage, productImage, uploadProductImage };
