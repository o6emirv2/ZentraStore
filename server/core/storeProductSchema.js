'use strict';

const { CATEGORY_PRESETS, categoryKey, normalizeCategoryKey } = require('../../public/js/store/catalog-schema.mjs');

function failure(code) { return Object.assign(new Error(code), { code, statusCode: 400 }); }

function productCategory(input = {}, base = {}, { creating = false } = {}) {
  const key = input.categoryKey === undefined ? categoryKey({ ...base, ...input })
    : normalizeCategoryKey(input.categoryKey, input.platform || base.platform);
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
