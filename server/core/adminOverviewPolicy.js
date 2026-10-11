'use strict';

const METRIC_PERMISSIONS = Object.freeze({
  'store.orders.read': ['orders', 'ordersAnalyzed', 'ordersComplete', 'todayOrders', 'awaitingPayment', 'processing', 'delivered', 'cancelled', 'refunded', 'paymentRejected', 'deliveryFailures', 'telegramOrders', 'automaticOrders'],
  'store.wallet.read': ['confirmedRevenueKurus', 'grossRevenueKurus', 'netRevenueKurus', 'deliveredRevenueKurus', 'refundedKurus', 'walletLiabilityKurus', 'fundedAccounts'],
  'store.users.read': ['users', 'activeUsers', 'purchaseBlockedUsers', 'suspendedUsers', 'disabledUsers'],
  'store.inventory.read': ['availableStock', 'lowStockSkus'],
  'store.catalog.read': ['activeProducts', 'inactiveProducts', 'archivedProducts', 'totalProducts', 'activePlans']
});

function overviewCan(policy, permission) {
  const permissions = Array.isArray(policy?.permissions) ? policy.permissions : [];
  return permissions.includes('*') || permissions.includes(permission);
}

function redactUserFinance(user, policy) {
  if (!user || overviewCan(policy, 'store.wallet.read')) return user;
  const { balanceKurus, totalSpendKurus, refundedKurus, walletLiabilityKurus, fundedAccounts, ...visible } = user;
  return visible;
}

function projectAdminOverview(overview, policy) {
  const metrics = {};
  for (const [permission, names] of Object.entries(METRIC_PERMISSIONS)) {
    if (!overviewCan(policy, permission)) continue;
    for (const name of names) {
      if (Object.hasOwn(overview.metrics || {}, name)) metrics[name] = overview.metrics[name];
    }
  }
  return {
    metrics,
    ...(overviewCan(policy, 'store.users.read') ? { users: redactUserFinance(overview.users, policy) } : {}),
    ...(overviewCan(policy, 'store.inventory.read') ? { stock: overview.stock } : {}),
    ...(overviewCan(policy, 'store.security.read') ? { system: overview.system } : {}),
    generatedAt: overview.generatedAt
  };
}

module.exports = { overviewCan, projectAdminOverview, redactUserFinance };
