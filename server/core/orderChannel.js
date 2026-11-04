'use strict';

function paymentChannel(row = {}) {
  const declared = row.paymentMethod;
  if (['telegram', 'shopier', 'wallet'].includes(declared)) return declared;
  if (declared !== undefined && declared !== null && declared !== '') return 'unknown';
  if (row.shopier?.productId || row.shopier?.orderId || row.shopier?.state || row.orderType === 'wallet_topup') return 'shopier';
  if (row.walletPaidAt || row.walletRefundedAt || row.walletDebitedKurus) return 'wallet';
  if (row.salesChannel === 'telegram' || /^TELEGRAM_/.test(String(row.fulfillmentStatus || ''))) return 'telegram';
  return 'unknown';
}
function hasPaymentEvidence(row = {}) {
  return !!(row.paidAt || row.approvedAt || row.manualPayment?.verifiedAt
    || ['paid', 'processing', 'delivery_pending', 'delivered', 'refunded'].includes(row.status)
    || ['paid', 'refunded'].includes(row.paymentState));
}
module.exports = { paymentChannel, hasPaymentEvidence };
