export const PAYMENT_WORKFLOW = Object.freeze({
  awaiting_payment: 'Ödeme Bekleniyor', checking: 'Ödeme Kontrol Ediliyor', paid: 'Ödeme Onaylandı',
  rejected: 'Ödeme Reddedildi', link_closed: 'Ödeme Bağlantısı Kapatıldı', cancelled: 'Sipariş İptal Edildi',
  refund_pending: 'İade Bekliyor', refunded: 'İade Tamamlandı', api_error: 'API Bağlantı Hatası',
  provider_review: 'Sağlayıcı Doğrulaması Bekleniyor'
});

export function paymentWorkflow(order = {}) {
  const shopier = order.shopier || {};
  let key = 'awaiting_payment';
  if (order.status === 'refunded' && (order.paymentMethod !== 'shopier' || shopier.refundStatus === 'full')) key = 'refunded';
  else if (shopier.refundPending || ['requesting', 'uncertain', 'pending'].includes(shopier.refundRequest?.state)) key = 'refund_pending';
  else if (shopier.state === 'paid_review') key = 'provider_review';
  else if (order.status === 'cancelled') key = 'cancelled';
  else if (order.paidAt || ['paid', 'processing', 'delivery_pending', 'delivered'].includes(order.status)) key = 'paid';
  else if (shopier.linkClosedAt) key = 'link_closed';
  else if (/TIMEOUT|CONNECTION|AUTH_FAILED|API_ERROR|RATE_LIMITED/.test(shopier.lastError || '')) key = 'api_error';
  else if (['creation_uncertain', 'paid_review', 'close_uncertain'].includes(shopier.state)) key = 'provider_review';
  else if (['payment_rejected'].includes(order.status) || order.paymentState === 'failed') key = 'rejected';
  else if (order.status === 'payment_review' || shopier.operation?.until > Date.now()) key = 'checking';
  return { key, label: PAYMENT_WORKFLOW[key], providerVerified: order.paymentMethod === 'shopier' && !!shopier.verifiedAt };
}
