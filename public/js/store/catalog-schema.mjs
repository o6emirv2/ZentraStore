export const GAME_LABELS = Object.freeze({
  pubg: 'PUBG MOBILE',
  oxide: 'OXİDE'
});

export const GAME_KEYS = Object.freeze(Object.keys(GAME_LABELS));

const presets = {
  'pubg-android': { category: 'PUBG MOBILE Android', platform: 'android', game: 'pubg', inventoryType: 'license' },
  'pubg-ios': { category: 'PUBG MOBILE iOS', platform: 'ios', game: 'pubg', inventoryType: 'license' },
  'oxide-android': { category: 'OXİDE Android', platform: 'android', game: 'oxide', inventoryType: 'license' },
  'oxide-ios': { category: 'OXİDE iOS', platform: 'ios', game: 'oxide', inventoryType: 'license' }
};
export const CATEGORY_PRESETS = Object.freeze(Object.fromEntries(
  Object.entries(presets).map(([key, preset]) => [key, Object.freeze(preset)])
));

const filterLabels = {
  'pubg-ios': 'PUBG MOBILE İOS', 'pubg-android': 'PUBG MOBILE ANDROİD',
  'oxide-ios': 'OXİDE İOS', 'oxide-android': 'OXİDE ANDROİD'
};
export const CATALOG_FILTERS = Object.freeze(Object.fromEntries([
  ['all', { label: 'Tüm Ürünler', platform: '', game: '' }],
  ['android', { label: 'Android Ürünleri', platform: 'android', game: '' }],
  ['ios', { label: 'iOS Ürünleri', platform: 'ios', game: '' }],
  ['favorites', { label: 'Favori Ürünlerin', platform: '', game: '' }],
  ...Object.entries(CATEGORY_PRESETS).map(([key, preset]) => [key, {
    label: filterLabels[key] || preset.category,
    platform: preset.platform, game: preset.game
  }])
].map(([key, value]) => [key, Object.freeze(value)])));

export const CATEGORY_VISIBILITY_KEYS = Object.freeze(['android', 'ios', ...Object.keys(CATEGORY_PRESETS)]);

export function normalizeCategoryKey(value, platform) {
  const key = String(value || '');
  const candidate = GAME_KEYS.includes(key) ? `${key}-${platform}` : key;
  return Object.hasOwn(CATEGORY_PRESETS, candidate) ? candidate : '';
}

export function expandCategoryVisibility(source = {}) {
  const value = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
  return Object.fromEntries(CATEGORY_VISIBILITY_KEYS.filter((key) => typeof value[key] === 'boolean').map((key) => [key, value[key]]));
}

export function normalizeCategoryVisibility(source = {}) {
  const expanded = expandCategoryVisibility(source);
  return Object.fromEntries(CATEGORY_VISIBILITY_KEYS.map((key) => [key, expanded[key] !== false]));
}

export function categoryKey(product = {}) {
  if (!product || typeof product !== 'object' || Array.isArray(product)) return '';
  return normalizeCategoryKey(product.categoryKey || `${product.game}-${product.platform}`, product.platform);
}

export function isSupportedProduct(product = {}) {
  if (!product || typeof product !== 'object' || Array.isArray(product)) return false;
  const preset = CATEGORY_PRESETS[categoryKey(product)];
  return Boolean(preset && preset.game === product.game && preset.platform === product.platform);
}

export function normalizeProductId(value) {
  if (typeof value !== 'string') return '';
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/ı/g, 'i').trim().replace(/[\u2010-\u2015\u2212]/g, '-');
}
export function validProductId(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9-]{2,63}$/.test(value);
}
export function suggestProductId(name = '', category = '') {
  return normalizeProductId(`${category}-${name}`).replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-').replace(/^-+|-+$/g, '').replace(/^[^a-z]+/, '').slice(0, 64).replace(/-+$/, '');
}
