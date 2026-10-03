'use strict';

const rawCatalog = require('../../public/data/store-products.json');
const { resolveBadge } = require('./storeBadgeCatalog');

const SAFE_ID = /^[a-z0-9][a-z0-9-]{1,79}$/;
const SAFE_PLAN_KEY = /^[a-z0-9][a-z0-9-]{1,39}$/;

function sanitizeCatalog() {
  const products = Array.isArray(rawCatalog.products) ? rawCatalog.products : [];
  const seenProducts = new Set();
  const normalized = products.map((source) => {
    const id = String(source?.id || '').trim().toLowerCase();
    if (!SAFE_ID.test(id) || seenProducts.has(id)) throw new Error(`STORE_CATALOG_INVALID_PRODUCT:${id || 'missing'}`);
    seenProducts.add(id);

    const platform = String(source?.platform || '').trim().toLowerCase();
    if (platform !== 'android' && platform !== 'ios') throw new Error(`STORE_CATALOG_INVALID_PLATFORM:${id}`);
    const game = String(source?.game || 'other').trim().toLowerCase();
    if (!['pubg', 'oxide', 'other'].includes(game)) throw new Error(`STORE_CATALOG_INVALID_GAME:${id}`);
    const inventoryType = String(source?.inventoryType || 'license').trim().toLowerCase();
    if (!['license', 'account'].includes(inventoryType)) throw new Error(`STORE_CATALOG_INVALID_INVENTORY_TYPE:${id}`);
    const inventoryPoolId = String(source?.inventoryPoolId || '').trim().toLowerCase();
    if (inventoryPoolId && !SAFE_ID.test(inventoryPoolId)) throw new Error(`STORE_CATALOG_INVALID_INVENTORY_POOL:${id}`);
    const fulfillmentMode = String(source?.fulfillmentMode || 'automatic').trim().toLowerCase();
    if (!['automatic', 'telegram_only'].includes(fulfillmentMode)) throw new Error(`STORE_CATALOG_INVALID_FULFILLMENT_MODE:${id}`);

    const seenPlans = new Set();
    const plans = (Array.isArray(source?.plans) ? source.plans : []).map((plan) => {
      const key = String(plan?.key || '').trim().toLowerCase();
      const priceKurus = Math.trunc(Number(plan?.priceKurus) || 0);
      if (!SAFE_PLAN_KEY.test(key) || seenPlans.has(key) || priceKurus < 1 || priceKurus > 100_000_000) {
        throw new Error(`STORE_CATALOG_INVALID_PLAN:${id}:${key || 'missing'}`);
      }
      seenPlans.add(key);
      return Object.freeze({
        key,
        label: String(plan?.label || '').trim().slice(0, 50),
        duration: String(plan?.duration || '').trim().slice(0, 50),
        priceKurus
      });
    });
    if (!plans.length) throw new Error(`STORE_CATALOG_PLAN_REQUIRED:${id}`);

    const badge = resolveBadge({ badgeKey: source?.badgeKey, badge: source?.badge });
    return Object.freeze({
      id,
      platform,
      game,
      inventoryType,
      inventoryPoolId: inventoryPoolId || '',
      fulfillmentMode,
      name: String(source?.name || '').trim().slice(0, 80),
      category: String(source?.category || '').trim().slice(0, 50),
      badgeKey: badge.key,
      badge: badge.label,
      badgeIcon: badge.icon,
      badgeTone: badge.tone,
      icon: String(source?.icon || 'fa-box').replace(/[^a-z0-9-]/gi, '').slice(0, 50) || 'fa-box',
      image: String(source?.image || '').trim().slice(0, 300),
      accent: String(source?.accent || '255,72,160').replace(/[^0-9,]/g, '').slice(0, 20),
      description: String(source?.description || '').trim().slice(0, 240),
      featured: source?.featured === true,
      sortOrder: Math.max(0, Math.min(10_000, Math.trunc(Number(source?.sortOrder) || 500))),
      tags: Object.freeze([...new Set((Array.isArray(source?.tags) ? source.tags : []).map((tag) => String(tag || '').trim().toLowerCase()).filter((tag) => ['new', 'popular', 'discounted'].includes(tag)))]),
      plans: Object.freeze(plans)
    });
  });

  return Object.freeze({
    version: Math.max(1, Math.trunc(Number(rawCatalog.version) || 1)),
    currency: 'TRY',
    telegramUsername: String(rawCatalog.telegramUsername || 'shelbyios').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 32),
    products: Object.freeze(normalized)
  });
}

const STORE_CATALOG = sanitizeCatalog();
const PRODUCT_BY_ID = new Map(STORE_CATALOG.products.map((product) => [product.id, product]));

function findProduct(productId = '') {
  return PRODUCT_BY_ID.get(String(productId || '').trim().toLowerCase()) || null;
}

function findPlan(product, planKey = '') {
  if (!product) return null;
  const key = String(planKey || '').trim().toLowerCase();
  return product.plans.find((plan) => plan.key === key) || null;
}

module.exports = { STORE_CATALOG, findProduct, findPlan };
