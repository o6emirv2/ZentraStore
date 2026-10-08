'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { resolveBadge } = require('./storeBadgeCatalog');
const assetDirectory = path.resolve(__dirname, '../../public/assets/products');
const ID = /^[a-z0-9][a-z0-9-]{1,79}$/;
const PLAN = /^[a-z0-9][a-z0-9-]{1,39}$/;
const ASSET = /^\/public\/assets\/products\/([A-Za-z0-9._-]+\.(?:png|PNG|jpg|JPG|jpeg|webp|svg))$/;
const ALLOWED = new Set(['id', 'name', 'platform', 'game', 'description', 'image', 'badgeKey', 'inventoryType', 'fulfillmentMode', 'plans']);

function invalid(code = 'STORE_PRODUCT_SETTINGS_INVALID') {
  throw Object.assign(new Error(code), { code, statusCode: 400 });
}
function text(value, max) {
  if (typeof value !== 'string' || value.trim().length > max || /[\u0000-\u001f\u007f<>]/.test(value)) invalid();
  return value.trim();
}
function productAssetOptions() {
  return fs.readdirSync(assetDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && ASSET.test(`/public/assets/products/${entry.name}`))
    .map((entry) => ({ name: entry.name, path: `/public/assets/products/${entry.name}` }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
function productAssetExists(image) {
  const match = typeof image === 'string' ? image.match(ASSET) : null;
  if (!match) return false;
  const filename = path.join(assetDirectory, match[1]);
  return fs.existsSync(filename) && fs.statSync(filename).isFile();
}
function normalizeCustomProduct(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !ALLOWED.has(key))) invalid();
  const id = text(input.id, 80).toLowerCase();
  const name = text(input.name, 80);
  if (!ID.test(id) || name.length < 2) invalid('STORE_PRODUCT_ID_INVALID');
  if (!['android', 'ios'].includes(input.platform) || !['pubg', 'oxide', 'other'].includes(input.game)) invalid('STORE_PRODUCT_PLATFORM_INVALID');
  const image = text(input.image, 300);
  if (!productAssetExists(image)) invalid('STORE_PRODUCT_IMAGE_INVALID');
  const inventoryType = input.inventoryType || 'license';
  const fulfillmentMode = input.fulfillmentMode || 'automatic';
  if (!['license', 'account'].includes(inventoryType) || !['automatic', 'telegram_only'].includes(fulfillmentMode)) invalid('STORE_PRODUCT_SETTINGS_INVALID');
  const badge = resolveBadge({ badgeKey: input.badgeKey || 'premium' });
  if (badge.key !== (input.badgeKey || 'premium')) invalid('STORE_PRODUCT_BADGE_INVALID');
  if (!Array.isArray(input.plans) || input.plans.length < 1 || input.plans.length > 8) invalid('STORE_SKU_INVALID');
  const seen = new Set();
  const plans = input.plans.map((source) => {
    if (!source || typeof source !== 'object' || Array.isArray(source) || Object.keys(source).some((key) => !['key', 'label', 'duration', 'priceKurus'].includes(key))) invalid('STORE_SKU_INVALID');
    const key = text(source.key, 40).toLowerCase();
    const label = text(source.label, 50);
    const duration = text(source.duration, 50);
    if (!PLAN.test(key) || seen.has(key) || !label || !duration || !Number.isSafeInteger(source.priceKurus) || source.priceKurus < 1 || source.priceKurus > 100_000_000) invalid('STORE_PRODUCT_PRICE_INVALID');
    seen.add(key);
    return { key, label, duration, priceKurus: source.priceKurus };
  });
  return { id, name, platform: input.platform, game: input.game, image, description: text(input.description || '', 240), inventoryType, inventoryPoolId: '', fulfillmentMode, badgeKey: badge.key, badge: badge.label, badgeIcon: badge.icon, badgeTone: badge.tone, icon: inventoryType === 'account' ? 'fa-user-shield' : 'fa-box', accent: '8,127,132', featured: false, sortOrder: 500, tags: ['new'], plans };
}

module.exports = { normalizeCustomProduct, productAssetExists, productAssetOptions };
