export const GAME_LABELS = Object.freeze({
  pubg: 'PUBG Mobile',
  oxide: 'Oxide',
  'delta-force': 'DELTA FORCE',
  valorant: 'VALORANT',
  codm: 'CODM',
  bloodstrike: 'BLOODSTRIKE',
  'standoff-2': 'STANDOFF 2',
  'mobile-legends': 'MOBILE LEGENDS',
  '8ball-pool': '8BALL POOL',
  'free-fire': 'FREE FIRE',
  other: 'Diğer'
});

export const GAME_KEYS = Object.freeze(Object.keys(GAME_LABELS));
export const LEGACY_GAME_CATEGORY_KEYS = Object.freeze(GAME_KEYS.filter((key) => !['pubg', 'oxide', 'other'].includes(key)));

const presets = {
  'pubg-android': { category: 'PUBG Android', platform: 'android', game: 'pubg', inventoryType: 'license' },
  'pubg-ios': { category: 'PUBG iOS', platform: 'ios', game: 'pubg', inventoryType: 'license' },
  gbox: { category: 'GBox', platform: 'ios', game: 'other', inventoryType: 'license', fulfillmentMode: 'telegram_only' },
  'random-account': { category: 'Random Hesap', inventoryType: 'account' },
  'oxide-android': { category: 'Oxide Android', platform: 'android', game: 'oxide', inventoryType: 'license' },
  'oxide-ios': { category: 'Oxide iOS', platform: 'ios', game: 'oxide', inventoryType: 'license' }
};
for (const game of LEGACY_GAME_CATEGORY_KEYS) {
  for (const platform of ['ios', 'android']) {
    presets[`${game}-${platform}`] = {
      category: `${GAME_LABELS[game]} ${platform === 'ios' ? 'iOS' : 'Android'}`,
      platform, game, inventoryType: 'license'
    };
  }
}
export const CATEGORY_PRESETS = Object.freeze(Object.fromEntries(
  Object.entries(presets).map(([key, preset]) => [key, Object.freeze(preset)])
));

const filterLabels = {
  'pubg-ios': 'PUBG İOS', 'pubg-android': 'PUBG ANDROİD',
  'oxide-ios': 'OXİDE İOS', 'oxide-android': 'OXİDE ANDROİD',
  gbox: 'GBOX', 'random-account': 'RANDOM HESAPLAR'
};
export const CATALOG_FILTERS = Object.freeze(Object.fromEntries([
  ['all', { label: 'Tüm Ürünler', platform: '', game: '' }],
  ['android', { label: 'Android Ürünleri', platform: 'android', game: '' }],
  ['ios', { label: 'iOS Ürünleri', platform: 'ios', game: '' }],
  ['favorites', { label: 'Favori Ürünlerin', platform: '', game: '' }],
  ...Object.entries(CATEGORY_PRESETS).map(([key, preset]) => [key, {
    label: filterLabels[key] || preset.category,
    platform: preset.platform || '', game: preset.game === 'other' ? '' : preset.game || ''
  }])
].map(([key, value]) => [key, Object.freeze(value)])));

export const CATEGORY_VISIBILITY_KEYS = Object.freeze(['android', 'ios', ...Object.keys(CATEGORY_PRESETS)]);

export function normalizeCategoryKey(value, platform) {
  const key = String(value || '');
  return LEGACY_GAME_CATEGORY_KEYS.includes(key) && ['android', 'ios'].includes(platform) ? `${key}-${platform}` : key;
}

export function expandCategoryVisibility(source = {}) {
  const value = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
  const expanded = { ...value };
  for (const game of LEGACY_GAME_CATEGORY_KEYS) {
    if (typeof value[game] !== 'boolean') continue;
    for (const platform of ['ios', 'android']) {
      const key = `${game}-${platform}`;
      if (!Object.hasOwn(value, key)) expanded[key] = value[game];
    }
  }
  return expanded;
}

export function normalizeCategoryVisibility(source = {}) {
  const expanded = expandCategoryVisibility(source);
  return Object.fromEntries(CATEGORY_VISIBILITY_KEYS.map((key) => [key, expanded[key] !== false]));
}

export function categoryKey(product = {}) {
  const key = normalizeCategoryKey(product.categoryKey, product.platform);
  if (Object.hasOwn(CATEGORY_PRESETS, key)) return key;
  if (key === 'custom') return 'custom';
  const category = String(product.category || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/ı/g, 'i');
  if (category === 'gbox' || /^ios-gbox-/.test(product.id || '')) return 'gbox';
  if (product.inventoryType === 'account' || /random.*hesap|random.*account/.test(category)) return 'random-account';
  const inferred = `${product.game}-${product.platform}`;
  return Object.hasOwn(CATEGORY_PRESETS, inferred) ? inferred : 'custom';
}
