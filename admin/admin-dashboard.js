import { isUncertainMutationError } from '../public/js/request-utils.js?v=audit-20260908-v1';
import { adminFetch, lockAdminInteractions, startAmbientCanvas } from './admin-core.js?v=audit-20260908-v1';
import { createNotificationCenter } from '/public/js/ui/notification-center.js?v=audit-20260908-v1';
import { installInteractionGuard } from '/public/js/ui/interaction-guard.js?v=audit-20260908-v1';
import { LINK_PLATFORM_META, MAX_QUICK_LINKS, validateQuickLink } from '/public/js/store/social-links.js?v=audit-20260908-v1';

installInteractionGuard();

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const PANELS = Object.freeze(['overview', 'orders', 'inventory', 'products', 'users', 'wallet', 'content', 'links', 'coupons', 'staff', 'audit', 'security']);
const PANEL_PERMISSIONS = Object.freeze({ overview: 'store.overview.read', orders: 'store.orders.read', inventory: 'store.inventory.read', products: 'store.catalog.read', users: 'store.users.read', wallet: 'store.wallet.read', content: 'store.content.read', links: 'store.content.read', coupons: 'store.content.read', staff: 'store.staff.read', audit: 'store.audit.read', security: 'store.security.read' });
const state = {
  activePanel: 'overview', loaded: new Set(), overview: null, orders: [], catalog: null, inventory: [], users: [],
  selectedUser: null, walletUser: null, security: null, query: '', filter: 'all', busyOrder: '', reauthResolve: null, secureActionResolve: null,
  inventoryReadiness: null, inventoryImportAttempt: null, inventoryImportBusy: false, walletAdjustmentAttempt: null, secureActionReturnFocus: null,
  usersSummary: null, walletSummary: null, securityRuntime: null, adminPolicy: null, productDirty: new Set(), productBulkBusy: false,
  chromeFrame: 0, chromeObserver: null, promotions: [], quickLinks: [], quickLinksBusy: false, orderNextCursor: '', orderPageLoading: false,
  panelLoads: new Map()
};

const STATUS = Object.freeze({
  awaiting_payment: { label: 'TELEGRAM İLETİŞİM / ÖDEME BEKLİYOR', icon: 'fa-clock' },
  payment_review: { label: 'ÖDEME KONTROL EDİLİYOR', icon: 'fa-magnifying-glass-dollar' },
  paid: { label: 'ÖDEME ONAYLANDI', icon: 'fa-circle-check' },
  processing: { label: 'ÜRÜN TEMİN EDİLİYOR', icon: 'fa-gears' },
  delivery_pending: { label: 'TESLİMAT BEKLİYOR', icon: 'fa-box' },
  delivered: { label: 'TESLİM EDİLDİ', icon: 'fa-box-open' },
  payment_rejected: { label: 'ÖDEME REDDİ', icon: 'fa-ban' },
  refunded: { label: 'İADE EDİLDİ', icon: 'fa-rotate-left' },
  cancelled: { label: 'İPTAL EDİLDİ', icon: 'fa-circle-xmark' }
});

function hasPermission(permission = '') {
  const permissions = Array.isArray(state.adminPolicy?.permissions) ? state.adminPolicy.permissions : [];
  return permissions.includes('*') || permissions.includes(permission);
}

function panelAllowed(name = '') {
  const permission = PANEL_PERMISSIONS[name];
  if (!permission) return false;
  if (name === 'staff' && state.adminPolicy?.systemOwner !== true) return false;
  return hasPermission(permission);
}

function requirePermission(permission = '', actionLabel = 'Bu işlem') {
  if (hasPermission(permission)) return true;
  toast('warning', 'Bu işlem için yetkiniz bulunmuyor', `${actionLabel} işlemi mevcut rolünüze açık değil. Lütfen yetkili bir yöneticiyle iletişime geçin.`);
  return false;
}

function permissionDisabled(permission = '') {
  return hasPermission(permission) ? '' : ' disabled aria-disabled="true" title="Bu rol için yazma yetkisi yok"';
}

function syncAdminChrome() {
  if (state.chromeFrame) return;
  state.chromeFrame = window.requestAnimationFrame(() => {
    state.chromeFrame = 0;
    const viewport = window.visualViewport;
    const top = Math.max(0, Math.round(viewport?.offsetTop || 0));
    const topbar = $('.admin-topbar');
    const rect = topbar?.getBoundingClientRect?.();
    const height = Math.ceil(Number(topbar?.offsetHeight || rect?.height || 0));
    document.documentElement.style.setProperty('--visual-viewport-top', `${top}px`);
    if (height >= 52 && height <= 180) document.documentElement.style.setProperty('--admin-topbar-space', `${height}px`);
  });
}

function installAdminChromeStability() {
  syncAdminChrome();
  const topbar = $('.admin-topbar');
  if (topbar && 'ResizeObserver' in window) {
    state.chromeObserver = new ResizeObserver(syncAdminChrome);
    state.chromeObserver.observe(topbar);
  }
  window.addEventListener('resize', syncAdminChrome, { passive: true });
  window.addEventListener('orientationchange', syncAdminChrome, { passive: true });
  window.visualViewport?.addEventListener('resize', syncAdminChrome, { passive: true });
  window.visualViewport?.addEventListener('scroll', syncAdminChrome, { passive: true });
}

function applyAdminPermissions() {
  $$('[data-panel]').forEach((button) => {
    const name = button.dataset.panel;
    const allowed = panelAllowed(name);
    button.hidden = !allowed;
    button.disabled = !allowed;
    button.setAttribute('aria-hidden', allowed ? 'false' : 'true');
  });
  $$('[data-admin-panel]').forEach((panel) => {
    const name = panel.dataset.adminPanel;
    if (!panelAllowed(name)) { panel.hidden = true; panel.inert = true; }
  });
  const roleLabel = $('#adminRoleLabel');
  if (roleLabel) roleLabel.textContent = String(state.adminPolicy?.role || 'admin').toLocaleUpperCase('tr-TR') + ' OTURUMU';
  const staticWriteControls = [
    ['#inventoryKeys, #inventoryImportForm button[type="submit"], #inventoryMigrateShared, #inventoryRotateKeys', 'store.inventory.write'],
    ['#walletForm input, #walletForm select, #walletForm textarea, #walletForm button, #paymentConnectionForm input, #paymentConnectionForm button', 'store.wallet.write'],
    ['#contentForm input, #contentForm select, #contentForm textarea, #contentForm button, #promotionForm input, #promotionForm select, #promotionForm textarea, #promotionForm button, #quickLinksForm input, #quickLinksForm select, #quickLinksForm textarea, #quickLinksForm button', 'store.content.write'],
    ['#staffForm input, #staffForm select, #staffForm textarea, #staffForm button', 'store.staff.write']
  ];
  staticWriteControls.forEach(([selector, permission]) => {
    $$(selector).forEach((node) => {
      const ownerOnly = permission === 'store.staff.write';
      const enabled = hasPermission(permission) && (!ownerOnly || state.adminPolicy?.systemOwner === true);
      node.disabled = !enabled;
      node.setAttribute('aria-disabled', enabled ? 'false' : 'true');
    });
  });
}

function escapeHtml(value = '') {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[character]));
}

function formatPrice(kurus, signed = false) {
  if (kurus === undefined || kurus === null) return '—';
  const amount = Number(kurus) || 0;
  const value = (Math.abs(amount) / 100).toLocaleString('tr-TR', { style: 'currency', currency: 'TRY' });
  return `${signed && amount > 0 ? '+' : amount < 0 ? '−' : ''}${value}`;
}

function formatDate(timestamp = 0) {
  const date = new Date(Number(timestamp) || 0);
  return Number.isNaN(date.getTime()) || !Number(timestamp) ? '—' : date.toLocaleString('tr-TR', { dateStyle: 'medium', timeStyle: 'short' });
}

function compactAuditValue(value) {
  if (!value || typeof value !== 'object') return '';
  return Object.entries(value).slice(0, 6).map(([key, entry]) => {
    const normalized = entry && typeof entry === 'object' ? '[güncellendi]' : String(entry ?? '—');
    return `${key}=${normalized}`;
  }).join(', ').slice(0, 220);
}

function maskEmail(email = '') {
  const [name = '', domain = ''] = String(email).split('@');
  if (!domain) return '—';
  if (name.includes('•')) return `${name}@${domain}`;
  return `${name.slice(0, 3)}${name.length > 3 ? '***' : ''}@${domain}`;
}

function requestKey(prefix = 'admin') {
  return `${prefix}_${Date.now()}_${crypto.randomUUID?.() || Math.random().toString(36).slice(2)}`;
}

let notificationCenter = null;

function toast(type, title, message, options = {}) {
  notificationCenter ||= createNotificationCenter({
    host: $('#adminToasts'),
    brand: 'SHELBY STORE · YÖNETİM',
    soundUrl: '/public/assets/sounds/bildirim.wav'
  });
  return notificationCenter.notify(type, title, message, options);
}

function loadingMarkup(title = 'Veriler hazırlanıyor') {
  return `<div class="admin-skeleton-group" aria-label="${escapeHtml(title)}"><span></span><span></span><span></span></div>`;
}

function emptyMarkup(title, message, icon = 'fa-box-open') {
  return `<div class="list-message"><i class="fa-solid ${icon}"></i><strong>${escapeHtml(title)}</strong><p>${escapeHtml(message)}</p></div>`;
}

function failureMarkup(title, error, panel = '') {
  const requestId = String(error?.requestId || '').trim();
  const retry = panel ? `<button class="secondary-action" type="button" data-panel-retry="${escapeHtml(panel)}"><i class="fa-solid fa-rotate"></i> Yeniden Dene</button>` : '';
  return `<div class="list-message is-error"><i class="fa-solid fa-triangle-exclamation"></i><strong>${escapeHtml(title)}</strong><p>${escapeHtml(error?.message || 'İşlem tamamlanamadı. Lütfen yeniden deneyin.')}</p>${requestId ? `<small>İstek kodu: ${escapeHtml(requestId)}</small>` : ''}${retry}</div>`;
}

function renderLiveStatus(hostSelector, { icon = 'fa-satellite-dish', title = 'Canlı veri', detail = '', tone = 'ok', meta = '' } = {}) {
  const host = $(hostSelector);
  if (!host) return;
  host.className = `panel-live-status is-${tone}`;
  host.innerHTML = `<i class="fa-solid ${escapeHtml(icon)}"></i><span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(detail)}</small></span>${meta ? `<b>${escapeHtml(meta)}</b>` : ''}`;
}

function parseMoneyInput(value = '') {
  let raw = String(value || '').trim().replace(/\s+/g, '').replace(/[^0-9,.-]/g, '');
  if (!raw) return NaN;
  const negative = raw.startsWith('-');
  raw = raw.replace(/-/g, '');
  const comma = raw.lastIndexOf(',');
  const dot = raw.lastIndexOf('.');
  if (comma >= 0 && dot >= 0) {
    const decimal = comma > dot ? ',' : '.';
    const thousands = decimal === ',' ? /\./g : /,/g;
    raw = raw.replace(thousands, '').replace(decimal, '.');
  } else if (comma >= 0) {
    raw = raw.replace(/\./g, '').replace(',', '.');
  } else if ((raw.match(/\./g) || []).length > 1) {
    const last = raw.lastIndexOf('.');
    raw = `${raw.slice(0, last).replace(/\./g, '')}.${raw.slice(last + 1)}`;
  }
  const number = Number(raw);
  return Number.isFinite(number) ? (negative ? -number : number) : NaN;
}

function securityView(security = {}) {
  state.security = security;
  const score = Math.max(0, Math.min(100, Number(security.score || 0) || 0));
  $('#securityChipScore').textContent = `${score}/100`;
  $('#securityScore').textContent = String(score);
  $('#securityLevel').textContent = String(security.level || 'Denetleniyor').toLocaleUpperCase('tr-TR');
  $('#securityRing').style.background = `conic-gradient(var(--green) ${score}%, rgba(92,240,173,.08) 0)`;
  const checks = Array.isArray(security.checks) ? security.checks : [];
  const icons = {
    'firebase-admin': 'fa-fire-flame-curved', 'firebase-auth': 'fa-user-shield', firestore: 'fa-database',
    'admin-email': 'fa-envelope', 'admin-uid': 'fa-fingerprint', 'firebase-password': 'fa-key',
    'fourth-factor': 'fa-shield-halved', 'fifth-factor': 'fa-shield', 'totp-factor': 'fa-mobile-screen-button', 'signed-access': 'fa-signature',
    'cookie-http-only': 'fa-cookie-bite', 'cookie-secure': 'fa-lock', 'cookie-samesite': 'fa-globe',
    'strict-csp': 'fa-code', cors: 'fa-network-wired', 'rate-limit': 'fa-gauge-high',
    'app-check': 'fa-mobile-shield', 'key-vault': 'fa-vault', 'encryption-key-id': 'fa-key',
    inventory: 'fa-boxes-stacked', render: 'fa-server'
  };
  $('#securityChecks').innerHTML = checks.map((check) => `<article class="security-check${check.ok ? ' is-ready' : ''}"><i class="fa-solid ${escapeHtml(icons[check.key] || (check.ok ? 'fa-circle-check' : 'fa-triangle-exclamation'))}"></i><span><strong>${escapeHtml(check.label)}</strong><small>${check.ok ? 'Koruma denetimi başarılı · HAZIR' : 'Koruma ayarı tamamlanmalı · KRİTİK'}</small></span><b>${escapeHtml(check.earned ?? 0)}/${escapeHtml(check.weight ?? 0)}</b></article>`).join('');
}

function askReauthPassword() {
  if (state.reauthResolve) return Promise.resolve('');
  $('#reauthLayer').hidden = false;
  $('#reauthPassword').value = '';
  setTimeout(() => $('#reauthPassword').focus(), 80);
  return new Promise((resolve) => { state.reauthResolve = resolve; });
}

function closeReauth(value = '') {
  const resolve = state.reauthResolve;
  state.reauthResolve = null;
  $('#reauthLayer').hidden = true;
  $('#reauthPassword').value = '';
  resolve?.(value);
}

async function reauthenticateAdmin(password = '') {
  const value = String(password || '');
  if (!value) return false;
  try {
    await window.SHELBY_ADMIN_AUTH.reauthenticate(value);
    return true;
  } catch (error) {
    toast('error', 'Kimliğinizi doğrulayamadık', error?.message || 'Lütfen hesap şifrenizi kontrol edip yeniden deneyin.');
    return false;
  }
}

async function requestAdminReauth() {
  const password = await askReauthPassword();
  if (!password) return false;
  return reauthenticateAdmin(password);
}

async function verifySecureAction(action) {
  if (!action) return null;
  if (!(await reauthenticateAdmin(action.password))) return null;
  return { category: action.category, categoryLabel: action.categoryLabel, reasonText: action.reasonText, reason: action.reason };
}

function askSecureAction({ kicker = 'GÜVENLİ İŞLEM', title = 'İşlemi doğrula.', summary = '', categories = [], confirmLabel = 'Doğrula ve Uygula' } = {}) {
  if (state.secureActionResolve) return Promise.resolve(null);
  const safeCategories = categories.length ? categories : [{ value: 'other', label: 'Diğer' }];
  state.secureActionReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  $('#secureActionKicker').textContent = kicker;
  $('#secureActionTitle').textContent = title;
  $('#secureActionSummary').textContent = summary || 'Bu kritik işlem gerekçe ve yönetici hesap şifresiyle doğrulanacaktır.';
  $('#secureActionCategory').innerHTML = safeCategories.map((item) => `<option value="${escapeHtml(item.value)}">${escapeHtml(item.label)}</option>`).join('');
  $('#secureActionReason').value = '';
  $('#secureActionPassword').value = '';
  $('#secureActionConfirm').textContent = confirmLabel;
  $('#secureActionLayer').hidden = false;
  setTimeout(() => $('#secureActionReason').focus(), 80);
  return new Promise((resolve) => { state.secureActionResolve = resolve; });
}

function closeSecureAction(value = null) {
  const resolve = state.secureActionResolve;
  state.secureActionResolve = null;
  $('#secureActionLayer').hidden = true;
  $('#secureActionReason').value = '';
  $('#secureActionPassword').value = '';
  resolve?.(value);
  const returnFocus = state.secureActionReturnFocus;
  state.secureActionReturnFocus = null;
  if (returnFocus?.isConnected) setTimeout(() => returnFocus.focus({ preventScroll: true }), 0);
}

function secureActionResult() {
  const select = $('#secureActionCategory');
  const category = String(select.value || '').trim();
  const categoryLabel = String(select.selectedOptions?.[0]?.textContent || category || 'Diğer').trim();
  const reasonText = String($('#secureActionReason').value || '').trim();
  const password = String($('#secureActionPassword').value || '');
  if (reasonText.length < 3) {
    toast('warning', 'Lütfen işlem gerekçesini yazın', 'Güvenli işlem kaydı için en az 3 karakterlik kısa bir açıklama girin.');
    return null;
  }
  if (!password) {
    toast('warning', 'Lütfen hesap şifrenizi girin', 'Bu hassas işleme güvenle devam etmek için yönetici hesap şifrenizi doğrulayın.');
    return null;
  }
  return { category, categoryLabel, reasonText, reason: `${categoryLabel}: ${reasonText}`.slice(0, 200), password };
}

function summaryView() {
  const counts = { total: state.orders.length, awaiting_payment: 0, processing: 0, delivered: 0, telegram: 0, closed: 0 };
  state.orders.forEach((order) => {
    if (['awaiting_payment', 'payment_review'].includes(order.status)) counts.awaiting_payment += 1;
    if (['paid', 'processing', 'delivery_pending'].includes(order.status)) counts.processing += 1;
    if (order.status === 'delivered') counts.delivered += 1;
    if (order.salesChannel === 'telegram' || order.paymentMethod === 'telegram') counts.telegram += 1;
    if (['refunded', 'cancelled', 'payment_rejected'].includes(order.status)) counts.closed += 1;
  });
  Object.entries(counts).forEach(([key, value]) => { const node = $(`[data-summary="${key}"]`); if (node) node.textContent = String(value); });
}


function orderMarkup(order) {
  const status = STATUS[order.status] || STATUS.awaiting_payment;
  const transitions = Array.isArray(order.availableTransitions) && order.availableTransitions.length ? order.availableTransitions : [order.status];
  const options = transitions.map((value) => `<option value="${escapeHtml(value)}"${value === order.status ? ' selected' : ''}>${escapeHtml(STATUS[value]?.label || value)}</option>`).join('');
  const items = (order.items || []).map((item) => `<span><em><strong>${escapeHtml(item.productName)}</strong><small>${escapeHtml(String(item.platform || '').toUpperCase())} · ${escapeHtml(item.planLabel)} · Birim ${escapeHtml(formatPrice(item.unitPriceKurus))} · Adet ${escapeHtml(item.quantity)}</small></em><b>${escapeHtml(formatPrice(item.lineTotalKurus))}</b></span>`).join('');
  const locked = ['cancelled', 'refunded'].includes(order.status);
  const telegram = order.paymentMethod === 'telegram' || order.salesChannel === 'telegram';
  const deliveryAttached = Number(order.delivery?.itemCount || 0) > 0;
  const canAttachManualDelivery = telegram && !deliveryAttached && !locked
    && transitions.some((value) => ['paid', 'processing', 'delivery_pending', 'delivered'].includes(value));
  const manualDelivery = canAttachManualDelivery
    ? `<label><span>Şifreli manuel teslimat bilgisi</span><textarea data-manual-delivery maxlength="60000" placeholder="Her ürün/adet için bir satır: key veya random hesap için kullanıcı/e-posta | şifre"></textarea><small class="form-hint"><i class="fa-solid fa-shield-halved"></i>Bu alan yalnızca bu Telegram siparişine şifreli teslimat bağlar; otomatik stok kasasına eklemez.</small></label>`
    : telegram && deliveryAttached ? `<div class="form-hint"><i class="fa-solid fa-lock"></i>Manuel teslimat bu siparişe şifreli olarak bağlandı (${escapeHtml(order.delivery.itemCount)} kayıt).</div>` : '';
  const deliveryPlaceholder = telegram ? 'Müşteriye gösterilecek açıklama/not. Key veya şifreyi bu alana yazmayın.' : 'Teslimat bilgisini buraya yazmayın; sistem güvenli şekilde otomatik teslim eder.';
  const paymentLabel = order.paymentMethod === 'wallet' ? 'SHELBY STORE Bakiye' : 'Telegram';
  const salesChannelLabel = telegram ? 'Telegram · manuel teslimat' : 'Otomatik teslimat';
  return `<article class="admin-order" data-admin-order="${escapeHtml(order.id)}"><header class="admin-order__head"><div><small>OLUŞTURULDU · ${escapeHtml(formatDate(order.createdAt))}</small><strong>${escapeHtml(order.orderNumber)}</strong><em>Son güncelleme · ${escapeHtml(formatDate(order.updatedAt || order.createdAt))}</em></div><span class="order-state order-state--${escapeHtml(order.status)}"><i class="fa-solid ${status.icon}"></i>${escapeHtml(status.label)}</span></header><div class="admin-order__meta"><span><small>KULLANICI</small><strong>${escapeHtml(order.username || '—')}</strong></span><span><small>E-POSTA</small><strong title="${escapeHtml(order.email)}">${escapeHtml(order.email || '—')}</strong></span><span><small>HESAP KİMLİĞİ</small><strong title="${escapeHtml(order.uid)}">…${escapeHtml(String(order.uid || '').slice(-10))}</strong></span><span><small>ÖDEME</small><strong>${escapeHtml(paymentLabel)}</strong></span><span><small>SATIŞ KANALI</small><strong>${escapeHtml(salesChannelLabel)}</strong></span><span><small>TESLİMAT</small><strong>${escapeHtml(order.delivery?.status || (telegram ? 'bekliyor' : 'otomatik'))}</strong></span></div><div class="admin-order__items">${items || '<span><em>Ürün bilgisi bulunamadı</em><b>—</b></span>'}</div><div class="admin-order__total"><span>Sipariş toplamı</span><strong>${escapeHtml(formatPrice(order.totalKurus))}</strong></div><div class="admin-order__editor"><label><span>Yeni durum</span><select data-order-status ${locked ? 'disabled' : permissionDisabled('store.orders.write')}>${options}</select></label>${manualDelivery}<label><span>Kullanıcıya teslimat notu</span><textarea data-delivery-message maxlength="500" placeholder="${escapeHtml(deliveryPlaceholder)}" ${locked ? 'disabled' : ''}>${escapeHtml(order.delivery?.message || '')}</textarea></label><button class="primary-action" type="button" data-save-order="${escapeHtml(order.id)}" ${locked || state.busyOrder === order.id ? 'disabled' : permissionDisabled('store.orders.write')}><i class="fa-solid ${state.busyOrder === order.id ? 'fa-spinner fa-spin' : 'fa-lock'}"></i>${state.busyOrder === order.id ? 'Güncelleniyor' : ['awaiting_payment', 'payment_review'].includes(order.status) ? 'Ödemeyi Onayla / Güncelle' : 'Güvenli Şekilde Güncelle'}</button></div></article>`;
}

function visibleOrders() {
  const query = state.query.toLocaleLowerCase('tr-TR');
  return state.orders.filter((order) => (state.filter === 'all' || order.status === state.filter) && (!query || [order.orderNumber, order.email, order.username, order.uid].some((value) => String(value || '').toLocaleLowerCase('tr-TR').includes(query))));
}

function renderOrders() {
  summaryView();
  const orders = visibleOrders();
  $('#adminOrderList').innerHTML = orders.length ? orders.map(orderMarkup).join('') : emptyMarkup('Eşleşen sipariş yok', 'Filtreleri temizleyin veya yeni sipariş oluşmasını bekleyin.');
  const more = $('#adminLoadMoreOrders');
  if (more) {
    more.hidden = !state.orderNextCursor;
    more.disabled = state.orderPageLoading;
  }
}

let orderLoadSequence = 0;
async function loadOrders({ silent = false } = {}) {
  const sequence = ++orderLoadSequence;
  if (!silent) $('#adminOrderList').innerHTML = loadingMarkup('Siparişler yükleniyor');
  renderLiveStatus('#ordersLiveMeta', { icon: 'fa-spinner fa-spin', title: 'Siparişler yenileniyor', detail: 'Güncel sipariş kayıtları güvenli biçimde hazırlanıyor.', tone: 'checking' });
  const filter = state.filter !== 'all' ? `&status=${encodeURIComponent(state.filter)}` : '';
  const payload = await adminFetch(`/api/admin/store/orders?limit=100${filter}`, { timeoutMs: 30_000 });
  if (sequence !== orderLoadSequence) return;
  state.orders = Array.isArray(payload.orders) ? payload.orders : [];
  state.orderNextCursor = String(payload.nextCursor || '');
  state.loaded.add('orders');
  const newest = state.orders.reduce((max, order) => Math.max(max, Number(order.createdAt || 0)), 0);
  renderLiveStatus('#ordersLiveMeta', { icon: 'fa-database', title: 'Güncel sipariş kayıtları', detail: state.orders.length ? `${state.orders.length} kayıt yüklendi · Son sipariş ${formatDate(newest)}` : 'Henüz sipariş kaydı bulunmuyor.', tone: 'ok', meta: 'CANLI' });
  renderOrders();
}

async function loadMoreAdminOrders() {
  if (!state.orderNextCursor || state.orderPageLoading) return;
  const button = $('#adminLoadMoreOrders');
  const sequence = orderLoadSequence;
  state.orderPageLoading = true;
  if (button) button.disabled = true;
  try {
    const filter = state.filter !== 'all' ? `&status=${encodeURIComponent(state.filter)}` : '';
    const payload = await adminFetch(`/api/admin/store/orders?limit=100${filter}&cursor=${encodeURIComponent(state.orderNextCursor)}`, { timeoutMs: 30_000 });
    if (sequence !== orderLoadSequence) return;
    const existing = new Set(state.orders.map((order) => order.id));
    state.orders.push(...(Array.isArray(payload.orders) ? payload.orders : []).filter((order) => !existing.has(order.id)));
    state.orderNextCursor = String(payload.nextCursor || '');
    renderLiveStatus('#ordersLiveMeta', { icon: 'fa-database', title: 'Sayfalanan sipariş kayıtları', detail: `${state.orders.length} kayıt güvenli sırayla yüklendi.`, tone: 'ok', meta: state.orderNextCursor ? 'DAHA FAZLA' : 'TAMAMLANDI' });
  } catch (error) {
    toast('error', 'Önceki siparişler yüklenemedi', error.message);
  } finally {
    state.orderPageLoading = false;
    renderOrders();
  }
}

async function updateOrder(orderId, card) {
  if (!requirePermission('store.orders.write', 'Sipariş güncelleme')) return;
  if (!orderId || state.busyOrder) return;
  const status = $('[data-order-status]', card)?.value;
  let cancellationReason = '';
  let refundReason = '';
  if (status === 'cancelled' || status === 'refunded') {
    const isRefund = status === 'refunded';
    const action = await askSecureAction({
      kicker: isRefund ? 'İADE ONAYI' : 'SİPARİŞ İPTALİ',
      title: isRefund ? 'İade işlemini doğrula.' : 'Sipariş iptalini doğrula.',
      summary: `${orderId} numaralı kayıt için gerekçe denetim kaydına yazılacak ve işlem owner parolasıyla doğrulanacaktır.`,
      categories: isRefund
        ? [{ value: 'customer', label: 'Müşteri talebi' }, { value: 'payment', label: 'Ödeme düzeltmesi' }, { value: 'delivery', label: 'Teslimat sorunu' }, { value: 'security', label: 'Güvenlik' }, { value: 'other', label: 'Diğer' }]
        : [{ value: 'customer', label: 'Müşteri talebi' }, { value: 'payment', label: 'Ödeme sorunu' }, { value: 'stock', label: 'Stok / teslimat' }, { value: 'security', label: 'Güvenlik' }, { value: 'other', label: 'Diğer' }],
      confirmLabel: isRefund ? 'İadeyi Doğrula ve Uygula' : 'İptali Doğrula ve Uygula'
    });
    const verifiedAction = await verifySecureAction(action);
    if (!verifiedAction) return;
    if (isRefund) refundReason = verifiedAction.reason;
    else cancellationReason = verifiedAction.reason;
  } else if (!(await requestAdminReauth())) {
    return;
  }
  state.busyOrder = orderId;
  renderOrders();
  try {
    const payload = await adminFetch(`/api/admin/store/orders/${encodeURIComponent(orderId)}`, { method: 'PATCH', timeoutMs: 45_000, body: { status, cancellationReason, refundReason, deliveryMessage: $('[data-delivery-message]', card)?.value, manualDeliveryText: $('[data-manual-delivery]', card)?.value || '' } });
    state.orders = state.orders.map((order) => order.id === orderId ? payload.order : order);
    state.loaded.delete('overview');
    toast(
      'success',
      payload.order.status === 'delivered' ? 'Teslimat başarıyla tamamlandı' : 'Sipariş başarıyla güncellendi',
      payload.order.status === 'delivered'
        ? (payload.order.salesChannel === 'telegram' ? 'Siparişe ait korumalı teslimat bilgileri kullanıcı hesabına eklendi.' : 'Ödeme onaylandı ve dijital ürün kullanıcı hesabına otomatik olarak teslim edildi.')
        : `${payload.order.orderNumber} numaralı sipariş güvenle kaydedildi.`
    );
  } catch (error) { toast('error', 'Siparişi güncelleyemedik', error.message); }
  finally { state.busyOrder = ''; renderOrders(); }
}

function metricCard(icon, label, value, tone = '') {
  return `<article class="metric-card ${tone ? `is-${tone}` : ''}"><i class="fa-solid ${icon}"></i><span><small>${escapeHtml(label)}</small><strong>${escapeHtml(value)}</strong></span></article>`;
}

function overviewBarChart(rows = [], { currency = false, title = '' } = {}) {
  const data = rows.map(([label, raw, color]) => ({
    label: String(label || ''), value: Math.max(0, Number(raw) || 0), color: String(color || '#ff6672')
  }));
  const maximum = Math.max(1, ...data.map((row) => row.value));
  const height = 18 + data.length * 46;
  const compact = (amount) => currency
    ? `${new Intl.NumberFormat('tr-TR', { notation: 'compact', maximumFractionDigits: 1 }).format(amount / 100)} ₺`
    : new Intl.NumberFormat('tr-TR').format(amount);
  const bars = data.map((row, index) => {
    const top = 12 + index * 46;
    const width = row.value > 0 ? Math.max(5, Math.round(row.value / maximum * 272)) : 0;
    return `<g><text x="0" y="${top}" class="overview-chart__label">${escapeHtml(row.label)}</text><text x="320" y="${top}" text-anchor="end" class="overview-chart__value">${escapeHtml(compact(row.value))}</text><rect x="0" y="${top + 8}" width="320" height="9" rx="4.5" class="overview-chart__track"></rect><rect x="0" y="${top + 8}" width="${width}" height="9" rx="4.5" fill="${escapeHtml(row.color)}"></rect></g>`;
  }).join('');
  return `<svg viewBox="0 0 320 ${height}" role="img" aria-label="${escapeHtml(title)}" preserveAspectRatio="xMidYMid meet"><title>${escapeHtml(title)}</title>${bars}</svg>`;
}

async function loadOverview() {
  $('#overviewMetrics').innerHTML = loadingMarkup('Yönetim özeti hazırlanıyor');
  const sections = [
    ['#overviewFinanceChart', 'store.wallet.read'],
    ['#overviewOperationsChart', 'store.orders.read'],
    ['#overviewStock', 'store.inventory.read'],
    ['#overviewSystem', 'store.security.read']
  ];
  sections.forEach(([id, permission]) => { $(id).closest('.admin-card').hidden = !hasPermission(permission); });
  renderLiveStatus('#overviewLiveMeta', { icon: 'fa-spinner fa-spin', title: 'Güncel kayıtlar hazırlanıyor', detail: 'Rolünüze açık sipariş, stok ve hesap bilgileri okunuyor.', tone: 'checking' });
  const payload = await adminFetch('/api/admin/store/overview', { timeoutMs: 45_000 });
  const overview = payload.overview || {};
  state.overview = overview;
  state.usersSummary = overview.users || null;
  state.loaded.add('overview');
  const m = overview.metrics || {};
  const specs = [
    ['orders', 'TOPLAM SİPARİŞ', 'fa-box', ''],
    ['todayOrders', 'BUGÜNKÜ SİPARİŞ', 'fa-calendar-day', 'cyan'],
    ['grossRevenueKurus', 'BRÜT SATIŞ', 'fa-chart-line', ''],
    ['netRevenueKurus', 'NET SATIŞ', 'fa-coins', 'green'],
    ['refundedKurus', 'İADE TUTARI', 'fa-rotate-left', 'yellow'],
    ['awaitingPayment', 'ÖDEME BEKLİYOR', 'fa-clock', 'yellow'],
    ['processing', 'HAZIRLANIYOR', 'fa-gears', 'cyan'],
    ['delivered', 'TESLİM EDİLDİ', 'fa-box-open', 'green'],
    ['cancelled', 'İPTAL', 'fa-ban', ''],
    ['refunded', 'İADE', 'fa-rotate-left', ''],
    ['telegramOrders', 'TELEGRAM SİPARİŞ', 'fa-paper-plane', ''],
    ['automaticOrders', 'OTOMATİK SİPARİŞ', 'fa-bolt', 'cyan'],
    ['users', 'TOPLAM KULLANICI', 'fa-users', ''],
    ['activeUsers', 'AKTİF KULLANICI', 'fa-user-check', 'green'],
    ['purchaseBlockedUsers', 'ALIŞVERİŞ ENGELLİ', 'fa-user-slash', 'yellow'],
    ['suspendedUsers', 'ASKIDAKİ HESAP', 'fa-user-clock', 'yellow'],
    ['disabledUsers', 'DEVRE DIŞI HESAP', 'fa-user-xmark', ''],
    ['walletLiabilityKurus', 'BAKİYE YÜKÜMLÜLÜĞÜ', 'fa-wallet', ''],
    ['availableStock', 'KULLANILABİLİR STOK', 'fa-cubes', 'cyan'],
    ['lowStockSkus', 'DÜŞÜK STOK', 'fa-triangle-exclamation', 'yellow'],
    ['activeProducts', 'AKTİF ÜRÜN', 'fa-tags', 'green'],
    ['inactiveProducts', 'PASİF ÜRÜN', 'fa-toggle-off', ''],
    ['archivedProducts', 'ARŞİV ÜRÜN', 'fa-box-archive', ''],
    ['paymentRejected', 'ÖDEME REDDİ', 'fa-ban', ''],
    ['deliveryFailures', 'TESLİMAT HATASI', 'fa-circle-exclamation', 'red']
  ];
  const partialOrders = m.ordersComplete === false;
  $('#overviewMetrics').innerHTML = specs.filter(([key]) => Object.hasOwn(m, key)).map(([key, label, icon, tone]) => {
    const sampled = partialOrders && !['orders', 'walletLiabilityKurus', 'users', 'activeUsers', 'purchaseBlockedUsers', 'suspendedUsers', 'disabledUsers', 'availableStock', 'lowStockSkus', 'activeProducts', 'inactiveProducts', 'archivedProducts'].includes(key);
    return metricCard(icon, sampled ? label + ' · SON ' + m.ordersAnalyzed : label, key.endsWith('Kurus') ? formatPrice(m[key]) : m[key] || 0, tone);
  }).join('');
  $('#overviewFinanceChart').innerHTML = overviewBarChart([
    ['Brüt satış', m.grossRevenueKurus, '#ff6573'],
    ['Net satış', m.netRevenueKurus, '#70efb5'],
    ['İade tutarı', m.refundedKurus, '#ffd36e'],
    ['Bakiye yükümlülüğü', m.walletLiabilityKurus, '#72caff']
  ].filter((row) => Number.isFinite(row[1])), { currency: true, title: partialOrders ? 'Son yüklenen siparişlerin finansal özeti' : 'Satış ve bakiye özeti' });
  $('#overviewOperationsChart').innerHTML = overviewBarChart([
    ['Ödeme bekliyor', m.awaitingPayment, '#ffd36e'],
    ['Hazırlanıyor', m.processing, '#72caff'],
    ['Teslim edildi', m.delivered, '#70efb5'],
    ['Düşük stok', m.lowStockSkus, '#ff6573']
  ].filter((row) => Number.isFinite(row[1])), { title: 'Sipariş ve stok özeti' });
  const stock = Array.isArray(overview.stock) ? overview.stock : [];
  $('#overviewStock').innerHTML = stock.length ? stock.map((row) => '<div><span><strong>' + escapeHtml(row.productName) + ' · ' + escapeHtml(row.planLabel) + '</strong><small>' + escapeHtml(row.duration) + ' · Rezerve ' + escapeHtml(row.reserved || 0) + ' · Teslim ' + escapeHtml(row.delivered || 0) + '</small></span><b class="stock-count ' + (row.available < 1 ? 'is-empty' : row.available <= 3 ? 'is-low' : '') + '">' + escapeHtml(row.available) + '</b></div>').join('') : emptyMarkup('Otomatik stok kaydı yok', 'Telegram ürünleri otomatik stok toplamına dahil değildir.', 'fa-vault');
  const system = overview.system || {};
  const checks = [
    ['Hesap doğrulama', system.firebaseAuth, 'fa-user-shield'],
    ['Veri bağlantısı yapılandırması', system.firestore, 'fa-database'],
    ['Mağaza ayarları', system.configurationReady, 'fa-sliders'],
    ['Şifreli stok kasası', system.keyVault, 'fa-vault'],
    ['Otomatik teslimat', system.automaticDelivery, 'fa-bolt'],
    ['Telegram sipariş', system.telegram, 'fa-paper-plane'],
    ['Zorunlu uygulama doğrulaması', system.appCheckConfigured && system.appCheckMode === 'enforce', 'fa-shield']
  ];
  $('#overviewSystem').innerHTML = checks.map(([label, ok, icon]) => '<article><i class="fa-solid ' + icon + '"></i><span><strong>' + escapeHtml(label) + '</strong><small>' + (ok ? 'Yapılandırma hazır' : 'Kontrol edilmeli') + '</small></span></article>').join('');
  $('#sidebarServiceText').textContent = overview.system ? (system.configurationReady ? 'Mağaza ayarları hazır' : 'Yapılandırmayı kontrol edin') : 'Rolünüze uygun erişim';
  const sampleNotice = partialOrders ? ' · Satış ve durum toplamları son ' + m.ordersAnalyzed + ' siparişle sınırlı.' : '';
  renderLiveStatus('#overviewLiveMeta', { icon: 'fa-clock', title: 'Yönetim özeti', detail: 'Son güncelleme: ' + formatDate(overview.generatedAt) + sampleNotice, tone: partialOrders ? 'warning' : 'ok', meta: partialOrders ? 'KISMİ VERİ' : 'GÜNCEL' });
}


async function ensureCatalog(force = false) {
  if (state.catalog && !force) return state.catalog;
  const payload = await adminFetch('/api/admin/store/catalog');
  state.catalog = payload.catalog || { products: [] };
  return state.catalog;
}

function inventorySelectorProducts() {
  const groups = new Map();
  for (const product of state.catalog?.products || []) {
    if (product.fulfillmentMode === 'telegram_only') continue;
    const poolId = String(product.inventoryPoolId || product.id || '').trim().toLowerCase();
    if (!groups.has(poolId)) groups.set(poolId, product);
  }
  return [...groups.entries()].map(([poolId, product]) => ({
    product,
    poolId,
    shared: !!product.inventoryPoolId,
    label: poolId === 'random-30sv-shared'
      ? 'RANDOM HESAP · Android + iOS Ortak Havuz'
      : `${product.name} · ${String(product.platform || '').toUpperCase()}`
  }));
}

function populateInventorySelectors() {
  const productSelect = $('#inventoryProduct');
  const current = productSelect.value;
  const options = inventorySelectorProducts();
  productSelect.innerHTML = options.map(({ product, poolId, shared, label }) => `<option value="${escapeHtml(product.id)}" data-inventory-pool="${escapeHtml(poolId)}" data-shared-pool="${shared ? '1' : '0'}">${escapeHtml(label)}</option>`).join('');
  if ([...productSelect.options].some((option) => option.value === current)) productSelect.value = current;
  populateInventoryPlans();
  renderInventoryMode();
}

function populateInventoryPlans() {
  const product = (state.catalog?.products || []).find((item) => item.id === $('#inventoryProduct').value) || state.catalog?.products?.[0];
  const select = $('#inventoryPlan');
  const current = select.value;
  select.innerHTML = (product?.plans || []).map((plan) => `<option value="${escapeHtml(plan.key)}">${escapeHtml(plan.label)} · ${escapeHtml(plan.duration)}</option>`).join('');
  if ([...select.options].some((option) => option.value === current)) select.value = current;
}

function selectedInventoryProduct() {
  return (state.catalog?.products || []).find((item) => item.id === $('#inventoryProduct').value) || null;
}

function selectedInventoryType() {
  return selectedInventoryProduct()?.inventoryType === 'account' ? 'account' : 'license';
}

function splitAccountLine(value = '') {
  const source = String(value || '').normalize('NFKC').trim();
  const separators = ['\t', '|', ';', ',', ':'];
  const candidate = separators.map((separator) => ({ separator, index: source.indexOf(separator) }))
    .filter(({ index }) => index > 0).sort((left, right) => left.index - right.index)[0];
  if (!candidate) return null;
  const username = source.slice(0, candidate.index).trim();
  const password = source.slice(candidate.index + candidate.separator.length).trim();
  return username.length >= 3 && username.length <= 160 && password.length >= 6 && password.length <= 256
    ? { username, password }
    : null;
}

function parseInventoryInput() {
  const inventoryType = selectedInventoryType();
  const values = String($('#inventoryKeys')?.value || '').split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  const errors = [];
  if (!values.length) errors.push(inventoryType === 'account' ? 'En az bir kullanıcı ve şifre girin.' : 'En az bir key girin.');
  if (values.length > 200) errors.push('Tek işlemde en fazla 200 kayıt eklenebilir.');
  const normalized = values.map((value) => value.normalize('NFKC'));
  const duplicateCount = normalized.length - new Set(normalized).size;
  if (duplicateCount) errors.push(`Listede ${duplicateCount} mükerrer kayıt var.`);
  if (inventoryType === 'account') {
    const invalid = values.reduce((count, value) => count + (splitAccountLine(value) ? 0 : 1), 0);
    if (invalid) errors.push(`${invalid} satır “kullanıcı | şifre” biçimine uymuyor.`);
  }
  return { inventoryType, values, errors, duplicateCount, valid: !errors.length };
}

function renderInventoryParsePreview() {
  const host = $('#inventoryParsePreview');
  if (!host) return;
  const parsed = parseInventoryInput();
  const typeLabel = parsed.inventoryType === 'account' ? 'hesap' : 'key';
  if (!parsed.values.length) {
    host.className = 'inventory-parse-preview';
    host.innerHTML = `<i class="fa-solid fa-list-check"></i><span>Listeyi yapıştırdığınızda biçim ve mükerrer kayıtlar eklemeden önce denetlenir.</span>`;
    return;
  }
  host.className = `inventory-parse-preview ${parsed.valid ? 'is-valid' : 'is-error'}`;
  host.innerHTML = `<i class="fa-solid ${parsed.valid ? 'fa-circle-check' : 'fa-triangle-exclamation'}"></i><span><strong>${escapeHtml(parsed.values.length)} ${typeLabel} algılandı</strong><small>${escapeHtml(parsed.valid ? 'Liste eklenmeye hazır.' : parsed.errors.join(' '))}</small></span>`;
}

function renderInventoryMode({ resetAttempt = true } = {}) {
  const account = selectedInventoryType() === 'account';
  if (resetAttempt) state.inventoryImportAttempt = null;
  $('#inventoryImportTitle').textContent = account ? 'Toplu random hesap ekle' : 'Toplu key ekle';
  $('#inventoryImportIcon').className = `fa-solid ${account ? 'fa-user-lock' : 'fa-key'}`;
  $('#inventoryInputLabel').textContent = account ? 'Hesap listesi · her satıra kullanıcı | şifre' : 'Key listesi · her satıra bir key';
  $('#inventoryKeys').placeholder = account ? 'oyuncu01 | GuvenliSifre01\noyuncu02 | GuvenliSifre02' : 'ABCD-EFGH-IJKL\nMNOP-QRST-UVWX';
  $('#inventoryFormatHint').innerHTML = account
    ? '<i class="fa-solid fa-shield-halved"></i> Kullanıcı adı ve şifre birlikte şifrelenir; liste ve stok ekranında yalnızca maskeli hesap görünür.'
    : '<i class="fa-solid fa-shield-halved"></i> Key’ler düz metin saklanmaz; ekranda yalnızca maskeli biçimde görünür.';
  $('#inventoryImportButton span').textContent = account ? 'Parolayla Hesapları Şifrele ve Ekle' : 'Parolayla Keyleri Şifrele ve Ekle';
  const product = selectedInventoryProduct();
  const sharedPool = !!product?.inventoryPoolId;
  const poolHint = $('#inventoryPoolHint');
  poolHint.hidden = !sharedPool;
  if (sharedPool) poolHint.innerHTML = '<i class="fa-solid fa-code-merge"></i> Android ve iOS Random Hesap kayıtları tek ortak stok havuzudur. Bir platformdan yapılan satış her iki platformdaki ortak adedi aynı anda azaltır.';
  const migrationButton = $('#inventoryMigrateShared');
  if (migrationButton) migrationButton.hidden = !sharedPool;
  renderInventoryParsePreview();
  renderInventoryReadiness();
}

function renderInventoryReadiness(readiness = state.inventoryReadiness) {
  const host = $('#inventoryReadiness');
  if (!host) return;
  const button = $('#inventoryImportButton');
  const textarea = $('#inventoryKeys');
  if (!readiness) {
    host.className = 'inventory-readiness is-checking';
    host.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i><span><strong>Stok kasası denetleniyor</strong><small>Şifreleme ve mükerrer kayıt koruması kontrol ediliyor.</small></span>';
    if (button) button.disabled = true;
    if (textarea) textarea.disabled = true;
    return;
  }
  const labels = {
    FIREBASE_KEY: 'güvenli mağaza bağlantısı',
    STORE_KEY_ENCRYPTION_SECRET: 'stok şifreleme ayarı',
    STORE_KEY_FINGERPRINT_SECRET: 'mükerrer kayıt koruması',
    STORE_KEY_SECRETS_MUST_DIFFER: 'stok güvenlik anahtarları birbirinden farklı olmalı'
  };
  const blockers = Array.isArray(readiness.blockers) ? readiness.blockers.map((item) => labels[item] || item) : [];
  host.className = `inventory-readiness ${readiness.ready ? 'is-ready' : 'is-blocked'}`;
  host.innerHTML = readiness.ready
    ? `<i class="fa-solid fa-shield-circle-check"></i><span><strong>Şifreli stok kasası hazır</strong><small>Güvenli bağlantı hazır · şifreleme ve mükerrer kayıt koruması aktif · en fazla ${escapeHtml(readiness.maxBatchSize || 200)} kayıt/işlem</small></span><b>HAZIR</b>`
    : `<i class="fa-solid fa-triangle-exclamation"></i><span><strong>Stok ekleme güvenlik nedeniyle kapalı</strong><small>Mağaza güvenlik ayarlarında kontrol edin: ${escapeHtml(blockers.join(', ') || 'kritik yapılandırma')}</small></span><b>KONTROL</b>`;
  const disabled = !readiness.ready || state.inventoryImportBusy || !hasPermission('store.inventory.write');
  if (button) button.disabled = disabled;
  if (textarea) textarea.disabled = !readiness.ready || state.inventoryImportBusy || !hasPermission('store.inventory.write');
}

function renderInventorySummary() {
  const rows = state.inventory;
  $('#inventorySummary').innerHTML = rows.length ? rows.map((row) => `<button type="button" data-stock-select="${escapeHtml(row.productId)}:${escapeHtml(row.planKey)}"><span><strong>${escapeHtml(row.productName)} · ${escapeHtml(row.planLabel)}</strong><small>${escapeHtml(row.platformLabel || String(row.platform || '').toUpperCase())} · ${row.inventoryType === 'account' ? 'Random hesap' : 'Lisans key'} · Rezerve ${escapeHtml(row.reserved || 0)} · Teslim ${escapeHtml(row.delivered || 0)} · İptal ${escapeHtml(row.revoked || 0)} · Toplam ${escapeHtml(row.total || 0)}</small><em>Son ekleme: ${escapeHtml(formatDate(row.lastImportAt))} · Son teslimat: ${escapeHtml(formatDate(row.lastDeliveryAt))}</em></span><b class="stock-count ${row.available < 1 ? 'is-empty' : row.available <= 3 ? 'is-low' : ''}">${escapeHtml(row.available)}</b></button>`).join('') : emptyMarkup('Stok kaydı yok', 'İlk key veya random hesap grubunu güvenli kasaya ekleyin.', 'fa-vault');
}

async function loadInventory() {
  $('#inventorySummary').innerHTML = loadingMarkup('Stoklar yükleniyor');
  state.inventoryReadiness = null;
  renderInventoryReadiness();
  const [catalogResult, readinessResult, summaryResult] = await Promise.allSettled([
    adminFetch('/api/admin/store/catalog?stock=0'),
    adminFetch('/api/admin/store/inventory-readiness'),
    adminFetch('/api/admin/store/inventory-summary', { timeoutMs: 30_000 })
  ]);
  if (catalogResult.status === 'rejected') throw catalogResult.reason;
  state.catalog = catalogResult.value.catalog || { products: [] };
  state.inventoryReadiness = readinessResult.status === 'fulfilled'
    ? (readinessResult.value.readiness || { ready: false, blockers: [] })
    : { ready: false, blockers: [] };
  state.inventory = summaryResult.status === 'fulfilled' && Array.isArray(summaryResult.value.inventory)
    ? summaryResult.value.inventory
    : [];
  if (summaryResult.status === 'fulfilled') state.loaded.add('inventory');
  populateInventorySelectors();
  renderInventoryReadiness();
  if (summaryResult.status === 'fulfilled') {
    renderInventorySummary();
    const totals = state.inventory.reduce((acc, row) => { acc.available += Number(row.available || 0); acc.reserved += Number(row.reserved || 0); acc.delivered += Number(row.delivered || 0); acc.revoked += Number(row.revoked || 0); acc.total += Number(row.total || 0); if (Number(row.available || 0) <= 3) acc.low += 1; return acc; }, { available: 0, reserved: 0, delivered: 0, revoked: 0, total: 0, low: 0 });
    renderLiveStatus('#inventoryMetrics', { icon: 'fa-vault', title: `${totals.available} kullanılabilir şifreli stok`, detail: `${state.inventory.length} SKU/havuz · ${totals.total} toplam · ${totals.reserved} rezerve · ${totals.delivered} teslim · ${totals.revoked} iptal · ${totals.low} düşük stok`, tone: state.inventoryReadiness?.ready ? 'ok' : 'warning', meta: state.inventoryReadiness?.ready ? 'KASA HAZIR' : 'KONTROL' });
  } else {
    $('#inventorySummary').innerHTML = failureMarkup('Stok özeti yüklenemedi', summaryResult.reason, 'inventory');
    renderLiveStatus('#inventoryMetrics', { icon: 'fa-triangle-exclamation', title: 'Stok özeti okunamadı', detail: summaryResult.reason?.message || 'Lütfen kısa bir süre sonra yeniden deneyin.', tone: 'error', meta: 'HATA' });
  }
}

async function importInventory(event) {
  event.preventDefault();
  if (!requirePermission('store.inventory.write', 'Stok ekleme')) return;
  if (state.inventoryImportBusy) return;
  const parsed = parseInventoryInput();
  if (!state.inventoryReadiness?.ready) return toast('warning', 'Stok kasası henüz hazır değil', 'Lütfen koruma ayarlarını tamamladıktan sonra yeniden deneyin.');
  if (!parsed.valid) return toast('warning', 'Stok listesini kontrol edin', parsed.errors.join(' '));
  const productId = $('#inventoryProduct').value;
  const planKey = $('#inventoryPlan').value;
  const signature = JSON.stringify([productId, planKey, parsed.values]);
  if (!state.inventoryImportAttempt || state.inventoryImportAttempt.signature !== signature) {
    state.inventoryImportAttempt = { signature, idempotencyKey: requestKey('inventory') };
  }

  if (!(await requestAdminReauth())) return;
  try {
    const check = await adminFetch('/api/admin/store/inventory/import-check', {
      method: 'POST', timeoutMs: 30_000, body: { productId, planKey, keys: parsed.values }
    });
    const duplicateResult = check.result || {};
    if (duplicateResult.requiresConfirmation) {
      const duplicates = Array.isArray(duplicateResult.duplicates) ? duplicateResult.duplicates : [];
      const manual = duplicates.some((entry) => entry.source === 'telegram-manual');
      const preview = duplicates.slice(0, 4).map((entry) => entry.masked).join(' · ');
      const reason = manual
        ? 'Bu teslimat bilgisi daha önce manuel bir siparişte kullanılmış.'
        : 'Bu key veya hesap daha önce otomatik stok kasasına eklenmiş.';
      return toast('warning', 'Bu stok daha önce kaydedilmiş', `${reason} Aynı kayıt ikinci kez satışa açılamaz.${preview ? ` Eşleşen kayıt: ${preview}` : ''}`);
    }
  } catch (error) {
    return toast('error', 'Stok listesini doğrulayamadık', error.message);
  }

  const button = $('#inventoryImportButton');
  const buttonText = $('span', button);
  const originalText = buttonText.textContent;
  state.inventoryImportBusy = true;
  renderInventoryReadiness();
  buttonText.textContent = `${parsed.values.length} kayıt güvenli kasaya ekleniyor`;
  $('i', button).className = 'fa-solid fa-spinner fa-spin';
  try {
    const payload = await adminFetch('/api/admin/store/inventory/import', {
      method: 'POST', timeoutMs: 60_000,
      headers: { 'X-Idempotency-Key': state.inventoryImportAttempt.idempotencyKey },
      body: {
        productId, planKey, keys: parsed.values,
        idempotencyKey: state.inventoryImportAttempt.idempotencyKey
      }
    });
    $('#inventoryKeys').value = '';
    const noun = parsed.inventoryType === 'account' ? 'random hesap' : 'key';
    const reentry = Number(payload.result.duplicateReentries || 0);
    const replaced = Number(payload.result.replacedActiveDuplicates || 0);
    const detail = reentry
      ? `${payload.result.imported} ${noun} onaylı olarak yeniden eklendi. ${replaced ? `${replaced} eski aktif kopya güvenli biçimde satıştan kaldırıldı. ` : ''}Kullanılabilir stok: ${payload.result.available}.`
      : `${payload.result.imported} benzersiz ${noun} şifrelenerek kaydedildi. Kullanılabilir stok: ${payload.result.available}.`;
    toast('success', payload.result.idempotentReplay ? 'Stok kaydı daha önce tamamlanmış' : reentry ? 'Onaylanan stok güvenle eklendi' : 'Stok güvenli kasaya eklendi', detail);
    state.inventoryImportAttempt = null;
    state.loaded.delete('overview');
    await loadInventory();
  } catch (error) {
    if (!isUncertainMutationError(error)) state.inventoryImportAttempt = null;
    const retry = isUncertainMutationError(error) ? ' Aynı listeyle güvenle yeniden deneyebilirsiniz; tamamlanan kayıtlar ikinci kez oluşturulmaz.' : '';
    toast('error', 'Stok kaydını tamamlayamadık', `${error.message}${retry}`);
  } finally {
    state.inventoryImportBusy = false;
    buttonText.textContent = originalText;
    $('i', button).className = 'fa-solid fa-lock';
    renderInventoryReadiness();
    renderInventoryParsePreview();
  }
}

async function inspectInventory() {
  const productId = $('#inventoryProduct').value; const planKey = $('#inventoryPlan').value;
  if (!productId || !planKey) return;
  $('#inventoryItems').innerHTML = loadingMarkup('Maskeli stok kayıtları yükleniyor');
  try {
    const payload = await adminFetch(`/api/admin/store/inventory?productId=${encodeURIComponent(productId)}&planKey=${encodeURIComponent(planKey)}&limit=200`);
    const rows = payload.inventory?.items || [];
    const account = payload.inventory?.product?.inventoryType === 'account';
    const shared = payload.inventory?.pool?.shared === true;
    $('#inventoryItems').innerHTML = rows.length ? `<table class="data-table"><thead><tr><th>${account ? 'Maskeli hesap' : 'Maskeli key'}</th>${shared ? '<th>Kaynak</th>' : ''}<th>Durum</th><th>Sipariş</th><th>Koruma</th><th>Tarih</th><th></th></tr></thead><tbody>${rows.map((row) => `<tr data-inventory-row="${escapeHtml(row.id)}" data-storage-sku="${escapeHtml(row.storageSku)}"><td><code data-secret-cell>${escapeHtml(row.masked)}</code></td>${shared ? `<td>${escapeHtml(String(row.platform || '').toUpperCase())}</td>` : ''}<td><span class="table-state is-${escapeHtml(row.status)}">${escapeHtml(row.status.toLocaleUpperCase('tr-TR'))}</span></td><td>${escapeHtml(row.orderId ? `…${row.orderId.slice(-9)}` : '—')}</td><td>${row.protectionCurrent === false ? 'Yenileme gerekli' : 'Güncel'}</td><td>${escapeHtml(formatDate(row.createdAt))}</td><td><div class="table-actions"><button type="button" class="table-action" data-reveal-stock="${escapeHtml(row.id)}" data-storage-sku="${escapeHtml(row.storageSku)}"${permissionDisabled('store.inventory.reveal')}>Görüntüle</button>${row.status === 'available' ? `<button type="button" class="table-action is-danger" data-revoke-stock="${escapeHtml(row.id)}" data-storage-sku="${escapeHtml(row.storageSku)}"${permissionDisabled('store.inventory.write')}>İptal Et</button>` : ''}</div></td></tr>`).join('')}</tbody></table>` : emptyMarkup('Kayıt bulunamadı', account ? 'Bu ortak havuz için henüz random hesap eklenmemiş.' : 'Bu paket için henüz key eklenmemiş.');
  } catch (error) { $('#inventoryItems').innerHTML = emptyMarkup('Stok kayıtları yüklenemedi', error.message, 'fa-triangle-exclamation'); }
}

async function revokeStock(itemId, storageSku = '') {
  if (!requirePermission('store.inventory.write', 'Stok iptali')) return;
  const action = await askSecureAction({
    kicker: 'STOK İPTALİ', title: 'Stok kaydını satıştan kaldır.',
    summary: 'Kayıt yeniden satılamaz duruma alınacak, ortak havuz stok sayısı güncellenecek ve işlem denetim kaydına yazılacaktır.',
    categories: [{ value: 'invalid', label: 'Geçersiz kayıt' }, { value: 'duplicate', label: 'Mükerrer kayıt' }, { value: 'risk', label: 'Riskli key / hesap' }, { value: 'correction', label: 'Operasyon düzeltmesi' }, { value: 'other', label: 'Diğer' }],
    confirmLabel: 'Stok Kaydını İptal Et'
  });
  if (!action) return;
  const verifiedAction = await verifySecureAction(action); if (!verifiedAction) return;
  try {
    await adminFetch(`/api/admin/store/inventory/${encodeURIComponent(itemId)}/revoke`, { method: 'POST', timeoutMs: 30_000, body: { productId: $('#inventoryProduct').value, planKey: $('#inventoryPlan').value, storageSku, reason: verifiedAction.reason } });
    toast('success', 'Stok kaydı iptal edildi', 'Kayıt yeniden satışa açılamaz duruma alındı ve stok sayısı güncellendi.');
    await Promise.all([loadInventory(), inspectInventory()]);
  } catch (error) { toast('error', 'Stok kaydını iptal edemedik', error.message); }
}

async function revealStock(itemId, storageSku = '') {
  if (!requirePermission('store.inventory.reveal', 'Şifreli stok görüntüleme')) return;
  const action = await askSecureAction({
    kicker: 'GİZLİ STOK ERİŞİMİ', title: 'Şifreli kaydı kontrollü görüntüle.',
    summary: 'Açık key/hesap bilgisi yalnızca bu oturumda kısa süreli gösterilir. Gerekçe, yönetici ve zaman bilgisi korumalı denetim kaydına yazılır.',
    categories: [{ value: 'support', label: 'Destek doğrulaması' }, { value: 'delivery', label: 'Teslimat incelemesi' }, { value: 'security', label: 'Güvenlik denetimi' }, { value: 'other', label: 'Diğer' }],
    confirmLabel: 'Doğrula ve Görüntüle'
  });
  if (!action) return;
  const verifiedAction = await verifySecureAction(action); if (!verifiedAction) return;
  try {
    const payload = await adminFetch(`/api/admin/store/inventory/${encodeURIComponent(itemId)}/reveal`, { method: 'POST', timeoutMs: 30_000, body: { productId: $('#inventoryProduct').value, planKey: $('#inventoryPlan').value, storageSku, reason: verifiedAction.reason } });
    const row = $$('[data-inventory-row]').find((candidate) => candidate.dataset.inventoryRow === itemId && (!storageSku || candidate.dataset.storageSku === storageSku));
    const cell = $('[data-secret-cell]', row);
    if (cell) { cell.textContent = payload.item.secret; cell.classList.add('is-revealed'); }
    toast('warning', 'Stok bilgisi geçici olarak açıldı', 'Bilgi sayfa yenilendiğinde yeniden maskelenecek ve bu görüntüleme güvenlik kaydına eklendi.');
  } catch (error) { toast('error', 'Stok bilgisini görüntüleyemedik', error.message); }
}

async function migrateSharedInventory() {
  if (!requirePermission('store.inventory.write', 'Ortak stok düzenleme')) return;
  const product = selectedInventoryProduct();
  if (!product?.inventoryPoolId) return toast('warning', 'Ortak stok havuzu seçilmemiş', 'Lütfen bu işlem için ortak stok havuzu bulunan bir ürün seçin.');
  const action = await askSecureAction({
    kicker: 'STOK MİGRASYONU', title: 'Eski Random stoklarını ortak havuzda birleştir.',
    summary: 'Yalnızca kullanılabilir eski Android/iOS Random kayıtları canonical ortak havuza taşınır. Geçmiş teslimatlar eski yollarında korunur.',
    categories: [{ value: 'shared-pool', label: 'Ortak havuz geçişi' }], confirmLabel: 'Migrasyonu Doğrula ve Başlat'
  });
  if (!action) return;
  const verifiedAction = await verifySecureAction(action); if (!verifiedAction) return;
  try {
    const payload = await adminFetch('/api/admin/store/inventory/migrate-shared-pool', { method: 'POST', timeoutMs: 90_000, body: { productId: $('#inventoryProduct').value, planKey: $('#inventoryPlan').value, limit: 400 } });
    const result = payload.result || {};
    toast(result.completed ? 'success' : 'warning', 'Ortak stok düzenlemesi tamamlandı', `${Number(result.migrated || 0)} kullanılabilir kayıt ortak havuza taşındı.${result.completed ? ' Eski kullanılabilir Random stok kalmadı.' : ' Kalan kayıtlar için işlemi yeniden çalıştırabilirsiniz.'}`);
    await Promise.all([loadInventory(), inspectInventory()]);
  } catch (error) { toast('error', 'Ortak stok düzenlemesini tamamlayamadık', error.message); }
}

async function rotateInventoryKeys() {
  if (!requirePermission('store.inventory.write', 'Şifreleme anahtarı rotasyonu')) return;
  if (!state.inventoryReadiness?.ready) return toast('warning', 'Stok kasası henüz hazır değil', 'Koruma yenilemesine başlamadan önce stok kasası ayarlarını tamamlayın.');
  const action = await askSecureAction({
    kicker: 'ANAHTAR ROTASYONU', title: 'Seçili stok havuzunu aktif şifreleme anahtarına taşı.',
    summary: `Aktif kasa sürümü: ${state.inventoryReadiness?.keyRotation?.activeKeyId || 'legacy-v1'}. Açık stok verisi yönetim ekranına taşınmadan güvenli alanda yeniden şifrelenir.`,
    categories: [{ value: 'key-rotation', label: 'Şifreleme anahtarı rotasyonu' }], confirmLabel: 'Rotasyonu Doğrula ve Başlat'
  });
  if (!action) return;
  const verifiedAction = await verifySecureAction(action); if (!verifiedAction) return;
  try {
    const payload = await adminFetch('/api/admin/store/inventory/rotate-encryption', { method: 'POST', timeoutMs: 90_000, body: { productId: $('#inventoryProduct').value, planKey: $('#inventoryPlan').value, limit: 100 } });
    const result = payload.result || {};
    toast(result.cycleComplete ? 'success' : 'warning', 'Stok koruması yenilendi', `${Number(result.scanned || 0)} kayıt denetlendi, ${Number(result.rotated || 0)} kayıt güncel koruma anahtarıyla yenilendi.${result.cycleComplete ? ' Denetim tamamlandı.' : ' Kalan kayıtlar için işlemi yeniden çalıştırabilirsiniz.'}`);
    await inspectInventory();
  } catch (error) { toast('error', 'Stok korumasını yenileyemedik', error.message); }
}


function productBadgeOptions() {
  const options = Array.isArray(state.catalog?.badgeOptions) ? state.catalog.badgeOptions : [];
  return options.filter((item) => item && /^[a-z0-9-]{1,40}$/.test(String(item.key || '')) && /^fa-[a-z0-9-]{1,60}$/.test(String(item.icon || '')));
}

function productBadgeDefinition(key = '', product = {}) {
  return productBadgeOptions().find((item) => item.key === key)
    || { key: String(product.badgeKey || 'premium'), label: String(product.badge || 'PREMIUM'), icon: String(product.badgeIcon || 'fa-gem'), tone: String(product.badgeTone || 'premium') };
}

function productBadgeField(product = {}) {
  const current = productBadgeDefinition(product.badgeKey, product);
  const options = productBadgeOptions();
  const list = options.length ? options : [current];
  const optionMarkup = list.map((option) => `<option value="${escapeHtml(option.key)}" ${option.key === current.key ? 'selected' : ''}>${escapeHtml(option.label)}</option>`).join('');
  return `<label class="product-badge-field"><span>Satış etiketi</span><div class="admin-badge-picker"><span class="admin-badge-preview is-${escapeHtml(current.tone || 'premium')}" data-product-badge-preview><i class="fa-solid ${escapeHtml(current.icon || 'fa-gem')}"></i><strong>${escapeHtml(current.label || 'PREMIUM')}</strong></span><select data-product-badge-key aria-label="Satış etiketi">${optionMarkup}</select></div><small>Etiket adı ve ikonu güvenli listeden birlikte seçilir; serbest metin kullanılmaz.</small></label>`;
}

function syncProductBadgePreview(select) {
  const form = select?.closest?.('[data-product-form]');
  const preview = form?.querySelector?.('[data-product-badge-preview]');
  if (!form || !preview) return;
  const definition = productBadgeDefinition(select.value, {});
  preview.className = `admin-badge-preview is-${String(definition.tone || 'premium').replace(/[^a-z0-9-]/g, '')}`;
  preview.innerHTML = `<i class="fa-solid ${escapeHtml(definition.icon || 'fa-gem')}"></i><strong>${escapeHtml(definition.label || 'PREMIUM')}</strong>`;
  $$('[data-product-tag]', form).forEach((input) => {
    const duplicate = input.dataset.productTag === definition.key;
    if (duplicate) input.checked = false;
    input.disabled = duplicate;
    input.closest('.mini-check')?.classList.toggle('is-disabled', duplicate);
  });
}

function productMarkup(product) {
  const telegramOnly = product.fulfillmentMode === 'telegram_only';
  const deliveryLabel = telegramOnly ? 'Otomatik teslimat kapalı' : `Otomatik stok: ${escapeHtml(product.stock?.available || 0)}`;
  const tag = (name, label) => {
    const duplicate = product.badgeKey === name;
    return `<label class="mini-check${duplicate ? ' is-disabled' : ''}"><input type="checkbox" data-product-tag="${name}" ${(product.tags || []).includes(name) && !duplicate ? 'checked' : ''} ${duplicate ? 'disabled' : ''}/><span>${label}</span></label>`;
  };
  return `<form class="product-admin-card" data-product-form="${escapeHtml(product.id)}"><header><img src="${escapeHtml(product.image)}" alt=""/><div><small>${escapeHtml(product.platform.toUpperCase())} · ${escapeHtml(product.id)}</small><h2>${escapeHtml(product.name)}</h2><p>${deliveryLabel} · Telegram ${product.telegramEnabled !== false ? 'açık' : 'kapalı'}</p></div><span class="account-state ${product.archived ? 'is-suspended' : product.active !== false ? 'is-active' : 'is-purchase_blocked'}">${product.archived ? 'ARŞİV' : product.active !== false ? 'AKTİF' : 'PASİF'}</span></header><div class="toggle-grid"><label class="toggle-row"><input type="checkbox" data-product-active ${product.active !== false ? 'checked' : ''}/><span><strong>Satışta aktif</strong><small>Kullanıcı kataloğunda satış durumunu yönetir.</small></span></label><label class="toggle-row"><input type="checkbox" data-product-archived ${product.archived ? 'checked' : ''}/><span><strong>Arşivle</strong><small>Geçmiş siparişleri silmeden ürünü vitrinden kaldırır.</small></span></label><label class="toggle-row"><input type="checkbox" data-product-automatic ${product.automaticEnabled !== false && !product.immutableFulfillment ? 'checked' : ''} ${product.immutableFulfillment ? 'disabled' : ''}/><span><strong>Otomatik teslimat</strong><small>${product.immutableFulfillment ? 'Bu ürün mağaza politikasıyla yalnızca Telegram üzerinden satılır.' : 'Şifreli stok kasasını kullanır.'}</small></span></label><label class="toggle-row"><input type="checkbox" data-product-telegram ${product.telegramEnabled !== false ? 'checked' : ''} ${product.immutableFulfillment ? 'disabled' : ''}/><span><strong>Telegram satışı</strong><small>${product.immutableFulfillment ? 'GBOX için zorunlu ve değiştirilemez.' : 'Talep üzerine Telegram siparişine izin verir.'}</small></span></label></div><div class="form-grid"><label><span>Ürün adı</span><input data-product-name maxlength="80" value="${escapeHtml(product.name || '')}"/></label><label><span>Platform</span><select data-product-platform ${product.immutablePlatform ? 'disabled' : ''}><option value="android" ${product.platform === 'android' ? 'selected' : ''}>Android</option><option value="ios" ${product.platform === 'ios' ? 'selected' : ''}>iOS</option></select></label><label><span>Kategori</span><input data-product-category maxlength="50" value="${escapeHtml(product.category || '')}"/></label>${productBadgeField(product)}<label><span>Sıralama</span><input data-product-sort type="number" min="0" max="10000" value="${escapeHtml(product.sortOrder || 500)}"/></label></div><label><span>Ürün görsel yolu</span><input data-product-image maxlength="300" value="${escapeHtml(product.image || '')}" placeholder="Katalogdaki /public/assets/products/ görsel yolu"/></label><label><span>Açıklama</span><textarea data-product-description maxlength="240" rows="3">${escapeHtml(product.description || '')}</textarea></label><div class="tag-row">${tag('new', 'Yeni')}${tag('popular', 'Çok Tercih Edilen')}${tag('discounted', 'İndirimli')}<label class="mini-check"><input type="checkbox" data-product-featured ${product.featured ? 'checked' : ''}/><span>Öne Çıkan</span></label></div><div class="plan-admin-list">${(product.plans || []).map((plan) => `<div data-plan="${escapeHtml(plan.key)}"><label class="mini-check"><input type="checkbox" data-plan-active ${plan.active !== false ? 'checked' : ''}/><span>${escapeHtml(plan.key)}</span></label><label><span>Paket adı</span><input data-plan-label maxlength="50" value="${escapeHtml(plan.label)}"/></label><label><span>Süre</span><input data-plan-duration maxlength="50" value="${escapeHtml(plan.duration)}"/></label><label><span>Fiyat (₺)</span><input data-plan-price type="text" inputmode="decimal" value="${escapeHtml((plan.priceKurus / 100).toFixed(2).replace('.', ','))}"/></label><b>${telegramOnly ? 'Yalnızca Telegram' : `Stok ${escapeHtml(plan.stock?.available || 0)}`}</b></div>`).join('')}</div><div class="product-admin-card__save-hint"><i class="fa-solid fa-layer-group"></i><span>Bu karttaki değişiklikler üstteki <strong>Toplu Kayıt</strong> ile diğer ürünlerle birlikte kaydedilir.</span></div></form>`;
}

function productFormBody(form) {
  const productId = String(form?.dataset?.productForm || 'ürün');
  const plans = {};
  $$('[data-plan]', form).forEach((row) => {
    const rawPrice = parseMoneyInput($('[data-plan-price]', row).value || '');
    if (!Number.isFinite(rawPrice) || rawPrice <= 0 || rawPrice > 1_000_000) {
      throw new Error(`${productId} · ${row.dataset.plan} paket fiyatı geçersiz.`);
    }
    plans[row.dataset.plan] = {
      active: $('[data-plan-active]', row).checked,
      label: $('[data-plan-label]', row).value,
      duration: $('[data-plan-duration]', row).value,
      priceKurus: Math.round(rawPrice * 100)
    };
  });
  const sortOrder = Number($('[data-product-sort]', form).value);
  if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 10_000) throw new Error(`${productId} sıralama değeri 0-10000 arasında tam sayı olmalıdır.`);
  return {
    active: $('[data-product-active]', form).checked,
    archived: $('[data-product-archived]', form).checked,
    automaticEnabled: $('[data-product-automatic]', form).checked,
    telegramEnabled: $('[data-product-telegram]', form).checked,
    name: $('[data-product-name]', form).value,
    platform: $('[data-product-platform]', form).value,
    category: $('[data-product-category]', form).value,
    featured: $('[data-product-featured]', form).checked,
    sortOrder,
    badgeKey: $('[data-product-badge-key]', form).value,
    description: $('[data-product-description]', form).value,
    image: $('[data-product-image]', form).value,
    tags: $$('[data-product-tag]:checked', form).map((input) => input.dataset.productTag),
    plans
  };
}

function updateProductBulkButton() {
  const button = $('#productBulkSave');
  if (!button) return;
  const count = state.productDirty.size;
  button.disabled = state.productBulkBusy || !hasPermission('store.catalog.write') || count < 1;
  button.setAttribute('aria-disabled', button.disabled ? 'true' : 'false');
  const label = $('span', button);
  if (label) label.textContent = count ? `Toplu Kayıt · ${count} Değişiklik` : 'Toplu Kayıt';
  const refresh = $('#productCatalogRefresh');
  if (refresh) {
    refresh.disabled = state.productBulkBusy || count > 0;
    refresh.setAttribute('aria-disabled', refresh.disabled ? 'true' : 'false');
    refresh.title = count > 0 ? 'Kaydedilmemiş değişiklikleri kaybetmemek için önce Toplu Kayıt kullanın.' : 'Kataloğu yeniden yükle';
  }
}

function markProductDirty(form) {
  const id = String(form?.dataset?.productForm || '');
  if (!id) return;
  state.productDirty.add(id);
  form.classList.add('is-dirty');
  updateProductBulkButton();
}

async function loadProducts() {
  $('#adminProductGrid').innerHTML = loadingMarkup('Katalog yükleniyor');
  renderLiveStatus('#productMetrics', { icon: 'fa-spinner fa-spin', title: 'Katalog yenileniyor', detail: 'Ürün ayarları ile gerçek stok bilgileri birleştiriliyor.', tone: 'checking' });
  await ensureCatalog(true);
  state.loaded.add('products');
  state.productDirty.clear();
  state.productBulkBusy = false;
  const products = state.catalog.products || [];
  const active = products.filter((product) => product.active !== false && product.archived !== true).length;
  const inactive = products.filter((product) => product.active === false && product.archived !== true).length;
  const archived = products.filter((product) => product.archived === true).length;
  const plans = products.reduce((sum, product) => sum + (product.plans || []).length, 0);
  const telegramOnly = products.filter((product) => product.fulfillmentMode === 'telegram_only').length;
  renderLiveStatus('#productMetrics', { icon: 'fa-tags', title: `${active} aktif ürün · ${plans} paket`, detail: `${inactive} pasif · ${archived} arşiv · ${telegramOnly} yalnız Telegram ürünü · güncel katalog ve stok bilgisi`, tone: 'ok', meta: `${products.length} ÜRÜN` });
  $('#adminProductGrid').innerHTML = products.map(productMarkup).join('') || emptyMarkup('Ürün bulunamadı', 'Katalog yapılandırmasını kontrol edin.');
  updateProductBulkButton();
}

async function saveAllProducts() {
  if (!requirePermission('store.catalog.write', 'Toplu ürün güncelleme')) return;
  if (state.productBulkBusy) return;
  const dirtyIds = [...state.productDirty];
  if (!dirtyIds.length) return toast('info', 'Henüz kaydedilecek değişiklik yok', 'Ürün alanlarında bir değişiklik yaptığınızda Toplu Kayıt ile tümünü tek seferde kaydedebilirsiniz.');
  let updates;
  try {
    updates = dirtyIds.map((productId) => {
      const form = $$('[data-product-form]').find((candidate) => candidate.dataset.productForm === productId) || null;
      if (!form) throw new Error(`${productId} ürün formu bulunamadı. Lütfen kataloğu yenileyip yeniden deneyin.`);
      return { productId, settings: productFormBody(form) };
    });
  } catch (error) {
    return toast('error', 'Ürün değişikliklerini doğrulayamadık', error.message);
  }
  if (!(await requestAdminReauth())) return;
  const button = $('#productBulkSave');
  state.productBulkBusy = true;
  updateProductBulkButton();
  const icon = $('i', button);
  const originalClass = icon?.className || '';
  if (icon) icon.className = 'fa-solid fa-spinner fa-spin';
  let payload;
  try {
    payload = await adminFetch('/api/admin/store/products/bulk', { method: 'POST', timeoutMs: 60_000, body: { updates } });
  } catch (error) {
    toast('error', 'Ürün değişikliklerini kaydedemedik', `${error.message} ${isUncertainMutationError(error) ? 'Yanıt alınamadığı için kayıt sonucunu doğrulayamıyoruz; tekrar kaydetmeden önce güncel kataloğu kontrol edin.' : 'Toplu değişiklikler tek işlem olarak kaydedilir.'}`);
    state.productBulkBusy = false;
    if (icon) icon.className = originalClass || 'fa-solid fa-floppy-disk';
    updateProductBulkButton();
    return;
  }

  const updated = Number(payload.result?.updated || updates.length);
  state.productDirty.clear();
  $$('[data-product-form].is-dirty').forEach((form) => form.classList.remove('is-dirty'));
  state.catalog = null;
  state.loaded.delete('overview');
  toast('success', 'Ürün değişiklikleri kaydedildi', `${updated} ürüne ait değişiklikler güvenle kaydedildi.`);
  try { await loadProducts(); } catch (_) {
    toast('warning', 'Değişiklikler kaydedildi', 'Görünümü şu anda yenileyemedik. Güncel bilgiler için Kataloğu Yenile düğmesini kullanabilirsiniz.');
  }
  state.productBulkBusy = false;
  if (icon) icon.className = originalClass || 'fa-solid fa-floppy-disk';
  updateProductBulkButton();
}

function userCard(user) {
  const statusLabel = user.disabled ? 'HESAP DEVRE DIŞI' : user.accountStatus.toLocaleUpperCase('tr-TR');
  return `<article class="admin-card user-card" data-user-card="${escapeHtml(user.uid)}"><header><div><small>MAĞAZA HESABI</small><h2>${escapeHtml(user.username || 'Kullanıcı')}</h2></div><span class="account-state ${user.disabled ? 'is-suspended' : `is-${escapeHtml(user.accountStatus)}`}">${escapeHtml(statusLabel)}</span></header><div class="user-facts"><div><small>E-posta</small><strong>${escapeHtml(maskEmail(user.email))}</strong></div><div><small>Hesap kimliği</small><strong title="${escapeHtml(user.uid)}">…${escapeHtml(user.uid.slice(-12))}</strong></div><div><small>Kullanılabilir bakiye</small><strong>${escapeHtml(formatPrice(user.balanceKurus))}</strong></div><div><small>Toplam sipariş</small><strong>${escapeHtml(user.orderCount || 0)}</strong></div><div><small>Toplam harcama</small><strong>${escapeHtml(formatPrice(user.totalSpendKurus))}</strong></div><div><small>Toplam iade</small><strong>${escapeHtml(formatPrice(user.refundedKurus))}</strong></div><div><small>Hesap oluşturma</small><strong>${escapeHtml(formatDate(user.createdAt))}</strong></div><div><small>Son giriş</small><strong>${escapeHtml(formatDate(user.lastSignInAt))}</strong></div><div><small>Son sipariş</small><strong>${escapeHtml(formatDate(user.lastOrderAt))}</strong></div></div><div class="form-grid"><label><span>Hesap durumu</span><select data-user-status><option value="active" ${user.accountStatus === 'active' ? 'selected' : ''}>Aktif</option><option value="purchase_blocked" ${user.accountStatus === 'purchase_blocked' ? 'selected' : ''}>Alışveriş engelli</option><option value="suspended" ${user.accountStatus === 'suspended' ? 'selected' : ''}>Askıda</option></select></label><label><span>Yönetici notu</span><input data-user-note maxlength="300" value="${escapeHtml(user.adminNote || '')}" placeholder="İç kullanım notu"/></label></div><div class="action-row"><button class="secondary-action" type="button" data-user-orders="${escapeHtml(user.uid)}"${permissionDisabled('store.orders.read')}><i class="fa-solid fa-box"></i> Sipariş / Teslimat</button><button class="secondary-action" type="button" data-user-ledger="${escapeHtml(user.uid)}"${permissionDisabled('store.wallet.read')}><i class="fa-solid fa-wallet"></i> Bakiye Hareketleri</button><button class="secondary-action" type="button" data-user-audit="${escapeHtml(user.uid)}"${permissionDisabled('store.audit.read')}><i class="fa-solid fa-clipboard-check"></i> Denetim</button><button class="primary-action" type="button" data-save-user="${escapeHtml(user.uid)}"${permissionDisabled('store.users.write')}><i class="fa-solid fa-shield-halved"></i> Güvenli Kaydet</button></div><div class="ledger-list" data-ledger-host></div></article>`;
}

async function searchUser(event) {
  event.preventDefault(); const identifier = $('#userSearch').value.trim(); if (!identifier) return;
  const sequence = ++userSelectionSequence;
  $('#userResult').innerHTML = loadingMarkup('Kullanıcı aranıyor');
  try { const payload = await adminFetch(`/api/admin/store/users/resolve?identifier=${encodeURIComponent(identifier)}`); if (sequence !== userSelectionSequence) return; state.selectedUser = payload.user; $('#userResult').innerHTML = userCard(payload.user); }
  catch (error) { if (sequence !== userSelectionSequence) return; state.selectedUser = null; $('#userResult').innerHTML = emptyMarkup('Kullanıcı bulunamadı', error.message, 'fa-user-slash'); }
}

let userLoadSequence = 0;
let userSelectionSequence = 0;

function renderUserDirectory() {
  const host = $('#userDirectory');
  host.innerHTML = state.users.length ? state.users.map((user) => `<button type="button" data-user-select="${escapeHtml(user.uid)}"><span><strong>${escapeHtml(user.username || maskEmail(user.email))}</strong><small>${escapeHtml(maskEmail(user.email))} · ${escapeHtml(user.orderCount || 0)} sipariş${hasPermission('store.wallet.read') ? ` · ${escapeHtml(formatPrice(user.balanceKurus))} bakiye` : ''}</small></span><b class="account-state is-${escapeHtml(user.accountStatus)}">${escapeHtml(user.accountStatus.toLocaleUpperCase('tr-TR'))}</b></button>`).join('') : emptyMarkup('Kullanıcı bulunamadı', 'Henüz mağaza hesabı yok.', 'fa-users');
  if (state.userNextPageToken) host.insertAdjacentHTML('beforeend', '<button type="button" class="secondary-action admin-pagination" data-users-more>Diğer Kullanıcıları Yükle</button>');
}

async function loadMoreUsers(button) {
  if (state.userMoreBusy || !state.userNextPageToken) return;
  state.userMoreBusy = true;
  button.disabled = true;
  const sequence = userLoadSequence;
  try {
    const payload = await adminFetch(`/api/admin/store/users?limit=50&pageToken=${encodeURIComponent(state.userNextPageToken)}`, { timeoutMs: 30_000 });
    if (sequence !== userLoadSequence) return;
    state.users = [...new Map([...state.users, ...(payload.users || [])].map((user) => [user.uid, user])).values()];
    state.userNextPageToken = String(payload.nextPageToken || '');
    renderUserDirectory();
  } catch (error) {
    if (sequence === userLoadSequence) toast('error', 'Kullanıcı listesi genişletilemedi', error.message);
  } finally { state.userMoreBusy = false; button.disabled = false; }
}

async function loadUsers() {
  const sequence = ++userLoadSequence;
  state.userNextPageToken = '';
  $('#userDirectory').innerHTML = loadingMarkup('Kullanıcı dizini yükleniyor');
  renderLiveStatus('#userMetrics', { icon: 'fa-spinner fa-spin', title: 'Kullanıcı dizini okunuyor', detail: 'Mağaza hesapları ve profilleri birlikte denetleniyor.', tone: 'checking' });
  const [listPayload, summaryPayload] = await Promise.all([
    adminFetch('/api/admin/store/users?limit=50', { timeoutMs: 30_000 }),
    adminFetch('/api/admin/store/users-summary', { timeoutMs: 45_000 })
  ]);
  if (sequence !== userLoadSequence) return;
  state.userNextPageToken = String(listPayload.nextPageToken || '');
  state.users = Array.isArray(listPayload.users) ? listPayload.users : [];
  state.usersSummary = summaryPayload.summary || null;
  state.loaded.add('users');
  const summary = state.usersSummary || {};
  renderLiveStatus('#userMetrics', { icon: 'fa-users', title: `${summary.authUsers || 0} mağaza hesabı`, detail: `${summary.active || 0} aktif · ${summary.purchaseBlocked || 0} alışveriş engelli · ${summary.suspended || 0} askıda · ${summary.disabled || 0} devre dışı${hasPermission('store.wallet.read') ? ` · ${summary.fundedAccounts || 0} bakiyeli hesap` : ''}`, tone: summary.disabled || summary.suspended ? 'warning' : 'ok', meta: summary.countComplete === false ? 'KISMİ SAYIM' : 'GERÇEK SAYIM' });
  renderUserDirectory();
}

async function selectDirectoryUser(uid) {
  const sequence = ++userSelectionSequence;
  $('#userResult').innerHTML = loadingMarkup('Kullanıcı ayrıntısı yükleniyor');
  try { const payload = await adminFetch(`/api/admin/store/users/resolve?identifier=${encodeURIComponent(uid)}`); if (sequence !== userSelectionSequence) return; state.selectedUser = payload.user; $('#userResult').innerHTML = userCard(payload.user); $('#userResult').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }); }
  catch (error) { if (sequence !== userSelectionSequence) return; $('#userResult').innerHTML = emptyMarkup('Kullanıcı yüklenemedi', error.message, 'fa-user-slash'); }
}

async function saveUser(uid, card) {
  if (!requirePermission('store.users.write', 'Kullanıcı güncelleme')) return;
  if (!(await requestAdminReauth())) return;
  const sequence = userSelectionSequence;
  try { const payload = await adminFetch(`/api/admin/store/users/${encodeURIComponent(uid)}`, { method: 'PATCH', timeoutMs: 30_000, body: { status: $('[data-user-status]', card).value, adminNote: $('[data-user-note]', card).value } }); if (sequence !== userSelectionSequence) return; state.selectedUser = payload.user; $('#userResult').innerHTML = userCard(payload.user); toast('success', 'Kullanıcı bilgileri güncellendi', 'Hesap durumu ve yönetici notu güvenle kaydedildi.'); }
  catch (error) { toast('error', 'Kullanıcı bilgilerini güncelleyemedik', error.message); }
}

async function loadLedger(uid, host, { cursor = '' } = {}) {
  if (!host) return;
  if (!cursor) host.innerHTML = loadingMarkup('Bakiye hareketleri yükleniyor');
  try {
    const payload = await adminFetch(`/api/admin/store/users/${encodeURIComponent(uid)}/wallet-ledger?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    const rows = Array.isArray(payload.ledger) ? payload.ledger : [];
    const content = rows.map((row) => `<div><span><strong>${escapeHtml(row.type)} · ${escapeHtml(row.reason || '—')}</strong><small>${escapeHtml(formatDate(row.createdAt))} · ${escapeHtml(row.orderId ? `Sipariş …${row.orderId.slice(-8)}` : 'Manuel işlem')}</small></span><b class="${row.amountKurus < 0 ? 'is-negative' : 'is-positive'}">${escapeHtml(formatPrice(row.amountKurus, true))}</b></div>`).join('');
    const next = payload.nextCursor
      ? `<button class="secondary-action admin-pagination" type="button" data-ledger-more="${escapeHtml(uid)}" data-ledger-cursor="${escapeHtml(payload.nextCursor)}">Önceki Hareketleri Yükle</button>`
      : '';
    if (cursor) {
      host.querySelector('[data-ledger-more]')?.remove();
      host.insertAdjacentHTML('beforeend', `${content}${next}`);
    } else {
      host.innerHTML = rows.length ? `${content}${next}` : emptyMarkup('Hareket yok', 'Bu hesap için bakiye hareketi bulunmuyor.', 'fa-wallet');
    }
  } catch (error) {
    if (cursor) toast('error', 'Önceki bakiye hareketleri yüklenemedi', error.message);
    else host.innerHTML = emptyMarkup('Hareketler yüklenemedi', error.message, 'fa-triangle-exclamation');
  }
}

async function loadUserOrders(uid, host) {
  host.innerHTML = loadingMarkup('Sipariş ve teslimat geçmişi yükleniyor');
  try { const payload = await adminFetch(`/api/admin/store/orders?uid=${encodeURIComponent(uid)}&limit=100`); const rows = payload.orders || []; host.innerHTML = rows.length ? rows.map((row) => `<div><span><strong>${escapeHtml(row.orderNumber)} · ${escapeHtml(STATUS[row.status]?.label || row.status)}</strong><small>${escapeHtml(formatDate(row.createdAt))} · ${escapeHtml((row.items || []).map((item) => `${item.productName} ${item.planLabel}`).join(', '))}</small></span><b>${escapeHtml(formatPrice(row.totalKurus))}</b></div>`).join('') : emptyMarkup('Sipariş geçmişi yok', 'Bu hesap henüz sipariş oluşturmamış.', 'fa-box'); }
  catch (error) { host.innerHTML = emptyMarkup('Siparişler yüklenemedi', error.message, 'fa-triangle-exclamation'); }
}

async function loadUserAudit(uid, host) {
  host.innerHTML = loadingMarkup('Kullanıcı denetim kayıtları yükleniyor');
  try {
    const payload = await adminFetch(`/api/admin/store/audit?uid=${encodeURIComponent(uid)}&limit=100`);
    const rows = payload.audit || [];
    host.innerHTML = rows.length ? rows.map((row) => `<div><span><strong>${escapeHtml(row.action || 'İşlem')}</strong><small>${escapeHtml(formatDate(row.createdAt))} · ${row.source === 'admin' ? 'YÖNETİM' : 'MAĞAZA'} · İşlem izi ${escapeHtml(row.requestId ? `…${String(row.requestId).slice(-10)}` : '—')}</small></span><b>${escapeHtml(row.actor?.role || 'yetkili')}</b></div>`).join('') : emptyMarkup('Denetim kaydı yok', 'Bu kullanıcıyla ilişkili son denetim kaydı bulunamadı.', 'fa-clipboard-check');
  } catch (error) { host.innerHTML = emptyMarkup('Denetim yüklenemedi', error.message, 'fa-triangle-exclamation'); }
}

function walletPreview() {
  const user = state.walletUser; if (!user) return null;
  const raw = parseMoneyInput($('#walletAmount').value || '');
  const type = $('#walletType').value;
  let amountKurus = Number.isFinite(raw) ? Math.round(Math.abs(raw) * 100) : 0;
  if (type === 'DEBIT') amountKurus *= -1;
  if (type === 'CORRECTION' && raw < 0) amountKurus *= -1;
  const next = Number(user.balanceKurus || 0) + amountKurus;
  $('#walletConfirm').innerHTML = `<span><small>Mevcut bakiye</small><strong>${escapeHtml(formatPrice(user.balanceKurus))}</strong></span><i class="fa-solid fa-arrow-right"></i><span><small>Yeni bakiye</small><strong class="${next < 0 ? 'is-negative' : ''}">${escapeHtml(formatPrice(next))}</strong></span>`;
  return { amountKurus, next, raw };
}

async function loadWalletSummary() {
  renderLiveStatus('#walletMetrics', { icon: 'fa-spinner fa-spin', title: 'Bakiye merkezi yenileniyor', detail: 'Gerçek kullanıcı bakiyeleri ve hareket defteri okunuyor.', tone: 'checking' });
  $('#walletRecent').innerHTML = loadingMarkup('Son bakiye hareketleri yükleniyor');
  const payload = await adminFetch('/api/admin/store/wallet-summary', { timeoutMs: 45_000 });
  state.walletSummary = payload.summary || {};
  state.loaded.add('wallet');
  const w = state.walletSummary;
  renderLiveStatus('#walletMetrics', {
    icon: 'fa-wallet',
    title: `Toplam bakiye yükümlülüğü ${formatPrice(w.liabilityKurus || 0)}`,
    detail: `${w.fundedAccounts || 0} bakiyeli hesap · ${w.adjustmentCount || 0} yönetici bakiye işlemi · ${w.profileDocuments || 0} mağaza profili${w.ledgerComplete === false ? ` · Son ${w.ledgerAnalyzed || 0} hareket` : ''}`,
    tone: w.ledgerComplete === false ? 'warning' : 'ok',
    meta: w.ledgerComplete === false ? 'KISMİ KAYIT' : 'TAM KAYIT'
  });
  $('#walletSummaryGrid').innerHTML = [
    metricCard('fa-wallet', 'TOPLAM BAKİYE', formatPrice(w.liabilityKurus || 0), 'cyan'),
    metricCard('fa-users', 'BAKİYELİ HESAP', w.fundedAccounts || 0),
    metricCard('fa-scale-balanced', 'ORTALAMA BAKİYE', formatPrice(w.averageBalanceKurus || 0)),
    metricCard('fa-arrow-up-right-dots', 'EN YÜKSEK BAKİYE', formatPrice(w.highestBalanceKurus || 0)),
    metricCard('fa-calendar-plus', 'BUGÜN CREDIT', formatPrice(w.todayCreditKurus || 0), 'green'),
    metricCard('fa-calendar-minus', 'BUGÜN REFUND', formatPrice(w.todayRefundKurus || 0), w.todayRefundKurus ? 'yellow' : ''),
    metricCard('fa-circle-plus', w.ledgerComplete === false ? 'SON HAREKETLER CREDIT' : 'TOPLAM CREDIT', formatPrice(w.totalCreditKurus || 0), 'green'),
    metricCard('fa-circle-minus', w.ledgerComplete === false ? 'SON HAREKETLER DEBIT' : 'TOPLAM DEBIT', formatPrice(w.totalDebitKurus || 0), 'yellow'),
    metricCard('fa-rotate-left', w.ledgerComplete === false ? 'SON HAREKETLER REFUND' : 'TOPLAM REFUND', formatPrice(w.totalRefundKurus || 0), w.totalRefundKurus ? 'yellow' : ''),
    metricCard('fa-screwdriver-wrench', 'CORRECTION NET', formatPrice(w.totalCorrectionKurus || 0, true))
  ].join('');
  const rows = Array.isArray(w.recent) ? w.recent : [];
  $('#walletRecent').innerHTML = rows.length ? rows.map((row) => `<div><span><strong>${escapeHtml(row.type || 'HAREKET')} · ${escapeHtml(row.reason || '—')}</strong><small>${escapeHtml(row.username || 'Kullanıcı')} · UID …${escapeHtml(String(row.uid || '').slice(-8))} · ${escapeHtml(formatDate(row.createdAt))} · ${escapeHtml(row.actor?.email || row.actorSource || 'sistem')} · ${escapeHtml(formatPrice(row.balanceBeforeKurus || 0))} → ${escapeHtml(formatPrice(row.balanceAfterKurus || 0))} · İşlem …${escapeHtml(String(row.transactionId || row.id || '').slice(-10))}</small></span><b class="${Number(row.amountKurus || 0) < 0 ? 'is-negative' : 'is-positive'}">${escapeHtml(formatPrice(row.amountKurus, true))}</b></div>`).join('') : emptyMarkup('Bakiye hareketi yok', 'İlk bakiye hareketi oluşturulduğunda burada görünecek.', 'fa-wallet');
}


let walletLookupSequence = 0;
async function resolveWalletUser(event) {
  event.preventDefault();
  if (state.walletSubmitBusy) return;
  const sequence = ++walletLookupSequence;
  state.walletUser = null;
  $('#walletForm').hidden = true; const identifier = $('#walletIdentifier').value.trim(); if (!identifier) return;
  try { const payload = await adminFetch(`/api/admin/store/users/resolve?identifier=${encodeURIComponent(identifier)}`); if (sequence !== walletLookupSequence || $('#walletIdentifier').value.trim() !== identifier) return; state.walletUser = payload.user; $('#walletUserPreview').innerHTML = `<span><small>Kullanıcı</small><strong>${escapeHtml(payload.user.username || '—')}</strong></span><span><small>E-posta</small><strong>${escapeHtml(maskEmail(payload.user.email))}</strong></span><span><small>UID</small><strong>…${escapeHtml(payload.user.uid.slice(-8))}</strong></span><span><small>Bakiye</small><strong>${escapeHtml(formatPrice(payload.user.balanceKurus))}</strong></span>`; $('#walletForm').hidden = false; walletPreview(); }
  catch (error) { if (sequence !== walletLookupSequence) return; state.walletUser = null; $('#walletForm').hidden = true; toast('error', 'Aradığınız kullanıcıyı bulamadık', error.message); }
}

async function adjustWallet(event) {
  event.preventDefault();
  if (state.walletSubmitBusy) return;
  state.walletSubmitBusy = true;
  try {
  if (!requirePermission('store.wallet.write', 'Bakiye işlemi')) { event.preventDefault(); return; }
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('button[type="submit"]', form);
  const preview = walletPreview();
  const reason = $('#walletReason').value.trim();
  const targetUid = String(state.walletUser?.uid || '');
  if (!targetUid || !preview?.amountKurus) return toast('warning', 'Tutarı kontrol edin', 'Lütfen kullanıcıyı doğrulayın ve sıfırdan farklı geçerli bir tutar yazın.');
  if (preview.next < 0) return toast('warning', 'Bu işlem uygulanamaz', 'İşlem sonucunda kullanıcı bakiyesi sıfırın altına düşemez.');
  if (reason.length < 3) return toast('warning', 'Lütfen işlem gerekçesini yazın', 'Bakiye hareketi için kısa ve açıklayıcı bir neden girin.');
  const type = $('#walletType').value;
  const signature = JSON.stringify([targetUid, type, preview.amountKurus, reason]);
  if (!state.walletAdjustmentAttempt || state.walletAdjustmentAttempt.signature !== signature) {
    state.walletAdjustmentAttempt = { signature, idempotencyKey: requestKey('wallet') };
  }
  if (!(await requestAdminReauth())) return;
  if (state.walletUser?.uid !== targetUid) return toast('warning', 'Kullanıcı değişti', 'İşlemi yeni seçiminizle tekrar doğrulayın.');
  button.disabled = true;
  const originalHtml = button.innerHTML;
  button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Bakiye işlemi uygulanıyor';
  const attempt = state.walletAdjustmentAttempt;
  let payload;
  try {
    payload = await adminFetch('/api/admin/store/wallet/adjust', {
      method: 'POST', timeoutMs: 45_000,
      headers: { 'X-Idempotency-Key': attempt.idempotencyKey },
      body: { uid: targetUid, type, amountKurus: preview.amountKurus, reason, idempotencyKey: attempt.idempotencyKey }
    });
  } catch (error) {
    if (!isUncertainMutationError(error)) state.walletAdjustmentAttempt = null;
    const retry = isUncertainMutationError(error) ? ' Aynı bilgilerle güvenle yeniden deneyebilirsiniz; tamamlanan bakiye hareketi ikinci kez uygulanmaz.' : '';
    const requestId = error.requestId ? ` · İstek ${error.requestId}` : '';
    toast('error', 'Bakiye işlemini tamamlayamadık', `${error.message}${retry}${requestId}`);
    button.disabled = false;
    button.innerHTML = originalHtml;
    return;
  }

  state.walletAdjustmentAttempt = null;
  state.loaded.delete('overview');
  state.loaded.delete('users');
  $('#walletReason').value = '';
  $('#walletAmount').value = '';
  const adjustment = payload.adjustment || {};
  state.walletUser.balanceKurus = Number(adjustment.balanceKurus ?? adjustment.balanceAfterKurus ?? state.walletUser.balanceKurus) || 0;
  walletPreview();
  toast('success', adjustment.idempotentReplay ? 'Bakiye işlemi daha önce tamamlanmış' : 'Bakiye işlemi tamamlandı', `${type} hareketi güvenle kaydedildi. Güncel bakiye ${formatPrice(adjustment.balanceAfterKurus)} · İşlem …${String(adjustment.transactionId || '').slice(-8)}`);

  try {
    const refreshed = await adminFetch(`/api/admin/store/users/resolve?identifier=${encodeURIComponent(targetUid)}`, { timeoutMs: 30_000 });
    if (refreshed.user) state.walletUser = refreshed.user;
    $('#walletUserPreview').innerHTML = `<span><small>Kullanıcı</small><strong>${escapeHtml(state.walletUser.username || '—')}</strong></span><span><small>E-posta</small><strong>${escapeHtml(maskEmail(state.walletUser.email))}</strong></span><span><small>UID</small><strong>…${escapeHtml(state.walletUser.uid.slice(-8))}</strong></span><span><small>Bakiye</small><strong>${escapeHtml(formatPrice(state.walletUser.balanceKurus))}</strong></span>`;
  } catch (_) {
    toast('warning', 'Bakiye işlemi kaydedildi', 'Görünümü şu anda yenileyemedik. Güncel bilgiler için Bakiye Merkezi’ni yenileyebilirsiniz.');
  }
  try { await loadWalletSummary(); } catch (_) {}
  button.disabled = false;
  button.innerHTML = originalHtml;
  } finally { state.walletSubmitBusy = false; }
}


async function loadContent() {
  renderLiveStatus('#contentStatus', { icon: 'fa-spinner fa-spin', title: 'Mağaza yayın ayarları okunuyor', detail: 'Bakım, duyuru ve satış seçenekleri güvenli biçimde yükleniyor.', tone: 'checking' });
  const payload = await adminFetch('/api/admin/store/content'); const value = payload.storefront || {}; const a = value.announcement || {}; const s = value.services || {}; const support = value.support || {}; const home = value.home || {}; const visibility = value.categoryVisibility || {};
  $('#contentMaintenance').checked = value.maintenance === true; $('#announcementEnabled').checked = a.enabled === true; $('#announcementTitle').value = a.title || ''; $('#announcementMessage').value = a.message || ''; $('#announcementTone').value = a.tone || 'info'; $('#announcementCtaLabel').value = a.ctaLabel || ''; $('#announcementCtaTarget').value = a.ctaTarget || 'catalog'; $('#serviceAutomatic').checked = s.automaticDelivery !== false; $('#serviceTelegram').checked = s.telegramSupport !== false; $('#serviceBalance').checked = s.balancePayment !== false; $('#contentTelegramUsername').value = support.telegramUsername || ''; $('#contentHomeTitle').value = home.title || ''; $('#contentHomeMessage').value = home.message || ''; $('#contentAndroidVisible').checked = visibility.android !== false; $('#contentIosVisible').checked = visibility.ios !== false; state.loaded.add('content');
  const enabledServices = [s.automaticDelivery !== false, s.telegramSupport !== false, s.balancePayment !== false].filter(Boolean).length;
  const visibleCategories = [visibility.android !== false ? 'Android' : '', visibility.ios !== false ? 'iOS' : ''].filter(Boolean).join(' + ') || 'Kategori kapalı';
  renderLiveStatus('#contentStatus', { icon: value.maintenance ? 'fa-screwdriver-wrench' : 'fa-bullhorn', title: value.maintenance ? 'Mağaza bakım modunda' : 'Mağaza satışa açık', detail: `${a.enabled ? 'Duyuru yayında' : 'Duyuru kapalı'} · ${enabledServices}/3 hizmet aktif · ${visibleCategories}`, tone: value.maintenance ? 'warning' : 'ok', meta: 'YAYIN AYARI' });
}

function quickLinkEditorMarkup(link = {}, index = 0, total = 0) {
  const editable = permissionDisabled('store.content.write');
  const options = Object.entries(LINK_PLATFORM_META).map(([key, value]) => `<option value="${escapeHtml(key)}"${link.platform === key ? ' selected' : ''}>${escapeHtml(value.label)}</option>`).join('');
  return `<article class="quick-link-editor__card" data-link-index="${index}" data-link-id="${escapeHtml(link.id)}"><header><span class="quick-link-editor__index">${String(index + 1).padStart(2, '0')}</span><div><strong>${escapeHtml(link.title || 'Yeni bağlantı')}</strong><small>${escapeHtml(LINK_PLATFORM_META[link.platform]?.label || 'Platform seçin')}</small></div><div class="quick-link-editor__actions"><button type="button" data-link-move="up" aria-label="Bağlantıyı yukarı taşı"${index === 0 ? ' disabled' : editable}><i class="fa-solid fa-arrow-up" aria-hidden="true"></i></button><button type="button" data-link-move="down" aria-label="Bağlantıyı aşağı taşı"${index >= total - 1 ? ' disabled' : editable}><i class="fa-solid fa-arrow-down" aria-hidden="true"></i></button><button type="button" data-link-remove aria-label="Bağlantıyı kaldır"${editable}><i class="fa-solid fa-trash-can" aria-hidden="true"></i></button></div></header><div class="quick-link-editor__fields"><label><span>Platform</span><select data-link-field="platform"${editable}>${options}</select></label><label><span>Başlık</span><input data-link-field="title" maxlength="48" autocomplete="off" value="${escapeHtml(link.title || '')}" required${editable} /></label><label><span>Alt açıklama</span><input data-link-field="description" maxlength="80" autocomplete="off" value="${escapeHtml(link.description || '')}" required${editable} /></label><label class="quick-link-editor__url"><span>Bağlantı adresi</span><input data-link-field="url" type="url" maxlength="500" autocomplete="url" spellcheck="false" value="${escapeHtml(link.url || '')}" placeholder="https://${escapeHtml(LINK_PLATFORM_META[link.platform]?.canonicalHost || 't.me')}/hesap" required${editable} /></label></div><label class="toggle-row quick-link-editor__toggle"><input data-link-field="enabled" type="checkbox"${link.enabled !== false ? ' checked' : ''}${editable} /><span><strong>Ana sayfada göster</strong><small>Kapalı bağlantı kaydedilir ancak müşterilere gösterilmez.</small></span></label></article>`;
}

function readQuickLinkDrafts({ validate = false } = {}) {
  const cards = $$('#adminQuickLinks [data-link-index]');
  if (!cards.length) return [];
  const ids = new Set();
  const urls = new Set();
  return cards.map((card) => {
    const value = {
      id: card.dataset.linkId,
      platform: $('[data-link-field="platform"]', card)?.value || '',
      title: $('[data-link-field="title"]', card)?.value || '',
      description: $('[data-link-field="description"]', card)?.value || '',
      url: $('[data-link-field="url"]', card)?.value || '',
      enabled: $('[data-link-field="enabled"]', card)?.checked !== false
    };
    if (!validate) return value;
    let normalized;
    try {
      normalized = validateQuickLink(value);
    } catch (error) {
      const messages = {
        STORE_LINK_PLATFORM_INVALID: 'Bağlantı için geçerli bir platform seçin.',
        STORE_LINK_LABEL_REQUIRED: 'Her bağlantının başlığını ve alt açıklamasını doldurun.',
        STORE_LINK_URL_INVALID: 'Bağlantı adresi platformun gerçek HTTPS alan adına ve geçerli hesap biçimine uygun olmalıdır.'
      };
      throw new Error(messages[error.code] || 'Bağlantı bilgilerini kontrol edin.');
    }
    const url = normalized.url.toLowerCase();
    if (ids.has(normalized.id) || urls.has(url)) throw new Error('Aynı bağlantı adresi listede birden fazla kez kullanılamaz.');
    ids.add(normalized.id);
    urls.add(url);
    return normalized;
  });
}

function renderQuickLinkEditor() {
  const host = $('#adminQuickLinks');
  if (!host) return;
  host.innerHTML = state.quickLinks.length
    ? state.quickLinks.map((link, index) => quickLinkEditorMarkup(link, index, state.quickLinks.length)).join('')
    : emptyMarkup('Bağlantı bulunmuyor', 'Yeni bağlantı ekleyerek resmi hesaplarınızı ana sayfada gösterebilirsiniz.', 'fa-link');
  const add = $('#addQuickLink');
  if (add) {
    add.disabled = !hasPermission('store.content.write') || state.quickLinks.length >= MAX_QUICK_LINKS;
    add.setAttribute('aria-disabled', String(add.disabled));
  }
  const enabled = state.quickLinks.filter((item) => item.enabled !== false).length;
  renderLiveStatus('#quickLinksStatus', { icon: 'fa-link', title: `${enabled} bağlantı ana sayfada yayında`, detail: `${state.quickLinks.length}/${MAX_QUICK_LINKS} bağlantı · başlık, alt açıklama, sıralama ve adres yönetilebilir`, tone: enabled ? 'ok' : 'warning', meta: 'DOĞRULANMIŞ ALAN ADI' });
}

async function loadQuickLinks() {
  const host = $('#adminQuickLinks');
  if (host) host.innerHTML = loadingMarkup('Resmî bağlantılar hazırlanıyor');
  renderLiveStatus('#quickLinksStatus', { icon: 'fa-spinner fa-spin', title: 'Bağlantılar yükleniyor', detail: 'Ana sayfada kayıtlı resmi hesaplar denetleniyor.', tone: 'checking' });
  const response = await adminFetch('/api/admin/store/links');
  state.quickLinks = Array.isArray(response.links) ? response.links.map((link) => ({ ...link })) : [];
  state.loaded.add('links');
  renderQuickLinkEditor();
  return state.quickLinks;
}

function quickLinkIdentifier() {
  if (!window.crypto?.getRandomValues) throw new Error('Güvenli rastgele sayı üreticisi kullanılamıyor.');
  const bytes = window.crypto.getRandomValues(new Uint8Array(8));
  return `link-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function addQuickLink() {
  if (!requirePermission('store.content.write', 'Bağlantı ekleme')) return;
  state.quickLinks = readQuickLinkDrafts();
  if (state.quickLinks.length >= MAX_QUICK_LINKS) return toast('warning', 'Bağlantı sınırına ulaşıldı', `En fazla ${MAX_QUICK_LINKS} bağlantı yayımlanabilir.`);
  try {
    state.quickLinks.push({ id: quickLinkIdentifier(), platform: 'telegram', title: 'Telegram', description: 'Resmî hesabımızı takip et', url: '', enabled: true });
    renderQuickLinkEditor();
    $('#adminQuickLinks [data-link-index]:last-child [data-link-field="url"]')?.focus();
  } catch (error) {
    toast('error', 'Bağlantı eklenemedi', error.message);
  }
}

function updateQuickLinkOrder(button, action) {
  if (!requirePermission('store.content.write', 'Bağlantı düzenleme')) return;
  const card = button.closest('[data-link-index]');
  const index = Number(card?.dataset.linkIndex);
  if (!Number.isInteger(index)) return;
  state.quickLinks = readQuickLinkDrafts();
  if (action === 'remove') state.quickLinks.splice(index, 1);
  else {
    const target = action === 'up' ? index - 1 : index + 1;
    if (target < 0 || target >= state.quickLinks.length) return;
    [state.quickLinks[index], state.quickLinks[target]] = [state.quickLinks[target], state.quickLinks[index]];
  }
  renderQuickLinkEditor();
}

async function saveQuickLinks(event) {
  event.preventDefault();
  if (state.quickLinksBusy || !requirePermission('store.content.write', 'Bağlantı yayımlama')) return;
  let links;
  try {
    links = readQuickLinkDrafts({ validate: true });
  } catch (error) {
    return toast('warning', 'Bağlantıları kontrol edin', error.message);
  }
  if (!(await requestAdminReauth())) return;
  const button = $('#saveQuickLinks');
  const original = button.innerHTML;
  state.quickLinksBusy = true;
  button.disabled = true;
  button.innerHTML = '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> Bağlantılar yayımlanıyor';
  try {
    const response = await adminFetch('/api/admin/store/links', { method: 'PUT', timeoutMs: 30_000, body: { links } });
    state.quickLinks = Array.isArray(response.links) ? response.links.map((link) => ({ ...link })) : [];
    state.loaded.delete('content');
    renderQuickLinkEditor();
    toast('success', 'Bağlantılar güvenle yayımlandı', 'Başlıklar, açıklamalar ve bağlantı adresleri ana sayfada güncellendi.');
  } catch (error) {
    toast('error', 'Bağlantılar yayımlanamadı', error.message);
  } finally {
    state.quickLinksBusy = false;
    button.disabled = !hasPermission('store.content.write');
    button.innerHTML = original;
  }
}

function promotionAdminMarkup(promotion = {}) {
  const value = promotion.type === 'fixed' ? formatPrice(promotion.value) : `%${Number(promotion.value || 0)}`;
  const stateLabel = promotion.status === 'available' ? 'AKTİF' : promotion.status === 'expired' ? 'SÜRESİ DOLDU' : promotion.status === 'scheduled' ? 'PLANLANDI' : promotion.status === 'exhausted' ? 'TÜKENDİ' : 'PASİF';
  const limit = promotion.usageLimit ? `${promotion.usedCount}/${promotion.usageLimit}` : `${promotion.usedCount} kullanım`;
  return `<div class="promotion-admin-item"><span><strong>${escapeHtml(promotion.code)} · ${escapeHtml(value)}</strong><small>${escapeHtml(promotion.title)} · ${escapeHtml(limit)} · ${escapeHtml(stateLabel)}</small></span><button class="secondary-action" type="button" data-edit-promotion="${escapeHtml(promotion.code)}"${permissionDisabled('store.content.write')}>Düzenle</button></div>`;
}

async function loadPromotions() {
  const host = $('#adminPromotionList');
  if (!host) return [];
  host.innerHTML = loadingMarkup('Kupon kayıtları hazırlanıyor');
  renderLiveStatus('#couponMetrics', { icon: 'fa-spinner fa-spin', title: 'Kupon kodları yükleniyor', detail: 'Kullanım sayıları, geçerlilik tarihleri ve müşteri görünürlüğü denetleniyor.', tone: 'checking' });
  try {
    const response = await adminFetch('/api/admin/store/promotions');
    state.promotions = Array.isArray(response.promotions) ? response.promotions : [];
    state.loaded.add('coupons');
    const active = state.promotions.filter((promotion) => promotion.status === 'available').length;
    const visible = state.promotions.filter((promotion) => promotion.visibleInWallet === true).length;
    renderLiveStatus('#couponMetrics', { icon: 'fa-ticket', title: `${active} aktif kupon kodu`, detail: `${state.promotions.length} kayıtlı kupon · ${visible} kupon müşteri hesabında görünür · indirim tutarları sunucuda hesaplanır`, tone: active ? 'ok' : 'warning', meta: 'GÜVENLİ İNDİRİM' });
    host.innerHTML = state.promotions.length
      ? state.promotions.map(promotionAdminMarkup).join('')
      : emptyMarkup('Kupon bulunmuyor', 'Bir indirim kodu oluşturduğunuzda burada görünecek.', 'fa-ticket');
    return state.promotions;
  } catch (error) {
    host.innerHTML = failureMarkup('Kuponlar yüklenemedi', error, 'coupons');
    throw error;
  }
}

function generateCouponCode() {
  if (!requirePermission('store.content.write', 'Kupon kodu oluşturma')) return;
  if (!window.crypto?.getRandomValues) return toast('error', 'Kupon kodu oluşturulamadı', 'Tarayıcının güvenli rastgele sayı üreticisi kullanılamıyor.');
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = window.crypto.getRandomValues(new Uint8Array(8));
  $('#promotionCode').value = `SHELBY-${Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('')}`;
  $('#promotionTitle')?.focus();
}

function resetCouponForm() {
  if (!requirePermission('store.content.write', 'Kupon hazırlama')) return;
  $('#promotionForm')?.reset();
  $('#promotionActive').checked = true;
  $('#promotionVisible').checked = true;
  $('#promotionUserLimit').value = '1';
  $('#promotionValue').value = '10';
  $('#promotionCode')?.focus();
}

function promotionDateInput(timestamp = 0) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function editPromotion(code = '') {
  const promotion = state.promotions.find((item) => item.code === code);
  if (!promotion || !requirePermission('store.content.write', 'Kampanya düzenleme')) return;
  $('#promotionCode').value = promotion.code;
  $('#promotionTitle').value = promotion.title || '';
  $('#promotionType').value = promotion.type || 'percent';
  $('#promotionValue').value = promotion.type === 'fixed' ? Number(promotion.value || 0) / 100 : Number(promotion.value || 0);
  $('#promotionMinimum').value = Number(promotion.minimumSubtotalKurus || 0) / 100;
  $('#promotionMaximum').value = Number(promotion.maxDiscountKurus || 0) / 100;
  $('#promotionUsageLimit').value = Number(promotion.usageLimit || 0);
  $('#promotionUserLimit').value = Number(promotion.perUserLimit || 1);
  $('#promotionStarts').value = promotionDateInput(promotion.startsAt);
  $('#promotionEnds').value = promotionDateInput(promotion.endsAt);
  $('#promotionPlatform').value = promotion.platforms?.length === 1 ? promotion.platforms[0] : '';
  $('#promotionProducts').value = (promotion.productIds || []).join(', ');
  $('#promotionActive').checked = promotion.active === true;
  $('#promotionVisible').checked = promotion.visibleInWallet === true;
  $('#promotionForm').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
}

async function savePromotion(event) {
  event.preventDefault();
  if (!requirePermission('store.content.write', 'Kampanya yönetimi')) return;
  const code = String($('#promotionCode').value || '').trim().toLocaleUpperCase('en-US');
  if (!/^[A-Z0-9][A-Z0-9_-]{2,31}$/.test(code)) return toast('warning', 'Kampanya kodunu kontrol edin', 'Kod 3-32 karakter olmalı; harf, sayı, tire veya alt çizgi kullanabilirsiniz.');
  const type = $('#promotionType').value === 'fixed' ? 'fixed' : 'percent';
  const value = parseMoneyInput($('#promotionValue').value);
  if (!Number.isFinite(value) || value <= 0 || (type === 'percent' && (!Number.isInteger(value) || value > 90))) {
    return toast('warning', 'İndirim değerini kontrol edin', 'Yüzde kampanyaları 1-90 arasında tam sayı olmalıdır.');
  }
  const startsAt = $('#promotionStarts').value ? new Date($('#promotionStarts').value).getTime() : 0;
  const endsAt = $('#promotionEnds').value ? new Date($('#promotionEnds').value).getTime() : 0;
  if ((startsAt && !Number.isFinite(startsAt)) || (endsAt && !Number.isFinite(endsAt)) || (startsAt && endsAt && endsAt <= startsAt)) {
    return toast('warning', 'Kupon tarihlerini kontrol edin', 'Bitiş tarihi başlangıç tarihinden sonra olmalıdır.');
  }
  const body = {
    title: $('#promotionTitle').value,
    type,
    value: type === 'fixed' ? Math.round(value * 100) : value,
    minimumSubtotalKurus: Math.round(Math.max(0, parseMoneyInput($('#promotionMinimum').value) || 0) * 100),
    maxDiscountKurus: Math.round(Math.max(0, parseMoneyInput($('#promotionMaximum').value) || 0) * 100),
    usageLimit: Math.max(0, Math.trunc(Number($('#promotionUsageLimit').value) || 0)),
    perUserLimit: Math.max(1, Math.trunc(Number($('#promotionUserLimit').value) || 1)),
    startsAt,
    endsAt,
    platforms: $('#promotionPlatform').value ? [$('#promotionPlatform').value] : [],
    productIds: String($('#promotionProducts').value || '').split(',').map((item) => item.trim()).filter(Boolean),
    active: $('#promotionActive').checked,
    visibleInWallet: $('#promotionVisible').checked
  };
  if (!(await requestAdminReauth())) return;
  try {
    await adminFetch(`/api/admin/store/promotions/${encodeURIComponent(code)}`, { method: 'PUT', timeoutMs: 30_000, body });
    toast('success', 'Kupon güvenle kaydedildi', `${code} kodu; süre, kullanım limiti ve ürün kapsamıyla müşteri hesabında ve sepette doğrulanacak.`);
    await loadPromotions();
  } catch (error) {
    toast('error', 'Kupon kaydedilemedi', error.message);
  }
}


async function saveContent(event) {
  if (!requirePermission('store.content.write', 'İçerik güncelleme')) { event.preventDefault(); return; }
  event.preventDefault(); if (!(await requestAdminReauth())) return;
  const body = { maintenance: $('#contentMaintenance').checked, announcement: { enabled: $('#announcementEnabled').checked, title: $('#announcementTitle').value, message: $('#announcementMessage').value, tone: $('#announcementTone').value, ctaLabel: $('#announcementCtaLabel').value, ctaTarget: $('#announcementCtaTarget').value }, services: { automaticDelivery: $('#serviceAutomatic').checked, telegramSupport: $('#serviceTelegram').checked, balancePayment: $('#serviceBalance').checked }, support: { telegramUsername: $('#contentTelegramUsername').value }, home: { title: $('#contentHomeTitle').value, message: $('#contentHomeMessage').value }, categoryVisibility: { android: $('#contentAndroidVisible').checked, ios: $('#contentIosVisible').checked } };
  try { await adminFetch('/api/admin/store/content', { method: 'PATCH', timeoutMs: 30_000, body }); toast('success', 'Mağaza içeriği yayınlandı', 'Ana sayfa duyurusu ve hizmet durumları başarıyla güncellendi.'); state.loaded.delete('overview'); await loadContent(); }
  catch (error) { toast('error', 'Mağaza içeriğini kaydedemedik', error.message); }
}

async function loadAudit() {
  $('#auditList').innerHTML = loadingMarkup('Denetim kayıtları yükleniyor'); renderLiveStatus('#auditMetrics', { icon: 'fa-spinner fa-spin', title: 'Denetim defteri okunuyor', detail: 'Yönetim ve mağaza denetim kayıtları zaman sırasına getiriliyor.', tone: 'checking' }); const payload = await adminFetch('/api/admin/store/audit?limit=160'); const rows = payload.audit || []; state.loaded.add('audit');
  const adminCount = rows.filter((row) => row.source === 'admin').length; const storeCount = rows.length - adminCount; const newest = rows[0]?.createdAt || 0;
  renderLiveStatus('#auditMetrics', { icon: 'fa-clipboard-check', title: `${rows.length} son denetim kaydı`, detail: `${adminCount} yönetici · ${storeCount} mağaza işlemi · Son kayıt ${formatDate(newest)}`, tone: 'ok', meta: 'KORUMALI KAYIT' });
  $('#auditList').innerHTML = rows.length ? rows.map((row) => { const before = compactAuditValue(row.before); const after = compactAuditValue(row.after); const change = before || after ? ` · Önce: ${before || '—'} · Sonra: ${after || '—'}` : ''; return `<div><i class="fa-solid ${row.source === 'admin' ? 'fa-user-shield' : 'fa-store'}"></i><span><strong>${escapeHtml(row.action || 'İşlem')}</strong><small>${escapeHtml(row.actor?.email || row.actor?.uid || 'Sistem')} · ${escapeHtml(row.actor?.role || 'yetkili')} · ${escapeHtml(formatDate(row.createdAt))}</small><em>${escapeHtml((row.summary || (row.orderId || row.targetUid ? `Hedef …${String(row.orderId || row.targetUid).slice(-8)}` : 'Denetim kaydı')) + change)} · İşlem izi ${escapeHtml(row.requestId ? `…${String(row.requestId).slice(-10)}` : '—')} · Bağlantı izi ${escapeHtml(row.ipHash ? `…${String(row.ipHash).slice(-10)}` : '—')}</em></span><b>${row.source === 'admin' ? 'YÖNETİM' : 'MAĞAZA'}</b></div>`; }).join('') : emptyMarkup('Denetim kaydı yok', 'Kritik işlemler burada görünecek.', 'fa-clipboard-list');
}

async function loadStaff() {
  $('#staffList').innerHTML = loadingMarkup('Yetki kayıtları yükleniyor'); renderLiveStatus('#staffMetrics', { icon: 'fa-spinner fa-spin', title: 'Yetki politikaları denetleniyor', detail: 'Mağaza sahibi ve personel rol kayıtları okunuyor.', tone: 'checking' }); const payload = await adminFetch('/api/admin/store/staff'); const rows = payload.staff || []; state.loaded.add('staff');
  const active = rows.filter((row) => row.active).length; const owners = rows.filter((row) => row.systemOwner).length;
  renderLiveStatus('#staffMetrics', { icon: 'fa-user-shield', title: `${active} aktif yetki politikası`, detail: `${owners} korumalı mağaza sahibi · ${Math.max(0, rows.length - owners)} personel politikası · roller yalnızca gerekli izinleri taşır`, tone: owners === 1 ? 'ok' : 'warning', meta: owners === 1 ? 'SAHİP KORUNUYOR' : 'KONTROL' });
  $('#staffList').innerHTML = rows.map((row) => `<div><span><strong>${escapeHtml(row.email || row.uid)}</strong><small>${escapeHtml(row.role.toLocaleUpperCase('tr-TR'))} · ${row.active ? 'Aktif' : 'Kapalı'}${row.systemOwner ? ' · Mağaza sahibi' : ''} · ${(row.permissions || []).includes('*') ? 'Tüm mağaza sahibi izinleri' : `${(row.permissions || []).length} izin`}</small></span><b class="account-state ${row.active ? 'is-active' : 'is-suspended'}">${row.active ? 'AKTİF' : 'KAPALI'}</b></div>`).join('') || emptyMarkup('Yetkili hesap yok', 'Mağaza sahibi kaydı yapılandırılmalıdır.', 'fa-user-lock');
}

async function saveStaff(event) {
  if (!requirePermission('store.staff.write', 'Yetki politikası güncelleme') || state.adminPolicy?.systemOwner !== true) { event.preventDefault(); return; }
  event.preventDefault(); const form = event.currentTarget; if (!(await requestAdminReauth())) return;
  try { await adminFetch(`/api/admin/store/staff/${encodeURIComponent($('#staffUid').value.trim())}`, { method: 'PUT', timeoutMs: 30_000, body: { email: $('#staffEmail').value.trim(), role: $('#staffRole').value, active: $('#staffActive').checked } }); toast('success', 'Yetki ayarları kaydedildi', 'Personel rolü ve aktiflik durumu güvenle güncellendi.'); form.reset(); $('#staffActive').checked = true; await loadStaff(); }
  catch (error) { toast('error', 'Yetki ayarlarını kaydedemedik', error.message); }
}


async function loadSecurity() {
  renderLiveStatus('#securityRuntime', { icon: 'fa-spinner fa-spin', title: 'Güvenlik katmanları denetleniyor', detail: 'Aktif korumalar ve yönetici oturumu yeniden doğrulanıyor.', tone: 'checking' });
  const payload = await adminFetch('/api/admin/store/security', { timeoutMs: 30_000 });
  securityView(payload.security || {});
  state.securityRuntime = payload.runtime || {};
  state.loaded.add('security');
  const runtime = state.securityRuntime;
  const inventoryReady = runtime.inventory?.ready === true;
  const expires = runtime.adminAccessExpiresAt ? formatDate(runtime.adminAccessExpiresAt) : 'Oturum süresi güvenli biçimde yönetiliyor';
  const requestProtection = { off: 'kapalı', monitor: 'izleniyor', enforce: 'zorunlu' }[String(runtime.appCheckMode || '').toLowerCase()] || 'denetleniyor';
  const accessMode = { 'httpOnly-cookie': 'korumalı HttpOnly oturumu' }[String(runtime.adminAccessMode || '').toLowerCase()] || 'denetleniyor';
  renderLiveStatus('#securityRuntime', { icon: 'fa-shield-halved', title: `İstek koruması ${requestProtection} · Stok kasası ${inventoryReady ? 'hazır' : 'kontrol'}`, detail: `Yönetici erişimi: ${accessMode} · ${expires}`, tone: runtime.configurationReady && runtime.keyVaultReady ? 'ok' : 'warning', meta: runtime.configurationReady && runtime.keyVaultReady ? 'KORUMA HAZIR' : 'EKSİK AYAR' });
}

function renderPanelFailure(name, error) {
  const hosts = {
    overview: '#overviewMetrics',
    orders: '#adminOrderList',
    inventory: '#inventorySummary',
    products: '#adminProductGrid',
    users: '#userDirectory',
    audit: '#auditList',
    staff: '#staffList',
    wallet: '#walletRecent',
    security: '#securityRuntime',
    content: '#contentStatus',
    links: '#adminQuickLinks',
    coupons: '#adminPromotionList'
  };
  const host = $(hosts[name]);
  if (host) host.innerHTML = failureMarkup('Panel verisi yüklenemedi', error, name);
  if (name === 'inventory') {
    state.inventoryReadiness = { ready: false, blockers: [] };
    renderInventoryReadiness();
  }
}

async function loadPanel(name, force = false) {
  if (!force && state.loaded.has(name)) return;
  if (state.panelLoads.has(name)) return state.panelLoads.get(name);
  let operation;
  operation = (async () => {
    try {
      if (name === 'overview') await loadOverview();
      else if (name === 'orders') await loadOrders();
      else if (name === 'inventory') await loadInventory();
      else if (name === 'products') await loadProducts();
      else if (name === 'users') await loadUsers();
      else if (name === 'wallet') await loadWalletSummary();
      else if (name === 'content') await loadContent();
      else if (name === 'links') await loadQuickLinks();
      else if (name === 'coupons') await loadPromotions();
      else if (name === 'staff') await loadStaff();
      else if (name === 'audit') await loadAudit();
      else if (name === 'security') await loadSecurity();
    } catch (error) {
      renderPanelFailure(name, error);
      toast('error', 'Bu bölümün bilgilerini yükleyemedik', error.message);
      if (['ADMIN_GATE_REQUIRED', 'ADMIN_GATE_ACCESS_INVALID', 'AUTH_REQUIRED'].includes(String(error.code))) setTimeout(() => location.replace('/admin/index.html'), 600);
    } finally {
      if (state.panelLoads.get(name) === operation) state.panelLoads.delete(name);
    }
  })();
  state.panelLoads.set(name, operation);
  return operation;
}

function switchPanel(name = 'overview') {
  const requested = PANELS.includes(name) ? name : 'overview';
  const safe = panelAllowed(requested) ? requested : PANELS.find((panel) => panelAllowed(panel)) || 'overview';
  state.activePanel = safe;
  $$('[data-panel]').forEach((button) => button.classList.toggle('is-active', button.dataset.panel === safe));
  $$('[data-admin-panel]').forEach((panel) => { const active = panel.dataset.adminPanel === safe && panelAllowed(safe); panel.classList.toggle('is-active', active); panel.hidden = !active; panel.inert = !active; });
  const activeNavButton = document.querySelector(`.admin-sidebar [data-panel="${safe}"]`);
  if (activeNavButton && matchMedia('(max-width: 899px)').matches) {
    requestAnimationFrame(() => activeNavButton.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' }));
  }
  scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  return loadPanel(safe).catch(() => null);
}

async function logout() {
  await adminFetch('/api/auth/admin/gate/logout', { method: 'POST', body: {} }).catch(() => null);
  location.replace('/admin/index.html');
}

function bind() {
  let redirecting = false;
  window.addEventListener('shelby:admin-session-invalid', () => {
    if (redirecting) return;
    redirecting = true;
    toast('warning', 'Yönetici oturumunuz sona erdi', 'Güvenliğiniz için giriş sayfasına yönlendiriliyorsunuz.');
    setTimeout(() => location.replace('/admin/index.html'), 350);
  });
  document.addEventListener('click', (event) => {
    const panelButton = event.target.closest('[data-panel]'); if (panelButton) return switchPanel(panelButton.dataset.panel);
    const refresh = event.target.closest('[data-refresh]'); if (refresh) return loadPanel(refresh.dataset.refresh, true);
    const retry = event.target.closest('[data-panel-retry]'); if (retry) return loadPanel(retry.dataset.panelRetry, true);
    const saveOrder = event.target.closest('[data-save-order]'); if (saveOrder) return updateOrder(saveOrder.dataset.saveOrder, saveOrder.closest('[data-admin-order]'));
    const stockSelect = event.target.closest('[data-stock-select]'); if (stockSelect) { const [product, plan] = stockSelect.dataset.stockSelect.split(':'); $('#inventoryProduct').value = product; populateInventoryPlans(); $('#inventoryPlan').value = plan; renderInventoryMode(); return inspectInventory(); }
    const revoke = event.target.closest('[data-revoke-stock]'); if (revoke) return revokeStock(revoke.dataset.revokeStock, revoke.dataset.storageSku || '');
    const reveal = event.target.closest('[data-reveal-stock]'); if (reveal) return revealStock(reveal.dataset.revealStock, reveal.dataset.storageSku || '');
    const saveUserButton = event.target.closest('[data-save-user]'); if (saveUserButton) return saveUser(saveUserButton.dataset.saveUser, saveUserButton.closest('[data-user-card]'));
    const moreUsers = event.target.closest('[data-users-more]'); if (moreUsers) return loadMoreUsers(moreUsers);
    const selectedUser = event.target.closest('[data-user-select]'); if (selectedUser) return selectDirectoryUser(selectedUser.dataset.userSelect);
    const ledger = event.target.closest('[data-user-ledger]'); if (ledger) return loadLedger(ledger.dataset.userLedger, $('[data-ledger-host]', ledger.closest('[data-user-card]')));
    const olderLedger = event.target.closest('[data-ledger-more]'); if (olderLedger) return loadLedger(olderLedger.dataset.ledgerMore, olderLedger.closest('[data-ledger-host]'), { cursor: olderLedger.dataset.ledgerCursor });
    const userOrders = event.target.closest('[data-user-orders]'); if (userOrders) return loadUserOrders(userOrders.dataset.userOrders, $('[data-ledger-host]', userOrders.closest('[data-user-card]')));
    const userAudit = event.target.closest('[data-user-audit]'); if (userAudit) return loadUserAudit(userAudit.dataset.userAudit, $('[data-ledger-host]', userAudit.closest('[data-user-card]')));
    const promotionEdit = event.target.closest('[data-edit-promotion]'); if (promotionEdit) return editPromotion(promotionEdit.dataset.editPromotion);
    const linkMove = event.target.closest('[data-link-move]'); if (linkMove) return updateQuickLinkOrder(linkMove, linkMove.dataset.linkMove);
    const linkRemove = event.target.closest('[data-link-remove]'); if (linkRemove) return updateQuickLinkOrder(linkRemove, 'remove');
  });
  $$('[data-reauth-cancel]').forEach((button) => button.addEventListener('click', () => closeReauth('')));
  $('#reauthForm').addEventListener('submit', (event) => { event.preventDefault(); closeReauth($('#reauthPassword').value); });
  $$('[data-secure-action-cancel]').forEach((button) => button.addEventListener('click', () => closeSecureAction(null)));
  $('#secureActionForm').addEventListener('submit', (event) => { event.preventDefault(); const result = secureActionResult(); if (result) closeSecureAction(result); });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('#secureActionLayer').hidden && state.secureActionResolve) {
      event.preventDefault();
      closeSecureAction(null);
    }
  });
  $('#adminLogout').addEventListener('click', logout);
  $('#refreshAll').addEventListener('click', () => loadPanel(state.activePanel, true));
  $('#orderSearch').addEventListener('input', (event) => { state.query = event.target.value; renderOrders(); });
  $('#orderFilter').addEventListener('change', (event) => { state.filter = event.target.value; loadOrders().catch((error) => toast('error', 'Sipariş filtresi uygulanamadı', error.message)); });
  $('#adminLoadMoreOrders')?.addEventListener('click', loadMoreAdminOrders);
  $('#inventoryProduct').addEventListener('change', () => { populateInventoryPlans(); renderInventoryMode(); });
  $('#inventoryPlan').addEventListener('change', () => renderInventoryMode());
  $('#inventoryKeys').addEventListener('input', () => { state.inventoryImportAttempt = null; renderInventoryParsePreview(); });
  $('#inventoryImportForm').addEventListener('submit', importInventory);
  $('#inventoryInspect').addEventListener('click', inspectInventory);
  $('#inventoryMigrateShared').addEventListener('click', migrateSharedInventory);
  $('#inventoryRotateKeys').addEventListener('click', rotateInventoryKeys);
  $('#adminProductGrid').addEventListener('submit', (event) => event.preventDefault());
  $('#adminProductGrid').addEventListener('input', (event) => { const form = event.target.closest('[data-product-form]'); if (form) markProductDirty(form); });
  $('#adminProductGrid').addEventListener('change', (event) => { if (event.target.matches?.('[data-product-badge-key]')) syncProductBadgePreview(event.target); const form = event.target.closest('[data-product-form]'); if (form) markProductDirty(form); });
  $('#productBulkSave')?.addEventListener('click', saveAllProducts);
  $('#userSearchForm').addEventListener('submit', searchUser);
  $('#walletResolveForm').addEventListener('submit', resolveWalletUser);
  $('#walletForm').addEventListener('submit', adjustWallet);
  $('#walletAmount').addEventListener('input', walletPreview); $('#walletType').addEventListener('change', walletPreview);
  $('#contentForm').addEventListener('submit', saveContent);
  $('#quickLinksForm')?.addEventListener('submit', saveQuickLinks);
  $('#addQuickLink')?.addEventListener('click', addQuickLink);
  $('#adminQuickLinks')?.addEventListener('input', (event) => {
    if (event.target.matches('[data-link-field]')) state.quickLinks = readQuickLinkDrafts();
  });
  $('#adminQuickLinks')?.addEventListener('change', (event) => {
    if (!event.target.matches('[data-link-field]')) return;
    state.quickLinks = readQuickLinkDrafts();
    if (event.target.dataset.linkField === 'platform' || event.target.dataset.linkField === 'enabled') renderQuickLinkEditor();
  });
  $('#promotionForm')?.addEventListener('submit', savePromotion);
  $('#generateCouponCode')?.addEventListener('click', generateCouponCode);
  $('#resetCouponForm')?.addEventListener('click', resetCouponForm);
  $('#refreshPromotions')?.addEventListener('click', () => loadPromotions().catch((error) => toast('error', 'Kuponlar yenilenemedi', error.message)));
  $('#staffForm').addEventListener('submit', saveStaff);
}

async function confirmedAdminStatus() {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const status = await adminFetch('/api/auth/admin/gate/status');
      if (status?.authenticated === true && status?.admin) return status;
      lastError = Object.assign(new Error('Güvenli yönetici oturumu henüz doğrulanamadı.'), {
        code: 'ADMIN_GATE_ACCESS_INVALID'
      });
    } catch (error) {
      lastError = error;
    }
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 180 * (attempt + 1)));
  }
  throw lastError || new Error('Güvenli yönetici oturumu doğrulanamadı.');
}

function renderAdminEntryFailure(error) {
  const loader = $('#adminLoader');
  const content = loader?.querySelector('div');
  if (!loader || !content) return;
  const title = content.querySelector('strong');
  const detail = content.querySelector('small');
  const icon = content.querySelector(':scope > i');
  if (title) title.textContent = 'Yönetici oturumu doğrulanamadı';
  if (detail) detail.textContent = error?.message || 'Güvenli bağlantıyı kontrol edip yeniden deneyin.';
  if (icon) icon.className = 'fa-solid fa-shield-halved';
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'primary-action';
  const requiresHandoff = String(error?.code || '') === 'ADMIN_HANDOFF_REQUIRED';
  retry.textContent = requiresHandoff ? 'Yönetici Girişine Dön' : 'Yeniden Dene';
  retry.addEventListener('click', () => {
    if (requiresHandoff) {
      const origin = String(window.SHELBY_ADMIN_AUTH.canonicalOrigin() || window.location.origin).replace(/\/+$/, '');
      window.location.replace(`${origin}/admin/index.html`);
      return;
    }
    window.location.reload();
  });
  content.appendChild(retry);
  loader.classList.add('has-entry-error');
  loader.classList.remove('is-hidden');
}

async function boot() {
  lockAdminInteractions(); startAmbientCanvas($('#ambientCanvas')); installAdminChromeStability();
  try {
    await window.SHELBY_ADMIN_AUTH.init();
    const apiOrigin = new URL(window.SHELBY_ADMIN_AUTH.apiUrl('/api/public/runtime-config'), window.location.href).origin;
    if (apiOrigin !== window.location.origin) {
      throw Object.assign(new Error('Yönetim merkezi güvenli sunucu alanında açılmalıdır. Yönetici girişinden devam edin.'), {
        code: 'ADMIN_HANDOFF_REQUIRED'
      });
    }
    const status = await confirmedAdminStatus();
    bind();
    state.adminPolicy = status.admin;
    applyAdminPermissions();
    securityView(status.security || status.admin?.security || {}); $('#adminIdentity').textContent = status.user?.email || 'Yetkili yönetici';
    const initialPanel = panelAllowed('overview') ? 'overview' : PANELS.find((panel) => panelAllowed(panel));
    if (!initialPanel) throw new Error('Bu yönetici hesabına atanmış aktif panel izni bulunmuyor.');
    state.activePanel = initialPanel;
    await switchPanel(initialPanel);
    $('#adminLoader').classList.add('is-hidden');
  } catch (error) {
    renderAdminEntryFailure(error);
    toast('error', 'Yönetim merkezi açılamadı', error.message || 'Güvenli yönetici oturumunu yeniden doğrulayın.');
  }
}

boot();
