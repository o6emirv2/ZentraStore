export const PAYMENT_WORKFLOW = Object.freeze({
  awaiting_payment: 'Ödeme Bekleniyor', checking: 'Ödeme Kontrol Ediliyor', paid: 'Ödeme Onaylandı',
  rejected: 'Ödeme Reddedildi', cancelled: 'Sipariş İptal Edildi', refunded: 'İade Tamamlandı'
});

export function paymentWorkflow(order = {}) {
  let key = 'awaiting_payment';
  if (order.status === 'refunded') key = 'refunded';
  else if (order.status === 'cancelled') key = 'cancelled';
  else if (order.paidAt || ['paid', 'processing', 'delivery_pending', 'delivered'].includes(order.status)) key = 'paid';
  else if (order.status === 'payment_rejected') key = 'rejected';
  else if (order.status === 'payment_review') key = 'checking';
  return { key, label: PAYMENT_WORKFLOW[key] };
}
