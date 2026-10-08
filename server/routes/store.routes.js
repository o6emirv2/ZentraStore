'use strict';

const express = require('express');
const env = require('../config/env');
const { requireAuth, requireRecentUserAuth, requireAdmin, requireStorePermission, strictLimiter, deliveryLimiter, RATE_LIMIT_POLICY } = require('../core/security');
const { adminAccessCookiePolicy } = require('../core/adminAccessService');
const adminAuthRouter = require('./admin-auth.routes');
const { requireAdminReauth, writeSupplementalAdminAudit } = require('../core/adminReauthService');
const { redactUserFinance } = require('../core/adminOverviewPolicy');
const {
  publicCatalog,
  readAccount,
  updateProfileAvatar,
  createOrder,
  previewStorePromotion,
  listOrders,
  listOrdersForAdmin,
  cancelOrderByUser,
  adjustStoreBalance,
  updateOrderByAdmin
} = require('../core/storeService');
const {
  decorateCatalogWithStock,
  inventoryReadiness,
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
  markNotificationRead
} = require('../core/storeInventoryService');
const {
  getEffectiveCatalog,
  updateProductSettings,
  updateProductsBulk,
  updateStorefrontSettings,
  updateStorefrontQuickLinks
} = require('../core/storeCatalogService');
const {
  resolveStoreUser,
  listStoreUsers,
  updateStoreUser,
  listWalletLedger,
  getUserDirectorySummary,
  getWalletSummary,
  getAdminOverview,
  listAuditLogs,
  listStaff,
  upsertStaff,
  invalidateAdminStoreCaches
} = require('../core/adminStoreService');
const { listWalletPromotions, listPromotions, savePromotion } = require('../core/storePromotionService');
const {
  updateProfileUsername, updateProfileFullName,
  updateProfileBirthDate, updateProfileEmail
} = require('../core/storeProfileService');
const router = express.Router();
const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const adminChain = [requireAuth, requireAdmin, adminAuthRouter.requireAdminGate];
const sensitiveAdminChain = (permission) => [...adminChain, requireStorePermission(permission), strictLimiter, requireAdminReauth];

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
}

function requireOwner(req, res, next) {
  const uid = String(req.user?.uid || '').trim();
  const email = String(req.user?.email || '').trim().toLowerCase();
  if (uid && email && env.adminUids.length === 1 && env.adminEmails.length === 1
    && env.adminUids[0] === uid && env.adminEmails[0] === email) return next();
  return res.status(403).json({ ok: false, error: 'ADMIN_OWNER_REQUIRED' });
}

function operationalSecurityPosture(configuration = {}, gateSecurity = {}, inventory = {}) {
  const gateChecks = new Map((Array.isArray(gateSecurity.checks) ? gateSecurity.checks : []).map((check) => [check.key, check.ok === true]));
  const cookie = adminAccessCookiePolicy();
  const strictRateLimitReady = Number(RATE_LIMIT_POLICY?.strict?.windowMs || 0) > 0 && Number(RATE_LIMIT_POLICY?.strict?.max || 0) > 0;
  const checks = [
    ['firebase-admin', 'Güvenli yönetim bağlantısı', gateChecks.get('firebase-admin') === true],
    ['firebase-auth', 'Hesap doğrulama', initFirebaseReady()],
    ['firestore', 'Korumalı veri alanı', initFirebaseReady()],
    ['admin-email', 'Yetkili e-posta', env.adminEmails.length === 1],
    ['admin-uid', 'Yetkili hesap kimliği', env.adminUids.length === 1],
    ['firebase-password', '3. adım hesap şifresi', gateChecks.get('firebase-password') === true],
    ['fourth-factor', '4. güvenlik faktörü', gateChecks.get('fourth-factor') === true],
    ['fifth-factor', '5. güvenlik faktörü', gateChecks.get('fifth-factor') === true],
    ['signed-access', 'İmzalı yönetim oturumu', gateChecks.get('signed-access') === true],
    ['cookie-http-only', 'Korumalı oturum alanı', cookie.httpOnly === true],
    ['cookie-secure', 'Güvenli bağlantı zorunluluğu', cookie.secure === true],
    ['cookie-samesite', 'Siteler arası istek koruması', String(cookie.sameSite).toLowerCase() === 'strict'],
    ['strict-csp', 'İçerik koruma politikası', env.security.strictCsp === true],
    ['cors', 'İzinli bağlantı politikası', Array.isArray(env.allowedOrigins) && env.allowedOrigins.includes(env.canonicalOrigin) && env.allowedOrigins.includes(env.serviceOrigin)],
    ['rate-limit', 'Dağıtık istek deneme sınırı', strictRateLimitReady && configuration.rateLimitStore === 'firestore'],
    ['app-check', 'Zorunlu uygulama doğrulaması', configuration.appCheckConfigured === true && configuration.appCheckMode === 'enforce'],
    ['totp-factor', 'Tek kullanımlık doğrulama kodu', configuration.adminTotpRequired === true && configuration.adminTotpConfigured === true],
    ['key-vault', 'Şifreli stok kasası', configuration.keyVaultReady === true],
    ['encryption-key-id', 'Aktif kasa anahtarı', !!String(configuration.keyVaultActiveKeyId || '').trim()],
    ['inventory', 'Otomatik teslimat', inventory.ready === true],
    ['render', 'Canlı mağaza ayarları', configuration.ready === true]
  ].map(([key, label, ok]) => ({ key, label, ok, weight: 1, earned: ok ? 1 : 0 }));
  const readyCount = checks.filter((check) => check.ok).length;
  const score = Math.round((readyCount / checks.length) * 100);
  return {
    score, minimum: 100, ready: readyCount === checks.length,
    level: score === 100 ? 'hazır' : score >= 85 ? 'uyarı' : 'kritik',
    checks
  };
}

function initFirebaseReady() {
  try {
    const firebase = require('../config/firebaseAdmin').initFirebaseAdmin();
    return !!(firebase?.enabled && firebase?.db && firebase?.auth);
  } catch (_) { return false; }
}

router.get('/store/catalog', asyncRoute(async (_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=45, stale-while-revalidate=180');
  res.json({ ok: true, catalog: await publicCatalog() });
}));

router.get('/store/account', requireAuth, asyncRoute(async (req, res) => {
  const account = await readAccount(req.user.uid, req.user);
  noStore(res);
  res.json({ ok: true, account });
}));

router.patch('/store/profile/avatar', requireAuth, strictLimiter, asyncRoute(async (req, res) => {
  const account = await updateProfileAvatar(req.user.uid, req.user, req.body || {});
  noStore(res);
  res.json({ ok: true, account });
}));

const protectedProfileUpdate = (handler) => [requireAuth, strictLimiter, requireRecentUserAuth, asyncRoute(async (req, res) => {
  const account = await handler(req.user.uid, req.user, req.body || {});
  noStore(res);
  res.json({ ok: true, account });
})];

router.patch('/store/profile/username', ...protectedProfileUpdate(updateProfileUsername));
router.patch('/store/profile/name', ...protectedProfileUpdate(updateProfileFullName));
router.patch('/store/profile/birth-date', ...protectedProfileUpdate(updateProfileBirthDate));
router.patch('/store/profile/email', ...protectedProfileUpdate(updateProfileEmail));

router.get('/store/orders', requireAuth, asyncRoute(async (req, res) => {
  const result = await listOrders(req.user.uid, req.query.limit || 30, req.query.cursor);
  noStore(res);
  res.json({ ok: true, ...result, empty: result.orders.length === 0 });
}));

router.post('/store/orders', requireAuth, strictLimiter, asyncRoute(async (req, res) => {
  const result = await createOrder({
    uid: req.user.uid,
    authUser: req.user,
    rawItems: req.body?.items,
    paymentMethod: req.body?.paymentMethod,
    idempotencyKey: req.body?.idempotencyKey || req.headers['x-idempotency-key'],
    promotionCode: req.body?.promotionCode
  });
  noStore(res);
  res.status(201).json({ ok: true, ...result });
}));

router.post('/store/orders/:orderId/cancel', requireAuth, strictLimiter, asyncRoute(async (req, res) => {
  const result = await cancelOrderByUser({ uid: req.user.uid, orderId: req.params.orderId, reason: req.body?.reason });
  noStore(res);
  res.json({ ok: true, ...result });
}));

router.get('/store/orders/:orderId/delivery', requireAuth, deliveryLimiter, asyncRoute(async (req, res) => {
  const delivery = await readDeliverySecrets({ uid: req.user.uid, orderId: req.params.orderId });
  noStore(res);
  res.json({ ok: true, delivery });
}));

router.post('/store/promotions/validate', requireAuth, strictLimiter, asyncRoute(async (req, res) => {
  const promotion = await previewStorePromotion({ uid: req.user.uid, rawItems: req.body?.items, code: req.body?.code });
  noStore(res);
  res.json({ ok: true, promotion });
}));

router.get('/store/promotions', requireAuth, asyncRoute(async (req, res) => {
  noStore(res);
  res.json({ ok: true, promotions: await listWalletPromotions(req.user.uid) });
}));

router.post('/store/restock-subscriptions', requireAuth, strictLimiter, asyncRoute(async (req, res) => {
  const subscription = await subscribeRestock({
    uid: req.user.uid,
    productId: req.body?.productId,
    planKey: req.body?.planKey
  });
  noStore(res);
  res.status(subscription.subscribed ? 201 : 200).json({ ok: true, subscription });
}));

router.get('/store/notifications', requireAuth, asyncRoute(async (req, res) => {
  const notifications = await listNotifications(req.user.uid, req.query.limit);
  noStore(res);
  res.json({ ok: true, notifications });
}));

router.patch('/store/notifications/:notificationId/read', requireAuth, strictLimiter, asyncRoute(async (req, res) => {
  await markNotificationRead(req.user.uid, req.params.notificationId);
  noStore(res);
  res.json({ ok: true });
}));

router.get('/admin/store/overview', ...adminChain, requireStorePermission('store.overview.read'), asyncRoute(async (req, res) => {
  noStore(res);
  res.json({ ok: true, overview: await getAdminOverview(req.adminPolicy) });
}));

router.get('/admin/store/orders', ...adminChain, requireStorePermission('store.orders.read'), asyncRoute(async (req, res) => {
  const result = await listOrdersForAdmin({ limit: req.query.limit, status: req.query.status, uid: req.query.uid, cursor: req.query.cursor });
  noStore(res);
  res.json({ ok: true, ...result, empty: result.orders.length === 0 });
}));

router.patch('/admin/store/orders/:orderId', ...sensitiveAdminChain('store.orders.write'), asyncRoute(async (req, res) => {
  const order = await updateOrderByAdmin({ orderId: req.params.orderId, input: req.body || {}, actor: req.user });
  invalidateAdminStoreCaches();
  await writeSupplementalAdminAudit(req, 'store.order.update', { orderId: req.params.orderId, orderNumber: order.orderNumber, before: { status: order.previousStatus || '' }, after: { status: order.status } });
  noStore(res);
  res.json({ ok: true, order });
}));

router.get('/admin/store/catalog', ...adminChain, requireStorePermission('store.catalog.read'), asyncRoute(async (req, res) => {
  const catalog = await getEffectiveCatalog({ includeInactive: true, fresh: true });
  noStore(res);
  res.json({ ok: true, catalog: req.query.stock === '0' ? catalog : await decorateCatalogWithStock(catalog, { fresh: true }) });
}));

router.patch('/admin/store/products/:productId', ...sensitiveAdminChain('store.catalog.write'), asyncRoute(async (req, res) => {
  const beforeCatalog = await getEffectiveCatalog({ includeInactive: true, fresh: true });
  const before = beforeCatalog.products.find((item) => item.id === String(req.params.productId || '').toLowerCase()) || null;
  const product = await updateProductSettings(req.params.productId, req.body || {}, req.user);
  await writeSupplementalAdminAudit(req, 'store.product.update', {
    productId: req.params.productId,
    before: before ? { active: before.active, archived: before.archived, name: before.name, platform: before.platform, automaticEnabled: before.automaticEnabled, telegramEnabled: before.telegramEnabled } : null,
    after: product ? { active: product.active, archived: product.archived, name: product.name, platform: product.platform, automaticEnabled: product.automaticEnabled, telegramEnabled: product.telegramEnabled } : null
  });
  noStore(res);
  res.json({ ok: true, product });
}));

router.post('/admin/store/products/bulk', ...sensitiveAdminChain('store.catalog.write'), asyncRoute(async (req, res) => {
  const updates = Array.isArray(req.body?.updates) ? req.body.updates : [];
  const beforeCatalog = await getEffectiveCatalog({ includeInactive: true, fresh: true });
  const beforeMap = new Map(beforeCatalog.products.map((item) => [item.id, item]));
  const result = await updateProductsBulk(updates, req.user, { requestId: req.requestId });
  const afterMap = new Map((result.products || []).map((item) => [item.id, item]));
  await writeSupplementalAdminAudit(req, 'store.product.bulk-update', {
      count: result.updated,
      productIds: result.productIds,
      changes: result.productIds.slice(0, 100).map((productId) => {
        const before = beforeMap.get(productId) || {};
        const after = afterMap.get(productId) || {};
        return {
          productId,
          before: { active: before.active, archived: before.archived, name: before.name, platform: before.platform, automaticEnabled: before.automaticEnabled, telegramEnabled: before.telegramEnabled },
          after: { active: after.active, archived: after.archived, name: after.name, platform: after.platform, automaticEnabled: after.automaticEnabled, telegramEnabled: after.telegramEnabled }
        };
      })
  });
  noStore(res);
  res.json({ ok: true, result });
}));

router.get('/admin/store/content', ...adminChain, requireStorePermission('store.content.read'), asyncRoute(async (_req, res) => {
  const catalog = await getEffectiveCatalog({ includeInactive: true, fresh: true });
  noStore(res);
  res.json({ ok: true, storefront: catalog.storefront });
}));

router.patch('/admin/store/content', ...sensitiveAdminChain('store.content.write'), asyncRoute(async (req, res) => {
  const before = (await getEffectiveCatalog({ includeInactive: true, fresh: true })).storefront;
  const storefront = await updateStorefrontSettings(req.body || {}, req.user);
  await writeSupplementalAdminAudit(req, 'store.content.update', {
    before: { maintenance: before.maintenance, announcement: before.announcement, services: before.services, support: before.support, home: before.home, categoryVisibility: before.categoryVisibility },
    after: { maintenance: storefront.maintenance, announcement: storefront.announcement, services: storefront.services, support: storefront.support, home: storefront.home, categoryVisibility: storefront.categoryVisibility }
  });
  noStore(res);
  res.json({ ok: true, storefront });
}));

router.get('/admin/store/links', ...adminChain, requireStorePermission('store.content.read'), asyncRoute(async (_req, res) => {
  const catalog = await getEffectiveCatalog({ includeInactive: true, fresh: true });
  noStore(res);
  res.json({ ok: true, links: catalog.storefront.quickLinks || [] });
}));

router.put('/admin/store/links', ...sensitiveAdminChain('store.content.write'), asyncRoute(async (req, res) => {
  const before = (await getEffectiveCatalog({ includeInactive: true, fresh: true })).storefront.quickLinks || [];
  const links = await updateStorefrontQuickLinks(req.body?.links, req.user);
  await writeSupplementalAdminAudit(req, 'store.links.update', {
    before: before.map(({ id, title, description, url, enabled }) => ({ id, title, description, url, enabled })),
    after: links.map(({ id, title, description, url, enabled }) => ({ id, title, description, url, enabled }))
  });
  noStore(res);
  res.json({ ok: true, links });
}));

router.get('/admin/store/promotions', ...adminChain, requireStorePermission('store.content.read'), asyncRoute(async (_req, res) => {
  noStore(res);
  res.json({ ok: true, promotions: await listPromotions() });
}));

router.put('/admin/store/promotions/:code', ...sensitiveAdminChain('store.content.write'), asyncRoute(async (req, res) => {
  const promotion = await savePromotion(req.params.code, req.body || {}, req.user);
  await writeSupplementalAdminAudit(req, 'store.promotion.update', {
    code: promotion.code, type: promotion.type, active: promotion.active,
    value: promotion.value, usageLimit: promotion.usageLimit, perUserLimit: promotion.perUserLimit
  });
  noStore(res);
  res.json({ ok: true, promotion });
}));

router.get('/admin/store/inventory', ...adminChain, requireStorePermission('store.inventory.read'), asyncRoute(async (req, res) => {
  const inventory = await listInventory({
    productId: req.query.productId,
    planKey: req.query.planKey,
    status: req.query.status,
    limit: req.query.limit
  });
  noStore(res);
  res.json({ ok: true, inventory });
}));

router.get('/admin/store/inventory-summary', ...adminChain, requireStorePermission('store.inventory.read'), asyncRoute(async (_req, res) => {
  noStore(res);
  res.json({ ok: true, inventory: await inventorySummary({ fresh: true }) });
}));

router.get('/admin/store/inventory-readiness', ...adminChain, requireStorePermission('store.inventory.read'), asyncRoute(async (_req, res) => {
  noStore(res);
  res.json({ ok: true, readiness: inventoryReadiness() });
}));

router.post('/admin/store/inventory/import-check', ...sensitiveAdminChain('store.inventory.write'), asyncRoute(async (req, res) => {
  const result = await inspectInventoryImport({
    productId: req.body?.productId,
    planKey: req.body?.planKey,
    keys: req.body?.keys
  });
  noStore(res);
  res.json({ ok: true, result });
}));

router.post('/admin/store/inventory/import', ...sensitiveAdminChain('store.inventory.write'), asyncRoute(async (req, res) => {
  const result = await importInventory({
    productId: req.body?.productId,
    planKey: req.body?.planKey,
    keys: req.body?.keys,
    actor: req.user,
    idempotencyKey: req.body?.idempotencyKey || req.headers['x-idempotency-key']
  });
  if (!result.idempotentReplay) {
    await writeSupplementalAdminAudit(req, 'store.inventory.import', {
      productId: result.productId,
      planKey: result.planKey,
      inventoryType: result.inventoryType,
      imported: result.imported,
      duplicateReentries: result.duplicateReentries || 0,
      replacedActiveDuplicates: result.replacedActiveDuplicates || 0
    });
  }
  noStore(res);
  res.status(result.idempotentReplay ? 200 : 201).json({ ok: true, result });
}));

router.post('/admin/store/inventory/migrate-shared-pool', ...sensitiveAdminChain('store.inventory.write'), asyncRoute(async (req, res) => {
  const result = await migrateSharedInventoryPool({
    productId: req.body?.productId,
    planKey: req.body?.planKey,
    actor: req.user,
    limit: req.body?.limit
  });
  await writeSupplementalAdminAudit(req, 'store.inventory.shared-pool-migration', {
    productId: req.body?.productId, planKey: req.body?.planKey, migrated: result.migrated, completed: result.completed
  });
  noStore(res);
  res.json({ ok: true, result });
}));

router.post('/admin/store/inventory/rotate-encryption', ...sensitiveAdminChain('store.inventory.write'), asyncRoute(async (req, res) => {
  const result = await rotateInventoryEncryption({
    productId: req.body?.productId,
    planKey: req.body?.planKey,
    actor: req.user,
    limit: req.body?.limit
  });
  await writeSupplementalAdminAudit(req, 'store.inventory.encryption-rotation', {
    productId: req.body?.productId, planKey: req.body?.planKey, activeKeyId: result.activeKeyId, scanned: result.scanned, rotated: result.rotated, cycleComplete: result.cycleComplete
  });
  noStore(res);
  res.json({ ok: true, result });
}));

router.post('/admin/store/inventory/:itemId/revoke', ...sensitiveAdminChain('store.inventory.write'), asyncRoute(async (req, res) => {
  const item = await revokeInventory({
    productId: req.body?.productId,
    planKey: req.body?.planKey,
    itemId: req.params.itemId,
    storageSku: req.body?.storageSku,
    reason: req.body?.reason,
    actor: req.user
  });
  await writeSupplementalAdminAudit(req, 'store.inventory.revoke', { productId: item.productId, planKey: item.planKey, itemId: item.id, reason: req.body?.reason });
  noStore(res);
  res.json({ ok: true, item });
}));

router.post('/admin/store/inventory/:itemId/reveal', ...sensitiveAdminChain('store.inventory.reveal'), asyncRoute(async (req, res) => {
  const item = await revealInventorySecret({
    productId: req.body?.productId,
    planKey: req.body?.planKey,
    itemId: req.params.itemId,
    storageSku: req.body?.storageSku,
    reason: req.body?.reason,
    actor: req.user
  });
  await writeSupplementalAdminAudit(req, 'store.inventory.reveal', { productId: item.productId, planKey: item.planKey, itemId: item.id, reason: req.body?.reason });
  noStore(res);
  res.json({ ok: true, item });
}));

router.get('/admin/store/users', ...adminChain, requireStorePermission('store.users.read'), asyncRoute(async (req, res) => {
  const result = await listStoreUsers({ query: req.query.query, limit: req.query.limit, pageToken: req.query.pageToken });
  noStore(res);
  res.json({ ok: true, ...result, users: result.users.map((user) => redactUserFinance(user, req.adminPolicy)) });
}));

router.get('/admin/store/users/resolve', ...adminChain, requireStorePermission('store.users.read'), asyncRoute(async (req, res) => {
  noStore(res);
  res.json({ ok: true, user: redactUserFinance(await resolveStoreUser(req.query.identifier), req.adminPolicy) });
}));

router.get('/admin/store/users-summary', ...adminChain, requireStorePermission('store.users.read'), asyncRoute(async (req, res) => {
  noStore(res);
  res.json({ ok: true, summary: redactUserFinance(await getUserDirectorySummary({ fresh: req.query.fresh === '1' }), req.adminPolicy) });
}));

router.patch('/admin/store/users/:uid', ...sensitiveAdminChain('store.users.write'), asyncRoute(async (req, res) => {
  const before = await resolveStoreUser(req.params.uid);
  const user = await updateStoreUser({ uid: req.params.uid, status: req.body?.status, adminNote: req.body?.adminNote, actor: req.user });
  await writeSupplementalAdminAudit(req, 'store.user.update', {
    targetUid: req.params.uid,
    before: { accountStatus: before.accountStatus, adminNote: before.adminNote },
    after: { accountStatus: user.accountStatus, adminNote: user.adminNote }
  });
  noStore(res);
  res.json({ ok: true, user });
}));

router.get('/admin/store/users/:uid/wallet-ledger', ...adminChain, requireStorePermission('store.wallet.read'), asyncRoute(async (req, res) => {
  noStore(res);
  res.json({ ok: true, ...await listWalletLedger(req.params.uid, req.query.limit, req.query.cursor) });
}));

router.get('/admin/store/wallet-summary', ...adminChain, requireStorePermission('store.wallet.read'), asyncRoute(async (req, res) => {
  noStore(res);
  res.json({ ok: true, summary: await getWalletSummary({ fresh: req.query.fresh === '1' }) });
}));

router.post('/admin/store/wallet/adjust', ...sensitiveAdminChain('store.wallet.write'), asyncRoute(async (req, res) => {
  const result = await adjustStoreBalance({
    targetUid: req.body?.uid,
    amountKurus: req.body?.amountKurus,
    type: req.body?.type,
    reason: req.body?.reason,
    actor: req.user,
    idempotencyKey: req.body?.idempotencyKey || req.headers['x-idempotency-key'],
    requestId: req.requestId
  });
  invalidateAdminStoreCaches();
  const audit = await writeSupplementalAdminAudit(req, 'store.wallet.adjust', { targetUid: req.body?.uid, type: result.type, amountKurus: result.amountKurus, balanceBeforeKurus: result.balanceBeforeKurus, balanceAfterKurus: result.balanceAfterKurus, transactionId: result.transactionId, reason: req.body?.reason });
  noStore(res);
  res.json({ ok: true, adjustment: result, audit: { transactionAudit: true, adminAuditRecorded: audit.ok === true } });
}));

router.get('/admin/store/audit', ...adminChain, requireStorePermission('store.audit.read'), asyncRoute(async (req, res) => {
  noStore(res);
  res.json({ ok: true, audit: await listAuditLogs(req.query.limit, req.query.uid) });
}));

router.get('/admin/store/staff', ...adminChain, requireStorePermission('store.staff.read'), requireOwner, asyncRoute(async (_req, res) => {
  noStore(res);
  res.json({ ok: true, staff: await listStaff() });
}));

router.put('/admin/store/staff/:uid', ...sensitiveAdminChain('store.staff.write'), requireOwner, asyncRoute(async (req, res) => {
  const staff = await upsertStaff({ uid: req.params.uid, email: req.body?.email, role: req.body?.role, active: req.body?.active, actor: req.user });
  await writeSupplementalAdminAudit(req, 'store.staff.update', { targetUid: staff.uid, role: staff.role, active: staff.active });
  noStore(res);
  res.json({ ok: true, staff });
}));

router.get('/admin/store/security', ...adminChain, requireStorePermission('store.security.read'), asyncRoute(async (req, res) => {
  const configuration = env.configurationReport();
  const gateSecurity = adminAuthRouter.securityPosture();
  const inventory = inventoryReadiness();
  const security = operationalSecurityPosture(configuration, gateSecurity, inventory);
  noStore(res);
  res.json({
    ok: true,
    security,
    gateSecurity,
    runtime: {
      appCheckMode: configuration.appCheckMode,
      appCheckConfigured: configuration.appCheckConfigured === true,
      keyVaultReady: configuration.keyVaultReady === true,
      configurationReady: configuration.ready === true,
      inventory,
      adminAccessMode: String(req.adminAccess?.mode || 'unknown'),
      adminAccessExpiresAt: Math.max(0, Number(req.adminAccess?.expiresAt || 0) || 0),
      generatedAt: Date.now()
    }
  });
}));

module.exports = router;
