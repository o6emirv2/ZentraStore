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

const presets = {
  'pubg-android': { category: 'PUBG Android', platform: 'android', game: 'pubg', inventoryType: 'license' },
  'pubg-ios': { category: 'PUBG iOS', platform: 'ios', game: 'pubg', inventoryType: 'license' },
  gbox: { category: 'GBox', platform: 'ios', game: 'other', inventoryType: 'license', fulfillmentMode: 'telegram_only' },
  'random-account': { category: 'Random Hesap', inventoryType: 'account' },
  'oxide-android': { category: 'Oxide Android', platform: 'android', game: 'oxide', inventoryType: 'license' },
  'oxide-ios': { category: 'Oxide iOS', platform: 'ios', game: 'oxide', inventoryType: 'license' }
};
for (const game of GAME_KEYS.filter((key) => !['pubg', 'oxide', 'other'].includes(key))) {
  presets[game] = { category: GAME_LABELS[game], game, inventoryType: 'license' };
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

export function categoryKey(product = {}) {
  if (Object.hasOwn(CATEGORY_PRESETS, product.categoryKey)) return product.categoryKey;
  if (product.categoryKey === 'custom') return 'custom';
  const category = String(product.category || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/ı/g, 'i');
  if (category === 'gbox' || /^ios-gbox-/.test(product.id || '')) return 'gbox';
  if (product.inventoryType === 'account' || /random.*hesap|random.*account/.test(category)) return 'random-account';
  if (['pubg', 'oxide'].includes(product.game) && ['android', 'ios'].includes(product.platform)) return `${product.game}-${product.platform}`;
  return Object.hasOwn(CATEGORY_PRESETS, product.game) ? product.game : 'custom';
}
