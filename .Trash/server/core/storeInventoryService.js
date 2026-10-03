'use strict';

const crypto = require('crypto');
const env = require('../config/env');
const { initFirebaseAdmin } = require('../config/firebaseAdmin');
const { getEffectiveCatalog } = require('./storeCatalogService');
const { STORE_CATALOG } = require('./storeCatalog');
const keyVault = require('./storeKeyVault');
const { recordMutationAudit } = require('./storeMutationAudit');

const INVENTORY_STATUSES = Object.freeze(['available', 'reserved', 'released', 'delivered', 'revoked', 'expired']);
const INVENTORY_TYPES = Object.freeze(['license', 'account']);
const MAX_IMPORT_KEYS = 200;
const STOCK_CACHE_TTL_MS = 60_000;
const RESTOCK_SUBSCRIPTION_TTL_MS = 30 * 86_400_000;
const RESTOCK_NOTIFICATION_TTL_MS = 7 * 86_400_000;
const INVENTORY_IMPORT_RECEIPT_TTL_MS = 30 * 86_400_000;
const STORE_CATALOG_PRODUCTS = STORE_CATALOG.products || [];
const INVENTORY_PATH_PATTERN = /^storeInventory\/([a-z0-9][a-z0-9-]{1,79}__[a-z0-9][a-z0-9-]{1,39})\/items\/([A-Za-z0-9_-]{8,160})$/;
let stockCache = null;
const stockLoads = new Map();

function serviceError(code, statusCode = 400, details = {}) {
  return Object.assign(new Error(code), { code, statusCode, ...details });
}

function safeText(value = '', max = 160) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max);
}

function firebaseStore() {
  const firebase = initFirebaseAdmin();
  if (!firebase.db || !firebase.admin) throw serviceError('STORE_STORAGE_UNAVAILABLE', 503);
  return firebase;
}

function skuKey(productId = '', planKey = '') {
  const product = safeText(productId, 80).toLowerCase();
  const plan = safeText(planKey, 40).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,79}$/.test(product) || !/^[a-z0-9][a-z0-9-]{1,39}$/.test(plan)) {
    throw serviceError('STORE_SKU_INVALID', 400);
  }
  return `${product}__${plan}`;
}

function inventoryPoolId(product = {}) {
  const pool = safeText(product.inventoryPoolId, 80).toLowerCase();
  return pool || safeText(product.id, 80).toLowerCase();
}

function inventorySkuKey(product = {}, planKey = '') {
  return skuKey(inventoryPoolId(product), planKey);
}

function poolMembers(catalog = {}, product = {}, plan = {}) {
  const poolId = inventoryPoolId(product);
  const shared = !!safeText(product.inventoryPoolId, 80);
  const members = shared
    ? (catalog.products || []).filter((candidate) => inventoryPoolId(candidate) === poolId && candidate.plans?.some((entry) => entry.key === plan.key))
    : [product];
  return members.length ? members : [product];
}

function inventoryTarget(catalog = {}, product = {}, plan = {}) {
  const poolId = inventoryPoolId(product);
  const sku = skuKey(poolId, plan.key);
  const members = poolMembers(catalog, product, plan);
  const legacySkus = members
    .map((member) => skuKey(member.id, plan.key))
    .filter((candidate) => candidate !== sku);
  return {
    sku,
    poolId,
    shared: legacySkus.length > 0,
    members,
    sourceSkus: [sku, ...new Set(legacySkus)]
  };
}

function allocationSourceSkus(item = {}) {
  const poolId = safeText(item.inventoryPoolId, 80).toLowerCase() || safeText(item.productId, 80).toLowerCase();
  const canonical = skuKey(poolId, item.planKey);
  const members = STORE_CATALOG_PRODUCTS.filter((product) => inventoryPoolId(product) === poolId && product.plans?.some((plan) => plan.key === item.planKey));
  const legacy = members.map((product) => skuKey(product.id, item.planKey)).filter((candidate) => candidate !== canonical);
  return [canonical, ...new Set(legacy)];
}

function invalidateStockCache() {
  stockCache = null;
}

function inventoryReadiness() {
  const firebase = initFirebaseAdmin();
  const report = env.configurationReport();
  const blockers = [];
  if (!firebase.enabled || !firebase.db) blockers.push('FIREBASE_KEY');
  if (!env.storeKeys.encryptionReady) blockers.push('STORE_KEY_ENCRYPTION_SECRET');
  if (!env.storeKeys.fingerprintReady) blockers.push('STORE_KEY_FINGERPRINT_SECRET');
  if (env.storeKeys.encryptionReady && env.storeKeys.fingerprintReady && !env.storeKeys.distinct) blockers.push('STORE_KEY_SECRETS_MUST_DIFFER');
  return {
    ready: blockers.length === 0,
    firebaseReady: firebase.enabled === true && !!firebase.db,
    keyVaultReady: env.storeKeys.configured === true,
    keyRotation: keyVault.rotationStatus(),
    publicFirebaseReady: report.firebasePublicReady === true,
    maxBatchSize: MAX_IMPORT_KEYS,
    supportedTypes: [...INVENTORY_TYPES],
    blockers: [...new Set(blockers)],
    checkedAt: Date.now()
  };
}

function inventoryItemCollection(db, sku) {
  return db.collection('storeInventory').doc(sku).collection('items');
}

function stockState(count = 0) {
  const available = Math.max(0, Math.trunc(Number(count) || 0));
  if (available < 1) return 'out_of_stock';
  if (available <= 3) return 'low_stock';
  return 'in_stock';
}

function inventoryType(value = '') {
  return value === 'account' ? 'account' : 'license';
}

function automaticInventoryEnabled(product = {}) {
  return product.fulfillmentMode !== 'telegram_only';
}

function assertAutomaticInventoryProduct(product = {}) {
  if (!automaticInventoryEnabled(product)) throw serviceError('STORE_AUTOMATIC_INVENTORY_DISABLED', 409);
}

function importIdempotencyKey(value = '') {
  const key = safeText(value, 160);
  if (key.length < 12) throw serviceError('IDEMPOTENCY_KEY_REQUIRED', 400);
  return key;
}

function splitAccountCredential(value = '') {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return { username: String(value.username || value.login || ''), password: String(value.password || '') };
  }
  const source = String(value ?? '').normalize('NFKC').trim();
  const separators = ['\t', '|', ';', ',', ':'];
  const positions = separators
    .map((separator) => ({ separator, index: source.indexOf(separator) }))
    .filter(({ index }) => index > 0)
    .sort((left, right) => left.index - right.index);
  if (!positions.length) throw serviceError('STORE_INVENTORY_ACCOUNT_FORMAT_INVALID', 400);
  const { separator, index } = positions[0];
  return {
    username: source.slice(0, index),
    password: source.slice(index + separator.length)
  };
}

function normalizeAccountCredential(value = '') {
  const source = splitAccountCredential(value);
  const username = String(source.username || '').normalize('NFKC').trim();
  const password = String(source.password || '').normalize('NFKC').trim();
  if (username.length < 3 || username.length > 160 || password.length < 6 || password.length > 256
    || /[\u0000-\u001f\u007f]/.test(username) || /[\u0000-\u001f\u007f]/.test(password)) {
    throw serviceError('STORE_INVENTORY_ACCOUNT_FORMAT_INVALID', 400);
  }
  return { username, password };
}

function encodeInventorySecret(value, type = 'license') {
  const safeType = inventoryType(type);
  if (safeType === 'account') {
    const account = normalizeAccountCredential(value);
    return JSON.stringify({ version: 1, type: 'account', username: account.username, password: account.password });
  }
  return keyVault.normalizeSecret(value);
}

function maskAccountUsername(value = '') {
  const username = String(value || '').trim();
  const at = username.lastIndexOf('@');
  if (at > 0) {
    const local = username.slice(0, at);
    const domain = username.slice(at + 1);
    return `${local.slice(0, Math.min(2, local.length))}${'•'.repeat(Math.max(3, Math.min(7, local.length - 1)))}@${domain}`;
  }
  return `${username.slice(0, Math.min(3, username.length))}${'•'.repeat(Math.max(4, Math.min(9, username.length - 1)))}`;
}

function maskInventorySecret(encoded = '', type = 'license') {
  if (inventoryType(type) !== 'account') return keyVault.maskSecret(encoded);
  const parsed = JSON.parse(encoded);
  return `${maskAccountUsername(parsed.username)} | ${'•'.repeat(8)}`;
}

function decodeInventorySecret(item = {}, context = {}) {
  const explicitRecordType = safeText(context.recordType || item.recordType, 20).toLowerCase();
  const recordType = explicitRecordType === 'delivery'
    || (!explicitRecordType && safeText(item.uid, 160) && safeText(item.orderId, 160))
    ? 'delivery'
    : 'inventory';
  const plaintext = keyVault.decryptSecret(item.secret, { ...item, ...context, recordType });
  if (inventoryType(item.inventoryType) !== 'account') {
    return { type: 'license', key: plaintext, copyValue: plaintext };
  }
  try {
    const parsed = JSON.parse(plaintext);
    if (parsed?.type !== 'account') throw new Error('invalid-type');
    const account = normalizeAccountCredential({ username: parsed.username, password: parsed.password });
    return {
      type: 'account',
      account,
      copyValue: `${account.username} | ${account.password}`
    };
  } catch (_) {
    try {
      const account = normalizeAccountCredential(plaintext);
      return { type: 'account', account, copyValue: `${account.username} | ${account.password}` };
    } catch (_) {
      return { type: 'license', key: plaintext, copyValue: plaintext };
    }
  }
}

function inventoryPathIdentity(value = '') {
  const path = safeText(value, 300);
  const match = path.match(INVENTORY_PATH_PATTERN);
  return match ? { path, sku: match[1], itemId: match[2] } : null;
}

async function summaryMapForCatalog(catalog, { fresh = false } = {}) {
  const now = Date.now();
  const targets = new Map();
  for (const product of catalog.products || []) {
    if (!automaticInventoryEnabled(product)) continue;
    for (const plan of product.plans || []) {
      const target = inventoryTarget(catalog, product, plan);
      if (!targets.has(target.sku)) targets.set(target.sku, { ...target, productId: product.id, planKey: plan.key });
    }
  }
  const sourceSkus = [...new Set([...targets.values()].flatMap((target) => target.sourceSkus))].sort();
  const signature = sourceSkus.join('|');
  if (!fresh && stockCache && stockCache.signature === signature && now - stockCache.at < STOCK_CACHE_TTL_MS) return stockCache.map;
  if (stockLoads.has(signature)) return stockLoads.get(signature);
  const loading = (async () => {
    const { db, admin } = firebaseStore();
    const collection = db.collection('storeInventorySummary');
    const documents = new Map();
    if (sourceSkus.length && typeof admin.firestore?.FieldPath?.documentId === 'function' && typeof collection.where === 'function') {
      const batches = [];
      for (let offset = 0; offset < sourceSkus.length; offset += 30) {
        batches.push(collection.where(admin.firestore.FieldPath.documentId(), 'in', sourceSkus.slice(offset, offset + 30)).get());
      }
      const snapshots = await Promise.all(batches);
      snapshots.forEach((snapshot) => snapshot.docs.forEach((document) => documents.set(document.id, document.data() || {})));
    } else if (sourceSkus.length) {
      const references = sourceSkus.map((sku) => collection.doc(sku));
      const snapshots = typeof db.getAll === 'function'
        ? await db.getAll(...references)
        : await Promise.all(references.map((reference) => reference.get()));
      snapshots.filter((snapshot) => snapshot.exists).forEach((snapshot) => documents.set(snapshot.id, snapshot.data() || {}));
    }
    const map = new Map();
    for (const target of targets.values()) {
      const aggregate = target.sourceSkus.reduce((output, sourceSku) => {
        const source = documents.get(sourceSku) || {};
        output.available += Math.max(0, Math.trunc(Number(source.availableCount) || 0));
        output.delivered += Math.max(0, Math.trunc(Number(source.deliveredCount) || 0));
        output.revoked += Math.max(0, Math.trunc(Number(source.revokedCount) || 0));
        output.reserved += Math.max(0, Math.trunc(Number(source.reservedCount) || 0));
        output.released += Math.max(0, Math.trunc(Number(source.releasedCount) || 0));
        output.expired += Math.max(0, Math.trunc(Number(source.expiredCount) || 0));
        output.lastImportAt = Math.max(output.lastImportAt, Math.max(0, Number(source.lastImportAt || 0) || 0));
        output.lastDeliveryAt = Math.max(output.lastDeliveryAt, Math.max(0, Number(source.lastDeliveryAt || 0) || 0));
        output.updatedAt = Math.max(output.updatedAt, Math.max(0, Number(source.updatedAt || 0) || 0));
        return output;
      }, { available: 0, delivered: 0, revoked: 0, reserved: 0, released: 0, expired: 0, lastImportAt: 0, lastDeliveryAt: 0, updatedAt: 0 });
      map.set(target.sku, {
        sku: target.sku,
        inventoryPoolId: target.poolId,
        sharedPool: target.shared,
        sourceSkus: target.sourceSkus,
        productId: target.productId,
        planKey: target.planKey,
        ...aggregate,
        state: stockState(aggregate.available)
      });
    }
    stockCache = { at: Date.now(), signature, map };
    return map;
  })();
  stockLoads.set(signature, loading);
  try {
    return await loading;
  } finally {
    if (stockLoads.get(signature) === loading) stockLoads.delete(signature);
  }
}

async function decorateCatalogWithStock(catalog, options = {}) {
  const summaries = await summaryMapForCatalog(catalog, options);
  return {
    ...catalog,
    products: catalog.products.map((product) => {
      if (!automaticInventoryEnabled(product)) {
        const stock = { available: 0, delivered: 0, revoked: 0, state: 'not_applicable', automaticDelivery: false };
        return { ...product, stock: { ...stock }, plans: product.plans.map((plan) => ({ ...plan, stock: { ...stock } })) };
      }
      const plans = product.plans.map((plan) => {
        const stock = summaries.get(inventorySkuKey(product, plan.key)) || { available: 0, delivered: 0, revoked: 0, state: 'out_of_stock' };
        return { ...plan, stock };
      });
      const available = plans.reduce((sum, plan) => sum + plan.stock.available, 0);
      return { ...product, stock: { available, state: stockState(available) }, plans };
    })
  };
}

async function resolveSku(productId = '', planKey = '', { includeInactive = true } = {}) {
  const catalog = await getEffectiveCatalog({ includeInactive });
  const product = catalog.products.find((item) => item.id === safeText(productId, 80).toLowerCase());
  const plan = product?.plans?.find((item) => item.key === safeText(planKey, 40).toLowerCase());
  if (!product || !plan) throw serviceError('STORE_ITEM_UNAVAILABLE', 409);
  return { catalog, product, plan, ...inventoryTarget(catalog, product, plan) };
}

function normalizeImportKeys(values = [], type = 'license') {
  const source = Array.isArray(values) ? values : [];
  if (!source.length || source.length > MAX_IMPORT_KEYS) throw serviceError('STORE_INVENTORY_IMPORT_INVALID', 400);
  const safeType = inventoryType(type);
  const keys = source.map((value) => encodeInventorySecret(value, safeType));
  const fingerprints = keys.map((value) => keyVault.fingerprintSecret(value));
  if (new Set(fingerprints).size !== fingerprints.length) throw serviceError('STORE_INVENTORY_DUPLICATE_KEY', 409);
  return keys.map((value, index) => ({
    value,
    fingerprint: fingerprints[index],
    inventoryType: safeType,
    masked: maskInventorySecret(value, safeType)
  }));
}

async function inspectInventoryImport({ productId = '', planKey = '', keys = [] } = {}) {
  const { product, plan, sku, poolId, shared } = await resolveSku(productId, planKey);
  assertAutomaticInventoryProduct(product);
  const type = inventoryType(product.inventoryType);
  const input = normalizeImportKeys(keys, type);
  const { db } = firebaseStore();
  const inventoryRefs = input.map((entry) => db.collection('storeInventoryFingerprints').doc(entry.fingerprint));
  const manualRefs = input.map((entry) => db.collection('storeManualDeliveryFingerprints').doc(entry.fingerprint));
  const snapshots = typeof db.getAll === 'function'
    ? await db.getAll(...inventoryRefs, ...manualRefs)
    : await Promise.all([...inventoryRefs, ...manualRefs].map((ref) => ref.get()));
  const inventorySnapshots = snapshots.slice(0, input.length);
  const manualSnapshots = snapshots.slice(input.length);
  const duplicates = [];
  input.forEach((entry, index) => {
    const automatic = inventorySnapshots[index];
    const manual = manualSnapshots[index];
    if (manual?.exists) {
      const row = manual.data() || {};
      duplicates.push({ masked: entry.masked, source: 'telegram-manual', status: safeText(row.status || 'bound', 30), overrideAllowed: false });
      return;
    }
    if (automatic?.exists) {
      const row = automatic.data() || {};
      const status = safeText(row.status || 'unknown', 30).toLowerCase();
      duplicates.push({ masked: entry.masked, source: 'automatic', status, overrideAllowed: false });
    }
  });
  return {
    productId: product.id,
    planKey: plan.key,
    sku,
    inventoryPoolId: poolId,
    sharedPool: shared,
    inventoryType: type,
    total: input.length,
    duplicates,
    duplicateCount: duplicates.length,
    requiresConfirmation: duplicates.length > 0,
    canOverride: false
  };
}

async function queueRestockNotifications({ sourceSkus = [], product, plan }) {
  const { db, admin } = firebaseStore();
  const skus = [...new Set((Array.isArray(sourceSkus) ? sourceSkus : []).map((value) => safeText(value, 130)).filter(Boolean))];
  if (!skus.length) return 0;
  const docs = new Map();
  for (const sku of skus) {
    let cursor = null;
    for (let page = 0; page < 50; page += 1) {
      let query = db.collection('storeRestockSubscriptions').where('sku', '==', sku)
        .orderBy(admin.firestore.FieldPath.documentId()).limit(200);
      if (cursor) query = query.startAfter(cursor);
      const snapshot = await query.get();
      snapshot.docs.forEach((doc) => {
        if (doc.data()?.active === true) docs.set(doc.ref.path, doc);
      });
      if (snapshot.size < 200) break;
      cursor = snapshot.docs[snapshot.docs.length - 1];
    }
  }
  if (!docs.size) return 0;
  const now = Date.now();
  const entries = [...docs.values()];
  let notified = 0;
  for (let offset = 0; offset < entries.length; offset += 200) {
    const batch = db.batch();
    for (const doc of entries.slice(offset, offset + 200)) {
      const subscription = doc.data() || {};
      const uid = safeText(subscription.uid, 160);
      if (!uid) continue;
      const notificationRef = db.collection('storeUserNotifications').doc(uid).collection('items').doc();
      batch.create(notificationRef, {
        id: notificationRef.id, type: 'restock', title: 'Stok yeniden açıldı',
        message: `${product.name} · ${plan.label} paketi yeniden stokta.`,
        productId: product.id, planKey: plan.key, read: false, createdAt: now,
        expiresAt: new Date(now + RESTOCK_NOTIFICATION_TTL_MS)
      });
      batch.delete(doc.ref);
      notified += 1;
    }
    await batch.commit();
  }
  return notified;
}

async function importInventory({ productId = '', planKey = '', keys = [], actor = {}, idempotencyKey = '' } = {}) {
  const { catalog, product, plan, sku, poolId, shared, sourceSkus } = await resolveSku(productId, planKey);
  assertAutomaticInventoryProduct(product);
  const actorUid = safeText(actor.uid, 160);
  if (!actorUid) throw serviceError('ADMIN_REQUIRED', 403);
  const requestKey = importIdempotencyKey(idempotencyKey);
  const type = inventoryType(product.inventoryType);
  const input = normalizeImportKeys(keys, type);
  const { db } = firebaseStore();
  const summaryRef = db.collection('storeInventorySummary').doc(sku);
  const requestHash = crypto.createHash('sha256').update(JSON.stringify({
    sku,
    fingerprints: input.map((entry) => entry.fingerprint).sort()
  })).digest('hex');
  const receiptId = crypto.createHash('sha256').update(`store-inventory-import:${actorUid}:${requestKey}`).digest('hex');
  const receiptRef = db.collection('storeInventoryImports').doc(receiptId);
  const prepared = input.map((entry) => {
    const itemRef = inventoryItemCollection(db, sku).doc();
    return {
      ...entry,
      itemRef,
      registryRef: db.collection('storeInventoryFingerprints').doc(entry.fingerprint),
      manualRegistryRef: db.collection('storeManualDeliveryFingerprints').doc(entry.fingerprint),
      encrypted: keyVault.encryptSecret(entry.value, {
        recordType: 'inventory', recordId: itemRef.id, sku, productId: product.id, planKey: plan.key
      }),
      masked: entry.masked
    };
  });
  let previousAvailable = 0;
  let availableAfter = 0;
  let idempotentReplay = false;
  let duplicateReentries = 0;
  let replacedActiveDuplicates = 0;
  const now = Date.now();

  await db.runTransaction(async (tx) => {
    const fingerprintRefs = prepared.flatMap((entry) => [entry.registryRef, entry.manualRegistryRef]);
    const snapshots = typeof tx.getAll === 'function'
      ? await tx.getAll(receiptRef, summaryRef, ...fingerprintRefs)
      : await Promise.all([receiptRef, summaryRef, ...fingerprintRefs].map((ref) => tx.get(ref)));
    const [receiptSnapshot, summarySnapshot, ...fingerprintSnapshots] = snapshots;
    if (receiptSnapshot.exists) {
      const receipt = receiptSnapshot.data() || {};
      if (receipt.requestHash !== requestHash || receipt.sku !== sku) throw serviceError('STORE_INVENTORY_IMPORT_CONFLICT', 409);
      previousAvailable = Math.max(0, Number(receipt.previousAvailable || 0) || 0);
      availableAfter = Math.max(0, Number(receipt.available || 0) || 0);
      duplicateReentries = Math.max(0, Number(receipt.duplicateReentries || 0) || 0);
      replacedActiveDuplicates = Math.max(0, Number(receipt.replacedActiveDuplicates || 0) || 0);
      idempotentReplay = true;
      return;
    }

    const registrySnapshots = [];
    const manualSnapshots = [];
    for (let index = 0; index < prepared.length; index += 1) {
      registrySnapshots.push(fingerprintSnapshots[index * 2]);
      manualSnapshots.push(fingerprintSnapshots[index * 2 + 1]);
    }
    if (manualSnapshots.some((snapshot) => snapshot?.exists)) throw serviceError('STORE_INVENTORY_DUPLICATE_MANUAL_DELIVERY', 409);
    const duplicateIndexes = registrySnapshots.map((snapshot, index) => snapshot?.exists ? index : -1).filter((index) => index >= 0);
    if (duplicateIndexes.length) throw serviceError('STORE_INVENTORY_DUPLICATE_KEY', 409);

    const targetState = summarySnapshot.exists ? { ...(summarySnapshot.data() || {}) } : {};
    previousAvailable = Math.max(0, Number(targetState.availableCount || 0) || 0);
    targetState.availableCount = previousAvailable + prepared.length;
    targetState.updatedAt = now;
    availableAfter = targetState.availableCount;

    for (let index = 0; index < prepared.length; index += 1) {
      const entry = prepared[index];
      tx.create(entry.registryRef, { fingerprint: entry.fingerprint, sku, itemId: entry.itemRef.id, status: 'available', createdAt: now, updatedAt: now });
      tx.create(entry.itemRef, {
        id: entry.itemRef.id,
        sku,
        inventoryPoolId: poolId,
        sourceProductId: product.id,
        productId: product.id,
        planKey: plan.key,
        inventoryType: entry.inventoryType,
        secret: entry.encrypted,
        encryptionKeyId: keyVault.activeKeyId(),
        fingerprint: entry.fingerprint,
        masked: entry.masked,
        status: 'available',
        orderId: '',
        customerUid: '',
        duplicateReentry: false,
        duplicateReentryReason: '',
        createdAt: now,
        createdBy: { uid: actorUid, email: safeText(actor.email, 160).toLowerCase() },
        statusHistory: [{ status: 'available', at: now, actorUid }],
        updatedAt: now
      });
    }

    tx.set(summaryRef, {
      sku,
      inventoryPoolId: poolId,
      sharedPool: shared,
      productIds: sourceSkus.length > 1 ? sourceSkus.slice(1).map((value) => value.split('__')[0]) : [product.id],
      productId: product.id,
      planKey: plan.key,
      availableCount: availableAfter,
      deliveredCount: Math.max(0, Number(targetState.deliveredCount || 0) || 0),
      revokedCount: Math.max(0, Number(targetState.revokedCount || 0) || 0),
      reservedCount: Math.max(0, Number(targetState.reservedCount || 0) || 0),
      releasedCount: Math.max(0, Number(targetState.releasedCount || 0) || 0),
      expiredCount: Math.max(0, Number(targetState.expiredCount || 0) || 0),
      lastImportAt: now,
      lastDeliveryAt: Math.max(0, Number(targetState.lastDeliveryAt || 0) || 0),
      updatedAt: now
    }, { merge: true });

    tx.create(receiptRef, {
      id: receiptId,
      requestHash,
      sku,
      inventoryPoolId: poolId,
      sharedPool: shared,
      productId: product.id,
      planKey: plan.key,
      inventoryType: type,
      imported: prepared.length,
      previousAvailable,
      available: availableAfter,
      duplicateReentries,
      replacedActiveDuplicates,
      duplicateReason: '',
      actorUid,
      createdAt: now,
      expiresAt: new Date(now + INVENTORY_IMPORT_RECEIPT_TTL_MS)
    });
    const eventRef = db.collection('storeInventoryEvents').doc();
    tx.create(eventRef, {
      id: eventRef.id, type: 'import', sku, storageSku: sku, inventoryPoolId: poolId,
      productId: product.id, planKey: plan.key, quantity: prepared.length, duplicateReentries, replacedActiveDuplicates,
      reason: '',
      actor: { uid: actorUid, email: safeText(actor.email, 160).toLowerCase(), source: 'admin' }, createdAt: now
    });
    tx.create(db.collection('audit').doc(`store_inventory_import_${receiptId}`), {
      uid: actorUid,
      type: 'store-inventory-import',
      productId: product.id,
      planKey: plan.key,
      sku,
      imported: prepared.length,
      duplicateReentries,
      replacedActiveDuplicates,
      reason: '',
      actor: { uid: actorUid, email: safeText(actor.email, 160).toLowerCase(), source: 'admin' },
      transactionId: receiptId,
      at: now
    });
  });

  invalidateStockCache();
  const unifiedSummary = await summaryMapForCatalog(catalog, { fresh: true });
  const unifiedAvailable = Math.max(0, Number(unifiedSummary.get(sku)?.available || availableAfter) || 0);
  let notificationsQueued = 0;
  if (!idempotentReplay && duplicateReentries === 0 && unifiedAvailable > 0 && previousAvailable === 0) {
    notificationsQueued = await queueRestockNotifications({ sourceSkus, product, plan }).catch(() => 0);
  }
  return {
    sku, inventoryPoolId: poolId, sharedPool: shared,
    productId: product.id, planKey: plan.key, inventoryType: type,
    imported: prepared.length, available: unifiedAvailable,
    duplicateReentries, replacedActiveDuplicates,
    notificationsQueued, idempotentReplay
  };
}

function allocationRequirements(items = []) {
  const requirements = new Map();
  for (const item of items) {
    if (item?.fulfillmentMode === 'telegram_only') throw serviceError('STORE_TELEGRAM_ONLY_PRODUCT', 409);
    const catalogProduct = STORE_CATALOG_PRODUCTS.find((product) => product.id === safeText(item?.productId, 80).toLowerCase());
    if (catalogProduct && !automaticInventoryEnabled(catalogProduct)) throw serviceError('STORE_TELEGRAM_ONLY_PRODUCT', 409);
    const poolId = safeText(item.inventoryPoolId, 80).toLowerCase() || safeText(item.productId, 80).toLowerCase();
    const sku = skuKey(poolId, item.planKey);
    const quantity = Math.max(1, Math.trunc(Number(item.quantity) || 1));
    const current = requirements.get(sku) || { sku, poolId, quantity: 0, segments: [], sourceSkus: allocationSourceSkus({ ...item, inventoryPoolId: poolId }) };
    current.quantity += quantity;
    current.segments.push({ item, quantity });
    requirements.set(sku, current);
  }
  return [...requirements.values()];
}

async function assertStockForCartInTransaction({ tx, db, items = [] }) {
  const requirements = allocationRequirements(items);
  for (const requirement of requirements) {
    let available = 0;
    for (const sourceSku of requirement.sourceSkus) {
      const summary = await tx.get(db.collection('storeInventorySummary').doc(sourceSku));
      available += summary.exists ? Math.max(0, Number(summary.data()?.availableCount || 0) || 0) : 0;
    }
    if (available < requirement.quantity) {
      const first = requirement.segments[0]?.item || {};
      throw serviceError('STORE_OUT_OF_STOCK', 409, { productId: first.productId, planKey: first.planKey, available });
    }
  }
}

async function allocateInventoryInTransaction({ tx, db, admin, items = [], orderId = '', uid = '', now = Date.now() }) {
  const requirements = allocationRequirements(items);
  const allocations = [];
  const summaryDeltas = new Map();

  for (const requirement of requirements) {
    const selected = [];
    let remaining = requirement.quantity;
    for (const sourceSku of requirement.sourceSkus) {
      if (remaining < 1) break;
      const snapshot = await tx.get(inventoryItemCollection(db, sourceSku).where('status', '==', 'available').limit(remaining));
      snapshot.docs.forEach((doc) => selected.push({ doc, sourceSku }));
      remaining -= snapshot.size;
    }
    if (remaining > 0) {
      const first = requirement.segments[0]?.item || {};
      throw serviceError('STORE_OUT_OF_STOCK', 409, { productId: first.productId, planKey: first.planKey, available: requirement.quantity - remaining });
    }

    let cursor = 0;
    for (const segment of requirement.segments) {
      for (let count = 0; count < segment.quantity; count += 1) {
        const selectedItem = selected[cursor++];
        allocations.push({ ...selectedItem, requirement, item: segment.item });
      }
    }
  }

  for (const allocation of allocations) {
    summaryDeltas.set(allocation.sourceSku, (summaryDeltas.get(allocation.sourceSku) || 0) + 1);
  }
  const summaryStates = new Map();
  for (const sourceSku of summaryDeltas.keys()) {
    const snapshot = await tx.get(db.collection('storeInventorySummary').doc(sourceSku));
    summaryStates.set(sourceSku, snapshot.exists ? (snapshot.data() || {}) : {});
  }

  for (const allocation of allocations) {
    const data = allocation.doc.data() || {};
    if (data.status !== 'available' || data.sku !== allocation.sourceSku) throw serviceError('STORE_STOCK_CONFLICT', 409);
    tx.update(allocation.doc.ref, {
      status: 'delivered', orderId, customerUid: uid,
      inventoryType: inventoryType(data.inventoryType || allocation.item.inventoryType),
      reservedAt: now, deliveredAt: now,
      statusHistory: [
        ...(Array.isArray(data.statusHistory) ? data.statusHistory.slice(-16) : []),
        { status: 'reserved', at: now, orderId }, { status: 'delivered', at: now, orderId }
      ],
      updatedAt: now
    });
    tx.set(db.collection('storeInventoryFingerprints').doc(safeText(data.fingerprint, 64)), {
      sku: allocation.sourceSku, itemId: allocation.doc.id, status: 'delivered', orderId, customerUid: uid, deliveredAt: now
    }, { merge: true });
    const deliveryId = allocation.sourceSku === allocation.requirement.sku
      ? allocation.doc.id
      : `l_${crypto.createHash('sha256').update(`${allocation.sourceSku}:${allocation.doc.id}`).digest('hex').slice(0, 30)}`;
    const deliveryRef = db.collection('storeDeliveries').doc(orderId).collection('items').doc(deliveryId);
    tx.create(deliveryRef, {
      id: deliveryRef.id, orderId, uid, inventoryPath: allocation.doc.ref.path,
      productId: allocation.item.productId, productName: allocation.item.productName,
      planKey: allocation.item.planKey, planLabel: allocation.item.planLabel, duration: allocation.item.duration,
      inventoryType: inventoryType(data.inventoryType || allocation.item.inventoryType),
      masked: safeText(data.masked, 80), createdAt: now
    });
    const eventRef = db.collection('storeInventoryEvents').doc();
    tx.create(eventRef, {
      id: eventRef.id, type: 'delivered', sku: allocation.requirement.sku, storageSku: allocation.sourceSku,
      inventoryPoolId: allocation.requirement.poolId, itemId: allocation.doc.id,
      productId: allocation.item.productId, planKey: allocation.item.planKey,
      quantity: -1, orderId, customerUid: uid, actor: { uid: 'system', source: 'automatic-delivery' }, createdAt: now
    });
  }

  for (const [sourceSku, quantity] of summaryDeltas.entries()) {
    const current = summaryStates.get(sourceSku) || {};
    tx.set(db.collection('storeInventorySummary').doc(sourceSku), {
      availableCount: Math.max(0, Math.trunc(Number(current.availableCount) || 0) - quantity),
      deliveredCount: Math.max(0, Math.trunc(Number(current.deliveredCount) || 0)) + quantity,
      lastDeliveryAt: now,
      updatedAt: now
    }, { merge: true });
  }
  return allocations.map((allocation) => ({
    itemId: allocation.doc.id, productId: allocation.item.productId, planKey: allocation.item.planKey,
    masked: safeText(allocation.doc.data()?.masked, 80)
  }));
}

async function attachManualDeliveryInTransaction({ tx, db, orderId = '', uid = '', items = [], values = [], now = Date.now() }) {
  const safeOrderId = safeText(orderId, 160);
  const safeUid = safeText(uid, 160);
  if (!safeOrderId || !safeUid) throw serviceError('STORE_MANUAL_DELIVERY_INVALID', 400);
  if (!Array.isArray(values) || values.length < 1 || values.length > 100) throw serviceError('STORE_MANUAL_DELIVERY_INVALID', 400);

  const expanded = [];
  for (const item of Array.isArray(items) ? items : []) {
    const quantity = Math.max(1, Math.min(5, Math.trunc(Number(item.quantity) || 1)));
    for (let index = 0; index < quantity; index += 1) expanded.push(item);
  }
  if (expanded.length !== values.length) {
    throw serviceError('STORE_MANUAL_DELIVERY_COUNT_MISMATCH', 409, { expected: expanded.length, received: values.length });
  }

  const seenFingerprints = new Set();
  const prepared = values.map((raw, index) => {
    const item = expanded[index] || {};
    const type = inventoryType(item.inventoryType);
    const encoded = encodeInventorySecret(raw, type);
    const fingerprint = keyVault.fingerprintSecret(encoded);
    if (seenFingerprints.has(fingerprint)) throw serviceError('STORE_INVENTORY_DUPLICATE_KEY', 409);
    seenFingerprints.add(fingerprint);
    const deliveryRef = db.collection('storeDeliveries').doc(safeOrderId).collection('items').doc();
    return {
      item,
      type,
      encoded,
      fingerprint,
      encrypted: keyVault.encryptSecret(encoded, {
        recordType: 'delivery', recordId: deliveryRef.id, productId: item.productId,
        planKey: item.planKey, orderId: safeOrderId, uid: safeUid
      }),
      masked: maskInventorySecret(encoded, type),
      deliveryRef,
      manualFingerprintRef: db.collection('storeManualDeliveryFingerprints').doc(fingerprint),
      inventoryFingerprintRef: db.collection('storeInventoryFingerprints').doc(fingerprint)
    };
  });

  for (const entry of prepared) {
    const [manualFingerprint, inventoryFingerprint] = await Promise.all([
      tx.get(entry.manualFingerprintRef),
      tx.get(entry.inventoryFingerprintRef)
    ]);
    if (manualFingerprint.exists || inventoryFingerprint.exists) throw serviceError('STORE_INVENTORY_DUPLICATE_KEY', 409);
  }

  for (const entry of prepared) {
    tx.create(entry.deliveryRef, {
      id: entry.deliveryRef.id,
      orderId: safeOrderId,
      uid: safeUid,
      source: 'telegram-manual',
      productId: safeText(entry.item.productId, 80),
      productName: safeText(entry.item.productName, 80),
      planKey: safeText(entry.item.planKey, 40),
      planLabel: safeText(entry.item.planLabel, 50),
      duration: safeText(entry.item.duration, 50),
      inventoryType: entry.type,
      secret: entry.encrypted,
      encryptionKeyId: keyVault.activeKeyId(),
      fingerprint: entry.fingerprint,
      masked: safeText(entry.masked, 80),
      createdAt: now
    });
    tx.create(entry.manualFingerprintRef, {
      fingerprint: entry.fingerprint,
      orderId: safeOrderId,
      customerUid: safeUid,
      source: 'telegram-manual',
      status: 'bound',
      createdAt: now
    });
  }

  return prepared.map((entry) => ({
    itemId: entry.deliveryRef.id,
    productId: safeText(entry.item.productId, 80),
    planKey: safeText(entry.item.planKey, 40),
    masked: safeText(entry.masked, 80)
  }));
}

async function readDeliverySecrets({ uid = '', orderId = '' } = {}) {
  const safeUid = safeText(uid, 160);
  const safeOrderId = safeText(orderId, 160);
  if (!safeUid) throw serviceError('AUTH_REQUIRED', 401);
  if (!safeOrderId) throw serviceError('STORE_ORDER_ID_REQUIRED', 400);
  const { db } = firebaseStore();
  const orderRef = db.collection('storeOrders').doc(safeOrderId);
  const profileRef = db.collection('users').doc(safeUid);
  const [orderSnapshot, profileSnapshot] = typeof db.getAll === 'function'
    ? await db.getAll(orderRef, profileRef)
    : await Promise.all([orderRef.get(), profileRef.get()]);
  if (profileSnapshot.data()?.storeAccountStatus === 'suspended') throw serviceError('STORE_ACCOUNT_SUSPENDED', 403);
  if (!orderSnapshot.exists) throw serviceError('STORE_ORDER_NOT_FOUND', 404);
  const order = orderSnapshot.data() || {};
  if (safeText(order.uid, 160) !== safeUid) throw serviceError('STORE_ORDER_ACCESS_DENIED', 403);
  if (order.status !== 'delivered' || order.delivery?.status !== 'delivered') throw serviceError('STORE_DELIVERY_NOT_READY', 409);
  const deliverySnapshot = await db.collection('storeDeliveries').doc(safeOrderId).collection('items').limit(100).get();
  if (deliverySnapshot.empty) throw serviceError('STORE_DELIVERY_KEY_NOT_AVAILABLE', 409);
  const inventorySnapshots = await Promise.all(deliverySnapshot.docs.map((doc) => {
    const delivery = doc.data() || {};
    if (delivery.secret) return Promise.resolve(null);
    const identity = inventoryPathIdentity(delivery.inventoryPath);
    return identity ? db.doc(identity.path).get() : Promise.resolve(null);
  }));
  const items = deliverySnapshot.docs.map((doc, index) => {
    const delivery = doc.data() || {};
    let opened;
    if (delivery.secret) {
      const embeddedId = safeText(delivery.id, 160);
      if ((embeddedId && embeddedId !== doc.id)
        || safeText(delivery.uid, 160) !== safeUid
        || safeText(delivery.orderId, 160) !== safeOrderId
        || !delivery.secret) {
        throw serviceError('STORE_DELIVERY_INTEGRITY_ERROR', 500);
      }
      opened = decodeInventorySecret(delivery, {
        recordType: 'delivery', recordId: doc.id, id: doc.id,
        orderId: safeOrderId, uid: safeUid
      });
    } else {
      const inventorySnapshot = inventorySnapshots[index];
      const inventory = inventorySnapshot?.exists ? (inventorySnapshot.data() || {}) : {};
      const identity = inventoryPathIdentity(delivery.inventoryPath);
      const embeddedId = safeText(inventory.id, 160);
      const embeddedSku = safeText(inventory.sku, 130);
      if (!identity || inventorySnapshot?.id !== identity.itemId
        || (embeddedId && embeddedId !== identity.itemId)
        || (embeddedSku && embeddedSku !== identity.sku)
        || inventory.status !== 'delivered'
        || inventory.orderId !== safeOrderId
        || inventory.customerUid !== safeUid) {
        throw serviceError('STORE_DELIVERY_INTEGRITY_ERROR', 500);
      }
      opened = decodeInventorySecret(inventory, {
        recordType: 'inventory', recordId: identity.itemId, id: identity.itemId, sku: identity.sku
      });
    }
    return {
      id: doc.id,
      productName: safeText(delivery.productName, 80),
      planLabel: safeText(delivery.planLabel, 50),
      duration: safeText(delivery.duration, 50),
      ...opened
    };
  });
  const now = Date.now();
  try {
    const batch = db.batch();
    batch.set(orderSnapshot.ref, {
      deliveryOpenedAt: now,
      deliveryOpenCount: initFirebaseAdmin().admin.firestore.FieldValue.increment(1),
      updatedAt: now
    }, { merge: true });
    batch.create(db.collection('storeDeliveryAccessAudit').doc(), {
      uid: safeUid, orderId: safeOrderId, itemCount: items.length, at: now,
      expiresAt: new Date(now + 180 * 86_400_000)
    });
    await batch.commit();
  } catch (_) {
    throw serviceError('STORE_DELIVERY_AUDIT_UNAVAILABLE', 503);
  }
  return { orderId: safeOrderId, orderNumber: safeText(order.orderNumber, 40), items, openedAt: now };
}

function sharedPoolDisplayName(target = {}, product = {}) {
  if (target.poolId === 'random-30sv-shared') return 'RANDOM HESAP · Android + iOS Ortak Havuz';
  if (target.shared) return `${safeText(product.name, 80)} · Ortak Havuz`;
  return safeText(product.name, 80);
}

async function inventorySummary({ fresh = true } = {}) {
  const catalog = await getEffectiveCatalog({ includeInactive: true });
  const summaries = await summaryMapForCatalog(catalog, { fresh });
  const rows = new Map();
  for (const product of catalog.products || []) {
    if (!automaticInventoryEnabled(product)) continue;
    for (const plan of product.plans || []) {
      const target = inventoryTarget(catalog, product, plan);
      if (rows.has(target.sku)) continue;
      const summary = summaries.get(target.sku) || {
        sku: target.sku, inventoryPoolId: target.poolId, sharedPool: target.shared,
        sourceSkus: target.sourceSkus, productId: product.id, planKey: plan.key,
        available: 0, delivered: 0, revoked: 0, reserved: 0, released: 0, expired: 0,
        lastImportAt: 0, lastDeliveryAt: 0, state: 'out_of_stock', updatedAt: 0
      };
      rows.set(target.sku, {
        ...summary,
        productId: product.id,
        productIds: target.members.map((member) => member.id),
        productName: sharedPoolDisplayName(target, product),
        platform: target.shared ? 'shared' : product.platform,
        platformLabel: target.shared ? 'ANDROID + IOS' : safeText(product.platform, 30).toUpperCase(),
        inventoryType: inventoryType(product.inventoryType),
        planLabel: plan.label,
        duration: plan.duration,
        productActive: target.members.some((member) => member.active !== false && member.archived !== true),
        planActive: target.members.some((member) => member.active !== false && member.archived !== true && member.plans?.some((entry) => entry.key === plan.key && entry.active !== false))
      });
    }
  }
  return [...rows.values()].map((row) => {
    const total = Math.max(0, Number(row.available || 0))
      + Math.max(0, Number(row.delivered || 0))
      + Math.max(0, Number(row.revoked || 0))
      + Math.max(0, Number(row.reserved || 0))
      + Math.max(0, Number(row.released || 0))
      + Math.max(0, Number(row.expired || 0));
    return { ...row, total };
  });
}

async function locateInventoryItem(db, sourceSkus = [], itemId = '', storageSku = '') {
  const safeItemId = safeText(itemId, 160);
  if (!safeItemId) throw serviceError('STORE_INVENTORY_ITEM_REQUIRED', 400);
  const candidates = [...new Set(sourceSkus.map((value) => safeText(value, 130)).filter(Boolean))];
  const requestedStorageSku = safeText(storageSku, 130).toLowerCase();
  if (requestedStorageSku) {
    if (!candidates.includes(requestedStorageSku)) throw serviceError('STORE_INVENTORY_ITEM_NOT_FOUND', 404);
    const snapshot = await inventoryItemCollection(db, requestedStorageSku).doc(safeItemId).get();
    if (!snapshot.exists) throw serviceError('STORE_INVENTORY_ITEM_NOT_FOUND', 404);
    return { snapshot, storageSku: requestedStorageSku };
  }
  const snapshots = await Promise.all(candidates.map(async (candidate) => ({
    storageSku: candidate,
    snapshot: await inventoryItemCollection(db, candidate).doc(safeItemId).get()
  })));
  const matches = snapshots.filter((entry) => entry.snapshot.exists);
  if (!matches.length) throw serviceError('STORE_INVENTORY_ITEM_NOT_FOUND', 404);
  if (matches.length > 1) throw serviceError('STORE_INVENTORY_INTEGRITY_ERROR', 409);
  return matches[0];
}

async function listInventory({ productId = '', planKey = '', status = '', limit = 100 } = {}) {
  const { catalog, product, plan, sku, poolId, shared, sourceSkus, members } = await resolveSku(productId, planKey);
  const { db } = firebaseStore();
  const requestedStatus = safeText(status, 30).toLowerCase();
  if (requestedStatus && !INVENTORY_STATUSES.includes(requestedStatus)) throw serviceError('STORE_INVENTORY_STATUS_INVALID', 400);
  const safeLimit = Math.max(1, Math.min(200, Math.trunc(Number(limit) || 100)));
  const snapshots = await Promise.all(sourceSkus.map(async (storageSku) => {
    let query = inventoryItemCollection(db, storageSku);
    if (requestedStatus) query = query.where('status', '==', requestedStatus);
    return { storageSku, snapshot: await query.limit(safeLimit).get() };
  }));
  const products = new Map((catalog.products || []).map((entry) => [entry.id, entry]));
  const items = snapshots.flatMap(({ storageSku, snapshot }) => snapshot.docs.map((doc) => {
    const row = doc.data() || {};
    const sourceProduct = products.get(safeText(row.sourceProductId || row.productId, 80).toLowerCase()) || product;
    return {
      id: doc.id,
      sku,
      storageSku,
      inventoryPoolId: poolId,
      sharedPool: shared,
      productId: product.id,
      sourceProductId: sourceProduct.id,
      productName: sourceProduct.name,
      platform: sourceProduct.platform,
      planKey: plan.key,
      planLabel: plan.label,
      inventoryType: inventoryType(row.inventoryType || product.inventoryType),
      masked: safeText(row.masked, 80),
      status: INVENTORY_STATUSES.includes(row.status) ? row.status : 'revoked',
      orderId: safeText(row.orderId, 160),
      customerUidSuffix: safeText(row.customerUid, 160).slice(-6),
      protectionCurrent: !keyVault.needsRotation(row.secret),
      createdAt: Math.max(0, Number(row.createdAt || 0) || 0),
      deliveredAt: Math.max(0, Number(row.deliveredAt || 0) || 0)
    };
  })).sort((left, right) => right.createdAt - left.createdAt).slice(0, safeLimit);
  return {
    sku, product, plan, items,
    pool: { id: poolId, shared, sourceSkus, productIds: members.map((member) => member.id) }
  };
}

async function revealInventorySecret({ productId = '', planKey = '', itemId = '', storageSku = '', reason = '', actor = {} } = {}) {
  const { product, plan, sku, sourceSkus, poolId } = await resolveSku(productId, planKey);
  const safeItemId = safeText(itemId, 160);
  const safeReason = safeText(reason, 200);
  if (!safeItemId) throw serviceError('STORE_INVENTORY_ITEM_REQUIRED', 400);
  if (safeReason.length < 3) throw serviceError('STORE_INVENTORY_REASON_REQUIRED', 400);
  const { db } = firebaseStore();
  const located = await locateInventoryItem(db, sourceSkus, safeItemId, storageSku);
  const item = located.snapshot.data() || {};
  if (!INVENTORY_STATUSES.includes(item.status)) throw serviceError('STORE_INVENTORY_STATUS_INVALID', 409);
  const now = Date.now();
  await db.collection('storeInventoryAccessAudit').add({
    sku,
    storageSku: located.storageSku,
    inventoryPoolId: poolId,
    itemId: safeItemId,
    status: item.status,
    orderId: safeText(item.orderId, 160),
    action: 'inventory-secret-reveal',
    reason: safeReason,
    actor: { uid: safeText(actor.uid, 160), email: safeText(actor.email, 160).toLowerCase() },
    at: now
  });
  const opened = decodeInventorySecret(item, {
    recordType: 'inventory', recordId: safeItemId, id: safeItemId, sku: located.storageSku
  });
  return {
    id: safeItemId,
    storageSku: located.storageSku,
    productId: product.id,
    productName: product.name,
    planKey: plan.key,
    planLabel: plan.label,
    status: item.status,
    ...opened,
    secret: opened.copyValue,
    revealedAt: now
  };
}

async function revokeInventory({ productId = '', planKey = '', itemId = '', storageSku = '', reason = '', actor = {} } = {}) {
  const { product, plan, sku, sourceSkus, poolId } = await resolveSku(productId, planKey);
  const safeItemId = safeText(itemId, 160);
  const safeReason = safeText(reason, 200);
  if (!safeItemId) throw serviceError('STORE_INVENTORY_ITEM_REQUIRED', 400);
  if (safeReason.length < 3) throw serviceError('STORE_INVENTORY_REASON_REQUIRED', 400);
  const { db } = firebaseStore();
  const located = await locateInventoryItem(db, sourceSkus, safeItemId, storageSku);
  const itemRef = located.snapshot.ref;
  const summaryRef = db.collection('storeInventorySummary').doc(located.storageSku);
  let result = null;
  await db.runTransaction(async (tx) => {
    const [itemSnapshot, summarySnapshot] = await Promise.all([tx.get(itemRef), tx.get(summaryRef)]);
    if (!itemSnapshot.exists) throw serviceError('STORE_INVENTORY_ITEM_NOT_FOUND', 404);
    const item = itemSnapshot.data() || {};
    if (item.status !== 'available') throw serviceError('STORE_INVENTORY_REVOKE_NOT_ALLOWED', 409);
    const available = Math.max(0, Number(summarySnapshot.data()?.availableCount || 0) || 0);
    const now = Date.now();
    tx.update(itemRef, {
      status: 'revoked',
      revokeReason: safeReason,
      revokedAt: now,
      revokedBy: { uid: safeText(actor.uid, 160), email: safeText(actor.email, 160).toLowerCase() },
      statusHistory: [...(Array.isArray(item.statusHistory) ? item.statusHistory.slice(-18) : []), { status: 'revoked', at: now, reason: safeReason }],
      updatedAt: now
    });
    tx.set(db.collection('storeInventoryFingerprints').doc(safeText(item.fingerprint, 64)), {
      sku: located.storageSku, itemId: safeItemId, status: 'revoked', revokedAt: now
    }, { merge: true });
    tx.set(summaryRef, {
      availableCount: Math.max(0, available - 1),
      revokedCount: Math.max(0, Number(summarySnapshot.data()?.revokedCount || 0) || 0) + 1,
      updatedAt: now
    }, { merge: true });
    const eventRef = db.collection('storeInventoryEvents').doc();
    tx.create(eventRef, {
      id: eventRef.id, type: 'revoked', sku, storageSku: located.storageSku,
      inventoryPoolId: poolId, itemId: safeItemId, productId: product.id, planKey: plan.key,
      quantity: -1, reason: safeReason,
      actor: { uid: safeText(actor.uid, 160), email: safeText(actor.email, 160).toLowerCase(), source: 'admin' }, createdAt: now
    });
    recordMutationAudit(tx, db, 'store.inventory.revoke', actor, {
      productId: product.id,
      planKey: plan.key,
      itemId: safeItemId,
      reason: safeReason
    });
    result = { id: safeItemId, sku, storageSku: located.storageSku, productId: product.id, planKey: plan.key, status: 'revoked', masked: safeText(item.masked, 80) };
  });
  invalidateStockCache();
  return result;
}

async function migrateSharedInventoryPool({ productId = '', planKey = '', actor = {}, limit = 400 } = {}) {
  const { product, plan, sku, poolId, shared, sourceSkus } = await resolveSku(productId, planKey);
  if (!shared) return { migrated: 0, sku, inventoryPoolId: poolId, sharedPool: false, completed: true };
  const actorUid = safeText(actor.uid, 160);
  if (!actorUid) throw serviceError('ADMIN_REQUIRED', 403);
  const { db } = firebaseStore();
  const maxItems = Math.max(1, Math.min(1000, Math.trunc(Number(limit) || 400)));
  const legacySkus = sourceSkus.filter((value) => value !== sku);
  let migrated = 0;
  const perSource = {};

  for (const legacySku of legacySkus) {
    perSource[legacySku] = 0;
    while (migrated < maxItems) {
      const remaining = maxItems - migrated;
      const snapshot = await inventoryItemCollection(db, legacySku).where('status', '==', 'available').limit(Math.min(40, remaining)).get();
      if (snapshot.empty) break;
      const sourceRefs = snapshot.docs.map((doc) => doc.ref);
      const destinationRefs = snapshot.docs.map((doc) => {
        const prefix = crypto.createHash('sha256').update(`${legacySku}:${doc.id}`).digest('hex').slice(0, 12);
        return inventoryItemCollection(db, sku).doc(`m_${prefix}_${doc.id}`.slice(0, 160));
      });
      const fingerprintRefs = snapshot.docs.map((doc) => db.collection('storeInventoryFingerprints').doc(safeText(doc.data()?.fingerprint, 64)));
      const sourceSummaryRef = db.collection('storeInventorySummary').doc(legacySku);
      const targetSummaryRef = db.collection('storeInventorySummary').doc(sku);
      const now = Date.now();

      let movedThisBatch = 0;
      await db.runTransaction(async (tx) => {
        const refs = [sourceSummaryRef, targetSummaryRef, ...sourceRefs, ...destinationRefs, ...fingerprintRefs];
        const results = typeof tx.getAll === 'function' ? await tx.getAll(...refs) : await Promise.all(refs.map((ref) => tx.get(ref)));
        const sourceSummary = results[0];
        const targetSummary = results[1];
        const sourceSnaps = results.slice(2, 2 + sourceRefs.length);
        const destinationSnaps = results.slice(2 + sourceRefs.length, 2 + sourceRefs.length + destinationRefs.length);
        const fingerprintSnaps = results.slice(2 + sourceRefs.length + destinationRefs.length);
        const movable = [];
        sourceSnaps.forEach((sourceSnap, index) => {
          if (!sourceSnap.exists) return;
          const row = sourceSnap.data() || {};
          if (row.status !== 'available') return;
          if (destinationSnaps[index]?.exists) throw serviceError('STORE_INVENTORY_MIGRATION_CONFLICT', 409);
          const fingerprint = fingerprintSnaps[index];
          if (fingerprint?.exists) {
            const registry = fingerprint.data() || {};
            const registeredSku = safeText(registry.sku, 130);
            const registeredItemId = safeText(registry.itemId, 160);
            if ((registeredSku && registeredSku !== legacySku) || (registeredItemId && registeredItemId !== sourceSnap.id)) {
              throw serviceError('STORE_INVENTORY_INTEGRITY_ERROR', 409);
            }
          }
          movable.push({ index, sourceSnap, row });
        });
        if (!movable.length) return;
        movedThisBatch = movable.length;
        const sourceAvailable = Math.max(0, Number(sourceSummary.data()?.availableCount || 0) || 0);
        const targetAvailable = Math.max(0, Number(targetSummary.data()?.availableCount || 0) || 0);
        for (const entry of movable) {
          const destinationRef = destinationRefs[entry.index];
          const fingerprintRef = fingerprintRefs[entry.index];
          const history = Array.isArray(entry.row.statusHistory) ? entry.row.statusHistory.slice(-17) : [];
          const plaintext = keyVault.decryptSecret(entry.row.secret, {
            ...entry.row,
            recordType: 'inventory',
            recordId: entry.sourceSnap.id,
            id: entry.sourceSnap.id,
            sku: legacySku
          });
          const migratedSecret = keyVault.encryptSecret(plaintext, {
            recordType: 'inventory',
            recordId: destinationRef.id,
            sku,
            productId: safeText(entry.row.productId, 80) || product.id,
            planKey: safeText(entry.row.planKey, 40) || plan.key
          });
          tx.create(destinationRef, {
            ...entry.row,
            id: destinationRef.id,
            sku,
            secret: migratedSecret,
            inventoryPoolId: poolId,
            sourceProductId: safeText(entry.row.sourceProductId || entry.row.productId, 80) || product.id,
            migratedFromPath: entry.sourceSnap.ref.path,
            migratedAt: now,
            migratedBy: { uid: actorUid, email: safeText(actor.email, 160).toLowerCase() },
            statusHistory: [...history, { status: 'available', at: now, event: 'shared-pool-migration', fromSku: legacySku }],
            updatedAt: now
          });
          tx.delete(entry.sourceSnap.ref);
          tx.set(fingerprintRef, { sku, itemId: destinationRef.id, status: 'available', migratedAt: now }, { merge: true });
        }
        tx.set(sourceSummaryRef, { availableCount: Math.max(0, sourceAvailable - movable.length), updatedAt: now }, { merge: true });
        tx.set(targetSummaryRef, {
          sku, inventoryPoolId: poolId, sharedPool: true,
          productIds: sourceSkus.slice(1).map((value) => value.split('__')[0]),
          productId: product.id, planKey: plan.key,
          availableCount: targetAvailable + movable.length,
          deliveredCount: Math.max(0, Number(targetSummary.data()?.deliveredCount || 0) || 0),
          revokedCount: Math.max(0, Number(targetSummary.data()?.revokedCount || 0) || 0),
          lastImportAt: Math.max(
            Math.max(0, Number(targetSummary.data()?.lastImportAt || 0) || 0),
            Math.max(0, Number(sourceSummary.data()?.lastImportAt || 0) || 0)
          ),
          lastDeliveryAt: Math.max(0, Number(targetSummary.data()?.lastDeliveryAt || 0) || 0),
          updatedAt: now
        }, { merge: true });
        const eventRef = db.collection('storeInventoryEvents').doc();
        tx.create(eventRef, {
          id: eventRef.id, type: 'shared-pool-migration', sku, storageSku: sku, fromSku: legacySku,
          inventoryPoolId: poolId, productId: product.id, planKey: plan.key, quantity: movable.length,
          actor: { uid: actorUid, email: safeText(actor.email, 160).toLowerCase(), source: 'admin' }, createdAt: now
        });
        recordMutationAudit(tx, db, 'store.inventory.shared-pool-migration', actor, {
          productId: product.id,
          planKey: plan.key,
          fromSku: legacySku,
          migrated: movable.length
        });
      });
      migrated += movedThisBatch;
      perSource[legacySku] += movedThisBatch;
      if (!movedThisBatch || snapshot.size < Math.min(40, remaining)) break;
    }
  }

  invalidateStockCache();
  const pendingChecks = await Promise.all(legacySkus.map((legacySku) => inventoryItemCollection(db, legacySku).where('status', '==', 'available').limit(1).get()));
  const completed = pendingChecks.every((snapshot) => snapshot.empty);
  return { migrated, sku, inventoryPoolId: poolId, sharedPool: true, completed, perSource };
}

async function rotateInventoryEncryption({ productId = '', planKey = '', actor = {}, limit = 100 } = {}) {
  const { product, plan, sku, poolId, shared, sourceSkus } = await resolveSku(productId, planKey);
  const actorUid = safeText(actor.uid, 160);
  if (!actorUid) throw serviceError('ADMIN_REQUIRED', 403);
  if (!keyVault.configured()) throw serviceError('STORE_KEY_VAULT_UNAVAILABLE', 503);
  const { db, admin } = firebaseStore();
  const safeLimit = Math.max(1, Math.min(200, Math.trunc(Number(limit) || 100)));
  const activeId = keyVault.activeKeyId();
  let remaining = safeLimit;
  let scanned = 0;
  let rotated = 0;
  let cycleComplete = true;
  const sources = [];

  for (const storageSku of sourceSkus) {
    if (remaining < 1) { cycleComplete = false; break; }
    const cursorId = crypto.createHash('sha256').update(`inventory-key-rotation:${activeId}:${storageSku}`).digest('hex');
    const cursorRef = db.collection('storeInventoryMaintenance').doc(cursorId);
    const cursorSnapshot = await cursorRef.get();
    const lastItemId = safeText(cursorSnapshot.data()?.lastItemId, 160);
    let query = inventoryItemCollection(db, storageSku).orderBy(admin.firestore.FieldPath.documentId()).limit(Math.min(remaining, 100));
    if (lastItemId) query = query.startAfter(lastItemId);
    let snapshot = await query.get();
    if (snapshot.empty && lastItemId) {
      await cursorRef.set({ lastItemId: '', cycleCompletedAt: Date.now(), activeKeyId: activeId, storageSku }, { merge: true });
      snapshot = await inventoryItemCollection(db, storageSku).orderBy(admin.firestore.FieldPath.documentId()).limit(Math.min(remaining, 100)).get();
    }
    if (snapshot.empty) {
      sources.push({ storageSku, scanned: 0, rotated: 0, cycleComplete: true });
      continue;
    }
    const prepared = [];
    for (const doc of snapshot.docs) {
      const row = doc.data() || {};
      if (!row.secret || !keyVault.needsRotation(row.secret)) continue;
      const context = {
        ...row,
        recordType: 'inventory',
        recordId: doc.id,
        id: row.id || doc.id,
        sku: row.sku || storageSku
      };
      const plaintext = keyVault.decryptSecret(row.secret, context);
      prepared.push({ ref: doc.ref, encrypted: keyVault.encryptSecret(plaintext, context) });
    }
    const now = Date.now();
    const batch = db.batch();
    prepared.forEach((entry) => batch.update(entry.ref, {
      secret: entry.encrypted,
      encryptionKeyId: activeId,
      encryptionRotatedAt: now,
      encryptionRotatedBy: { uid: actorUid, email: safeText(actor.email, 160).toLowerCase() },
      updatedAt: now
    }));
    const lastId = snapshot.docs[snapshot.docs.length - 1]?.id || '';
    const sourceComplete = snapshot.size < Math.min(remaining, 100);
    batch.set(cursorRef, {
      activeKeyId: activeId,
      storageSku,
      lastItemId: sourceComplete ? '' : lastId,
      lastRunAt: now,
      ...(sourceComplete ? { cycleCompletedAt: now } : {})
    }, { merge: true });
    if (prepared.length) {
      const eventRef = db.collection('storeInventoryEvents').doc();
      batch.create(eventRef, {
        id: eventRef.id, type: 'encryption-rotation', sku, storageSku, inventoryPoolId: poolId,
        productId: product.id, planKey: plan.key, quantity: prepared.length, activeKeyId: activeId,
        actor: { uid: actorUid, email: safeText(actor.email, 160).toLowerCase(), source: 'admin' }, createdAt: now
      });
    }
    recordMutationAudit(batch, db, 'store.inventory.encryption-rotation', actor, {
      productId: product.id,
      planKey: plan.key,
      storageSku,
      activeKeyId: activeId,
      scanned: snapshot.size,
      rotated: prepared.length
    });
    await batch.commit();
    scanned += snapshot.size;
    rotated += prepared.length;
    remaining -= snapshot.size;
    cycleComplete = cycleComplete && sourceComplete;
    sources.push({ storageSku, scanned: snapshot.size, rotated: prepared.length, cycleComplete: sourceComplete });
  }

  return {
    sku, inventoryPoolId: poolId, sharedPool: shared, activeKeyId: activeId,
    scanned, rotated, cycleComplete, sources,
    warning: 'Eski decrypt-only anahtarı tüm tarihsel kayıtların rotasyonu tamamlanmadan kaldırmayın.'
  };
}

async function subscribeRestock({ uid = '', productId = '', planKey = '' } = {}) {
  const safeUid = safeText(uid, 160);
  if (!safeUid) throw serviceError('AUTH_REQUIRED', 401);
  const { catalog, product, plan, sku, poolId, shared, sourceSkus } = await resolveSku(productId, planKey, { includeInactive: false });
  assertAutomaticInventoryProduct(product);
  const summaries = await summaryMapForCatalog(catalog, { fresh: true });
  const available = Math.max(0, Number(summaries.get(sku)?.available || 0) || 0);
  if (available > 0) return { subscribed: false, alreadyAvailable: true, available };
  const { db } = firebaseStore();
  const id = crypto.createHash('sha256').update(`${safeUid}:${sku}`).digest('hex');
  const now = Date.now();
  await db.collection('storeRestockSubscriptions').doc(id).set({
    id,
    uid: safeUid,
    sku,
    inventoryPoolId: poolId,
    sharedPool: shared,
    sourceSkus,
    productId: product.id,
    productName: sharedPoolDisplayName({ poolId, shared }, product),
    planKey: plan.key,
    planLabel: plan.label,
    active: true,
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(now + RESTOCK_SUBSCRIPTION_TTL_MS)
  }, { merge: true });
  return { subscribed: true, alreadyAvailable: false, available: 0 };
}

async function listNotifications(uid = '', limit = 20) {
  const safeUid = safeText(uid, 160);
  if (!safeUid) throw serviceError('AUTH_REQUIRED', 401);
  const { db } = firebaseStore();
  const safeLimit = Math.max(1, Math.min(50, Math.trunc(Number(limit) || 20)));
  const snapshot = await db.collection('storeUserNotifications').doc(safeUid).collection('items')
    .orderBy('createdAt', 'desc').limit(safeLimit).get();
  return snapshot.docs.map((doc) => {
    const row = doc.data() || {};
    return {
      id: doc.id,
      type: safeText(row.type, 30),
      title: safeText(row.title, 80),
      message: safeText(row.message, 240),
      productId: safeText(row.productId, 80),
      planKey: safeText(row.planKey, 40),
      read: row.read === true,
      createdAt: Math.max(0, Number(row.createdAt || 0) || 0)
    };
  }).filter((notification) => notification.read !== true)
    .sort((left, right) => right.createdAt - left.createdAt);
}

async function markNotificationRead(uid = '', notificationId = '') {
  const safeUid = safeText(uid, 160);
  const safeId = safeText(notificationId, 160);
  if (!safeUid) throw serviceError('AUTH_REQUIRED', 401);
  if (!safeId) throw serviceError('STORE_NOTIFICATION_ID_REQUIRED', 400);
  const { db } = firebaseStore();
  await db.collection('storeUserNotifications').doc(safeUid).collection('items').doc(safeId).delete();
  return true;
}

module.exports = {
  INVENTORY_STATUSES,
  INVENTORY_TYPES,
  MAX_IMPORT_KEYS,
  inventoryReadiness,
  skuKey,
  inventoryPoolId,
  inventorySkuKey,
  allocationRequirements,
  stockState,
  normalizeImportKeys,
  decodeInventorySecret,
  decorateCatalogWithStock,
  summaryMapForCatalog,
  assertStockForCartInTransaction,
  allocateInventoryInTransaction,
  attachManualDeliveryInTransaction,
  inspectInventoryImport,
  importInventory,
  inventorySummary,
  listInventory,
  revealInventorySecret,
  revokeInventory,
  migrateSharedInventoryPool,
  rotateInventoryEncryption,
  readDeliverySecrets,
  subscribeRestock,
  listNotifications,
  markNotificationRead,
  invalidateStockCache,
  serviceError
};
