const CUSTOMER_VIEWS = Object.freeze(['cart', 'orders', 'deliveries', 'coupons', 'profile']);
const ORDER_FILTERS = Object.freeze(['all', 'pending', 'approved', 'delivered']);
const COUPON_FILTERS = Object.freeze(['available', 'used', 'expired']);

const CUSTOMER_VIEW_META = Object.freeze({
  cart: Object.freeze({
    title: 'Sepetim',
    description: 'Seçtiğin ürünler ve güvenli ödeme seçenekleri',
    icon: 'fa-trash-can',
    actionLabel: 'Sepeti temizle'
  }),
  orders: Object.freeze({
    title: 'Siparişlerim',
    description: 'Tüm sipariş hareketlerin ve canlı durumları',
    icon: 'fa-magnifying-glass',
    actionLabel: 'Siparişlerde ara'
  }),
  deliveries: Object.freeze({
    title: 'Teslimatlarım',
    description: 'Onaylanan siparişlerinin korumalı teslimatı',
    icon: 'fa-rotate',
    actionLabel: 'Teslimatları yenile'
  }),
  coupons: Object.freeze({
    title: 'Kuponlarım',
    description: 'Hesabına tanımlanan fırsatlar ve indirimler',
    icon: 'fa-rotate',
    actionLabel: 'Kuponları yenile'
  }),
  profile: Object.freeze({
    title: 'Hesabım',
    description: 'Profil, bakiye ve güvenlik merkezi',
    icon: 'fa-pen',
    actionLabel: 'Profil bilgilerini düzenle'
  })
});

const ACCOUNT_ACTIONS = Object.freeze({
  avatar: Object.freeze({
    title: 'Profil avatarını seç',
    description: 'Görselin kırpılmadan gösterilir ve hesabına güvenle kaydedilir.',
    icon: 'fa-user-astronaut',
    focus: '[data-avatar-choice][aria-pressed="true"]'
  }),
  username: Object.freeze({
    title: 'Kullanıcı adını değiştir',
    description: 'Yeni kullanıcı adın benzersiz olmalı ve en fazla 3 kez değiştirilebilir.',
    icon: 'fa-at',
    focus: '#accountNewUsername'
  }),
  name: Object.freeze({
    title: 'Ad ve soyadı güncelle',
    description: 'Ad ve soyad bilgisi birlikte yalnızca 1 kez değiştirilebilir.',
    icon: 'fa-id-card',
    focus: '#accountNewFirstName'
  }),
  birthdate: Object.freeze({
    title: 'Doğum tarihini güncelle',
    description: 'Doğum tarihi yalnızca 1 kez değiştirilebilir; tarihi dikkatle seç.',
    icon: 'fa-cake-candles',
    focus: '#accountBirthDay'
  }),
  email: Object.freeze({
    title: 'E-posta adresini güncelle',
    description: 'Mevcut hesap şifren doğrulanır ve yeni adres doğrudan kaydedilir.',
    icon: 'fa-envelope-circle-check',
    focus: '#accountNewEmail'
  }),
  password: Object.freeze({
    title: 'Hesap şifreni değiştir',
    description: 'Mevcut şifren doğrulanır; yeni şifren güvenlik kurallarından geçirilir.',
    icon: 'fa-key',
    focus: '#accountPasswordCurrent'
  }),
  logout: Object.freeze({
    title: 'Oturumu güvenle kapat',
    description: 'Bu cihazdaki oturum ve ekranda tutulan korumalı veriler temizlenir.',
    icon: 'fa-right-from-bracket',
    focus: '[data-account-action-cancel]'
  })
});

function nodes(root, selector) {
  return [...(root?.querySelectorAll(selector) || [])];
}

function normalizedCustomerView(value = 'profile', { deliveryAvailable = true } = {}) {
  const requested = CUSTOMER_VIEWS.includes(value) ? value : 'profile';
  return requested === 'deliveries' && !deliveryAvailable ? 'orders' : requested;
}

function clearSensitiveForms(dialog) {
  nodes(dialog, 'form').forEach((form) => form.reset?.());
  nodes(dialog, '[aria-invalid="true"]').forEach((field) => {
    field.removeAttribute('aria-invalid');
    field.closest?.('.form-field__input')?.classList.remove('is-invalid');
  });
  nodes(dialog, '[data-account-sensitive]').forEach((field) => {
    field.type = 'password';
  });
  nodes(dialog, '[data-toggle-password]').forEach((button) => {
    button.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-label', 'Şifreyi göster');
    const icon = button.querySelector('i');
    if (icon) icon.className = 'fa-solid fa-eye';
  });
}

function customerOrderGroup(order = {}) {
  const status = String(order.status || '');
  if (status === 'delivered') return 'delivered';
  if (['paid', 'processing', 'delivery_pending'].includes(status)) return 'approved';
  if (['awaiting_payment', 'payment_review'].includes(status)) return 'pending';
  return 'closed';
}

function orderMatchesFilter(order = {}, filter = 'all') {
  const selected = ORDER_FILTERS.includes(filter) ? filter : 'all';
  return selected === 'all' || customerOrderGroup(order) === selected;
}

function summarizeCustomerOrders(orders = []) {
  return (Array.isArray(orders) ? orders : []).reduce((summary, order) => {
    const group = customerOrderGroup(order);
    summary.total += 1;
    if (group === 'delivered') summary.delivered += 1;
    if (group === 'pending') summary.pending += 1;
    if (group === 'approved') summary.approved += 1;
    return summary;
  }, { total: 0, delivered: 0, pending: 0, approved: 0 });
}

function customerCouponGroup(coupon = {}) {
  const status = String(coupon.status || '');
  const limit = Math.max(1, Math.trunc(Number(coupon.perUserLimit || 1)));
  const used = Math.max(0, Math.trunc(Number(coupon.usedCount || 0))) >= limit;
  if (used) return 'used';
  if (['expired', 'exhausted', 'inactive'].includes(status)) return 'expired';
  if (['available', 'scheduled'].includes(status)) return 'available';
  return 'expired';
}

function couponMatchesFilter(coupon = {}, filter = 'available') {
  const selected = COUPON_FILTERS.includes(filter) ? filter : 'available';
  return customerCouponGroup(coupon) === selected;
}

function couponIsUsable(coupon = {}) {
  return String(coupon.status || '') === 'available' && customerCouponGroup(coupon) === 'available';
}

function summarizeCustomerCoupons(coupons = []) {
  return (Array.isArray(coupons) ? coupons : []).reduce((summary, coupon) => {
    const group = customerCouponGroup(coupon);
    summary[group] += 1;
    if (couponIsUsable(coupon)) summary.usable += 1;
    return summary;
  }, { available: 0, used: 0, expired: 0, usable: 0 });
}

function couponAccent(coupon = {}) {
  if (coupon.type === 'fixed') return 'violet';
  return Math.max(0, Number(coupon.value || 0)) >= 15 ? 'crimson' : 'gold';
}

function couponScopeLabel(coupon = {}) {
  const platforms = Array.isArray(coupon.platforms)
    ? coupon.platforms.filter((platform) => platform === 'android' || platform === 'ios')
    : [];
  if (Array.isArray(coupon.productIds) && coupon.productIds.length) return 'Seçili ürünlerde geçerli';
  if (platforms.length === 1) return platforms[0] === 'ios' ? 'iOS kategorisinde geçerli' : 'Android kategorisinde geçerli';
  return 'Tüm uygun ürünlerde geçerli';
}

function latestDeliveryLabel(orders = [], now = Date.now()) {
  const latest = (Array.isArray(orders) ? orders : [])
    .filter((order) => order.status === 'delivered' || order.delivery?.status === 'delivered')
    .map((order) => Math.max(0, Number(order.delivery?.deliveredAt || order.updatedAt || order.createdAt || 0)))
    .sort((left, right) => right - left)[0];
  if (!latest) return 'Henüz yok';
  const date = new Date(latest);
  const today = new Date(now);
  const dateKey = (value) => [value.getFullYear(), value.getMonth(), value.getDate()].join('-');
  if (dateKey(date) === dateKey(today)) return 'Bugün';
  if (dateKey(date) === dateKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1))) return 'Dün';
  return new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'short' }).format(date);
}

function createCustomerAppController({
  layer,
  authenticated = () => false,
  busy = () => false,
  deliveryAvailable = () => true,
  onViewChange = () => {},
  onActionOpen = () => {},
  onActionClose = () => {}
} = {}) {
  const shell = layer?.querySelector('[data-customer-shell]');
  const actionDialog = layer?.querySelector('#accountActionModal');
  const mainRegions = nodes(layer, '[data-customer-main]');
  let view = 'profile';
  let action = '';
  let actionFocus = null;
  let focusSequence = 0;

  function setView(next = 'profile', { focus = false } = {}) {
    const safe = normalizedCustomerView(next, { deliveryAvailable: deliveryAvailable() });
    if (action) closeAction({ restoreFocus: false, force: true });
    view = safe;
    if (shell) shell.dataset.customerActiveView = safe;
    const meta = CUSTOMER_VIEW_META[safe];
    const title = layer?.querySelector('#customerTitle');
    const description = layer?.querySelector('#customerDescription');
    const headerAction = layer?.querySelector('#customerHeaderAction');
    if (title) title.textContent = meta.title;
    if (description) description.textContent = meta.description;
    if (headerAction) {
      headerAction.setAttribute('aria-label', meta.actionLabel);
      headerAction.dataset.customerHeaderAction = safe;
      const icon = headerAction.querySelector('i');
      if (icon) icon.className = `fa-solid ${meta.icon}`;
    }
    nodes(layer, '[data-customer-view]').forEach((panel) => {
      const selected = panel.dataset.customerView === safe;
      panel.hidden = !selected;
      panel.inert = !selected;
      panel.classList.toggle('is-active', selected);
    });
    nodes(layer, '[data-customer-nav]').forEach((button) => {
      const disabled = button.dataset.customerNav === 'deliveries' && !deliveryAvailable();
      const selected = button.dataset.customerNav === safe;
      button.disabled = disabled;
      button.setAttribute('aria-disabled', String(disabled));
      button.classList.toggle('is-active', selected);
      if (selected) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    onViewChange(safe);
    if (focus) layer?.querySelector(`[data-customer-nav="${safe}"]`)?.focus({ preventScroll: true });
    return safe;
  }

  function closeAction({ restoreFocus = true, force = false } = {}) {
    if (!actionDialog || !action || (!force && busy())) return false;
    const completed = action;
    const target = actionFocus;
    action = '';
    actionFocus = null;
    focusSequence += 1;
    actionDialog.classList.remove('is-open');
    actionDialog.hidden = true;
    actionDialog.inert = true;
    actionDialog.setAttribute('aria-hidden', 'true');
    actionDialog.removeAttribute('data-account-action');
    nodes(actionDialog, '[data-account-action-panel]').forEach((panel) => {
      panel.hidden = true;
      panel.inert = true;
    });
    clearSensitiveForms(actionDialog);
    mainRegions.forEach((region) => { region.inert = false; });
    shell?.setAttribute('aria-modal', 'true');
    onActionClose(completed);
    if (restoreFocus && target?.isConnected !== false && typeof target?.focus === 'function'
      && layer?.getAttribute('aria-hidden') !== 'true') target.focus({ preventScroll: true });
    return true;
  }

  function openAction(next, trigger = null) {
    const requested = String(next || '');
    const configuration = ACCOUNT_ACTIONS[requested];
    if (!actionDialog || !configuration || !authenticated() || busy()) return false;
    if (action && !closeAction({ restoreFocus: false })) return false;
    action = requested;
    actionFocus = trigger;
    mainRegions.forEach((region) => { region.inert = true; });
    shell?.setAttribute('aria-modal', 'false');
    nodes(actionDialog, '[data-account-action-panel]').forEach((panel) => {
      const selected = panel.dataset.accountActionPanel === requested;
      panel.hidden = !selected;
      panel.inert = !selected;
    });
    const title = actionDialog.querySelector('#accountActionTitle');
    const description = actionDialog.querySelector('#accountActionDescription');
    const icon = actionDialog.querySelector('#accountActionIcon');
    if (title) title.textContent = configuration.title;
    if (description) description.textContent = configuration.description;
    if (icon) icon.className = `fa-solid ${configuration.icon}`;
    actionDialog.dataset.accountAction = requested;
    actionDialog.hidden = false;
    actionDialog.inert = false;
    actionDialog.setAttribute('aria-hidden', 'false');
    actionDialog.classList.add('is-open');
    onActionOpen(requested);
    const sequence = ++focusSequence;
    const focusTarget = () => {
      if (sequence !== focusSequence || actionDialog.hidden || action !== requested) return;
      (actionDialog.querySelector(configuration.focus)
        || actionDialog.querySelector('[data-account-action-close]'))?.focus({ preventScroll: true });
    };
    if (typeof window?.requestAnimationFrame === 'function') window.requestAnimationFrame(focusTarget);
    else focusTarget();
    return true;
  }

  return Object.freeze({
    get view() { return view; },
    get action() { return action; },
    setView,
    openAction,
    closeAction
  });
}

export {
  ACCOUNT_ACTIONS,
  COUPON_FILTERS,
  CUSTOMER_VIEWS,
  CUSTOMER_VIEW_META,
  ORDER_FILTERS,
  couponAccent,
  couponIsUsable,
  couponMatchesFilter,
  couponScopeLabel,
  createCustomerAppController,
  customerCouponGroup,
  customerOrderGroup,
  latestDeliveryLabel,
  normalizedCustomerView,
  orderMatchesFilter,
  summarizeCustomerCoupons,
  summarizeCustomerOrders
};
