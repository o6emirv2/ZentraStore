import { normalizeQuickLinks } from './social-links.js?v=audit-20260908-v1';

let catalogCache = null;
let catalogCachedAt = 0;
let catalogLoad = null;

const CANONICAL_PRODUCT_NAMES = Object.freeze({
  'android-contra-hax': 'CONTRAHAX',
  'ios-dolphin': 'DelphinİOS'
});

export const CATALOG_FILTERS = Object.freeze({
  all: Object.freeze({ label: 'Tüm Ürünler', platform: '', game: '' }),
  android: Object.freeze({ label: 'Android Ürünleri', platform: 'android', game: '' }),
  ios: Object.freeze({ label: 'iOS Ürünleri', platform: 'ios', game: '' }),
  favorites: Object.freeze({ label: 'Favori Ürünlerin', platform: '', game: '' }),
  'pubg-ios': Object.freeze({ label: 'PUBG İOS', platform: 'ios', game: 'pubg' }),
  'pubg-android': Object.freeze({ label: 'PUBG ANDROİD', platform: 'android', game: 'pubg' }),
  'oxide-ios': Object.freeze({ label: 'OKSİDE İOS', platform: 'ios', game: 'oxide' }),
  'oxide-android': Object.freeze({ label: 'OKSİDE ANDROİD', platform: 'android', game: 'oxide' })
});

export function resolveCatalogFilter(value = 'all', visibility = {}) {
  const key = Object.prototype.hasOwnProperty.call(CATALOG_FILTERS, value) ? value : 'all';
  const filter = CATALOG_FILTERS[key];
  return filter.platform && visibility[filter.platform] === false ? 'all' : key;
}

export function productMatchesCatalogFilter(product = {}, value = 'all', favorites = new Set(), visibility = {}) {
  if (visibility[product.platform] === false) return false;
  const key = resolveCatalogFilter(value, visibility);
  const filter = CATALOG_FILTERS[key];
  if (key === 'favorites' && !favorites.has(String(product.id))) return false;
  return (!filter.platform || product.platform === filter.platform) && (!filter.game || product.game === filter.game);
}

const DEFAULT_BADGE_OPTIONS = normalizeBadgeOptions([
  { key: 'premium', label: 'PREMIUM', icon: 'fa-gem', tone: 'premium' },
  { key: 'cheat', label: 'HİLE', icon: 'fa-wand-magic-sparkles', tone: 'danger' },
  { key: 'rooted', label: 'ROOTLU', icon: 'fa-microchip', tone: 'root' },
  { key: 'new', label: 'YENİ', icon: 'fa-star', tone: 'new' },
  { key: 'bestseller', label: 'EN ÇOK SATILAN', icon: 'fa-crown', tone: 'bestseller' },
  { key: 'popular', label: 'ÇOK TERCİH EDİLEN', icon: 'fa-fire-flame-curved', tone: 'popular' },
  { key: 'discounted', label: 'İNDİRİMLİ', icon: 'fa-tags', tone: 'discounted' },
  { key: 'mod', label: 'MOD', icon: 'fa-puzzle-piece', tone: 'mod' },
  { key: 'guaranteed-login', label: 'KESİN GİRİŞ', icon: 'fa-circle-check', tone: 'verified' },
  { key: 'annual', label: 'YILLIK', icon: 'fa-calendar-check', tone: 'annual' },
  { key: 'verified', label: 'DOĞRULANMIŞ', icon: 'fa-shield-halved', tone: 'verified' }
]);

function normalizeBadgeOption(source = {}) {
  const key = String(source.key || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
  const label = String(source.label || '').trim().slice(0, 40);
  const icon = String(source.icon || '').trim().replace(/[^a-z0-9-]/gi, '').slice(0, 50);
  const tone = String(source.tone || 'premium').trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 32) || 'premium';
  if (!key || !label || !icon) return null;
  return Object.freeze({ key, label, icon, tone });
}

function normalizeBadgeOptions(source = []) {
  const options = [];
  const keys = new Set();
  const labels = new Set();
  const icons = new Set();
  for (const entry of Array.isArray(source) ? source : []) {
    const badge = normalizeBadgeOption(entry);
    if (!badge) continue;
    const labelKey = badge.label.toLocaleUpperCase('tr-TR');
    if (keys.has(badge.key) || labels.has(labelKey) || icons.has(badge.icon)) continue;
    keys.add(badge.key);
    labels.add(labelKey);
    icons.add(badge.icon);
    options.push(badge);
  }
  return Object.freeze(options);
}

function badgeResolver(options = []) {
  const byKey = new Map(options.map((badge) => [badge.key, badge]));
  const byLabel = new Map(options.map((badge) => [badge.label.toLocaleUpperCase('tr-TR'), badge]));
  return (source = {}) => {
    const requestedKey = String(source.badgeKey || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
    const requestedLabel = String(source.badge || '').trim().toLocaleUpperCase('tr-TR');
    return byKey.get(requestedKey) || byLabel.get(requestedLabel) || byKey.get('premium') || options[0] || Object.freeze({ key: 'premium', label: 'PREMIUM', icon: 'fa-gem', tone: 'premium' });
  };
}

function normalizeStock(source = {}) {
  const available = Math.max(0, Math.trunc(Number(source.available) || 0));
  const state = ['in_stock', 'low_stock', 'out_of_stock', 'unverified'].includes(String(source.state || ''))
    ? String(source.state)
    : available < 1 ? 'out_of_stock' : available <= 3 ? 'low_stock' : 'in_stock';
  return Object.freeze({ available, state });
}

function normalizePlan(source = {}) {
  const priceKurus = Math.max(0, Math.trunc(Number(source.priceKurus) || 0));
  return Object.freeze({
    key: String(source.key || '').trim().slice(0, 40),
    label: String(source.label || '').trim().slice(0, 50),
    duration: String(source.duration || '').trim().slice(0, 50),
    priceKurus,
    active: source.active !== false,
    stock: normalizeStock(source.stock)
  });
}

function normalizeProduct(source = {}, resolveBadge = badgeResolver([])) {
  const badge = resolveBadge(source);
  const id = String(source.id || '').trim().slice(0, 80);
  const name = CANONICAL_PRODUCT_NAMES[id] || String(source.name || '').trim().slice(0, 80);
  let description = String(source.description || '').trim().slice(0, 240);
  if (id === 'android-contra-hax') description = description.replace(/CONTRA\s+HAX/giu, 'CONTRAHAX');
  if (id === 'ios-dolphin') description = description.replace(/DOLPHIN/giu, 'DelphinİOS');
  return Object.freeze({
    id,
    platform: source.platform === 'ios' ? 'ios' : 'android',
    game: ['pubg', 'oxide'].includes(source.game) ? source.game : 'other',
    inventoryType: source.inventoryType === 'account' ? 'account' : 'license',
    inventoryPoolId: String(source.inventoryPoolId || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 80),
    fulfillmentMode: source.fulfillmentMode === 'telegram_only' ? 'telegram_only' : 'automatic',
    archived: source.archived === true,
    automaticEnabled: source.automaticEnabled !== false && source.fulfillmentMode !== 'telegram_only',
    telegramEnabled: source.telegramEnabled !== false,
    immutableFulfillment: source.immutableFulfillment === true,
    immutablePlatform: source.immutablePlatform === true,
    name,
    category: String(source.category || '').trim().slice(0, 50),
    badgeKey: badge.key,
    badge: badge.label,
    badgeIcon: badge.icon,
    badgeTone: badge.tone,
    icon: String(source.icon || 'fa-box').replace(/[^a-z0-9-]/gi, '').slice(0, 50),
    image: String(source.image || '').trim().slice(0, 300),
    accent: String(source.accent || '255,72,160').replace(/[^0-9,]/g, '').slice(0, 20),
    description,
    active: source.active !== false,
    featured: source.featured === true,
    sortOrder: Math.max(0, Math.min(10000, Math.trunc(Number(source.sortOrder) || 500))),
    tags: Object.freeze((Array.isArray(source.tags) ? source.tags : []).map((tag) => String(tag || '').toLowerCase()).filter((tag) => ['new', 'popular', 'discounted'].includes(tag))),
    stock: normalizeStock(source.stock),
    plans: Object.freeze((Array.isArray(source.plans) ? source.plans : []).map(normalizePlan).filter((plan) => plan.active !== false && plan.key && plan.priceKurus > 0))
  });
}

function normalizeStorefront(source = {}) {
  const announcement = source.announcement && typeof source.announcement === 'object' ? source.announcement : {};
  const services = source.services && typeof source.services === 'object' ? source.services : {};
  const support = source.support && typeof source.support === 'object' ? source.support : {};
  const home = source.home && typeof source.home === 'object' ? source.home : {};
  const categoryVisibility = source.categoryVisibility && typeof source.categoryVisibility === 'object' ? source.categoryVisibility : {};
  return Object.freeze({
    maintenance: source.maintenance === true,
    announcement: Object.freeze({ enabled: announcement.enabled === true, title: String(announcement.title || '').slice(0, 80), message: String(announcement.message || '').slice(0, 240), tone: String(announcement.tone || 'info'), ctaLabel: String(announcement.ctaLabel || '').slice(0, 40), ctaTarget: String(announcement.ctaTarget || 'catalog') }),
    services: Object.freeze({ automaticDelivery: services.automaticDelivery !== false, telegramSupport: services.telegramSupport !== false, balancePayment: services.balancePayment !== false }),
    support: Object.freeze({ telegramUsername: String(support.telegramUsername || '').replace(/^@+/, '').replace(/[^a-z0-9_]/gi, '').slice(0, 32) }),
    home: Object.freeze({ title: String(home.title || '').slice(0, 80), message: String(home.message || '').slice(0, 240) }),
    categoryVisibility: Object.freeze({ android: categoryVisibility.android !== false, ios: categoryVisibility.ios !== false }),
    quickLinks: normalizeQuickLinks(source.quickLinks)
  });
}


function normalizeAvatar(source = {}) {
  const id = String(source.id || '').trim().slice(0, 20);
  const label = String(source.label || '').trim().slice(0, 60);
  const image = String(source.image || '').trim().slice(0, 500);
  if (!/^\d{1,2}$/.test(id) || !image) return null;
  try {
    const url = new URL(image);
    if (url.protocol !== 'https:' || url.hostname !== 'encrypted-tbn0.gstatic.com' || url.pathname !== '/images') return null;
    if (!/^tbn:ANd9Gc/i.test(url.searchParams.get('q') || '') || url.searchParams.get('s') !== '10') return null;
  } catch (_) { return null; }
  return Object.freeze({ id, label: label || `SHELBY Profil ${id}`, image });
}

function normalizeCatalog(source = {}) {
  const value = source.catalog && typeof source.catalog === 'object' ? source.catalog : source;
  const providedBadgeOptions = normalizeBadgeOptions(value.badgeOptions);
  const badgeOptions = providedBadgeOptions.length ? providedBadgeOptions : DEFAULT_BADGE_OPTIONS;
  const resolveBadge = badgeResolver(badgeOptions);
  const products = (Array.isArray(value.products) ? value.products : []).map((product) => normalizeProduct(product, resolveBadge)).filter((product) => product.active !== false && !product.archived && product.id && product.name && product.plans.length);
  return Object.freeze({
    version: Math.max(1, Math.trunc(Number(value.version) || 1)),
    currency: 'TRY',
    telegramUsername: String(value.telegramUsername || 'shelbyios').replace(/[^a-z0-9_]/gi, '').slice(0, 32),
    stockVerified: value.stockVerified !== false,
    badgeOptions,
    storefront: normalizeStorefront(value.storefront),
    avatars: Object.freeze((Array.isArray(value.avatars) ? value.avatars : []).map(normalizeAvatar).filter(Boolean).slice(0, 25)),
    products: Object.freeze(products)
  });
}

export async function loadStoreCatalog(apiRequest, { force = false } = {}) {
  if (!force && catalogCache && Date.now() - catalogCachedAt < 60_000) return catalogCache;
  if (catalogLoad) return catalogLoad;
  const pending = (async () => {
    let source = null;
    let stockVerified = false;
    if (typeof apiRequest === 'function') {
      try {
        source = await apiRequest('/api/store/catalog?v=11', { auth: false, timeoutMs: 6500 });
        stockVerified = (source?.catalog || source)?.stockVerified !== false;
      } catch (error) {
        if (catalogCache) {
          catalogCache = Object.freeze({ ...catalogCache, stockVerified: false, stale: true });
          catalogCachedAt = 0;
          return catalogCache;
        }
        throw error;
      }
    } else {
      const response = await fetch('/public/data/store-products.json', { cache: 'no-cache', credentials: 'same-origin' });
      if (!response.ok) throw new Error('STORE_CATALOG_UNAVAILABLE');
      source = await response.json();
    }
    if (source?.catalog && typeof source.catalog === 'object') source.catalog.stockVerified = stockVerified;
    else if (source && typeof source === 'object') source.stockVerified = stockVerified;
    const catalog = normalizeCatalog(source);
    if (!Array.isArray((source?.catalog || source)?.products)) throw new Error('STORE_CATALOG_INVALID');
    catalogCache = catalog;
    catalogCachedAt = Date.now();
    return catalogCache;
  })();
  catalogLoad = pending;
  try {
    return await pending;
  } finally {
    if (catalogLoad === pending) catalogLoad = null;
  }
}

export function getStoreProduct(catalog, id = '') {
  return catalog?.products?.find((product) => product.id === String(id || '')) || null;
}

export function getStorePlan(product, key = '') {
  return product?.plans?.find((plan) => plan.key === String(key || '')) || null;
}

export function formatStorePrice(valueKurus = 0) {
  return (Math.max(0, Number(valueKurus) || 0) / 100).toLocaleString('tr-TR', {
    style: 'currency', currency: 'TRY', minimumFractionDigits: 2, maximumFractionDigits: 2
  });
}
