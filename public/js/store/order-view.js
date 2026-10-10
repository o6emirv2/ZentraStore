import { escapeViewText as text, viewIcon as icon, safeExternalLink } from './view-utils.js?v=zentra-ui-v71';

export function renderOrderCardView(order = {}, context = {}) {
  const items = Array.isArray(order.items) ? order.items : [];
  const status = context.status || { label: 'Durum bekleniyor', icon: 'fa-clock' };
  const price = (value) => text(context.formatPrice?.(value) || '—');
  const closed = ['cancelled', 'payment_rejected', 'refunded'].includes(order.status);
  const delivered = order.status === 'delivered';
  const approved = ['paid', 'processing', 'delivery_pending', 'delivered'].includes(order.status);
  const steps = closed
    ? [{ label: 'Sipariş alındı', done: true }, { label: status.label, done: true }]
    : [{ label: 'Sipariş alındı', done: true }, { label: 'Ödeme onaylandı', done: approved }, { label: 'Teslim edildi', done: delivered }];
  const timeline = `<ol class="order-card__timeline" aria-label="Sipariş aşamaları">${steps.map((step) => `<li${step.done ? ' class="is-complete"' : ''}>${icon(step.done ? 'fa-check' : 'fa-circle')}<span>${text(step.label)}</span></li>`).join('')}</ol>`;
  const delivery = order.deliveryVisible === true
    ? `<button class="screen-button screen-button--primary" type="button" data-order-delivery="${text(order.id)}">${icon('fa-box-open')}<span>${delivered ? 'Teslimatı aç' : 'Teslimat durumu'}</span></button>` : '';
  const payment = order.paymentMethod === 'telegram' && order.status === 'awaiting_payment'
    ? `<a class="screen-button screen-button--primary" href="${text(safeExternalLink(context.telegramUrl?.(order)))}" target="_blank" rel="noopener noreferrer">${icon('fa-telegram', 'fa-brands')}<span>Telegram'da tamamla</span></a>` : '';
  const canCancel = order.cancellable === true && ['awaiting_payment', 'paid'].includes(order.status);
  const busy = context.busyOrderId === order.id;
  const cancel = !canCancel ? '' : context.cancelConfirmId === order.id
    ? `<div class="order-card__cancel" role="group" aria-label="Sipariş iptal onayı"><p>Bu siparişi iptal etmek istediğinizden emin misiniz?</p><div><button class="screen-button" type="button" data-order-cancel-dismiss="${text(order.id)}"${busy ? ' disabled' : ''}>Vazgeç</button><button class="screen-button screen-button--danger" type="button" data-order-cancel-confirm="${text(order.id)}"${busy ? ' disabled aria-busy="true"' : ''}>${busy ? 'İptal ediliyor…' : 'İptali onayla'}</button></div></div>`
    : `<button class="order-card__cancel-link" type="button" data-order-cancel-start="${text(order.id)}">Siparişi iptal et</button>`;
  const rows = items.map((item, index) => `<li>${index === 0 ? `<span class="order-card__image">${context.mediaHtml || icon('fa-box')}</span>` : `<span class="order-card__image">${icon('fa-box')}</span>`}<span class="order-card__item-copy"><strong>${text(item.productName || 'Dijital ürün')}</strong><small>${text(item.planLabel || 'Paket')} · ${Math.max(1, Math.trunc(Number(item.quantity) || 1))} adet</small></span><b>${price(item.lineTotalKurus)}</b></li>`).join('');
  return `<article class="order-card" data-order-card="${text(order.id)}">
    <header class="order-card__header"><div><small>Sipariş numarası</small><strong>#${text(order.orderNumber || '—')}</strong></div><span class="order-card__status${closed ? ' is-closed' : delivered ? ' is-delivered' : ' is-pending'}">${icon(status.icon)}${text(status.label)}</span></header>
    <ul class="order-card__items" aria-label="Sipariş ürünleri">${rows}</ul>
    <dl class="order-card__facts"><div><dt>Tarih</dt><dd>${text(context.formatDate?.(order.createdAt) || '—')}</dd></div><div><dt>Ödeme yöntemi</dt><dd>${order.paymentMethod === 'wallet' ? 'Mağaza bakiyesi' : order.paymentMethod === 'telegram' ? 'Telegram' : '—'}</dd></div></dl>
    ${Number(order.discountKurus) > 0 ? `<p class="order-card__discount">${icon('fa-ticket')} ${text(order.promotion?.code || 'İndirim')} · −${price(order.discountKurus)}</p>` : ''}
    <div class="order-card__total"><span>Sipariş tutarı</span><strong>${price(order.totalKurus)}</strong></div>
    ${timeline}
    ${payment || delivery || cancel ? `<footer class="order-card__actions">${payment}${delivery}${cancel}</footer>` : ''}
  </article>`;
}

export function renderOrdersEmpty({ filtered = false, error = '' } = {}) {
  const title = error ? 'Siparişler yüklenemedi' : filtered ? 'Eşleşen sipariş yok' : 'İlk siparişiniz burada görünecek';
  const message = error || (filtered ? 'Aramanızı veya durum filtresini değiştirin.' : 'Ürünleri keşfedin; siparişlerinizi ve teslimatlarını bu ekrandan takip edin.');
  return `<div class="screen-empty">${icon(error ? 'fa-wifi' : filtered ? 'fa-magnifying-glass' : 'fa-box-open')}<h3>${text(title)}</h3><p>${text(message)}</p><button class="screen-button${error ? '' : ' screen-button--primary'}" type="button" ${error ? 'data-order-retry' : filtered ? 'data-order-reset' : 'data-customer-products'}>${error ? 'Yeniden dene' : filtered ? 'Filtreleri temizle' : 'Ürünleri keşfet'}</button></div>`;
}

export function renderOrdersLoading() {
  const card = '<article class="order-card order-card--skeleton" aria-hidden="true"><span class="app-skeleton-line app-skeleton-line--short"></span><div class="order-card__items"><span class="app-skeleton-media"></span><span class="app-skeleton-line"></span></div><span class="app-skeleton-line"></span><span class="app-skeleton-line app-skeleton-line--short"></span><span class="app-skeleton-line"></span></article>';
  return `<div class="orders-page__list" role="status" aria-label="Siparişler yükleniyor"><span class="sr-only">Siparişler yükleniyor…</span>${card}${card}</div>`;
}
