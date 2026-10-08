'use strict';

const { initFirebaseAdmin } = require('../config/firebaseAdmin');
const { STORE_CATALOG } = require('./storeCatalog');

const PAGE_SIZE = 200;
const MAX_PAGES = 250;
let cleanupRun = null;

function safeId(value = '') {
  return String(value || '').trim().toLowerCase().slice(0, 160);
}

function productIdsFromRow(row = {}) {
  return [...new Set([
    safeId(row.productId),
    safeId(row.sourceProductId),
    ...(Array.isArray(row.productIds) ? row.productIds.map(safeId) : [])
  ].filter(Boolean))];
}

function catalogSkuSet(catalog = STORE_CATALOG) {
  const skus = new Set();
  for (const product of catalog.products || []) {
    const productId = safeId(product.id);
    const poolId = safeId(product.inventoryPoolId) || productId;
    for (const plan of product.plans || []) {
      const planKey = safeId(plan.key);
      if (!productId || !planKey) continue;
      skus.add(`${poolId}__${planKey}`);
      skus.add(`${productId}__${planKey}`);
    }
  }
  return skus;
}

function buildCatalogRetirementPlan({ settingsProducts = {}, legacyRows = [], summaries = [], catalog = STORE_CATALOG } = {}) {
  const allowedProductIds = new Set((catalog.products || []).map((product) => safeId(product.id)).filter(Boolean));
  const activeSkus = catalogSkuSet(catalog);
  const retiredProductIds = new Set();
  const staleSettingIds = Object.keys(settingsProducts || {}).map(safeId).filter(Boolean);

  for (const productId of staleSettingIds) {
    if (!allowedProductIds.has(productId)) retiredProductIds.add(productId);
  }
  for (const row of legacyRows || []) {
    const productId = safeId(row?.id);
    if (productId && !allowedProductIds.has(productId)) retiredProductIds.add(productId);
  }
  for (const summary of summaries || []) {
    for (const productId of productIdsFromRow(summary?.data || {})) {
      if (!allowedProductIds.has(productId)) retiredProductIds.add(productId);
    }
  }

  const retiredSkus = new Set();
  for (const summary of summaries || []) {
    const sku = safeId(summary?.id);
    if (!sku || activeSkus.has(sku)) continue;
    const rowIds = productIdsFromRow(summary?.data || {});
    if (rowIds.some((productId) => retiredProductIds.has(productId))
      || [...retiredProductIds].some((productId) => sku.startsWith(`${productId}__`))) {
      retiredSkus.add(sku);
    }
  }

  return {
    allowedProductIds,
    retiredProductIds,
    retiredSkus,
    staleSettingIds: new Set(staleSettingIds.filter((productId) => !allowedProductIds.has(productId)))
  };
}

function preserveHistoricalInventory(row = {}) {
  const status = safeId(row.status);
  return status === 'delivered' || !!safeId(row.orderId) || !!safeId(row.customerUid);
}

function promotionRetirementPatch(row = {}, allowedProductIds = new Set(), now = Date.now()) {
  const original = Array.isArray(row.productIds) ? [...new Set(row.productIds.map(safeId).filter(Boolean))] : [];
  if (!original.length) return null;
  const productIds = original.filter((productId) => allowedProductIds.has(productId));
  if (productIds.length === original.length) return null;
  return {
    productIds,
    updatedAt: now,
    ...(productIds.length ? {} : { active: false, visibleInWallet: false, retiredScopeAt: now })
  };
}

async function commitDeletes(db, references = []) {
  const unique = [...new Map(references.filter(Boolean).map((reference) => [reference.path, reference])).values()];
  for (let offset = 0; offset < unique.length; offset += 400) {
    const batch = db.batch();
    unique.slice(offset, offset + 400).forEach((reference) => batch.delete(reference));
    await batch.commit();
  }
  return unique.length;
}

async function deleteMatchingQuery(db, queryFactory) {
  let removed = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const snapshot = await queryFactory().limit(PAGE_SIZE).get();
    if (!snapshot.size) break;
    removed += await commitDeletes(db, snapshot.docs.map((document) => document.ref));
    if (snapshot.size < PAGE_SIZE) break;
  }
  return removed;
}

async function deleteRetiredNotifications(db, retiredProductIds = []) {
  let removed = 0;
  for (let offset = 0; offset < retiredProductIds.length; offset += 10) {
    const ids = retiredProductIds.slice(offset, offset + 10);
    let cursor = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      let query = db.collectionGroup('items').where('productId', 'in', ids).limit(PAGE_SIZE);
      if (cursor) query = query.startAfter(cursor);
      const snapshot = await query.get();
      if (!snapshot.size) break;
      const notifications = snapshot.docs
        .filter((document) => /^storeUserNotifications\/[^/]+\/items\/[^/]+$/.test(String(document.ref.path || '')))
        .map((document) => document.ref);
      removed += await commitDeletes(db, notifications);
      if (snapshot.size < PAGE_SIZE) break;
      cursor = snapshot.docs[snapshot.docs.length - 1];
    }
  }
  return removed;
}

async function retireInventorySku(db, admin, sku) {
  const collection = db.collection('storeInventory').doc(sku).collection('items');
  let cursor = null;
  let removed = 0;
  let preserved = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    let query = collection.orderBy(admin.firestore.FieldPath.documentId()).limit(PAGE_SIZE);
    if (cursor) query = query.startAfter(cursor);
    const snapshot = await query.get();
    if (!snapshot.size) break;
    const references = [];
    for (const document of snapshot.docs) {
      const row = document.data() || {};
      if (preserveHistoricalInventory(row)) {
        preserved += 1;
        continue;
      }
      references.push(document.ref);
      const fingerprint = safeId(row.fingerprint);
      if (fingerprint) references.push(db.collection('storeInventoryFingerprints').doc(fingerprint));
      removed += 1;
    }
    await commitDeletes(db, references);
    if (snapshot.size < PAGE_SIZE) break;
    cursor = snapshot.docs[snapshot.docs.length - 1];
  }
  await Promise.all([
    db.collection('storeInventorySummary').doc(sku).delete(),
    db.collection('storeInventory').doc(sku).delete()
  ]);
  return { removed, preserved };
}

async function pruneStoredCatalog(db, allowedProductIds, sourceVersion, now) {
  const reference = db.collection('storefrontSettings').doc('main');
  let removed = 0;
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists) return;
    const settings = snapshot.data() || {};
    const catalog = settings.catalog;
    if (!catalog || typeof catalog !== 'object' || !catalog.products || typeof catalog.products !== 'object') return;
    const products = Object.fromEntries(Object.entries(catalog.products).filter(([productId]) => allowedProductIds.has(safeId(productId))));
    removed = Object.keys(catalog.products).length - Object.keys(products).length;
    if (!removed && Number(catalog.sourceVersion) === Number(sourceVersion)) return;
    transaction.set(reference, {
      catalog: { ...catalog, products, sourceVersion, updatedAt: now }
    }, { merge: true });
  });
  return removed;
}

async function reconcileRetiredCatalogData({ apply = false } = {}) {
  const { db, admin, enabled } = initFirebaseAdmin();
  if (!enabled || !db || !admin) return { skipped: true, reason: 'storage-unavailable' };

  const settingsRef = db.collection('storefrontSettings').doc('main');
  const [settingsSnapshot, legacySnapshot, summarySnapshot] = await Promise.all([
    settingsRef.get(),
    db.collection('storeProductSettings').limit(500).get(),
    db.collection('storeInventorySummary').limit(500).get()
  ]);
  const settings = settingsSnapshot.exists ? (settingsSnapshot.data() || {}) : {};
  const summaryRows = summarySnapshot.docs.map((document) => ({ id: document.id, data: document.data() || {}, document }));
  const plan = buildCatalogRetirementPlan({
    settingsProducts: settings.catalog?.products || {},
    legacyRows: legacySnapshot.docs.map((document) => ({ id: document.id, data: document.data() || {} })),
    summaries: summaryRows
  });
  const retiredProductIds = [...plan.retiredProductIds];
  const retiredSkus = [...plan.retiredSkus];
  // Startup is read-only. Applying a retirement requires a separate, deliberate
  // maintenance call after backup and review of these exact product/SKU targets.
  if (apply !== true) return {
    skipped: false, dryRun: true, changed: false,
    retiredProductIds, retiredSkus,
    retiredProducts: retiredProductIds.length,
    catalogSettingsToReview: plan.staleSettingIds.size
  };
  const now = Date.now();
  const report = {
    retiredProducts: retiredProductIds.length,
    retiredSkus: retiredSkus.length,
    catalogSettingsRemoved: await pruneStoredCatalog(db, plan.allowedProductIds, STORE_CATALOG.version, now),
    legacySettingsRemoved: 0,
    activeInventoryRemoved: 0,
    historicalDeliveriesPreserved: 0,
    sharedSummariesUpdated: 0,
    restockSubscriptionsRemoved: 0,
    staleNotificationsRemoved: 0,
    importReceiptsRemoved: 0,
    promotionsUpdated: 0
  };

  report.legacySettingsRemoved = await commitDeletes(db, legacySnapshot.docs
    .filter((document) => plan.retiredProductIds.has(safeId(document.id)))
    .map((document) => document.ref));

  for (const sku of retiredSkus) {
    const inventory = await retireInventorySku(db, admin, sku);
    report.activeInventoryRemoved += inventory.removed;
    report.historicalDeliveriesPreserved += inventory.preserved;
  }

  const retiredSkuSet = new Set(retiredSkus);
  const sharedSummaryUpdates = summaryRows.flatMap(({ id, data, document }) => {
    if (retiredSkuSet.has(safeId(id)) || !Array.isArray(data.productIds)) return [];
    const productIds = [...new Set(data.productIds.map(safeId).filter((productId) => plan.allowedProductIds.has(productId)))];
    if (productIds.length === data.productIds.length) return [];
    const productId = plan.allowedProductIds.has(safeId(data.productId)) ? safeId(data.productId) : (productIds[0] || '');
    return [{ document, patch: {
      productIds,
      productId: productId || admin.firestore.FieldValue.delete(),
      updatedAt: now
    } }];
  });
  for (let offset = 0; offset < sharedSummaryUpdates.length; offset += 400) {
    const batch = db.batch();
    sharedSummaryUpdates.slice(offset, offset + 400).forEach(({ document, patch }) => batch.set(document.ref, patch, { merge: true }));
    await batch.commit();
  }
  report.sharedSummariesUpdated = sharedSummaryUpdates.length;

  for (const sku of retiredSkus) {
    report.restockSubscriptionsRemoved += await deleteMatchingQuery(db, () => db.collection('storeRestockSubscriptions').where('sku', '==', sku));
  }
  for (const productId of retiredProductIds) {
    report.restockSubscriptionsRemoved += await deleteMatchingQuery(db, () => db.collection('storeRestockSubscriptions').where('productId', '==', productId));
    report.importReceiptsRemoved += await deleteMatchingQuery(db, () => db.collection('storeInventoryImports').where('productId', '==', productId));
  }

  if (retiredProductIds.length && typeof db.collectionGroup === 'function') {
    report.staleNotificationsRemoved = await deleteRetiredNotifications(db, retiredProductIds);
  }

  const promotions = await db.collection('storePromotions').limit(200).get();
  const promotionUpdates = promotions.docs
    .map((document) => ({ document, patch: promotionRetirementPatch(document.data() || {}, plan.allowedProductIds, now) }))
    .filter((entry) => entry.patch);
  for (let offset = 0; offset < promotionUpdates.length; offset += 400) {
    const batch = db.batch();
    promotionUpdates.slice(offset, offset + 400).forEach(({ document, patch }) => batch.set(document.ref, patch, { merge: true }));
    await batch.commit();
  }
  report.promotionsUpdated = promotionUpdates.length;

  const changed = Object.values(report).some((value) => Number(value) > 0);
  if (changed) {
    const auditRef = db.collection('audit').doc();
    await auditRef.set({
      id: auditRef.id,
      type: 'store-catalog-retirement',
      action: 'store.catalog.retirement',
      retiredProductIds,
      retiredSkus,
      report,
      sourceVersion: STORE_CATALOG.version,
      actor: { source: 'server-startup' },
      at: now,
      createdAt: now
    }, { merge: false });
  }
  return { skipped: false, changed, ...report };
}

function scheduleCatalogRetirementCleanup() {
  if (!cleanupRun) {
    cleanupRun = reconcileRetiredCatalogData({ apply: false }).catch((error) => {
      cleanupRun = null;
      throw error;
    });
  }
  return cleanupRun;
}

module.exports = {
  buildCatalogRetirementPlan,
  preserveHistoricalInventory,
  promotionRetirementPatch,
  reconcileRetiredCatalogData,
  scheduleCatalogRetirementCleanup
};
