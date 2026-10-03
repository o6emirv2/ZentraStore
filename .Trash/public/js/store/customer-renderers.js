function escapeCustomerHtml(value = '') {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  }[character]));
}

function customerIcon(icon, family = 'fa-solid') {
  return `<i class="${escapeCustomerHtml(family)} ${escapeCustomerHtml(icon)}" aria-hidden="true"></i>`;
}

function renderCustomerEmpty({ icon = 'fa-inbox', title = 'Kayıt bulunamadı', message = '' } = {}) {
  return `<div class="customer-empty">${customerIcon(icon)}<strong>${escapeCustomerHtml(title)}</strong><p>${escapeCustomerHtml(message)}</p></div>`;
}

function renderCartItemView({
  key = '', name = '', plan = '', mediaHtml = '', stockLabel = '', stockTone = 'ready',
  quantity = 1, lineTotal = '', disableIncrease = false
} = {}) {
  const safeQuantity = Math.max(1, Math.min(5, Number(quantity) || 1));
  return `<article class="customer-cart-item">
    <div class="customer-cart-item__media">${mediaHtml}</div>
    <div class="customer-cart-item__content">
      <div class="customer-cart-item__heading"><span>${escapeCustomerHtml(plan)}</span><strong>${escapeCustomerHtml(name)}</strong></div>
      <span class="customer-stock customer-stock--${escapeCustomerHtml(stockTone)}">${customerIcon(stockTone === 'danger' ? 'fa-circle-exclamation' : stockTone === 'warning' ? 'fa-hourglass-half' : 'fa-circle-check')} ${escapeCustomerHtml(stockLabel)}</span>
      <div class="customer-cart-item__controls">
        <div class="customer-quantity" aria-label="Ürün adedi">
          <button type="button" data-cart-quantity="decrease" data-cart-key="${escapeCustomerHtml(key)}" aria-label="Adedi azalt">−</button>
          <output aria-label="Adet">${safeQuantity}</output>
          <button type="button" data-cart-quantity="increase" data-cart-key="${escapeCustomerHtml(key)}" aria-label="Adedi artır"${disableIncrease ? ' disabled' : ''}>+</button>
        </div>
        <b>${escapeCustomerHtml(lineTotal)}</b>
      </div>
    </div>
    <button class="customer-cart-item__remove" type="button" data-cart-remove="${escapeCustomerHtml(key)}" aria-label="${escapeCustomerHtml(name)} ürününü sepetten kaldır">${customerIcon('fa-trash-can', 'fa-regular')}</button>
  </article>`;
}

function renderAvatarPickerView(avatars = [], selectedId = '1', fallbackIcons = {}) {
  return (Array.isArray(avatars) ? avatars : []).map((avatar) => {
    const id = String(avatar?.id || '1');
    const selected = id === String(selectedId || '1');
    const media = avatar?.image
      ? `<img class="avatar-image" src="${escapeCustomerHtml(avatar.image)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" />`
      : customerIcon(fallbackIcons[id] || fallbackIcons['1'] || 'fa-user');
    return `<button class="customer-avatar-choice${selected ? ' is-selected' : ''}" type="button" data-avatar-choice="${escapeCustomerHtml(id)}" aria-pressed="${String(selected)}" aria-label="${escapeCustomerHtml(avatar?.label || `SHELBY STORE Avatar ${id}`)}">
      <span class="customer-avatar-choice__media" data-avatar-id="${escapeCustomerHtml(id)}">${media}</span>
      <span class="customer-avatar-choice__check" aria-hidden="true">${customerIcon('fa-check')}</span>
    </button>`;
  }).join('');
}

function renderOrderTimelineView(order = {}) {
  const status = String(order.status || '');
  const terminal = ['cancelled', 'payment_rejected', 'refunded'].includes(status);
  const approved = ['paid', 'processing', 'delivery_pending', 'delivered'].includes(String(order.status || ''));
  const terminalLabel = status === 'payment_rejected' ? 'Ödeme reddedildi' : status === 'refunded' ? 'İade edildi' : 'İptal edildi';
  const stages = terminal
    ? [
      { label: 'Oluşturuldu', complete: true },
      { label: terminalLabel, terminal: true },
      { label: 'Süreç kapandı', terminal: true }
    ]
    : [
      { label: 'Oluşturuldu', complete: true },
      { label: 'Onaylandı', complete: approved },
      { label: 'Teslim edildi', complete: status === 'delivered' }
    ];
  return stages.map((stage) => `<span class="${stage.complete ? 'is-complete' : ''}${stage.terminal ? ' is-terminal' : ''}"><i aria-hidden="true"></i><small>${escapeCustomerHtml(stage.label)}</small></span>`).join('');
}

function renderOrderCardView(order = {}, context = {}) {
  const status = context.status || { label: 'Onay bekliyor', icon: 'fa-clock' };
  const primary = (order.items || [])[0] || {};
  const remaining = (order.items || []).slice(1);
  const itemRows = remaining.map((item) => `<span><span>${escapeCustomerHtml(item.productName)} · ${escapeCustomerHtml(item.planLabel)}${Number(item.quantity) > 1 ? ` × ${Math.min(5, Number(item.quantity))}` : ''}</span><b>${escapeCustomerHtml(context.formatPrice?.(item.lineTotalKurus) || '')}</b></span>`).join('');
  const canCancel = order.cancellable === true && ['awaiting_payment', 'paid'].includes(order.status);
  const confirming = context.cancelConfirmId === order.id;
  const busy = context.busyOrderId === order.id;
  const telegramAction = order.paymentMethod === 'telegram' && order.status === 'awaiting_payment'
    ? `<a class="customer-order-action customer-order-action--telegram" href="${escapeCustomerHtml(context.telegramUrl?.(order) || '#')}" target="_blank" rel="noopener noreferrer">${customerIcon('fa-telegram', 'fa-brands')}<span>Ödemeyi Telegram'da tamamla</span>${customerIcon('fa-arrow-up-right-from-square')}</a>`
    : '';
  const deliveryAction = order.deliveryVisible === true
    ? `<button class="customer-order-action" type="button" data-order-delivery="${escapeCustomerHtml(order.id)}">${customerIcon('fa-key')}<span>Teslimatı görüntüle</span>${customerIcon('fa-chevron-right')}</button>`
    : '';
  const cancelAction = canCancel
    ? (confirming
      ? `<div class="customer-order-cancel" role="group" aria-label="Sipariş iptal onayı"><span>${customerIcon('fa-triangle-exclamation')} Bu siparişi iptal etmek istediğine emin misin?</span><div><button type="button" data-order-cancel-dismiss="${escapeCustomerHtml(order.id)}">Vazgeç</button><button class="is-danger" type="button" data-order-cancel-confirm="${escapeCustomerHtml(order.id)}"${busy ? ' disabled' : ''}>${busy ? `${customerIcon('fa-spinner fa-spin')} İptal ediliyor` : 'Siparişi iptal et'}</button></div></div>`
      : `<button class="customer-order-action customer-order-action--danger" type="button" data-order-cancel-start="${escapeCustomerHtml(order.id)}">${customerIcon('fa-ban')}<span>Siparişi iptal et</span></button>`)
    : '';
  const quantity = Math.max(1, Math.min(5, Number(primary.quantity) || 1));
  return `<article class="customer-order-card">
    <header class="customer-order-card__header">
      <div class="customer-order-card__media">${context.mediaHtml || ''}</div>
      <div class="customer-order-card__identity">
        <div><span>#${escapeCustomerHtml(order.orderNumber)}</span><span class="customer-status customer-status--${escapeCustomerHtml(order.status)}">${customerIcon(status.icon)} ${escapeCustomerHtml(status.label)}</span></div>
        <strong>${escapeCustomerHtml(primary.productName || 'Mağaza siparişi')}</strong>
        <small>${escapeCustomerHtml(primary.planLabel || 'Dijital ürün')}${quantity > 1 ? ` · ${quantity} adet` : ''}</small>
      </div>
    </header>
    <div class="customer-order-card__facts"><span>${customerIcon('fa-calendar-days')}<small>Sipariş tarihi</small><strong>${escapeCustomerHtml(context.formatDate?.(order.createdAt) || '—')}</strong></span><span>${customerIcon('fa-credit-card')}<small>Ödeme</small><strong>${escapeCustomerHtml(order.paymentMethod === 'wallet' ? 'Mağaza bakiyesi' : 'Telegram')}</strong></span><span>${customerIcon('fa-receipt')}<small>Toplam</small><strong>${escapeCustomerHtml(context.formatPrice?.(order.totalKurus) || '')}</strong></span></div>
    ${itemRows ? `<div class="customer-order-card__items">${itemRows}</div>` : ''}
    ${Number(order.discountKurus || 0) > 0 ? `<div class="customer-order-card__promotion">${customerIcon('fa-ticket')} ${escapeCustomerHtml(order.promotion?.code || 'Kampanya')} · −${escapeCustomerHtml(context.formatPrice?.(order.discountKurus) || '')}</div>` : ''}
    <div class="customer-order-timeline" aria-label="Sipariş ilerlemesi">${renderOrderTimelineView(order)}</div>
    ${telegramAction || deliveryAction || cancelAction ? `<div class="customer-order-card__actions">${telegramAction}${deliveryAction}${cancelAction}</div>` : ''}
  </article>`;
}

function renderDeliveryCardView(order = {}, context = {}) {
  const delivered = order.status === 'delivered' || order.delivery?.status === 'delivered';
  const opened = context.openedDelivery;
  const primary = (order.items || [])[0] || {};
  const message = delivered
    ? (order.delivery?.message || 'Teslimatın tamamlandı. Bilgilerini bu korumalı oturumda açabilirsin.')
    : 'Ödemen onaylandı. Dijital teslimatın hazırlanıyor; tamamlandığında bilgiler burada açılacak.';
  const secrets = opened?.items?.length ? `<div class="customer-delivery-secrets">${opened.items.map((item, index) => {
    const account = item.type === 'account' && item.account;
    const value = account
      ? `<dl><div><dt>Kullanıcı</dt><dd>${escapeCustomerHtml(item.account.username)}</dd></div><div><dt>Şifre</dt><dd>${escapeCustomerHtml(item.account.password)}</dd></div></dl>`
      : `<code>${escapeCustomerHtml(item.key || item.copyValue || '')}</code>`;
    const actions = account
      ? `<div><button type="button" data-copy-delivery="${escapeCustomerHtml(order.id)}:${index}:username">${customerIcon('fa-user')} Kullanıcıyı kopyala</button><button type="button" data-copy-delivery="${escapeCustomerHtml(order.id)}:${index}:password">${customerIcon('fa-key')} Şifreyi kopyala</button></div>`
      : `<button type="button" data-copy-delivery="${escapeCustomerHtml(order.id)}:${index}:key">${customerIcon('fa-copy')} Anahtarı kopyala</button>`;
    return `<article><span><small>${escapeCustomerHtml(item.productName)} · ${escapeCustomerHtml(item.planLabel)}</small>${value}</span>${actions}</article>`;
  }).join('')}</div>` : '';
  return `<article class="customer-delivery-card" data-delivery-card="${escapeCustomerHtml(order.id)}">
    <header><div class="customer-delivery-card__media">${context.mediaHtml || ''}</div><div><span class="customer-status${delivered ? ' customer-status--delivered' : ' customer-status--processing'}">${customerIcon(delivered ? 'fa-circle-check' : 'fa-clock')} ${delivered ? 'TESLİM EDİLDİ' : 'HAZIRLANIYOR'}</span><small>#${escapeCustomerHtml(order.orderNumber)}</small><strong>${escapeCustomerHtml(primary.productName || 'Dijital teslimat')}</strong><p>${escapeCustomerHtml(primary.planLabel || 'Güvenli teslimat')}</p></div></header>
    <div class="customer-delivery-card__date">${customerIcon('fa-calendar-days')} ${escapeCustomerHtml(context.formatDate?.(order.delivery?.deliveredAt || order.createdAt) || '—')}</div>
    ${delivered && !opened ? `<div class="customer-delivery-mask">${customerIcon('fa-lock')}<span>•••• · •••• · •••• · ••••</span>${customerIcon('fa-shield-halved')}</div><button class="customer-delivery-open" type="button" data-delivery-open="${escapeCustomerHtml(order.id)}"><span>Teslimat bilgilerini görüntüle</span>${customerIcon('fa-chevron-right')}</button>` : ''}
    ${!delivered ? `<p class="customer-delivery-card__message">${escapeCustomerHtml(message)}</p>` : ''}
    ${secrets}
  </article>`;
}

function renderCouponCardView(coupon = {}, context = {}) {
  const group = context.group || 'expired';
  const disabled = context.usable !== true;
  const scheduled = coupon.status === 'scheduled';
  const value = coupon.type === 'percent' ? `%${Number(coupon.value || 0)}` : context.formatPrice?.(coupon.value || 0);
  const stateLabel = scheduled ? 'Yakında' : group === 'used' ? 'Kullanıldı' : 'Süresi doldu';
  const deadline = coupon.endsAt
    ? new Intl.DateTimeFormat('tr-TR', { dateStyle: 'long' }).format(new Date(Number(coupon.endsAt)))
    : 'Süre sınırı yok';
  const condition = coupon.minimumSubtotalKurus
    ? `${context.formatPrice?.(coupon.minimumSubtotalKurus)} ve üzeri siparişlerde`
    : context.scopeLabel;
  const action = disabled
    ? `disabled aria-label="${escapeCustomerHtml(stateLabel)}"`
    : `data-use-coupon="${escapeCustomerHtml(coupon.code)}" aria-label="${escapeCustomerHtml(coupon.code)} kuponunu sepette kullan"`;
  return `<article class="customer-coupon customer-coupon--${escapeCustomerHtml(context.accent || 'crimson')}${disabled ? ' is-disabled' : ''}">
    <div class="customer-coupon__value"><strong>${escapeCustomerHtml(value || '')}</strong><span>İNDİRİM</span></div>
    <div class="customer-coupon__body"><small>KUPON KODU</small><strong>${escapeCustomerHtml(coupon.code)}</strong><p>${customerIcon(coupon.minimumSubtotalKurus ? 'fa-cart-shopping' : 'fa-layer-group')} ${escapeCustomerHtml(condition)}</p><p>${customerIcon('fa-calendar-days')} ${escapeCustomerHtml(coupon.endsAt ? `Son gün: ${deadline}` : deadline)}</p></div>
    <button class="customer-coupon__action" type="button" ${action}>${customerIcon(disabled ? 'fa-lock' : 'fa-cart-shopping')}<span>${escapeCustomerHtml(disabled ? stateLabel : 'Sepette kullan')}</span></button>
  </article>`;
}

export {
  customerIcon,
  escapeCustomerHtml,
  renderAvatarPickerView,
  renderCartItemView,
  renderCouponCardView,
  renderCustomerEmpty,
  renderDeliveryCardView,
  renderOrderCardView
};
