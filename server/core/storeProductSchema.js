'use strict';

const CATEGORY_PRESETS = Object.freeze({
  'pubg-android': { category: 'PUBG Android', platform: 'android', game: 'pubg', inventoryType: 'license' },
  'pubg-ios': { category: 'PUBG iOS', platform: 'ios', game: 'pubg', inventoryType: 'license' },
  gbox: { category: 'GBox', platform: 'ios', game: 'other', inventoryType: 'license', fulfillmentMode: 'telegram_only' },
  'random-account': { category: 'Random Hesap', inventoryType: 'account' },
  'oxide-android': { category: 'Oxide Android', platform: 'android', game: 'oxide', inventoryType: 'license' },
  'oxide-ios': { category: 'Oxide iOS', platform: 'ios', game: 'oxide', inventoryType: 'license' }
});

function failure(code) { return Object.assign(new Error(code), { code, statusCode: 400 }); }

function categoryKey(product = {}) {
  if (Object.hasOwn(CATEGORY_PRESETS, product.categoryKey)) return product.categoryKey;
  if (product.categoryKey === 'custom') return 'custom';
  const category = String(product.category || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/ı/g, 'i');
  if (category === 'gbox' || /^ios-gbox-/.test(product.id || '')) return 'gbox';
  if (product.inventoryType === 'account' || /random.*hesap|random.*account/.test(category)) return 'random-account';
  return ['pubg', 'oxide'].includes(product.game) && ['android', 'ios'].includes(product.platform)
    ? `${product.game}-${product.platform}` : 'custom';
}

function productCategory(input = {}, base = {}, { creating = false } = {}) {
  const key = input.categoryKey === undefined ? categoryKey({ ...base, ...input }) : String(input.categoryKey);
  if (key !== 'custom' && !Object.hasOwn(CATEGORY_PRESETS, key)) throw failure('STORE_PRODUCT_CATEGORY_INVALID');
  const preset = CATEGORY_PRESETS[key];
  if (base.fulfillmentMode === 'telegram_only' && preset?.platform && preset.platform !== base.platform) throw failure('STORE_PRODUCT_CATEGORY_PLATFORM_CONFLICT');
  return {
    categoryKey: key,
    category: preset?.category || String(input.category || base.category || 'Diğer').trim().slice(0, 50),
    platform: preset?.platform || input.platform || base.platform,
    game: preset?.game || input.game || base.game || 'other',
    ...(creating && preset?.inventoryType ? { inventoryType: preset.inventoryType } : {}),
    ...(creating && preset?.fulfillmentMode ? { fulfillmentMode: preset.fulfillmentMode } : {})
  };
}

function normalizeFeatures(value = [], { strict = false } = {}) {
  if (typeof value !== 'string' && !Array.isArray(value)) {
    if (strict) throw failure('STORE_PRODUCT_FEATURES_INVALID');
    return [];
  }
  const rows = typeof value === 'string' ? value.split(/\r?\n/) : value;
  if (strict && rows.some((row) => typeof row !== 'string')) throw failure('STORE_PRODUCT_FEATURES_INVALID');
  const features = rows.filter((row) => typeof row === 'string').map((row) => row
    .replace(/[\u0000-\u001f\u007f]/g, ' ').trim().replace(/^[✅✔☑•\s-]+/u, '')
    .replace(/\s+/g, ' ').trim())
    .filter((row) => row && row.replace(/[🏆\s]/gu, '').toLocaleLowerCase('tr-TR') !== 'özellikler');
  if (strict && (features.length > 40 || features.some((row) => row.length > 160))) throw failure('STORE_PRODUCT_FEATURES_LIMIT');
  return [...new Set(features)].slice(0, 40).map((row) => row.slice(0, 160));
}

module.exports = { CATEGORY_PRESETS, categoryKey, productCategory, normalizeFeatures };
