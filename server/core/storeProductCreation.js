'use strict';

const fs = require('node:fs');
const path = require('node:path');
const env = require('../config/env');
const { productCategory, normalizeFeatures } = require('./storeProductSchema');
const { normalizeBadgeKey, resolveBadge } = require('./storeBadgeCatalog');

const PRODUCT_ID = /^[a-z][a-z0-9-]{2,63}$/;
const PLAN_ID = /^[a-z][a-z0-9-]{0,39}$/;
const LOCAL_IMAGE = /^\/public\/assets\/(?:products|images)\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.(?:jpe?g|png|svg|webp|gif|avif|bmp|ico)$/i;
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_IMAGE = '/public/assets/images/zentra-mark.webp';
const MAX_CUSTOM_PRODUCTS = 80;

function failure(code, statusCode = 400) {
  return Object.assign(new Error(code), { code, statusCode });
}

function safeText(value, max = 80) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max);
}

function isValidProductImage(value) {
  if (typeof value !== 'string' || value.length > 500) return false;
  const local = normalizeImagePath(value);
  if (LOCAL_IMAGE.test(local) && local.length <= 300) {
    try {
      const target = fs.realpathSync(path.join(PROJECT_ROOT, local.slice(1)));
      return target.startsWith(`${PROJECT_ROOT}${path.sep}public${path.sep}assets${path.sep}`) && fs.statSync(target).isFile();
    } catch (_) { return false; }
  }
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

function normalizeImagePath(value = '') {
  const image = String(value || '').trim();
  return image.startsWith('public/') ? `/${image}` : image;
}

function productImage(value = '', fallback = DEFAULT_IMAGE) {
  const image = normalizeImagePath(value);
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
  const category = productCategory(value, {}, { creating: true });
  const categoryImage = category.categoryKey === 'gbox' ? '/public/assets/products/gbox.jpeg' : category.categoryKey === 'random-account' ? '/public/assets/products/random.jpeg' : '';
  return {
    id,
    name,
    description,
    features: normalizeFeatures(value.features === undefined ? [] : value.features, { strict: true }),
    platform: value.platform,
    game: value.game,
    inventoryType: value.inventoryType,
    inventoryPoolId: '',
    fulfillmentMode: value.fulfillmentMode,
    ...category,
    badgeKey: badge.key,
    badge: badge.label,
    badgeIcon: badge.icon,
    badgeTone: badge.tone,
    icon: 'fa-box',
    image: productImage(value.image || categoryImage),
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
      const product = normalizeCreatedProduct({ ...source, image: productImage(source?.image), features: normalizeFeatures(source?.features || []) });
      return product.id === key ? [product] : [];
    } catch (_) { return []; }
  });
}

module.exports = { MAX_CUSTOM_PRODUCTS, normalizeCreatedProduct, readCustomProducts, isValidProductImage, productImage };
