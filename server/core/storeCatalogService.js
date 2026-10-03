'use strict';

const { initFirebaseAdmin } = require('../config/firebaseAdmin');
const { recordMutationAudit } = require('./storeMutationAudit');
const { STORE_CATALOG, findProduct: findBaseProduct } = require('./storeCatalog');
const { normalizeBadgeKey, badgeKeyFromLegacyLabel, resolveBadge, badgeOptions } = require('./storeBadgeCatalog');
const { CHANNEL_LINKS_REVISION, DEFAULT_QUICK_LINKS, channelLinksMigration, normalizeQuickLinks } = require('./storeLinks');

const CACHE_TTL_MS = 60_000;
const CATALOG_SCHEMA_VERSION = 1;
const PRODUCT_TAGS = Object.freeze(['new', 'popular', 'discounted']);
const ANNOUNCEMENT_TONES = Object.freeze(['info', 'success', 'warning']);
let cache = null;
let catalogLoad = null;
let cacheGeneration = 0;

const DEFAULT_STOREFRONT = Object.freeze({
  channelLinksRevision: CHANNEL_LINKS_REVISION,
  maintenance: false,
  announcement: Object.freeze({ enabled: false, title: '', message: '', tone: 'info', ctaLabel: '', ctaTarget: 'catalog' }),
  services: Object.freeze({ automaticDelivery: true, telegramSupport: true, balancePayment: true }),
  support: Object.freeze({ telegramUsername: STORE_CATALOG.telegramUsername }),
  home: Object.freeze({ title: '', message: '' }),
  categoryVisibility: Object.freeze({ android: true, ios: true }),
  quickLinks: DEFAULT_QUICK_LINKS
});

function serviceError(code, statusCode = 400) {
  return Object.assign(new Error(code), { code, statusCode });
}

function safeText(value = '', max = 240) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max);
}

function integer(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.trunc(number))) : fallback;
}

function safeImage(value = '', fallback = '') {
  const image = safeText(value, 300);
  return /^\/public\/assets\/products\/[a-zA-Z0-9._-]+$/.test(image) ? image : fallback;
}

function normalizeTags(value = []) {
  return [...new Set((Array.isArray(value) ? value : []).map((tag) => safeText(tag, 20).toLowerCase()).filter((tag) => PRODUCT_TAGS.includes(tag)))];
}

function normalizePlan(basePlan = {}, override = {}) {
  const source = override && typeof override === 'object' && !Array.isArray(override) ? override : {};
  const storedPrice = Number(source.priceKurus);
  const persistedPrice = Number.isSafeInteger(storedPrice) && storedPrice >= 1 && storedPrice <= 100_000_000;
  return {
    ...basePlan,
    active: source.active !== false,
    label: safeText(source.label, 50) || basePlan.label,
    duration: safeText(source.duration, 50) || basePlan.duration,
    priceKurus: persistedPrice ? storedPrice : basePlan.priceKurus
  };
}

function mergeProduct(baseProduct = {}, override = {}, includeInactive = false) {
  const source = override && typeof override === 'object' && !Array.isArray(override) ? override : {};
  const planOverrides = source.plans && typeof source.plans === 'object' && !Array.isArray(source.plans) ? source.plans : {};
  const plans = baseProduct.plans
    .map((plan) => normalizePlan(plan, planOverrides[plan.key]))
    .filter((plan) => includeInactive || plan.active !== false);
  const immutableTelegramOnly = baseProduct.fulfillmentMode === 'telegram_only';
  const automaticEnabled = immutableTelegramOnly ? false : source.automaticEnabled !== false;
  const telegramEnabled = immutableTelegramOnly ? true : source.telegramEnabled !== false;
  const badge = resolveBadge({ badgeKey: source.badgeKey, badge: source.badge }, baseProduct);
  const tags = source.tags !== undefined ? normalizeTags(source.tags) : normalizeTags(baseProduct.tags);
  const duplicateTag = badge.key === 'new' ? 'new' : badge.key === 'popular' ? 'popular' : badge.key === 'discounted' ? 'discounted' : '';
  return {
    ...baseProduct,
    platform: immutableTelegramOnly ? baseProduct.platform : (source.platform === 'ios' ? 'ios' : source.platform === 'android' ? 'android' : baseProduct.platform),
    immutablePlatform: immutableTelegramOnly,
    name: safeText(source.name, 80) || baseProduct.name,
    category: safeText(source.category, 50) || safeText(baseProduct.category, 50) || (baseProduct.platform === 'ios' ? 'iOS Premium' : 'Android Premium'),
    active: source.active !== false,
    archived: source.archived === true,
    automaticEnabled,
    telegramEnabled,
    fulfillmentMode: automaticEnabled ? 'automatic' : 'telegram_only',
    immutableFulfillment: immutableTelegramOnly,
    featured: source.featured !== undefined ? source.featured === true : baseProduct.featured === true,
    sortOrder: integer(source.sortOrder, integer(baseProduct.sortOrder, 500, 0, 10_000), 0, 10_000),
    badgeKey: badge.key,
    badge: badge.label,
    badgeIcon: badge.icon,
    badgeTone: badge.tone,
    description: safeText(source.description, 240) || baseProduct.description,
    image: safeImage(source.image, baseProduct.image),
    tags: duplicateTag ? tags.filter((tag) => tag !== duplicateTag) : tags,
    plans
  };
}

function normalizeStorefront(source = {}) {
  const current = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
  source = { ...current, ...(channelLinksMigration(current) || {}) };
  const announcement = source.announcement && typeof source.announcement === 'object' ? source.announcement : {};
  const services = source.services && typeof source.services === 'object' ? source.services : {};
  const support = source.support && typeof source.support === 'object' ? source.support : {};
  const home = source.home && typeof source.home === 'object' ? source.home : {};
  const categoryVisibility = source.categoryVisibility && typeof source.categoryVisibility === 'object' ? source.categoryVisibility : {};
  const tone = ANNOUNCEMENT_TONES.includes(String(announcement.tone || '').toLowerCase())
    ? String(announcement.tone).toLowerCase()
    : 'info';
  const ctaTarget = ['catalog', 'android', 'ios', 'orders'].includes(String(announcement.ctaTarget || ''))
    ? String(announcement.ctaTarget)
    : 'catalog';
  return {
    channelLinksRevision: Number(source.channelLinksRevision) || CHANNEL_LINKS_REVISION,
    maintenance: source.maintenance === true,
    announcement: {
      enabled: announcement.enabled === true,
      title: safeText(announcement.title, 80),
      message: safeText(announcement.message, 240),
      tone,
      ctaLabel: safeText(announcement.ctaLabel, 40),
      ctaTarget
    },
    services: {
      automaticDelivery: services.automaticDelivery !== false,
      telegramSupport: services.telegramSupport !== false,
      balancePayment: services.balancePayment !== false
    },
    support: {
      telegramUsername: safeText(support.telegramUsername, 40).replace(/^@+/, '').replace(/[^a-zA-Z0-9_]/g, '') || STORE_CATALOG.telegramUsername
    },
    home: {
      title: safeText(home.title, 80),
      message: safeText(home.message, 240)
    },
    categoryVisibility: {
      android: categoryVisibility.android !== false,
      ios: categoryVisibility.ios !== false
    },
    quickLinks: normalizeQuickLinks(source.quickLinks)
  };
}

function catalogState(source = {}) {
  const state = source.catalog;
  if (!state || typeof state !== 'object' || Array.isArray(state)) return null;
  if (Number(state.schemaVersion) !== CATALOG_SCHEMA_VERSION) return null;
  if (!state.products || typeof state.products !== 'object' || Array.isArray(state.products)) return null;
  return state;
}

function initializeProductSettings(legacy = new Map(), now = Date.now()) {
  return Object.fromEntries(STORE_CATALOG.products.map((base) => {
    const existing = legacy.get(base.id) || {};
    const effective = mergeProduct(base, existing, true);
    const settings = {
      ...effective,
      plans: Object.fromEntries(effective.plans.map((plan) => [plan.key, {
        active: plan.active !== false,
        label: plan.label,
        duration: plan.duration,
        priceKurus: plan.priceKurus
      }]))
    };
    const savedAt = Math.max(0, Number(existing.updatedAt || 0)) || now;
    const prepared = productSettingsPatch(base.id, settings, existing.updatedBy || {}, savedAt);
    return [base.id, prepared.patch];
  }));
}

async function readOverrides() {
  const { db } = initFirebaseAdmin();
  if (!db) return { products: new Map(), storefront: DEFAULT_STOREFRONT };
  const reference = db.collection('storefrontSettings').doc('main');
  const settingsSnapshot = await reference.get();
  let settings = settingsSnapshot.exists ? (settingsSnapshot.data() || {}) : {};
  let stored = catalogState(settings);
  if (!stored) {
    const legacySnapshot = await db.collection('storeProductSettings').limit(100).get();
    const legacy = new Map(legacySnapshot.docs.map((document) => [document.id, document.data() || {}]));
    const now = Date.now();
    const products = initializeProductSettings(legacy, now);
    await db.runTransaction(async (transaction) => {
      const currentSnapshot = await transaction.get(reference);
      const current = currentSnapshot.exists ? (currentSnapshot.data() || {}) : {};
      const currentState = catalogState(current);
      if (currentState) {
        settings = current;
        stored = currentState;
        return;
      }
      stored = {
        schemaVersion: CATALOG_SCHEMA_VERSION,
        sourceVersion: STORE_CATALOG.version,
        initializedAt: now,
        updatedAt: now,
        products
      };
      transaction.set(reference, { catalog: stored }, { merge: true });
      settings = { ...current, catalog: stored };
    });
  }
  const storedProducts = stored?.products || {};
  // A deployment/rollback is not permission to erase retired product settings.
  // Only add missing current products; keep historical overrides intact.
  const catalogChanged = Number(stored?.sourceVersion) < Number(STORE_CATALOG.version)
    || STORE_CATALOG.products.some((product) => !Object.hasOwn(storedProducts, product.id));
  if (catalogChanged) {
    const now = Date.now();
    await db.runTransaction(async (transaction) => {
      const currentSnapshot = await transaction.get(reference);
      const current = currentSnapshot.exists ? (currentSnapshot.data() || {}) : {};
      const currentState = catalogState(current);
      if (!currentState) return;
      const currentProducts = currentState.products || {};
      const defaults = initializeProductSettings(new Map(Object.entries(currentProducts)), now);
      const addedProducts = Object.fromEntries(Object.entries(defaults).filter(([id]) => !Object.hasOwn(currentProducts, id)));
      const nextState = {
        ...currentState,
        sourceVersion: Math.max(Number(currentState.sourceVersion) || 0, STORE_CATALOG.version),
        updatedAt: now,
        products: { ...currentProducts, ...addedProducts }
      };
      transaction.set(reference, { catalog: nextState }, { merge: true });
      settings = { ...current, catalog: nextState };
      stored = nextState;
    });
  }
  if (channelLinksMigration(settings)) {
    await db.runTransaction(async (transaction) => {
      const currentSnapshot = await transaction.get(reference);
      const current = currentSnapshot.exists ? (currentSnapshot.data() || {}) : {};
      const patch = channelLinksMigration(current);
      if (patch) transaction.set(reference, patch, { merge: true });
      settings = { ...current, ...(patch || {}) };
      stored = catalogState(settings);
    });
  }
  return {
    products: new Map(Object.entries(stored?.products || {})),
    storefront: normalizeStorefront(settings)
  };
}

async function getEffectiveCatalog({ includeInactive = false, fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && cache && now - cache.at < CACHE_TTL_MS) {
    return includeInactive ? cache.admin : cache.public;
  }
  if (!catalogLoad) {
    const generation = cacheGeneration;
    const pending = (async () => {
      const overrides = await readOverrides();
      const products = STORE_CATALOG.products
        .map((product) => mergeProduct(product, overrides.products.get(product.id), true))
        .sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name, 'tr'));
      const common = {
        version: STORE_CATALOG.version + 100,
        currency: STORE_CATALOG.currency,
        telegramUsername: overrides.storefront.support?.telegramUsername || STORE_CATALOG.telegramUsername,
        storefront: overrides.storefront,
        badgeOptions: badgeOptions()
      };
      if (generation !== cacheGeneration) return;
      cache = {
        at: Date.now(),
        public: {
          ...common,
          products: products
            .filter((product) => product.active !== false && product.archived !== true && overrides.storefront.categoryVisibility?.[product.platform] !== false)
            .map((product) => ({ ...product, plans: product.plans.filter((plan) => plan.active !== false) }))
            .filter((product) => product.plans.length > 0)
        },
        admin: { ...common, products }
      };
    })();
    catalogLoad = pending.finally(() => { catalogLoad = null; });
  }
  await catalogLoad;
  if (!cache) return getEffectiveCatalog({ includeInactive, fresh: true });
  return includeInactive ? cache.admin : cache.public;
}

function invalidateCatalogCache() {
  cacheGeneration += 1;
  cache = null;
}

function productSettingsPatch(productId = '', input = {}, actor = {}, updatedAt = Date.now()) {
  const id = safeText(productId, 80).toLowerCase();
  const base = findBaseProduct(id);
  if (!base) throw serviceError('STORE_PRODUCT_NOT_FOUND', 404);
  const body = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const plansInput = body.plans && typeof body.plans === 'object' && !Array.isArray(body.plans) ? body.plans : {};
  for (const key of ['active', 'archived', 'automaticEnabled', 'telegramEnabled', 'featured']) {
    if (body[key] !== undefined && typeof body[key] !== 'boolean') throw serviceError('STORE_PRODUCT_SETTINGS_INVALID', 400);
  }
  if (Object.keys(plansInput).some((key) => !base.plans.some((plan) => plan.key === key))) throw serviceError('STORE_SKU_INVALID', 400);
  if (body.platform !== undefined && !['android', 'ios'].includes(String(body.platform))) throw serviceError('STORE_PRODUCT_PLATFORM_INVALID', 400);
  if (body.sortOrder !== undefined && (!Number.isSafeInteger(Number(body.sortOrder)) || Number(body.sortOrder) < 0 || Number(body.sortOrder) > 10_000)) throw serviceError('STORE_PRODUCT_SORT_INVALID', 400);
  if (body.image !== undefined && safeText(body.image, 300) && safeImage(body.image, '') === '') throw serviceError('STORE_PRODUCT_IMAGE_INVALID', 400);
  const incomingBadgeKey = body.badgeKey !== undefined
    ? normalizeBadgeKey(body.badgeKey)
    : badgeKeyFromLegacyLabel(body.badge);
  if ((body.badgeKey !== undefined || body.badge !== undefined) && !incomingBadgeKey) throw serviceError('STORE_PRODUCT_BADGE_INVALID', 400);
  const requestedBadge = resolveBadge({ badgeKey: incomingBadgeKey }, base);
  const requestedActive = body.active !== false;
  const requestedArchived = body.archived === true;
  const requestedAutomatic = base.fulfillmentMode === 'telegram_only' ? false : body.automaticEnabled !== false;
  const requestedTelegram = base.fulfillmentMode === 'telegram_only' ? true : body.telegramEnabled !== false;
  if (requestedActive && !requestedArchived && !requestedAutomatic && !requestedTelegram) throw serviceError('STORE_PRODUCT_FULFILLMENT_REQUIRED', 409);
  const plans = {};
  for (const plan of base.plans) {
    const source = plansInput[plan.key];
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    if (source.active !== undefined && typeof source.active !== 'boolean') throw serviceError('STORE_PRODUCT_SETTINGS_INVALID', 400);
    if (typeof source.priceKurus !== 'number' && typeof source.priceKurus !== 'string') throw serviceError('STORE_PRODUCT_PRICE_INVALID', 400);
    const priceKurus = Number(source.priceKurus);
    if (!Number.isSafeInteger(priceKurus) || priceKurus < 1 || priceKurus > 100_000_000) throw serviceError('STORE_PRODUCT_PRICE_INVALID', 400);
    plans[plan.key] = {
      active: source.active !== false,
      label: safeText(source.label, 50) || plan.label,
      duration: safeText(source.duration, 50) || plan.duration,
      priceKurus
    };
  }
  return {
    id,
    patch: {
      name: safeText(body.name, 80) || base.name,
      platform: base.fulfillmentMode === 'telegram_only' ? base.platform : (body.platform === 'ios' ? 'ios' : body.platform === 'android' ? 'android' : base.platform),
      category: safeText(body.category, 50) || base.category || (base.platform === 'ios' ? 'iOS Premium' : 'Android Premium'),
      active: requestedActive,
      archived: requestedArchived,
      automaticEnabled: requestedAutomatic,
      telegramEnabled: requestedTelegram,
      featured: body.featured === undefined ? base.featured === true : body.featured === true,
      sortOrder: integer(body.sortOrder, integer(base.sortOrder, 500, 0, 10_000), 0, 10_000),
      badgeKey: requestedBadge.key,
      description: safeText(body.description, 240) || base.description,
      image: safeImage(body.image, base.image),
      tags: normalizeTags(body.tags),
      plans,
      updatedAt,
      updatedBy: { uid: safeText(actor.uid, 160), email: safeText(actor.email, 160).toLowerCase() }
    }
  };
}

function mergeProductInput(previous = {}, input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw serviceError('STORE_PRODUCT_SETTINGS_INVALID', 400);
  if (input.plans !== undefined && (!input.plans || typeof input.plans !== 'object' || Array.isArray(input.plans))) throw serviceError('STORE_PRODUCT_SETTINGS_INVALID', 400);
  const plans = { ...(previous.plans || {}) };
  for (const [key, plan] of Object.entries(input.plans || {})) {
    if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw serviceError('STORE_PRODUCT_SETTINGS_INVALID', 400);
    plans[key] = { ...(plans[key] || {}), ...plan };
  }
  return { ...previous, ...input, plans };
}

async function updateProductSettings(productId = '', input = {}, actor = {}) {
  const id = safeText(productId, 80).toLowerCase();
  if (!findBaseProduct(id)) throw serviceError('STORE_PRODUCT_NOT_FOUND', 404);
  const { db } = initFirebaseAdmin();
  if (!db) throw serviceError('STORE_STORAGE_UNAVAILABLE', 503);
  await readOverrides();
  const reference = db.collection('storefrontSettings').doc('main');
  const saved = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const current = catalogState(snapshot.exists ? snapshot.data() : {});
    if (!current) throw serviceError('STORE_CATALOG_PERSISTENCE_UNAVAILABLE', 503);
    const prepared = productSettingsPatch(id, mergeProductInput(current.products[id], input), actor);
    transaction.set(reference, {
      catalog: {
        ...current,
        updatedAt: prepared.patch.updatedAt,
        products: { ...current.products, [prepared.id]: prepared.patch }
      }
    }, { merge: true });
    recordMutationAudit(transaction, db, 'store.product.update', actor, { productId: id, before: current.products[id] || null, after: prepared.patch });
    return mergeProduct(findBaseProduct(id), prepared.patch, true);
  });
  invalidateCatalogCache();
  return saved;
}

async function updateProductsBulk(updates = [], actor = {}, context = {}) {
  if (!Array.isArray(updates) || !updates.length || updates.length > 100) throw serviceError('STORE_PRODUCT_BULK_INVALID', 400);
  const now = Date.now();
  const prepared = updates.map((entry) => {
    const id = safeText(entry?.productId, 80).toLowerCase();
    if (!findBaseProduct(id)) throw serviceError('STORE_PRODUCT_NOT_FOUND', 404);
    return { id };
  });
  if (new Set(prepared.map((entry) => entry.id)).size !== prepared.length) throw serviceError('STORE_PRODUCT_BULK_DUPLICATE', 409);
  const { db } = initFirebaseAdmin();
  if (!db) throw serviceError('STORE_STORAGE_UNAVAILABLE', 503);
  await readOverrides();
  const settingsRef = db.collection('storefrontSettings').doc('main');
  const auditRef = db.collection('audit').doc();
  const audit = {
    id: auditRef.id,
    type: 'store-product-bulk-update',
    action: 'store.product.bulk-update',
    productIds: prepared.map((entry) => entry.id),
    count: prepared.length,
    actor: { uid: safeText(actor.uid, 160), email: safeText(actor.email, 160).toLowerCase(), source: 'admin' },
    requestId: safeText(context.requestId, 180),
    at: now,
    createdAt: now
  };
  const savedProducts = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(settingsRef);
    const current = catalogState(snapshot.exists ? snapshot.data() : {});
    if (!current) throw serviceError('STORE_CATALOG_PERSISTENCE_UNAVAILABLE', 503);
    const products = { ...current.products };
    updates.forEach((entry) => {
      const id = safeText(entry.productId, 80).toLowerCase();
      products[id] = productSettingsPatch(id, mergeProductInput(current.products[id], entry.settings), actor, now).patch;
    });
    transaction.set(settingsRef, {
      catalog: { ...current, updatedAt: now, products }
    }, { merge: true });
    transaction.create(auditRef, audit);
    return prepared.map(({ id }) => mergeProduct(findBaseProduct(id), products[id], true));
  });
  invalidateCatalogCache();
  const ids = new Set(prepared.map((entry) => entry.id));
  return { updated: prepared.length, productIds: [...ids], products: savedProducts, updatedAt: now };
}

async function updateStorefrontSettings(input = {}, actor = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw serviceError('STORE_CONTENT_INVALID', 400);
  for (const key of ['services', 'announcement', 'home', 'categoryVisibility', 'support']) {
    if (input[key] !== undefined && (!input[key] || typeof input[key] !== 'object' || Array.isArray(input[key]))) throw serviceError('STORE_CONTENT_INVALID', 400);
  }
  const { db } = initFirebaseAdmin();
  if (!db) throw serviceError('STORE_STORAGE_UNAVAILABLE', 503);
  const reference = db.collection('storefrontSettings').doc('main');
  let normalized = null;
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const current = snapshot.exists ? (snapshot.data() || {}) : {};
    const effective = { ...current, ...(channelLinksMigration(current) || {}) };
    normalized = normalizeStorefront({
      ...effective,
      ...input,
      services: { ...(effective.services || {}), ...(input.services || {}) },
      announcement: { ...(effective.announcement || {}), ...(input.announcement || {}) },
      home: { ...(effective.home || {}), ...(input.home || {}) },
      categoryVisibility: { ...(effective.categoryVisibility || {}), ...(input.categoryVisibility || {}) },
      channelLinksRevision: CHANNEL_LINKS_REVISION,
      support: input.support === undefined ? effective.support : input.support,
      quickLinks: input.quickLinks === undefined ? effective.quickLinks : input.quickLinks
    });
    transaction.set(reference, {
      ...normalized,
      updatedAt: Date.now(),
      updatedBy: { uid: safeText(actor.uid, 160), email: safeText(actor.email, 160).toLowerCase() }
    }, { merge: true });
    recordMutationAudit(transaction, db, 'store.content.update', actor, { before: normalizeStorefront(effective), after: normalized });
  });
  invalidateCatalogCache();
  return normalized;
}

async function updateStorefrontQuickLinks(input, actor = {}) {
  const quickLinks = normalizeQuickLinks(input, { defaultsWhenMissing: false });
  const { db } = initFirebaseAdmin();
  if (!db) throw serviceError('STORE_STORAGE_UNAVAILABLE', 503);
  await readOverrides();
  const batch = db.batch();
  batch.set(db.collection('storefrontSettings').doc('main'), {
    channelLinksRevision: CHANNEL_LINKS_REVISION,
    quickLinks,
    updatedAt: Date.now(),
    updatedBy: { uid: safeText(actor.uid, 160), email: safeText(actor.email, 160).toLowerCase() }
  }, { merge: true });
  recordMutationAudit(batch, db, 'store.links.update', actor, { links: quickLinks });
  await batch.commit();
  invalidateCatalogCache();
  return quickLinks;
}

module.exports = {
  PRODUCT_TAGS,
  DEFAULT_STOREFRONT,
  getEffectiveCatalog,
  updateProductSettings,
  updateProductsBulk,
  updateStorefrontSettings,
  updateStorefrontQuickLinks,
  invalidateCatalogCache,
  normalizeStorefront,
  serviceError
};
