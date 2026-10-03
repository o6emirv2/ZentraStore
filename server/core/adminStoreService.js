'use strict';

const crypto = require('crypto');
const env = require('../config/env');
const { initFirebaseAdmin } = require('../config/firebaseAdmin');
const { inventorySummary, inventoryReadiness } = require('./storeInventoryService');
const { getEffectiveCatalog } = require('./storeCatalogService');
const { createdAtPage } = require('./firestorePagination');
const { revokeAdminSessionsForUser } = require('./adminSessionRegistry');
const { recordMutationAudit } = require('./storeMutationAudit');
const { overviewCan, projectAdminOverview } = require('./adminOverviewPolicy');

const ACCOUNT_STATUSES = Object.freeze(['active', 'purchase_blocked', 'suspended']);
const STAFF_ROLES = Object.freeze(['owner', 'finance', 'inventory', 'orders', 'support', 'viewer']);
const ROLE_PERMISSIONS = Object.freeze({
  owner: Object.freeze(['*']),
  finance: Object.freeze([
    'store.overview.read', 'store.orders.read', 'store.users.read', 'store.wallet.read', 'store.wallet.write',
    'store.audit.read', 'store.security.read'
  ]),
  inventory: Object.freeze([
    'store.overview.read', 'store.catalog.read', 'store.catalog.write', 'store.inventory.read', 'store.inventory.write',
    'store.audit.read', 'store.security.read'
  ]),
  orders: Object.freeze([
    'store.overview.read', 'store.catalog.read', 'store.orders.read', 'store.orders.write', 'store.inventory.read', 'store.users.read',
    'store.audit.read', 'store.security.read'
  ]),
  support: Object.freeze([
    'store.overview.read', 'store.orders.read', 'store.users.read', 'store.wallet.read', 'store.content.read',
    'store.audit.read', 'store.security.read'
  ]),
  viewer: Object.freeze([
    'store.overview.read', 'store.catalog.read', 'store.content.read'
  ])
});

const USER_SUMMARY_TTL_MS = 45_000;
const WALLET_SUMMARY_TTL_MS = 45_000;
const PROFILE_SUMMARY_TTL_MS = 45_000;
const OVERVIEW_ORDER_LIMIT = 500;
const WALLET_SUMMARY_LEDGER_LIMIT = 500;
let userSummaryCache = null;
let walletSummaryCache = null;
let profileSummaryCache = null;
let profileSummaryLoad = null;

function serviceError(code, statusCode = 400, details = {}) {
  return Object.assign(new Error(code), { code, statusCode, ...details });
}

function safeText(value = '', max = 200) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max);
}

function maskEmail(value = '') {
  const email = safeText(value, 254).toLowerCase();
  const separator = email.lastIndexOf('@');
  if (separator < 1) return '';
  const local = email.slice(0, separator);
  const domain = email.slice(separator + 1);
  return `${local.slice(0, Math.min(2, local.length))}${'•'.repeat(Math.max(3, Math.min(7, local.length - 1)))}@${domain}`;
}

function firebaseStore() {
  const firebase = initFirebaseAdmin();
  if (!firebase.db || !firebase.auth) throw serviceError('STORE_STORAGE_UNAVAILABLE', 503);
  return firebase;
}

function balance(profile = {}) {
  return Math.max(0, Math.trunc(Number(profile.storeBalanceKurus ?? profile.storeWallet?.balanceKurus ?? 0) || 0));
}

function parseDate(value = '') {
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function maxTimestamp(...values) {
  return Math.max(0, ...values.map((value) => Math.max(0, Number(value || 0) || 0)));
}

function turkeyDateKey(timestamp = Date.now()) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date(timestamp));
    const map = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
    return `${map.year}-${map.month}-${map.day}`;
  } catch (_) {
    return new Date(timestamp).toISOString().slice(0, 10);
  }
}

function publicAdminUser(authUser = {}, profile = {}, commerce = {}) {
  const username = safeText(profile.username || authUser.displayName || '', 40);
  const status = ACCOUNT_STATUSES.includes(profile.storeAccountStatus) ? profile.storeAccountStatus : 'active';
  const authCreatedAt = parseDate(authUser.metadata?.creationTime);
  const authLastSignInAt = parseDate(authUser.metadata?.lastSignInTime);
  return {
    uid: safeText(authUser.uid || profile.uid, 160),
    email: maskEmail(authUser.email || profile.email),
    username,
    firstName: safeText(profile.firstName, 50),
    lastName: safeText(profile.lastName, 50),
    disabled: authUser.disabled === true,
    accountStatus: status,
    balanceKurus: balance(profile),
    createdAt: maxTimestamp(profile.createdAt, profile.storeCreatedAt, authCreatedAt),
    lastActiveAt: maxTimestamp(profile.storeUpdatedAt, profile.updatedAt, authLastSignInAt, commerce.lastOrderAt),
    lastSignInAt: authLastSignInAt,
    orderCount: Math.max(0, Math.trunc(Number(commerce.totalOrders ?? profile.storeOrderCount ?? 0) || 0)),
    totalSpendKurus: Math.max(0, Math.trunc(Number(commerce.totalSpendKurus || 0) || 0)),
    refundedKurus: Math.max(0, Math.trunc(Number(commerce.refundedKurus || 0) || 0)),
    lastOrderAt: Math.max(0, Number(commerce.lastOrderAt || 0) || 0),
    adminNote: safeText(profile.storeAdminNote, 300)
  };
}

async function profileForUid(db, uid) {
  const snapshot = await db.collection('users').doc(uid).get();
  return snapshot.exists ? (snapshot.data() || {}) : {};
}

function commerceAggregate(rows = []) {
  const result = { totalOrders: 0, totalSpendKurus: 0, refundedKurus: 0, lastOrderAt: 0 };
  for (const order of rows) {
    result.totalOrders += 1;
    const amount = Math.max(0, Math.trunc(Number(order.totalKurus) || 0));
    const status = safeText(order.status, 40).toLowerCase();
    if (['paid', 'processing', 'delivery_pending', 'delivered'].includes(status)) result.totalSpendKurus += amount;
    if (status === 'refunded') result.refundedKurus += Math.max(0, Math.trunc(Number(order.walletRefundedKurus || amount) || 0));
    result.lastOrderAt = Math.max(result.lastOrderAt, Number(order.updatedAt || order.createdAt || 0) || 0);
  }
  return result;
}

async function commerceStatsForUids(db, uids = []) {
  const unique = [...new Set(uids.map((uid) => safeText(uid, 160)).filter(Boolean))];
  const map = new Map(unique.map((uid) => [uid, { totalOrders: 0, totalSpendKurus: 0, refundedKurus: 0, lastOrderAt: 0 }]));
  for (let offset = 0; offset < unique.length; offset += 10) {
    const chunk = unique.slice(offset, offset + 10);
    if (!chunk.length) continue;
    let snapshot;
    try { snapshot = await db.collection('storeOrders').where('uid', 'in', chunk).get(); }
    catch (_) {
      const docs = [];
      for (const uid of chunk) {
        const perUser = await db.collection('storeOrders').where('uid', '==', uid).get();
        docs.push(...perUser.docs);
      }
      snapshot = { docs };
    }
    const groups = new Map(chunk.map((uid) => [uid, []]));
    for (const doc of snapshot.docs) {
      const row = doc.data() || {};
      const uid = safeText(row.uid, 160);
      if (groups.has(uid)) groups.get(uid).push(row);
    }
    for (const [uid, rows] of groups) map.set(uid, commerceAggregate(rows));
  }
  return map;
}

async function resolveStoreUser(identifier = '') {
  const query = safeText(identifier, 254);
  if (!query) throw serviceError('STORE_USER_IDENTIFIER_REQUIRED', 400);
  const { db, auth } = firebaseStore();
  let authUser = null;
  if (query.includes('@')) {
    try { authUser = await auth.getUserByEmail(query.toLowerCase()); } catch (_) {}
  } else {
    try { authUser = await auth.getUser(query); } catch (_) {}
    if (!authUser) {
      const lower = query.toLocaleLowerCase('tr-TR');
      const snapshot = await db.collection('users').where('usernameLower', '==', lower).limit(2).get();
      if (snapshot.size > 1) throw serviceError('STORE_USER_IDENTIFIER_AMBIGUOUS', 409);
      if (!snapshot.empty) {
        try { authUser = await auth.getUser(snapshot.docs[0].id); } catch (_) {}
      }
    }
  }
  if (!authUser) throw serviceError('STORE_ACCOUNT_NOT_FOUND', 404);
  const [profile, commerce] = await Promise.all([
    profileForUid(db, authUser.uid),
    commerceStatsForUids(db, [authUser.uid])
  ]);
  return publicAdminUser(authUser, profile, commerce.get(authUser.uid));
}

async function listStoreUsers({ query = '', limit = 50, pageToken = '' } = {}) {
  const safeQuery = safeText(query, 254);
  if (safeQuery) return { users: [await resolveStoreUser(safeQuery)], nextPageToken: '' };
  const { db, auth } = firebaseStore();
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(Number(limit) || 50)));
  const result = await auth.listUsers(safeLimit, safeText(pageToken, 1024) || undefined);
  const [profiles, commerce] = await Promise.all([
    Promise.all(result.users.map((user) => profileForUid(db, user.uid))),
    commerceStatsForUids(db, result.users.map((user) => user.uid))
  ]);
  return {
    users: result.users.map((user, index) => publicAdminUser(user, profiles[index], commerce.get(user.uid))),
    nextPageToken: safeText(result.pageToken, 1024)
  };
}

async function updateStoreUser({ uid = '', status = '', adminNote = '', actor = {} } = {}) {
  const safeUid = safeText(uid, 160);
  const safeStatus = safeText(status, 40).toLowerCase();
  if (!safeUid) throw serviceError('STORE_TARGET_UID_REQUIRED', 400);
  if (!ACCOUNT_STATUSES.includes(safeStatus)) throw serviceError('STORE_ACCOUNT_STATUS_INVALID', 400);
  const { db, auth } = firebaseStore();
  let authUser;
  try { authUser = await auth.getUser(safeUid); } catch (_) { throw serviceError('STORE_ACCOUNT_NOT_FOUND', 404); }
  if (safeStatus === 'suspended' && env.adminUids.includes(safeUid)) throw serviceError('ADMIN_OWNER_IMMUTABLE', 403);
  const previousProfile = await profileForUid(db, safeUid);
  const suspend = safeStatus === 'suspended';
  const restoreManagedAccount = !suspend && previousProfile.storeAccountStatus === 'suspended'
    && previousProfile.storeSuspendedAuthDisabled === true && authUser.disabled === true;
  const disableAccount = suspend && authUser.disabled !== true;
  if (disableAccount || restoreManagedAccount) {
    try {
      authUser = await auth.updateUser(safeUid, { disabled: suspend });
      await auth.revokeRefreshTokens(safeUid);
      await revokeAdminSessionsForUser(safeUid);
    } catch (_) {
      throw serviceError('STORE_ACCOUNT_MODERATION_FAILED', 503);
    }
  } else if (suspend) {
    try {
      await auth.revokeRefreshTokens(safeUid);
      await revokeAdminSessionsForUser(safeUid);
    } catch (_) {
      throw serviceError('STORE_ACCOUNT_MODERATION_FAILED', 503);
    }
  }
  const now = Date.now();
  try {
    const batch = db.batch();
    batch.set(db.collection('users').doc(safeUid), {
      storeAccountStatus: safeStatus,
      storeSuspendedAuthDisabled: suspend ? (disableAccount || previousProfile.storeSuspendedAuthDisabled === true) : false,
      storeAdminNote: safeText(adminNote, 300),
      storeUpdatedAt: now,
      storeModeratedAt: now,
      storeModeratedBy: { uid: safeText(actor.uid, 160), email: safeText(actor.email, 160).toLowerCase() }
    }, { merge: true });
    recordMutationAudit(batch, db, 'store.user.update', actor, { uid: safeUid, before: previousProfile.storeAccountStatus || 'active', after: safeStatus });
    await batch.commit();
  } catch (_) {
    if (disableAccount || restoreManagedAccount) await auth.updateUser(safeUid, { disabled: !suspend }).catch(() => null);
    throw serviceError('STORE_ACCOUNT_MODERATION_FAILED', 503);
  }
  invalidateAdminStoreCaches();
  const [profile, commerce] = await Promise.all([
    profileForUid(db, safeUid),
    commerceStatsForUids(db, [safeUid])
  ]);
  return publicAdminUser(authUser, profile, commerce.get(safeUid));
}

async function listWalletLedger(uid = '', limit = 100, cursor = '') {
  const safeUid = safeText(uid, 160);
  if (!safeUid) throw serviceError('STORE_TARGET_UID_REQUIRED', 400);
  const { db } = firebaseStore();
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 100));
  const page = await createdAtPage({ db, collection: 'storeWalletLedger', filters: [['uid', safeUid]], limit: safeLimit, cursor });
  const ledger = page.docs.map((doc) => {
    const row = doc.data() || {};
    return {
      id: doc.id,
      type: safeText(row.type, 30),
      amountKurus: Math.trunc(Number(row.amountKurus) || 0),
      balanceBeforeKurus: Math.max(0, Math.trunc(Number(row.balanceBeforeKurus) || 0)),
      balanceAfterKurus: Math.max(0, Math.trunc(Number(row.balanceAfterKurus) || 0)),
      reason: safeText(row.reason, 200),
      orderId: safeText(row.orderId, 160),
      transactionId: safeText(row.transactionId || row.requestId || doc.id, 180),
      actor: { uid: safeText(row.actor?.uid, 160), email: safeText(row.actor?.email, 160).toLowerCase(), source: safeText(row.actor?.source, 40) },
      createdAt: Math.max(0, Number(row.createdAt || 0) || 0)
    };
  }).sort((left, right) => right.createdAt - left.createdAt);
  return { ledger, nextCursor: page.nextCursor, hasMore: page.hasMore };
}

async function collectFirebaseUsers(auth, maxPages = 5) {
  const users = [];
  let pageToken;
  let pages = 0;
  do {
    const result = await auth.listUsers(1000, pageToken);
    users.push(...result.users);
    pageToken = result.pageToken || undefined;
    pages += 1;
  } while (pageToken && pages < maxPages);
  return { users, complete: !pageToken };
}

async function getProfileSummarySnapshot(db, { fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && profileSummaryCache && now - profileSummaryCache.at < PROFILE_SUMMARY_TTL_MS) {
    return profileSummaryCache.snapshot;
  }
  if (!profileSummaryLoad) {
    const pending = db.collection('users').get().then((snapshot) => {
      profileSummaryCache = { at: Date.now(), snapshot };
      return snapshot;
    });
    profileSummaryLoad = pending.finally(() => { profileSummaryLoad = null; });
  }
  return profileSummaryLoad;
}

async function getUserDirectorySummary({ fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && userSummaryCache && now - userSummaryCache.at < USER_SUMMARY_TTL_MS) return userSummaryCache.value;
  const { db, auth } = firebaseStore();
  const [{ users, complete }, profilesSnapshot] = await Promise.all([
    collectFirebaseUsers(auth),
    getProfileSummarySnapshot(db, { fresh })
  ]);
  const profiles = new Map(profilesSnapshot.docs.map((doc) => [doc.id, doc.data() || {}]));
  const summary = {
    authUsers: users.length,
    countComplete: complete,
    disabled: users.filter((user) => user.disabled === true).length,
    active: 0,
    purchaseBlocked: 0,
    suspended: 0,
    profileDocuments: profilesSnapshot.size,
    walletLiabilityKurus: 0,
    fundedAccounts: 0,
    generatedAt: now
  };
  for (const user of users) {
    const profile = profiles.get(user.uid) || {};
    const status = ACCOUNT_STATUSES.includes(profile.storeAccountStatus) ? profile.storeAccountStatus : 'active';
    if (user.disabled === true) {
    } else if (status === 'active') summary.active += 1;
    else if (status === 'purchase_blocked') summary.purchaseBlocked += 1;
    else if (status === 'suspended') summary.suspended += 1;
    const amount = balance(profile);
    summary.walletLiabilityKurus += amount;
    if (amount > 0) summary.fundedAccounts += 1;
  }
  userSummaryCache = { at: now, value: summary };
  return summary;
}

async function collectLedgerRows(db, maxPages = 1) {
  const rows = [];
  let cursor = null;
  let pages = 0;
  do {
    let query = db.collection('storeWalletLedger').orderBy('createdAt', 'desc').limit(WALLET_SUMMARY_LEDGER_LIMIT);
    if (cursor) query = query.startAfter(cursor);
    const snapshot = await query.get();
    if (snapshot.empty) return { rows, complete: true };
    rows.push(...snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() || {}) })));
    cursor = snapshot.docs[snapshot.docs.length - 1];
    pages += 1;
    if (snapshot.size < WALLET_SUMMARY_LEDGER_LIMIT) return { rows, complete: true };
  } while (pages < maxPages);
  return { rows, complete: false };
}

async function getWalletSummary({ fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && walletSummaryCache && now - walletSummaryCache.at < WALLET_SUMMARY_TTL_MS) return walletSummaryCache.value;
  const { db } = firebaseStore();
  const [profilesSnapshot, ledgerResult, adjustmentsCount] = await Promise.all([
    getProfileSummarySnapshot(db, { fresh }),
    collectLedgerRows(db).catch(async () => {
      const snapshot = await db.collection('storeWalletLedger').limit(WALLET_SUMMARY_LEDGER_LIMIT).get();
      return {
        rows: snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() || {}) })),
        complete: snapshot.size < WALLET_SUMMARY_LEDGER_LIMIT
      };
    }),
    db.collection('storeWalletAdjustments').count().get().catch(() => null)
  ]);
  let liabilityKurus = 0;
  let fundedAccounts = 0;
  let highestBalanceKurus = 0;
  for (const doc of profilesSnapshot.docs) {
    const amount = balance(doc.data() || {});
    liabilityKurus += amount;
    if (amount > 0) fundedAccounts += 1;
    highestBalanceKurus = Math.max(highestBalanceKurus, amount);
  }
  const totals = { CREDIT: 0, DEBIT: 0, REFUND: 0, CORRECTION: 0 };
  const counts = { CREDIT: 0, DEBIT: 0, REFUND: 0, CORRECTION: 0 };
  let todayCreditKurus = 0;
  let todayRefundKurus = 0;
  const today = turkeyDateKey(now);
  const normalized = ledgerResult.rows.map((row) => {
    const type = safeText(row.type, 30).toUpperCase();
    const amountKurus = Math.trunc(Number(row.amountKurus) || 0);
    const createdAt = Math.max(0, Number(row.createdAt || 0) || 0);
    if (Object.prototype.hasOwnProperty.call(totals, type)) {
      totals[type] += amountKurus;
      counts[type] += 1;
      if (turkeyDateKey(createdAt) === today) {
        if (type === 'CREDIT') todayCreditKurus += Math.max(0, amountKurus);
        if (type === 'REFUND') todayRefundKurus += Math.max(0, amountKurus);
      }
    }
    return {
      id: safeText(row.id, 180),
      transactionId: safeText(row.transactionId || row.requestId || row.id, 180),
      uid: safeText(row.uid, 160),
      username: safeText(row.username, 80),
      type,
      amountKurus,
      balanceBeforeKurus: Math.max(0, Math.trunc(Number(row.balanceBeforeKurus) || 0)),
      balanceAfterKurus: Math.max(0, Math.trunc(Number(row.balanceAfterKurus) || 0)),
      reason: safeText(row.reason, 200),
      actorSource: safeText(row.actor?.source || '', 30),
      actor: { uid: safeText(row.actor?.uid, 160), email: safeText(row.actor?.email, 160).toLowerCase() },
      createdAt
    };
  }).sort((a, b) => b.createdAt - a.createdAt);
  const value = {
    liabilityKurus,
    fundedAccounts,
    averageBalanceKurus: profilesSnapshot.size ? Math.round(liabilityKurus / profilesSnapshot.size) : 0,
    highestBalanceKurus,
    profileDocuments: profilesSnapshot.size,
    adjustmentCount: Math.max(0, Number(adjustmentsCount?.data()?.count || 0) || 0),
    totalCreditKurus: Math.max(0, totals.CREDIT),
    totalDebitKurus: Math.abs(Math.min(0, totals.DEBIT)),
    totalRefundKurus: Math.max(0, totals.REFUND),
    totalCorrectionKurus: totals.CORRECTION,
    todayCreditKurus,
    todayRefundKurus,
    counts,
    ledgerAnalyzed: ledgerResult.rows.length,
    ledgerComplete: ledgerResult.complete === true,
    recent: normalized.slice(0, 50),
    generatedAt: now
  };
  walletSummaryCache = { at: now, value };
  return value;
}

async function getAdminOverview(policy = null) {
  const { db, auth, enabled } = firebaseStore();
  const can = (permission) => overviewCan(policy, permission);
  const needsOrders = can('store.orders.read') || can('store.wallet.read');
  const [ordersSnapshot, ordersCount, stock, usersSummary, catalog, walletSummary] = await Promise.all([
    needsOrders ? db.collection('storeOrders').orderBy('createdAt', 'desc').limit(OVERVIEW_ORDER_LIMIT).get() : Promise.resolve({ docs: [] }),
    needsOrders ? db.collection('storeOrders').count().get().catch(() => null) : Promise.resolve(null),
    can('store.inventory.read') ? inventorySummary({ fresh: false }) : Promise.resolve([]),
    can('store.users.read') ? getUserDirectorySummary({ fresh: false }) : Promise.resolve({}),
    getEffectiveCatalog({ includeInactive: true, fresh: false }),
    can('store.wallet.read') ? getWalletSummary({ fresh: false }) : Promise.resolve({})
  ]);
  const orders = ordersSnapshot.docs.map((doc) => doc.data() || {});
  const totalOrders = Math.max(orders.length, Number(ordersCount?.data()?.count || 0));
  const today = turkeyDateKey();
  const confirmed = orders.filter((order) => Number(order.approvedAt || 0) > 0 || ['paid', 'processing', 'delivery_pending', 'delivered', 'refunded'].includes(order.status));
  const delivered = orders.filter((order) => order.status === 'delivered');
  const awaiting = orders.filter((order) => ['awaiting_payment', 'payment_review'].includes(order.status)).length;
  const processing = orders.filter((order) => ['paid', 'processing', 'delivery_pending'].includes(order.status)).length;
  const refunded = orders.filter((order) => order.status === 'refunded' || Number(order.walletRefundedAt || 0) > 0);
  const cancelled = orders.filter((order) => order.status === 'cancelled').length;
  const paymentRejected = orders.filter((order) => order.status === 'payment_rejected').length;
  const deliveryFailures = orders.filter((order) => order.delivery?.status === 'failed').length;
  const grossRevenueKurus = confirmed.reduce((sum, order) => sum + Math.max(0, Number(order.totalKurus) || 0), 0);
  const deliveredRevenueKurus = delivered.reduce((sum, order) => sum + Math.max(0, Number(order.totalKurus) || 0), 0);
  const refundedKurus = refunded.reduce((sum, order) => sum + Math.max(0, Number(order.walletRefundedKurus || (order.status === 'refunded' ? order.totalKurus : 0)) || 0), 0);
  const telegramOrders = orders.filter((order) => order.salesChannel === 'telegram' || order.paymentMethod === 'telegram').length;
  const automaticOrders = orders.filter((order) => !(order.salesChannel === 'telegram' || order.paymentMethod === 'telegram')).length;
  const configuration = env.configurationReport();
  const inventory = inventoryReadiness();
  const activeProducts = catalog.products.filter((product) => product.active !== false && product.archived !== true);
  const inactiveProducts = catalog.products.filter((product) => product.active === false && product.archived !== true);
  const archivedProducts = catalog.products.filter((product) => product.archived === true);
  const todayOrders = orders.filter((order) => turkeyDateKey(Number(order.createdAt || 0)) === today).length;
  const availableStock = stock.reduce((sum, row) => sum + Math.max(0, Number(row.available || 0)), 0);
  const lowStockSkus = stock.filter((row) => row.productActive && row.planActive && row.available <= 3).length;
  return projectAdminOverview({
    metrics: {
      orders: totalOrders,
      ordersAnalyzed: orders.length,
      ordersComplete: orders.length >= totalOrders && (orders.length < OVERVIEW_ORDER_LIMIT || !!ordersCount),
      todayOrders,
      awaitingPayment: awaiting,
      processing,
      delivered: delivered.length,
      cancelled,
      refunded: refunded.length,
      paymentRejected,
      confirmedRevenueKurus: grossRevenueKurus,
      grossRevenueKurus,
      netRevenueKurus: Math.max(0, grossRevenueKurus - refundedKurus),
      deliveredRevenueKurus,
      refundedKurus,
      walletLiabilityKurus: walletSummary.liabilityKurus,
      users: usersSummary.authUsers,
      activeUsers: usersSummary.active,
      purchaseBlockedUsers: usersSummary.purchaseBlocked,
      suspendedUsers: usersSummary.suspended,
      disabledUsers: usersSummary.disabled,
      availableStock,
      lowStockSkus,
      deliveryFailures,
      telegramOrders,
      automaticOrders,
      activeProducts: activeProducts.length,
      inactiveProducts: inactiveProducts.length,
      archivedProducts: archivedProducts.length,
      totalProducts: catalog.products.length,
      activePlans: activeProducts.reduce((sum, product) => sum + (product.plans || []).filter((plan) => plan.active !== false).length, 0),
      fundedAccounts: walletSummary.fundedAccounts
    },
    users: usersSummary,
    system: {
      firebaseAdmin: enabled === true,
      firebaseAuth: !!auth,
      firestore: !!db,
      render: configuration.ready === true,
      keyVault: configuration.keyVaultReady === true,
      inventory: inventory.ready === true,
      automaticDelivery: catalog.storefront?.services?.automaticDelivery !== false && inventory.ready === true,
      telegram: catalog.storefront?.services?.telegramSupport !== false,
      appCheckMode: configuration.appCheckMode,
      appCheckConfigured: configuration.appCheckConfigured === true,
      configurationReady: configuration.ready,
      missingConfigurationCount: Array.isArray(configuration.missing) ? configuration.missing.length : 0,
      catalogProducts: catalog.products.length
    },
    stock: stock.sort((left, right) => left.available - right.available || left.productName.localeCompare(right.productName, 'tr')).slice(0, 30),
    generatedAt: Date.now()
  }, policy);
}

function normalizeAudit(doc, source) {
  const row = doc.data() || {};
  const details = row.details && typeof row.details === 'object' ? row.details : {};
  return {
    id: doc.id,
    eventId: safeText(row.eventId || doc.id, 180),
    source,
    action: safeText(row.action || row.type, 160),
    actor: {
      uid: safeText(row.actor?.uid || row.uid, 160),
      email: safeText(row.actor?.email, 160).toLowerCase(),
      role: safeText(row.actor?.role, 40)
    },
    targetUid: safeText(details.targetUid || row.uid, 160),
    orderId: safeText(details.orderId || row.orderId, 160),
    summary: safeText(details.reason || row.reason || row.orderNumber || details.summary || '', 200),
    requestId: safeText(row.requestId || details.requestId, 180),
    ipHash: safeText(row.ipHash || details.ipHash, 96),
    userAgent: safeText(row.userAgent || details.userAgent, 180),
    before: details.before && typeof details.before === 'object' ? details.before : null,
    after: details.after && typeof details.after === 'object' ? details.after : null,
    createdAt: Math.max(0, Number(row.createdAt || row.at || 0) || 0)
  };
}

async function listAuditLogs(limit = 100, targetUid = '') {
  const { db } = firebaseStore();
  const safeLimit = Math.max(1, Math.min(200, Math.trunc(Number(limit) || 100)));
  const [adminSnapshot, storeSnapshot] = await Promise.all([
    db.collection('adminAudit').orderBy('createdAt', 'desc').limit(safeLimit).get().catch(() => db.collection('adminAudit').limit(safeLimit).get()),
    db.collection('audit').orderBy('at', 'desc').limit(safeLimit).get().catch(() => db.collection('audit').limit(safeLimit).get())
  ]);
  const safeTargetUid = safeText(targetUid, 160);
  return [
    ...adminSnapshot.docs.map((doc) => normalizeAudit(doc, 'admin')),
    ...storeSnapshot.docs.map((doc) => normalizeAudit(doc, 'store'))
  ].filter((row) => !safeTargetUid || row.targetUid === safeTargetUid || row.actor?.uid === safeTargetUid)
    .sort((left, right) => right.createdAt - left.createdAt).slice(0, safeLimit);
}

async function listStaff() {
  const { db } = firebaseStore();
  const snapshot = await db.collection('adminUsers').limit(100).get();
  const rows = snapshot.docs.map((doc) => {
    const row = doc.data() || {};
    const role = STAFF_ROLES.includes(row.role) ? row.role : 'viewer';
    return {
      uid: safeText(row.uid || doc.id, 160),
      email: safeText(row.email, 254).toLowerCase(),
      role,
      permissions: ROLE_PERMISSIONS[role],
      active: row.active !== false && row.disabled !== true && row.revoked !== true,
      updatedAt: Math.max(0, Number(row.updatedAt || 0) || 0)
    };
  });
  if (env.adminUids[0]) rows.unshift({
    uid: env.adminUids[0], email: env.adminEmails[0] || '', role: 'owner', permissions: ['*'], active: true, systemOwner: true, updatedAt: 0
  });
  return rows;
}

async function resolveStaffPolicy(uid = '', email = '') {
  const safeUid = safeText(uid, 160);
  const safeEmail = safeText(email, 254).toLowerCase();
  if (!safeUid || !safeEmail) return null;
  if (env.adminUids.length === 1 && env.adminEmails.length === 1
    && env.adminUids[0] === safeUid && env.adminEmails[0] === safeEmail) {
    return { uid: safeUid, email: safeEmail, role: 'owner', permissions: ROLE_PERMISSIONS.owner, active: true, systemOwner: true };
  }
  const { db } = firebaseStore();
  const snapshot = await db.collection('adminUsers').doc(safeUid).get();
  if (!snapshot.exists) return null;
  const row = snapshot.data() || {};
  const role = STAFF_ROLES.includes(row.role) && row.role !== 'owner' ? row.role : 'viewer';
  const rowEmail = safeText(row.email, 254).toLowerCase();
  if (rowEmail !== safeEmail || row.active === false || row.disabled === true || row.revoked === true) return null;
  return { uid: safeUid, email: safeEmail, role, permissions: ROLE_PERMISSIONS[role], active: true, systemOwner: false };
}

function staffHasPermission(policy = null, permission = '') {
  const permissions = Array.isArray(policy?.permissions) ? policy.permissions : [];
  return permissions.includes('*') || permissions.includes(safeText(permission, 100));
}

async function upsertStaff({ uid = '', email = '', role = 'viewer', active = true, actor = {} } = {}) {
  const safeUid = safeText(uid, 160);
  const safeEmail = safeText(email, 254).toLowerCase();
  const safeRole = safeText(role, 30).toLowerCase();
  if (!safeUid || !safeEmail.includes('@')) throw serviceError('ADMIN_STAFF_IDENTITY_INVALID', 400);
  if (env.adminUids.includes(safeUid) || env.adminEmails.includes(safeEmail)) throw serviceError('ADMIN_OWNER_IMMUTABLE', 409);
  if (!STAFF_ROLES.includes(safeRole) || safeRole === 'owner') throw serviceError('ADMIN_STAFF_ROLE_INVALID', 400);
  const { db, auth } = firebaseStore();
  let user;
  try { user = await auth.getUser(safeUid); } catch (_) { throw serviceError('STORE_ACCOUNT_NOT_FOUND', 404); }
  if (String(user.email || '').toLowerCase() !== safeEmail) throw serviceError('ADMIN_STAFF_IDENTITY_MISMATCH', 409);
  const now = Date.now();
  const row = {
    uid: safeUid,
    email: safeEmail,
    role: safeRole,
    permissions: ROLE_PERMISSIONS[safeRole],
    active: active === true,
    disabled: active !== true,
    updatedAt: now,
    updatedBy: { uid: safeText(actor.uid, 160), email: safeText(actor.email, 160).toLowerCase() }
  };
  const batch = db.batch();
  batch.set(db.collection('adminUsers').doc(safeUid), row, { merge: true });
  recordMutationAudit(batch, db, 'store.staff.update', actor, { uid: safeUid, role: safeRole, active: row.active });
  await batch.commit();
  return row;
}

function walletLedgerId(scope = 'wallet') {
  return `${scope}_${Date.now()}_${crypto.randomBytes(7).toString('hex')}`;
}

function invalidateAdminStoreCaches() {
  userSummaryCache = null;
  walletSummaryCache = null;
  profileSummaryCache = null;
}

module.exports = {
  ACCOUNT_STATUSES,
  STAFF_ROLES,
  ROLE_PERMISSIONS,
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
  resolveStaffPolicy,
  staffHasPermission,
  walletLedgerId,
  invalidateAdminStoreCaches,
  serviceError
};
