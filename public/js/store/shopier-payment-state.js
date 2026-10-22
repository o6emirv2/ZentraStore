export function verifiedPaymentComplete(order = {}) {
  return order.paymentMethod === 'shopier' && order.paymentState === 'paid' && order.paidAt > 0
    && order.shopier?.state === 'paid' && order.shopier.verifiedAt > 0 && !!order.shopier.orderId
    && !order.shopier.refundPending && !Number(order.shopier.refundedKurus || 0) && !['pending', 'partial', 'full'].includes(order.shopier.refundStatus)
    && (order.orderType !== 'wallet_topup' || order.walletTopup?.settledAt > 0);
}

export function paymentNeedsRefresh(order = {}) {
  return order.paymentState === 'pending' || (order.paymentState === 'paid' && order.shopier?.refundPending === true) || (order.paymentState === 'paid' && order.orderType === 'wallet_topup'
    && !order.walletTopup?.settledAt && order.shopier?.state !== 'paid_review');
}

export function paymentReturnUrl(runtime = {}, currentOrigin = '') {
  try {
    const url = new URL(runtime.canonicalOrigin || runtime.publicBaseUrl || 'https://zentrastore.com.tr');
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('ORIGIN_INVALID');
    const local = url.origin === currentOrigin && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
    if (!local && (url.protocol !== 'https:' || !['zentrastore.com.tr', 'www.zentrastore.com.tr'].includes(url.hostname) || url.port)) throw new Error('ORIGIN_INVALID');
    return url.origin + '/';
  } catch (_) { return 'https://zentrastore.com.tr/'; }
}
