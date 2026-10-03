import { isUncertainMutationError } from '../request-utils.js?v=audit-20260908-v1';
import { createRequestId, friendlyStoreError, storeApi } from './api.js?v=audit-20260908-v1';
import {
  getStoreAuthSnapshot,
  initStoreAuth,
  logoutStore,
  refreshStoreAccount,
  refreshStoreIdentity,
  changeStoreEmail,
  changeStoreIdentity,
  changeStorePassword,
  registerStore,
  resetStorePassword,
  signInStore,
  subscribeStoreAuth
} from './auth.js?v=audit-20260908-v1';
import { CATALOG_FILTERS, formatStorePrice, getStorePlan, getStoreProduct, loadStoreCatalog, productMatchesCatalogFilter, resolveCatalogFilter } from './products.js?v=audit-20260908-v1';
import { createNotificationCenter } from '../ui/notification-center.js?v=audit-20260908-v1';
import { installProductGallery } from './product-gallery.js?v=audit-20260908-v1';
import { installShowcaseSlider } from './showcase-slider.js?v=audit-20260908-v1';
import { renderQuickLinks } from './social-links.js?v=audit-20260908-v1';
import {
  COUPON_FILTERS,
  ORDER_FILTERS,
  couponAccent,
  couponIsUsable,
  couponMatchesFilter,
  couponScopeLabel,
  customerCouponGroup,
  latestDeliveryLabel,
  orderMatchesFilter,
  summarizeCustomerCoupons,
  summarizeCustomerOrders
} from './customer-app.js?v=audit-20260908-v1';
import { createCustomerAppController } from './customer-app.js?v=audit-20260908-v1';
import {
  renderAvatarPickerView,
  renderCartItemView,
  renderCouponCardView,
  renderCustomerEmpty,
  renderDeliveryCardView,
  renderOrderCardView
} from './customer-renderers.js?v=audit-20260908-v1';

const STORE_VERSION = 'storefront-v66';
const FAVORITES_STORAGE_KEY = 'shelby-store-favorites-v66';
const LEGACY_FAVORITES_STORAGE_KEYS = Object.freeze(['shelby-store-favorites-v65', 'shelby-store-favorites-v64']);
const FALLBACK_AVATAR_ICONS = Object.freeze({
  '1': 'fa-crown',
  '2': 'fa-bolt',
  '3': 'fa-star',
  '4': 'fa-shield-halved',
  '5': 'fa-gem'
});
const ORDER_STATUS = Object.freeze({
  awaiting_payment: { label: 'Onay bekliyor', icon: 'fa-clock' },
  payment_review: { label: 'Kontrol ediliyor', icon: 'fa-magnifying-glass' },
  paid: { label: 'Onaylandı', icon: 'fa-circle-check' },
  processing: { label: 'Hazırlanıyor', icon: 'fa-gears' },
  delivery_pending: { label: 'Teslimat bekliyor', icon: 'fa-box' },
  delivered: { label: 'Teslim edildi', icon: 'fa-circle-check' },
  payment_rejected: { label: 'Ödeme reddedildi', icon: 'fa-ban' },
  refunded: { label: 'İade edildi', icon: 'fa-rotate-left' },
  cancelled: { label: 'İptal edildi', icon: 'fa-circle-xmark' }
});

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  catalog: null,
  activeFilter: 'all',
  searchQuery: '',
  selectedProduct: null,
  selectedPlan: null,
  cart: new Map(),
  paymentMethod: 'wallet',
  auth: getStoreAuthSnapshot(),
  orders: [],
  ordersLoadedAt: 0,
  ordersPromise: null,
  orderNextCursor: '',
  orderPageLoading: false,
  selectedAvatarId: '1',
  activeLayer: null,
  previousFocus: null,
  pendingLayer: '',
  checkoutAttempt: null,
  authOperation: '',
  cancelConfirmOrderId: '',
  orderOperationId: '',
  scrollLockY: 0,
  viewportFrame: 0,
  topbarObserver: null,
  runtimeNoticeAt: 0,
  deliverySecrets: new Map(),
  deliverySecretTimers: new Map(),
  restockSubscriptions: new Set(),
  deliveryAccessOrderId: '',
  deliveryAccessSequence: 0,
  accountSecurityBusy: '',
  accountAvatarBusy: false,
  accountLogoutBusy: false,
  promotion: null,
  promotions: [],
  promotionsLoadedAt: 0,
  promotionsPromise: null,
  promotionBusy: false,
  orderFilter: 'all',
  orderSearch: '',
  couponFilter: 'available',
  deliveryAccessFocus: null,
  favorites: new Set(),
  storeNavigationAction: 'storefront'
};

function loadFavoriteProducts() {
  try {
    const saved = window.localStorage.getItem(FAVORITES_STORAGE_KEY)
      || LEGACY_FAVORITES_STORAGE_KEYS.map((key) => window.localStorage.getItem(key)).find(Boolean)
      || '[]';
    const stored = JSON.parse(saved);
    state.favorites = new Set(Array.isArray(stored) ? stored.map((value) => String(value || '').trim()).filter(Boolean) : []);
    if (!window.localStorage.getItem(FAVORITES_STORAGE_KEY) && state.favorites.size) persistFavoriteProducts();
  } catch {
    state.favorites = new Set();
  }
}

function persistFavoriteProducts() {
  try {
    window.localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify([...state.favorites]));
  } catch {
    // Depolama kapalıysa favoriler mevcut oturum boyunca çalışmaya devam eder.
  }
}

function escapeHtml(value = '') {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  }[character]));
}

function iconMarkup(icon, className = 'fa-solid') {
  return `<i class="${escapeHtml(className)} ${escapeHtml(icon)}" aria-hidden="true"></i>`;
}

function platformName(platform) {
  return platform === 'ios' ? 'iOS' : 'Android';
}

function formatTopbarBalance(valueKurus = 0) {
  const value = Math.max(0, Number(valueKurus) || 0) / 100;
  return `₺${value.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function avatarOption(avatarId = '1') {
  const id = String(avatarId || '1');
  return state.catalog?.avatars?.find((item) => item.id === id) || null;
}

function trustedAvatarImage(avatarId = '1') {
  const id = String(avatarId || '1');
  const catalogImage = avatarOption(id)?.image || '';
  if (catalogImage) return catalogImage;
  if (String(state.auth?.account?.avatarId || '') === id) return String(state.auth?.account?.avatarUrl || '');
  return '';
}

function motionBehavior() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}

let notificationCenter = null;
let customerAppController = null;
let productGalleryController = null;

function showNotice(type, title, message, options = {}) {
  notificationCenter ||= createNotificationCenter({
    host: $('#toastStack'),
    brand: 'SHELBY STORE',
    soundUrl: '/public/assets/sounds/bildirim.wav'
  });
  return notificationCenter.notify(type, title, message, options);
}

function syncVisualViewport() {
  if (state.viewportFrame) return;
  state.viewportFrame = window.requestAnimationFrame(() => {
    state.viewportFrame = 0;
    const viewport = window.visualViewport;
    const height = Math.max(320, Math.round(viewport?.height || window.innerHeight || document.documentElement.clientHeight || 0));
    const top = Math.max(0, Math.round(viewport?.offsetTop || 0));
    const topbar = $('#topbar');
    const topbarRect = topbar?.getBoundingClientRect?.();
    const topbarHeight = Math.ceil(Number(topbar?.offsetHeight || topbarRect?.height || 0));
    document.documentElement.style.setProperty('--visual-viewport-height', `${height}px`);
    document.documentElement.style.setProperty('--visual-viewport-top', `${top}px`);
    if (topbarHeight >= 48 && topbarHeight <= 160) document.documentElement.style.setProperty('--topbar-space', `${topbarHeight}px`);
  });
}

function installViewportStability() {
  syncVisualViewport();
  const topbar = $('#topbar');
  if (topbar && 'ResizeObserver' in window) {
    state.topbarObserver = new ResizeObserver(syncVisualViewport);
    state.topbarObserver.observe(topbar);
  }
  window.addEventListener('resize', syncVisualViewport, { passive: true });
  window.addEventListener('orientationchange', syncVisualViewport, { passive: true });
  window.visualViewport?.addEventListener('resize', syncVisualViewport, { passive: true });
  window.visualViewport?.addEventListener('scroll', syncVisualViewport, { passive: true });
  document.addEventListener('focusin', (event) => {
    if (!state.activeLayer || !event.target.matches?.('input,textarea,select')) return;
    syncVisualViewport();
    window.setTimeout(() => event.target.scrollIntoView({ block: 'center', inline: 'nearest' }), 180);
  });
}

function installRuntimeSafety() {
  const notify = () => {
    const now = Date.now();
    if (now - state.runtimeNoticeAt < 5000) return;
    state.runtimeNoticeAt = now;
    document.documentElement.dataset.storefrontRuntime = 'recovered';
    showNotice('error', 'İşleminizi tamamlayamadık', 'Kısa süreli bir sorun oluştu. Lütfen birkaç saniye sonra yeniden deneyin.');
  };
  window.addEventListener('unhandledrejection', () => {
    notify();
  });
  window.addEventListener('error', (event) => {
    if (event.error) notify();
  });
}

function productPlaceholder(product, compact = false) {
  return `<div class="product-card__placeholder" style="--product-accent:${escapeHtml(product.accent)}">
    <span class="product-card__placeholder-icon">${iconMarkup(product.icon)}</span>
    ${compact ? '' : `<strong>${escapeHtml(product.name)}</strong><small>PREMIUM ACCESS</small>`}
  </div>`;
}

function productImage(product, { eager = false, compact = false } = {}) {
  if (!product?.image) return productPlaceholder(product, compact);
  return `<img class="product-card__image" src="${escapeHtml(product.image)}?v=${STORE_VERSION}" alt="${escapeHtml(product.name)} ürün görseli" loading="${eager ? 'eager' : 'lazy'}" ${eager ? 'fetchpriority="high"' : ''} decoding="async" draggable="false" data-product-image="${escapeHtml(product.id)}">`;
}

function isTelegramOnly(product = {}) {
  return product?.fulfillmentMode === 'telegram_only';
}

function isTelegramEnabled(product = {}) {
  return product?.telegramEnabled !== false;
}

function stockView(stock = {}, { verified = state.catalog?.stockVerified !== false, product = null } = {}) {
  if (isTelegramOnly(product)) return { state: 'telegram-only', label: 'Otomatik teslimat desteklenmiyor', shortLabel: 'Telegram', icon: 'fa-paper-plane', available: 0, applicable: false };
  const available = Math.max(0, Math.trunc(Number(stock.available) || 0));
  if (!verified || String(stock.state || '') === 'unverified') return { state: 'unverified', label: 'Otomatik teslimat doğrulanamadı', shortLabel: 'Kontrol', icon: 'fa-circle-exclamation', available: 0, applicable: true };
  if (available < 1) return { state: 'out', label: 'Otomatik teslimat stoğu tükendi', shortLabel: 'Tükendi', icon: 'fa-circle-xmark', available: 0, applicable: true };
  if (available <= 3) return { state: 'low', label: `Otomatik teslimata hazır ${available} adet`, shortLabel: `${available} kaldı`, icon: 'fa-fire', available, applicable: true };
  return { state: 'ready', label: `Otomatik teslimata hazır ${available} adet`, shortLabel: `${available} stok`, icon: 'fa-circle-check', available, applicable: true };
}

function salesChannelView(product = {}, stock = stockView(product.stock, { product })) {
  const telegramOnly = isTelegramOnly(product);
  const storefront = state.catalog?.storefront || {};
  const services = storefront.services || {};
  const maintenance = storefront.maintenance === true;
  const telegramOpen = !maintenance && services.telegramSupport !== false && isTelegramEnabled(product);
  const automaticProductOpen = !telegramOnly && product?.automaticEnabled !== false;
  const automaticServiceOpen = !maintenance
    && services.automaticDelivery !== false
    && services.balancePayment !== false;
  const automaticReady = automaticServiceOpen
    && automaticProductOpen
    && (stock.state === 'ready' || stock.state === 'low');
  const deliveryLabel = telegramOnly
    ? 'Teslimat yalnızca Telegram'
    : !automaticProductOpen
      ? 'Otomatik teslimat bu üründe kapalı'
      : !automaticServiceOpen
        ? 'Otomatik teslimat geçici kapalı'
        : stock.state === 'out'
          ? 'Otomatik stok tükendi'
          : stock.state === 'unverified'
            ? 'Otomatik stok kontrol ediliyor'
            : 'Otomatik teslimat hazır';
  const telegramLabel = telegramOpen
    ? (telegramOnly ? 'Telegram siparişi zorunlu' : 'Telegram talebi açık')
    : 'Telegram siparişi kapalı';
  const ctaLabel = automaticReady
    ? 'Detayları Gör'
    : telegramOpen
      ? 'Telegram ile Al'
      : stock.state === 'out'
        ? 'Stok Bildirimi'
        : 'Detayları Gör';
  return Object.freeze({
    automaticReady,
    automaticProductOpen,
    telegramOpen,
    telegramOnly,
    deliveryLabel,
    deliveryIcon: automaticReady ? 'fa-bolt' : telegramOnly ? 'fa-paper-plane' : 'fa-circle-xmark',
    telegramLabel,
    ctaLabel,
    assuranceLabel: automaticReady ? 'Otomatik teslimat' : telegramOpen ? 'Telegram teslimatı' : maintenance ? 'Satış geçici kapalı' : 'Stok bildirimi',
    assuranceIcon: automaticReady ? 'fa-box' : telegramOpen ? 'fa-paper-plane' : maintenance ? 'fa-circle-xmark' : 'fa-bell'
  });
}

function productTagMarkup(product = {}) {
  const definitions = {
    new: { label: 'Yeni', icon: 'fa-star' },
    popular: { label: 'Çok Tercih Edilen', icon: 'fa-fire-flame-curved' },
    discounted: { label: 'İndirimli', icon: 'fa-tags' }
  };
  return (product.tags || [])
    .filter((tag) => tag !== product.badgeKey)
    .map((tag) => {
      const definition = definitions[tag] || { label: tag, icon: 'fa-tag' };
      return `<span class="product-tag product-tag--${escapeHtml(tag)}">${iconMarkup(definition.icon)}<span>${escapeHtml(definition.label)}</span></span>`;
    }).join('');
}

function purchasablePlan(product = {}, requestedKey = '') {
  const plans = Array.isArray(product?.plans) ? product.plans : [];
  const isPurchasable = (plan) => {
    const channel = salesChannelView(product, stockView(plan?.stock, { product }));
    return channel.automaticReady || channel.telegramOpen;
  };
  const requested = requestedKey ? getStorePlan(product, requestedKey) : null;
  if (requested && isPurchasable(requested)) return requested;
  return plans.find(isPurchasable) || null;
}

function productCard(product) {
  const lowest = product.plans.reduce((min, plan) => Math.min(min, plan.priceKurus), Number.MAX_SAFE_INTEGER);
  const stock = stockView(product.stock, { product });
  const channel = salesChannelView(product, stock);
  const defaultPlan = purchasablePlan(product);
  const featured = (product.tags || []).some((tag) => ['new', 'popular', 'discounted'].includes(tag));
  const platformClass = product.platform === 'ios' ? 'ios' : 'android';
  const favorite = state.favorites.has(String(product.id));
  const routeLabel = channel.automaticReady
    ? 'Otomatik teslimata hazır'
    : channel.telegramOpen
      ? 'Telegram siparişi açık'
      : channel.deliveryLabel;
  const routeIcon = channel.automaticReady ? 'fa-bolt' : channel.telegramOpen ? 'fa-paper-plane' : 'fa-circle-xmark';
  return `<article class="product-card product-card--${platformClass} product-card--stock-${stock.state}${featured ? ' product-card--featured' : ''}" data-store-product="${escapeHtml(product.id)}" style="--product-accent:${escapeHtml(product.accent)}">
    <div class="product-card__media">
      ${productImage(product)}
      <button class="product-card__favorite${favorite ? ' is-active' : ''}" type="button" data-store-favorite="${escapeHtml(product.id)}" aria-pressed="${String(favorite)}" aria-label="${escapeHtml(product.name)} ürününü ${favorite ? 'favorilerden çıkar' : 'favorilere ekle'}">${iconMarkup('fa-heart', favorite ? 'fa-solid' : 'fa-regular')}</button>
      <div class="product-card__tags">${productTagMarkup(product)}</div>
      <div class="product-card__badges"><span class="product-badge product-badge--accent product-badge--${escapeHtml(product.badgeTone || 'premium')}">${iconMarkup(product.badgeIcon)}<span>${escapeHtml(product.badge)}</span></span></div>
    </div>
    <div class="product-card__body">
      <div class="product-card__heading">
        <div><span class="product-card__kicker">${escapeHtml(product.badge || 'Premium')}</span><h3 class="product-card__title">${escapeHtml(product.name)}</h3></div>
        <span class="product-card__status is-${stock.state}" role="img" title="${escapeHtml(stock.label)}" aria-label="${escapeHtml(stock.label)}">${iconMarkup(stock.icon)}<small>${escapeHtml(stock.shortLabel || stock.label)}</small></span>
      </div>
      <p class="product-card__description">${escapeHtml(product.description)}</p>
      <div class="sales-channel-stock is-${escapeHtml(channel.automaticReady ? stock.state : channel.telegramOpen ? 'telegram-only' : stock.state)}"><span>${iconMarkup(routeIcon)} ${escapeHtml(routeLabel)}</span></div>
      <div class="product-card__price"><span>${product.plans.length > 1 ? `Başlangıç · ${product.plans.length} paket` : product.plans[0]?.duration || 'Tek paket'}</span><strong>${escapeHtml(formatStorePrice(lowest))}</strong></div>
      <button class="product-card__cta" type="button" data-store-buy="${escapeHtml(product.id)}" data-store-plan="${escapeHtml(defaultPlan?.key || '')}" aria-label="${escapeHtml(product.name)} satın alma detaylarını aç"><span>Detayları Gör</span>${iconMarkup('fa-arrow-right')}</button>
    </div>
  </article>`;
}

function normalizeSearch(value = '') {
  return String(value || '').trim().toLocaleLowerCase('tr-TR').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ı/g, 'i');
}


function filteredProducts() {
  const products = state.catalog?.products || [];
  const query = normalizeSearch(state.searchQuery);
  const visibility = state.catalog?.storefront?.categoryVisibility || {};
  return products.filter((product) => {
    if (!productMatchesCatalogFilter(product, state.activeFilter, state.favorites, visibility)) return false;
    if (!query) return true;
    return normalizeSearch([
      product.name,
      product.category,
      product.game === 'pubg' ? 'PUBG MOBILE' : product.game === 'oxide' ? 'OXIDE OKSİDE' : '',
      product.badge,
      ...(product.tags || []),
      product.platform,
      product.description,
      ...product.plans.flatMap((plan) => [plan.label, plan.duration])
    ].join(' ')).includes(query);
  });
}

function renderCatalog() {
  if (!state.catalog) return;
  state.activeFilter = resolveCatalogFilter(state.activeFilter, state.catalog.storefront?.categoryVisibility || {});
  updateCatalogFilterControls();
  const products = filteredProducts();
  const androidProducts = products.filter((product) => product.platform === 'android');
  const iosProducts = products.filter((product) => product.platform === 'ios');
  const androidSection = $('#androidProducts');
  const iosSection = $('#iosProducts');
  const androidGrid = $('#androidGrid');
  const iosGrid = $('#iosGrid');
  const empty = $('#productsEmpty');

  if (androidGrid) androidGrid.innerHTML = androidProducts.map(productCard).join('');
  if (iosGrid) iosGrid.innerHTML = iosProducts.map(productCard).join('');
  if (androidSection) androidSection.hidden = androidProducts.length === 0;
  if (iosSection) iosSection.hidden = iosProducts.length === 0;
  if (empty) empty.hidden = products.length !== 0;
  const query = normalizeSearch(state.searchQuery);
  const title = query ? 'Arama Sonuçları' : CATALOG_FILTERS[state.activeFilter].label;
  if ($('#catalogTitle')) $('#catalogTitle').textContent = title;
  if ($('#catalogKicker')) $('#catalogKicker').textContent = query ? (state.activeFilter === 'all' ? 'ARAMA' : CATALOG_FILTERS[state.activeFilter].label) : state.activeFilter === 'all' ? 'ÜRÜN KATALOĞU' : 'FİLTRELENMİŞ KOLEKSİYON';
  if ($('#visibleProductCount')) $('#visibleProductCount').textContent = String(products.length);
  if ($('#androidCount')) $('#androidCount').textContent = `${androidProducts.length} ürün`;
  if ($('#iosCount')) $('#iosCount').textContent = `${iosProducts.length} ürün`;
  renderStorefrontConfiguration();
}

function renderStorefrontConfiguration() {
  const storefront = state.catalog?.storefront || {};
  const announcement = storefront.announcement || {};
  const host = $('#storeAnnouncement');
  if (host) {
    host.hidden = announcement.enabled !== true || (!announcement.title && !announcement.message);
    if (!host.hidden) host.innerHTML = `<div class="store-announcement__icon">${iconMarkup(announcement.tone === 'warning' ? 'fa-triangle-exclamation' : announcement.tone === 'success' ? 'fa-circle-check' : 'fa-bullhorn')}</div><div><small>MAĞAZA DUYURUSU</small><strong>${escapeHtml(announcement.title || 'SHELBY STORE')}</strong><p>${escapeHtml(announcement.message || '')}</p></div>${announcement.ctaLabel ? `<button type="button" data-announcement-target="${escapeHtml(announcement.ctaTarget || 'catalog')}">${escapeHtml(announcement.ctaLabel)} ${iconMarkup('fa-arrow-right')}</button>` : ''}`;
    host.dataset.tone = ['info', 'success', 'warning'].includes(announcement.tone) ? announcement.tone : 'info';
  }
  const categoryVisibility = storefront.categoryVisibility || {};
  const androidVisible = categoryVisibility.android !== false;
  const iosVisible = categoryVisibility.ios !== false;
  $$('[data-store-scroll="android"], [data-filter="android"], [data-category-platform="android"]').forEach((control) => { control.hidden = !androidVisible; });
  $$('[data-store-scroll="ios"], [data-filter="ios"], [data-category-platform="ios"]').forEach((control) => { control.hidden = !iosVisible; });

  const quickLinks = renderQuickLinks($('#quickLinksGrid'), storefront.quickLinks || []);
  const officialChannel = quickLinks.find((link) => link.id === 'official-telegram');
  $$('[data-telegram-channel]').forEach((link) => {
    link.hidden = !officialChannel;
    if (officialChannel) link.href = officialChannel.url;
  });
  const requestedSupport = String(storefront.support?.telegramUsername || state.catalog?.telegramUsername || '').replace(/^@+/, '');
  const supportUsername = /^[a-z][a-z0-9_]{4,31}$/i.test(requestedSupport) ? requestedSupport : 'shelbyios';
  $$('[data-telegram-support]').forEach((link) => {
    link.href = `https://t.me/${supportUsername}`;
  });

  const status = $('.topbar-status strong');
  if (status) status.textContent = state.catalog?.stockVerified === false ? 'KONTROL' : storefront.maintenance ? 'BAKIM' : 'AKTİF';
}

async function subscribeSelectedStock() {
  if (!state.selectedProduct || !state.selectedPlan) return;
  if (!requireSignedIn('')) return;
  const requestedUserId = String(state.auth.user?.uid || '');
  const selectedProductId = state.selectedProduct.id;
  const selectedPlanKey = state.selectedPlan.key;
  const button = $('#notifyStockButton');
  setButtonBusy(button, true, 'Bildirim oluşturuluyor...');
  try {
    const payload = await storeApi('/api/store/restock-subscriptions', { method: 'POST', body: { productId: selectedProductId, planKey: selectedPlanKey } });
    if (String(state.auth.user?.uid || '') !== requestedUserId) return;
    if (payload.subscription?.subscribed === true) {
      state.restockSubscriptions.add(cartKey(selectedProductId, selectedPlanKey));
    }
    showNotice(
      'success',
      payload.subscription?.alreadyAvailable ? 'Ürün yeniden stokta' : 'Stok bildiriminiz hazır',
      payload.subscription?.alreadyAvailable
        ? 'Seçtiğiniz paket yeniden hazır. Dilerseniz şimdi sepetinize ekleyebilirsiniz.'
        : 'Seçtiğiniz paket yeniden hazır olduğunda sizi nazikçe bilgilendireceğiz.'
    );
    if (payload.subscription?.alreadyAvailable) await loadCatalog(true);
  } catch (error) {
    if (String(state.auth.user?.uid || '') === requestedUserId) showNotice('error', 'Bildirim tercihinizi kaydedemedik', friendlyStoreError(error));
  }
  finally { setButtonBusy(button, false); renderPurchaseSummary(); }
}

async function loadNotifications() {
  if (!state.auth.user) return;
  const requestedUserId = String(state.auth.user.uid || '');
  const payload = await storeApi('/api/store/notifications?limit=1');
  if (String(state.auth.user?.uid || '') !== requestedUserId) return;
  const unread = (payload.notifications || []).find((item) => item.read !== true);
  if (!unread) return;
  showNotice('info', unread.title || 'Sizin için yeni bir bilgi var', unread.message || 'Hesabınızda yeni bir mağaza bildirimi bulunuyor.');
  await storeApi(`/api/store/notifications/${encodeURIComponent(unread.id)}/read`, { method: 'PATCH', body: {} }).catch(() => null);
}

function updateCatalogFilterControls() {
  $$('#catalog [data-filter]').forEach((button) => {
    const active = button.dataset.filter === state.activeFilter;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function setActiveFilter(value, { scroll = false } = {}) {
  state.activeFilter = resolveCatalogFilter(value, state.catalog?.storefront?.categoryVisibility || {});
  updateCatalogFilterControls();
  renderCatalog();
  if (scroll) {
    const platform = CATALOG_FILTERS[state.activeFilter].platform;
    const target = platform ? $(`#${platform}Products`) : $('#catalog');
    target?.scrollIntoView({ behavior: motionBehavior(), block: 'start' });
  }
}

function setQuickNavActive(action = 'storefront') {
  const normalized = ['storefront', 'catalog', 'android', 'ios'].includes(action) ? action : 'storefront';
  state.storeNavigationAction = normalized;
  $$('[data-store-scroll]').forEach((button) => {
    const active = button.dataset.storeScroll === normalized;
    button.classList.toggle('is-active', active);
    if (button.hasAttribute('aria-pressed')) button.setAttribute('aria-pressed', String(active));
  });
  const mobileAction = ['android', 'ios'].includes(normalized) ? 'catalog' : normalized;
  $$('#mobileBottomNav [data-store-action]').forEach((button) => button.classList.toggle('is-active', button.dataset.storeAction === mobileAction));
}

function scrollToStore(action = 'storefront') {
  const normalized = ['storefront', 'catalog', 'android', 'ios'].includes(action) ? action : 'storefront';
  if (normalized === 'android' || normalized === 'ios') {
    setActiveFilter(normalized);
    const target = $(`#${normalized}Products`);
    (target || $('#catalog'))?.scrollIntoView({ behavior: motionBehavior(), block: 'start' });
  } else {
    const target = $(`#${normalized}`) || $('#storefront');
    target?.scrollIntoView({ behavior: motionBehavior(), block: 'start' });
  }
  setQuickNavActive(normalized);
}

function layerFocusable(layer) {
  if (!layer) return [];
  return $$('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])', layer)
    .filter((node) => !node.hidden && !node.closest('[hidden],[inert]') && node.getClientRects().length > 0);
}

function setPageChromeInert(value) {
  $$('.skip-link,.topbar,.quick-rail,.page-shell,.site-footer,.mobile-nav').forEach((node) => {
    node.inert = !!value;
  });
}

function lockPageScroll() {
  if (document.documentElement.classList.contains('layer-open')) return;
  state.scrollLockY = Math.max(0, Math.round(window.scrollY || window.pageYOffset || 0));
  document.documentElement.style.setProperty('--layer-scroll-top', `-${state.scrollLockY}px`);
  document.documentElement.classList.add('layer-open');
  document.body.classList.add('layer-open');
}

function unlockPageScroll() {
  const scrollY = state.scrollLockY;
  const root = document.documentElement;
  const previousScrollBehavior = root.style.scrollBehavior;
  root.style.scrollBehavior = 'auto';
  document.documentElement.classList.remove('layer-open');
  document.body.classList.remove('layer-open');
  document.documentElement.style.setProperty('--layer-scroll-top', '0px');
  state.scrollLockY = 0;
  window.scrollTo(0, scrollY);
  window.requestAnimationFrame(() => {
    if (!root.classList.contains('layer-open')) window.scrollTo(0, scrollY);
    if (previousScrollBehavior) root.style.scrollBehavior = previousScrollBehavior;
    else root.style.removeProperty('scroll-behavior');
  });
}

function closeDeliveryAccess({ restoreFocus = true } = {}) {
  const dialog = $('#deliveryAccessModal');
  if (!dialog || dialog.hidden) return false;
  const target = state.deliveryAccessFocus;
  state.deliveryAccessSequence += 1;
  dialog.hidden = true;
  dialog.inert = true;
  dialog.setAttribute('aria-hidden', 'true');
  state.deliveryAccessOrderId = '';
  state.deliveryAccessFocus = null;
  $$('#customerApp [data-customer-main]').forEach((section) => { section.inert = false; });
  $('#customerApp [data-customer-shell]')?.setAttribute('aria-modal', 'true');
  if (restoreFocus && target instanceof HTMLElement && document.contains(target)) target.focus({ preventScroll: true });
  return true;
}

function setDeliveryAccessPhase(phase = 0, description = '') {
  const normalized = Math.max(0, Math.min(3, Number(phase) || 0));
  $$('[data-delivery-access-step]', $('#deliveryAccessModal')).forEach((step) => {
    const index = Number(step.dataset.deliveryAccessStep || 0);
    step.classList.toggle('is-complete', index < normalized || normalized === 3);
    step.classList.toggle('is-current', normalized < 3 && index === normalized);
  });
  const progress = $('#deliveryAccessProgress');
  if (progress) progress.style.setProperty('--delivery-progress', `${normalized === 3 ? 100 : 18 + (normalized * 32)}%`);
  if (description && $('#deliveryAccessDescription')) $('#deliveryAccessDescription').textContent = description;
}

function openDeliveryAccess(orderId = '', trigger = null) {
  const id = String(orderId || '').trim();
  const order = state.orders.find((item) => item.id === id);
  const dialog = $('#deliveryAccessModal');
  if (!dialog || !state.auth.user || state.activeLayer !== $('#customerApp') || !order?.deliveryVisible || order.status !== 'delivered') return false;
  if (customerAppController?.action && !customerAppController.closeAction({ restoreFocus: false })) return false;
  if (!dialog.hidden) closeDeliveryAccess({ restoreFocus: false });
  const sequence = state.deliveryAccessSequence + 1;
  state.deliveryAccessSequence = sequence;
  state.deliveryAccessOrderId = id;
  state.deliveryAccessFocus = trigger instanceof HTMLElement ? trigger : document.activeElement;
  if ($('#deliveryAccessOrderNumber')) $('#deliveryAccessOrderNumber').textContent = `#${order.orderNumber}`;
  setDeliveryAccessPhase(0, 'Güvenli hesap oturumunuz kontrol ediliyor.');
  $$('#customerApp [data-customer-main]').forEach((section) => { section.inert = true; });
  $('#customerApp [data-customer-shell]')?.setAttribute('aria-modal', 'false');
  dialog.hidden = false;
  dialog.inert = false;
  dialog.setAttribute('aria-hidden', 'false');
  window.setTimeout(() => {
    if (state.deliveryAccessSequence === sequence) setDeliveryAccessPhase(1, 'Sipariş sahipliği sunucuda doğrulanıyor.');
  }, 900);
  window.setTimeout(() => {
    if (state.deliveryAccessSequence === sequence) setDeliveryAccessPhase(2, 'Şifreli teslimat kasası güvenle açılıyor.');
  }, 1_900);
  window.requestAnimationFrame(() => $('[data-delivery-access-close]', dialog)?.focus({ preventScroll: true }));
  void openDelivery(id, sequence);
  return true;
}

function closeActiveLayer({ restoreFocus = true } = {}) {
  const layer = state.activeLayer;
  if (!layer) return;
  if (layer === $('#customerApp')) {
    closeDeliveryAccess({ restoreFocus: false });
    customerAppController?.closeAction({ restoreFocus: false, force: true });
  }
  if (layer === $('#purchaseModal')) {
    productGalleryController?.destroy();
    productGalleryController = null;
    state.selectedProduct = null;
    state.selectedPlan = null;
  }
  layer.classList.remove('is-open');
  layer.setAttribute('aria-hidden', 'true');
  layer.inert = true;
  state.activeLayer = null;
  unlockPageScroll();
  setPageChromeInert(false);
  if (restoreFocus && state.previousFocus instanceof HTMLElement && document.contains(state.previousFocus)) state.previousFocus.focus();
  state.previousFocus = null;
  setQuickNavActive(state.storeNavigationAction);
}

function openLayer(layer, trigger = null) {
  if (!layer) return;
  if (state.activeLayer && state.activeLayer !== layer) closeActiveLayer({ restoreFocus: false });
  state.previousFocus = trigger instanceof HTMLElement ? trigger : document.activeElement;
  state.activeLayer = layer;
  layer.inert = false;
  setPageChromeInert(true);
  layer.classList.add('is-open');
  layer.setAttribute('aria-hidden', 'false');
  lockPageScroll();
  $('.customer-main,.side-sheet__body', layer)?.scrollTo({ top: 0, left: 0 });
  window.requestAnimationFrame(() => layerFocusable(layer)[0]?.focus());
}

function openPurchase(productId, planKey = '', trigger = null) {
  const product = getStoreProduct(state.catalog, productId);
  if (!product) return;
  state.selectedProduct = product;
  state.selectedPlan = purchasablePlan(product, planKey);
  const productStock = stockView(product.stock, { product });
  const productChannel = salesChannelView(product, productStock);
  productGalleryController?.destroy();
  productGalleryController = installProductGallery($('#purchaseImage'), product);
  if ($('#purchaseBadges')) $('#purchaseBadges').innerHTML = `<span>${iconMarkup(product.platform === 'ios' ? 'fa-apple' : 'fa-android', 'fa-brands')} ${escapeHtml(platformName(product.platform))}</span><span>${iconMarkup(product.badgeIcon)} ${escapeHtml(product.badge)}</span><span class="is-stock-${productStock.state}">${iconMarkup(productStock.icon)} ${escapeHtml(productStock.label)}</span>${productTagMarkup(product)}`;
  if ($('#purchaseTitle')) $('#purchaseTitle').textContent = product.name;
  if ($('#purchaseDescription')) $('#purchaseDescription').textContent = product.description;
  if ($('#purchaseDeliveryAssurance')) $('#purchaseDeliveryAssurance').innerHTML = `${iconMarkup(productChannel.assuranceIcon)} ${escapeHtml(productChannel.assuranceLabel)}`;
  if ($('#purchasePlans')) {
    $('#purchasePlans').innerHTML = product.plans.map((plan) => {
      const stock = stockView(plan.stock, { product });
      const channel = salesChannelView(product, stock);
      const selected = plan.key === state.selectedPlan?.key;
      const telegramRoute = !channel.automaticReady && channel.telegramOpen;
      const routeLabel = channel.automaticReady
        ? (channel.telegramOpen ? 'Otomatik teslimat · Telegram alternatifi' : 'Otomatik teslimat')
        : channel.telegramOpen ? 'Telegram ile sipariş' : channel.deliveryLabel;
      return `<button class="plan-option${selected ? ' is-selected' : ''}${telegramRoute ? ' is-telegram-route' : ''} is-stock-${stock.state}" type="button" data-purchase-plan="${escapeHtml(plan.key)}" aria-pressed="${String(selected)}">${iconMarkup('fa-clock')}<span><strong>${escapeHtml(plan.label)}</strong><small>${escapeHtml(plan.duration)} · ${escapeHtml(routeLabel)}</small></span><b>${escapeHtml(formatStorePrice(plan.priceKurus))}</b></button>`;
    }).join('');
  }
  renderPurchaseSummary();
  openLayer($('#purchaseModal'), trigger);
}

function renderPurchaseSummary() {
  const product = state.selectedProduct;
  const plan = state.selectedPlan;
  if (!product || !$('#purchaseSummary')) return;
  if (!plan) {
    $('#purchaseSummary').innerHTML = `<span><small>PAKET DURUMU</small><b>Şu anda satın alınabilir paket bulunmuyor.</b><em class="purchase-stock is-out">Bildirim almak için aşağıdan bir paket seçebilirsin.</em></span><strong>—</strong>`;
    if ($('#purchaseDeliveryAssurance')) $('#purchaseDeliveryAssurance').innerHTML = `${iconMarkup('fa-bell')} Stok bildirimi kullanılabilir`;
    $$('#purchasePlans [data-purchase-plan]').forEach((button) => {
      button.classList.remove('is-selected');
      button.setAttribute('aria-pressed', 'false');
    });
    const add = $('#addToCartButton');
    const telegram = $('#buyTelegramButton');
    const notification = $('#notifyStockButton');
    if (add) { add.disabled = true; $('span', add).textContent = 'Satın Alınabilir Paket Yok'; }
    if (telegram) { telegram.disabled = true; $('span', telegram).textContent = 'Telegram Siparişi Kapalı'; }
    if (notification) notification.hidden = true;
    return;
  }
  const stock = stockView(plan.stock, { product });
  const channel = salesChannelView(product, stock);
  const maintenance = state.catalog?.storefront?.maintenance === true;
  const automaticUnavailable = !channel.automaticReady;
  const telegramUnavailable = !channel.telegramOpen;
  const routeLabel = channel.automaticReady
    ? (channel.telegramOpen ? 'Otomatik teslimat hazır · Telegram alternatifi açık' : 'Otomatik teslimat hazır')
    : channel.telegramOpen ? 'Telegram siparişi açık' : channel.deliveryLabel;
  $('#purchaseSummary').innerHTML = `<span><small>SEÇİLEN PAKET</small><b>${escapeHtml(product.name)} · ${escapeHtml(platformName(product.platform))} · ${escapeHtml(plan.label)}</b><em class="purchase-stock is-${stock.state}">${escapeHtml(routeLabel)}</em></span><strong>${escapeHtml(formatStorePrice(plan.priceKurus))}</strong>`;
  if ($('#purchaseDeliveryAssurance')) $('#purchaseDeliveryAssurance').innerHTML = `${iconMarkup(channel.assuranceIcon)} ${escapeHtml(channel.assuranceLabel)}`;
  $$('#purchasePlans [data-purchase-plan]').forEach((button) => {
    const active = button.dataset.purchasePlan === plan.key;
    button.classList.toggle('is-selected', active);
    button.setAttribute('aria-pressed', String(active));
  });
  const add = $('#addToCartButton');
  const telegram = $('#buyTelegramButton');
  if (add) {
    add.disabled = automaticUnavailable;
    $('span', add).textContent = maintenance ? 'Satış Geçici Kapalı' : automaticUnavailable ? 'Otomatik Satış Kullanılamıyor' : 'Sepete Ekle';
  }
  if (telegram) {
    telegram.disabled = telegramUnavailable;
    $('span', telegram).textContent = telegramUnavailable ? 'Telegram Siparişi Kapalı' : 'Telegram ile Al';
  }
  const notification = $('#notifyStockButton');
  if (notification) {
    notification.hidden = channel.telegramOnly || !(state.catalog?.stockVerified !== false && stock.available < 1);
    const subscribed = state.restockSubscriptions.has(cartKey(product.id, plan.key));
    notification.disabled = subscribed;
    notification.classList.toggle('is-confirmed', subscribed);
    notification.innerHTML = `${iconMarkup(subscribed ? 'fa-circle-check' : 'fa-bell')}<span>${subscribed ? 'Otomatik stok bildirimi aktif' : 'Otomatik stok gelince bildir'}</span>`;
  }
}

function cartKey(productId, planKey) {
  return `${productId}:${planKey}`;
}

function resetCheckoutAttempt() {
  state.checkoutAttempt = null;
}

function clearAppliedPromotion({ message = '' } = {}) {
  state.promotion = null;
  resetCheckoutAttempt();
  const status = $('#cartPromotionStatus');
  if (status) {
    status.className = 'promotion-form__status';
    status.textContent = message;
  }
}

function animateFlyToCart() {
  if (typeof window.matchMedia !== 'function' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const source = $('#purchaseImage .product-gallery__slide.is-active img, #purchaseImage img, #purchaseImage [data-product-image]');
  const destination = $('#cartButton:not([hidden])') || $('.mobile-nav [data-store-action="cart"]:not([hidden])');
  if (!source || !destination || typeof source.animate !== 'function') return;
  const start = source.getBoundingClientRect();
  const finish = destination.getBoundingClientRect();
  if (!start.width || !start.height || !finish.width || !finish.height) return;
  const flyer = source.cloneNode(true);
  flyer.removeAttribute('id');
  flyer.setAttribute('aria-hidden', 'true');
  Object.assign(flyer.style, {
    position: 'fixed', left: `${start.left}px`, top: `${start.top}px`,
    width: `${start.width}px`, height: `${start.height}px`, objectFit: 'cover',
    borderRadius: '18px', pointerEvents: 'none', zIndex: '220', willChange: 'transform, opacity'
  });
  document.body.appendChild(flyer);
  const x = finish.left + finish.width / 2 - start.left - start.width / 2;
  const y = finish.top + finish.height / 2 - start.top - start.height / 2;
  const movement = flyer.animate([
    { transform: 'translate3d(0, 0, 0) scale(1)', opacity: 0.86 },
    { transform: `translate3d(${x * 0.56}px, ${y * 0.7 - 28}px, 0) scale(0.48)`, opacity: 0.75, offset: 0.62 },
    { transform: `translate3d(${x}px, ${y}px, 0) scale(0.12)`, opacity: 0 }
  ], { duration: 520, easing: 'cubic-bezier(.22,.76,.28,1)', fill: 'forwards' });
  movement.addEventListener('finish', () => flyer.remove(), { once: true });
  movement.addEventListener('cancel', () => flyer.remove(), { once: true });
}

function addToCart(product, plan, quantity = 1) {
  if (!product || !plan) return;
  const key = cartKey(product.id, plan.key);
  const current = state.cart.get(key) || { productId: product.id, planKey: plan.key, quantity: 0 };
  current.quantity = Math.min(5, Math.max(1, current.quantity + Math.max(1, Number(quantity) || 1)));
  state.cart.set(key, current);
  clearAppliedPromotion({ message: 'Sepet değiştiği için indirim kodunu yeniden doğrulayın.' });
  renderCart();
  animateFlyToCart();
  showNotice('success', 'Ürün sepetinize eklendi', `${product.name} · ${platformName(product.platform)} · ${plan.label}`);
}

function cartLines() {
  if (!state.catalog) return [];
  return [...state.cart.values()].map((line) => {
    const product = getStoreProduct(state.catalog, line.productId);
    const plan = getStorePlan(product, line.planKey);
    if (!product || !plan) return null;
    const quantity = Math.max(1, Math.min(5, Number(line.quantity) || 1));
    return { ...line, quantity, product, plan, lineTotalKurus: plan.priceKurus * quantity };
  }).filter(Boolean);
}

function cartSignature(method = state.paymentMethod, lines = cartLines()) {
  return `${method}|${state.promotion?.code || ''}|${lines.map((line) => `${line.product.id}:${line.plan.key}:${line.quantity}`).sort().join('|')}`;
}

function checkoutIdempotencyKey(method, lines) {
  const signature = cartSignature(method, lines);
  if (!state.checkoutAttempt || state.checkoutAttempt.signature !== signature) {
    state.checkoutAttempt = { signature, key: createRequestId('order') };
  }
  return state.checkoutAttempt.key;
}

function cartItemMarkup(line) {
  const telegramOnly = isTelegramOnly(line.product);
  const stock = stockView(line.plan.stock, { product: line.product });
  const insufficient = !telegramOnly && stock.available < line.quantity;
  const lowStock = !telegramOnly && stock.available > 0 && stock.available <= 3;
  const stockLabel = telegramOnly ? 'Telegram ile sipariş' : lowStock ? `Son ${stock.available} ürün` : stock.label;
  return renderCartItemView({
    key: cartKey(line.product.id, line.plan.key),
    name: line.product.name,
    plan: line.plan.label,
    mediaHtml: productImage(line.product, { compact: true }),
    stockLabel,
    stockTone: insufficient ? 'danger' : lowStock || telegramOnly ? 'warning' : 'ready',
    quantity: line.quantity,
    lineTotal: formatStorePrice(line.lineTotalKurus),
    disableIncrease: line.quantity >= 5
  });
}

function renderCart() {
  const lines = cartLines();
  const totalQuantity = lines.reduce((total, line) => total + line.quantity, 0);
  const subtotalKurus = lines.reduce((total, line) => total + line.lineTotalKurus, 0);
  if (state.promotion && Number(state.promotion.subtotalKurus) !== subtotalKurus) clearAppliedPromotion();
  const discountKurus = state.promotion ? Math.max(0, Number(state.promotion.discountKurus || 0)) : 0;
  const totalKurus = Math.max(0, subtotalKurus - discountKurus);
  const hasItems = lines.length > 0;
  if ($('#cartItems')) $('#cartItems').innerHTML = lines.map(cartItemMarkup).join('');
  if ($('#cartEmpty')) {
    $('#cartEmpty').hidden = hasItems;
    $('#cartEmpty').inert = hasItems;
  }
  if ($('#cartContent')) {
    $('#cartContent').hidden = !hasItems;
    $('#cartContent').inert = !hasItems;
  }
  if ($('#cartFooter')) {
    $('#cartFooter').hidden = !hasItems;
    $('#cartFooter').inert = !hasItems;
  }
  if ($('#cartClearButton')) $('#cartClearButton').hidden = !hasItems;
  if ($('#cartSelectedSummary')) $('#cartSelectedSummary').textContent = hasItems
    ? `${totalQuantity} ürün seçildi`
    : 'Sepetindeki ürünleri güvenle incele.';
  if ($('#cartLineCount')) $('#cartLineCount').textContent = String(totalQuantity);
  if ($('#cartSubtotal')) $('#cartSubtotal').textContent = formatStorePrice(subtotalKurus);
  if ($('#cartDiscount')) $('#cartDiscount').textContent = `−${formatStorePrice(discountKurus)}`;
  if ($('#cartDiscountRow')) $('#cartDiscountRow').hidden = discountKurus < 1;
  if ($('#cartTotal')) $('#cartTotal').textContent = formatStorePrice(totalKurus);
  if ($('#cartCount')) {
    $('#cartCount').textContent = String(totalQuantity);
    $('#cartCount').hidden = totalQuantity < 1;
  }
  if ($('#mobileCartCount')) {
    $('#mobileCartCount').textContent = String(totalQuantity);
    $('#mobileCartCount').hidden = totalQuantity < 1;
  }
  const customerHeaderAction = $('#customerHeaderAction');
  if (customerHeaderAction?.dataset.customerHeaderAction === 'cart') {
    customerHeaderAction.hidden = !hasItems;
    customerHeaderAction.inert = !hasItems;
  }
  syncPaymentChoice();
}

async function applyCartPromotion(event) {
  event?.preventDefault();
  if (state.promotionBusy || !requireSignedIn('cart')) return;
  const input = $('#cartPromotionCode');
  const code = String(input?.value || '').trim().toLocaleUpperCase('en-US');
  if (!/^[A-Z0-9][A-Z0-9_-]{2,31}$/.test(code)) {
    return showNotice('warning', 'İndirim kodunu kontrol edin', 'Kampanya kodu en az üç karakter olmalıdır.');
  }
  const lines = cartLines();
  if (!lines.length) return;
  const requestedUserId = String(state.auth.user?.uid || '');
  const formButton = $('#cartPromotionForm button[type="submit"]');
  state.promotionBusy = true;
  setButtonBusy(formButton, true, 'Kontrol');
  try {
    const response = await storeApi('/api/store/promotions/validate', {
      method: 'POST',
      body: {
        code,
        items: lines.map((line) => ({ productId: line.product.id, planKey: line.plan.key, quantity: line.quantity }))
      }
    });
    if (String(state.auth.user?.uid || '') !== requestedUserId) return;
    state.promotion = response.promotion || null;
    resetCheckoutAttempt();
    if (input) input.value = state.promotion?.code || code;
    const status = $('#cartPromotionStatus');
    if (status) {
      status.className = 'promotion-form__status is-success';
      status.textContent = `${state.promotion.title} · ${formatStorePrice(state.promotion.discountKurus)} indirim uygulandı.`;
    }
    renderCart();
    showNotice('success', 'Kampanya doğrulandı', 'İndirim tutarı güvenli şekilde sunucuda hesaplandı.');
  } catch (error) {
    if (String(state.auth.user?.uid || '') !== requestedUserId) return;
    clearAppliedPromotion({ message: friendlyStoreError(error) });
    $('#cartPromotionStatus')?.classList.add('is-error');
    renderCart();
  } finally {
    state.promotionBusy = false;
    setButtonBusy(formButton, false);
  }
}

function syncPaymentChoice() {
  const lines = cartLines();
  const services = state.catalog?.storefront?.services || {};
  const balance = Math.max(0, Number(state.auth.account?.balanceKurus || 0));
  const subtotal = lines.reduce((total, line) => total + Math.max(0, Number(line.lineTotalKurus || 0)), 0);
  const discount = Math.min(subtotal, Math.max(0, Number(state.promotion?.discountKurus || 0)));
  const insufficientBalance = lines.length > 0 && balance < subtotal - discount;
  const hasTelegramOnlyProduct = lines.some((line) => isTelegramOnly(line.product));
  const invalidStock = state.catalog?.stockVerified === false || lines.some((line) => !isTelegramOnly(line.product) && Number(line.plan.stock?.available || 0) < line.quantity);
  const maintenance = state.catalog?.storefront?.maintenance === true;
  const walletDisabled = hasTelegramOnlyProduct || maintenance || invalidStock || insufficientBalance || services.automaticDelivery === false || services.balancePayment === false;
  const telegramDisabled = maintenance || services.telegramSupport === false || lines.some((line) => !isTelegramEnabled(line.product));
  const walletInput = $('input[name="paymentMethod"][value="wallet"]');
  const telegramInput = $('input[name="paymentMethod"][value="telegram"]');
  if (walletInput) {
    walletInput.disabled = walletDisabled;
    const walletCard = walletInput.closest('.payment-choice__item');
    walletCard?.classList.toggle('is-disabled', walletDisabled);
    walletCard?.classList.toggle('is-insufficient', insufficientBalance);
  }
  if (telegramInput) { telegramInput.disabled = telegramDisabled; telegramInput.closest('.payment-choice__item')?.classList.toggle('is-disabled', telegramDisabled); }
  if (state.paymentMethod === 'wallet' && walletDisabled && !telegramDisabled) { state.paymentMethod = 'telegram'; if (telegramInput) telegramInput.checked = true; }
  if (state.paymentMethod === 'telegram' && telegramDisabled && !walletDisabled) { state.paymentMethod = 'wallet'; if (walletInput) walletInput.checked = true; }
  $$('.payment-choice__item').forEach((label) => {
    const input = $('input[name="paymentMethod"]', label);
    label.classList.toggle('is-selected', !!input?.checked && !input.disabled);
  });
  const checkout = $('#checkoutButton');
  const telegramCheckout = $('#telegramCheckoutButton');
  if (checkout) {
    checkout.className = 'button button--primary button--large button--full';
    checkout.innerHTML = `${iconMarkup('fa-wallet')}<span>Bakiyeyle satın al</span>`;
    checkout.disabled = walletDisabled;
    if (walletDisabled) checkout.title = maintenance
      ? 'Mağaza bakım modunda'
      : hasTelegramOnlyProduct
        ? 'Bu ürün yalnızca Telegram üzerinden sipariş edilebilir'
        : insufficientBalance
          ? 'Mevcut bakiyen bu sipariş için yetersiz'
          : 'Otomatik teslimat stoğu veya bakiye kanalı uygun değil';
    else checkout.removeAttribute('title');
  }
  if (telegramCheckout) {
    telegramCheckout.disabled = telegramDisabled;
    if (telegramDisabled) telegramCheckout.title = maintenance ? 'Mağaza bakım modunda' : 'Telegram sipariş kanalı kapalı';
    else telegramCheckout.removeAttribute('title');
  }
  if ($('#cartWalletAmount')) $('#cartWalletAmount').textContent = formatTopbarBalance(balance);
  if ($('#cartWalletBalance')) $('#cartWalletBalance').textContent = `Mevcut bakiye: ${formatStorePrice(balance)}${hasTelegramOnlyProduct ? ' · Bu ürün için Telegram siparişi gerekli' : insufficientBalance ? ' · Bakiye yetersiz' : invalidStock ? ' · Otomatik stok yetersiz' : ''}`;
}

function setButtonBusy(button, busy, busyLabel = 'İşlem yapılıyor...') {
  if (!button) return;
  if (busy) {
    if (!button.dataset.originalHtml) {
      button.dataset.originalHtml = button.innerHTML;
      button.dataset.originalDisabled = String(button.disabled);
    }
    button.disabled = true;
    button.innerHTML = `${iconMarkup('fa-spinner')}<span>${escapeHtml(busyLabel)}</span>`;
  } else {
    button.disabled = button.dataset.originalDisabled === 'true';
    if (button.dataset.originalHtml) button.innerHTML = button.dataset.originalHtml;
    delete button.dataset.originalHtml;
    delete button.dataset.originalDisabled;
  }
}

function requireSignedIn(returnLayer = '') {
  if (state.auth.user) return true;
  state.pendingLayer = returnLayer;
  setAuthTab('login');
  openLayer($('#authSheet'));
  showNotice('info', 'Devam etmek için giriş yapın', 'Sipariş, bakiye ve teslimat işlemlerine güvenle devam etmek için lütfen hesabınıza giriş yapın.');
  return false;
}

function openTelegramTarget(url, reservedWindow = null) {
  if (!/^https:\/\/t\.me\//i.test(String(url || ''))) {
    reservedWindow?.close();
    throw new Error('Telegram bağlantısı doğrulanamadı.');
  }
  if (reservedWindow && !reservedWindow.closed) {
    reservedWindow.opener = null;
    reservedWindow.location.replace(url);
    return;
  }
  const opened = window.open(url, '_blank', 'noopener,noreferrer');
  if (!opened) window.location.assign(url);
}

function reserveTelegramWindow() {
  try {
    const target = window.open('', '_blank');
    if (target) {
      target.opener = null;
      target.document.title = 'Telegram açılıyor';
      target.document.body.style.cssText = 'margin:0;background:#08050d;color:#fff;font:600 16px system-ui;display:grid;place-items:center;min-height:100vh';
      target.document.body.textContent = 'Telegram siparişin hazırlanıyor…';
    }
    return target;
  } catch (_) {
    return null;
  }
}

async function submitOrder(lines, paymentMethod, options = {}) {
  if (!lines.length) return;
  if (!requireSignedIn(options.returnLayer || 'cart')) return;
  const requestedUserId = String(state.auth.user?.uid || '');
  const button = options.button || $('#checkoutButton');
  const telegramWindow = paymentMethod === 'telegram' ? reserveTelegramWindow() : null;
  setButtonBusy(button, true, paymentMethod === 'telegram' ? 'Telegram siparişi hazırlanıyor...' : 'Bakiye doğrulanıyor...');
  try {
    const payload = await storeApi('/api/store/orders', {
      method: 'POST',
      body: {
        items: lines.map((line) => ({ productId: line.product.id, planKey: line.plan.key, quantity: line.quantity })),
        paymentMethod,
        idempotencyKey: options.idempotencyKey || checkoutIdempotencyKey(paymentMethod, lines),
        ...((options.clearCart || options.applyPromotion) && state.promotion?.code ? { promotionCode: state.promotion.code } : {})
      },
      timeoutMs: 75_000
    });
    if (String(state.auth.user?.uid || '') !== requestedUserId) {
      telegramWindow?.close();
      return;
    }
    if (state.auth.account && Number.isFinite(Number(payload.balanceKurus))) {
      state.auth.account.balanceKurus = Number(payload.balanceKurus);
      renderAccountHeader();
    }
    if (payload.order) {
      state.orders = [payload.order, ...state.orders.filter((order) => order.id !== payload.order.id)];
      state.ordersLoadedAt = Date.now();
      renderOrders();
    }
    if (options.clearCart) {
      state.cart.clear();
      clearAppliedPromotion();
      if ($('#cartPromotionCode')) $('#cartPromotionCode').value = '';
      renderCart();
    } else if (options.resetAttemptOnSuccess) {
      resetCheckoutAttempt();
    }
    if (options.closeLayer && state.activeLayer) closeActiveLayer({ restoreFocus: false });
    if (paymentMethod === 'telegram') {
      showNotice('success', 'Siparişiniz oluşturuldu', `${payload.order?.orderNumber || 'SHELBY STORE siparişiniz'} hesabınıza başarıyla kaydedildi.`);
      openTelegramTarget(payload.telegramUrl, telegramWindow);
    }
    await Promise.allSettled([refreshStoreAccount(), loadCatalog(true), loadOrders(true)]);
    if (String(state.auth.user?.uid || '') !== requestedUserId) return;
    if (paymentMethod === 'wallet') {
      const completedOrder = state.orders.find((order) => order.id === payload.order?.id) || payload.order;
      const deliveryReady = completedOrder?.deliveryVisible === true;
      const outcome = String(payload.fulfillmentOutcome || '');
      const reserved = outcome === 'review' || completedOrder?.paymentState === 'reserved' || completedOrder?.status === 'processing';
      const released = outcome === 'failed' || completedOrder?.paymentState === 'released' || completedOrder?.status === 'cancelled';
      if (released) {
        showNotice('warning', 'Satın alma tamamlanamadı', 'Ürün tedariki güvenli şekilde tamamlanamadı. Ayrılan tutar bakiyenize geri bırakıldı; kalıcı bir kesinti yapılmadı.', {
          actionLabel: 'Siparişimi Görüntüle', actionIcon: 'fa-box', duration: 11_000, onAction: () => openCustomer('orders')
        });
      } else if (reserved) {
        showNotice('info', 'Siparişiniz güvenle doğrulanıyor', 'Satın alma sonucu kesinleştirilirken tutar geçici olarak rezervasyonda tutuluyor. Aynı sipariş otomatik olarak tekrarlanmayacak; güncel durumu hesabınızdan takip edebilirsiniz.', {
          actionLabel: 'Siparişimi Görüntüle', actionIcon: 'fa-shield-halved', duration: 12_000, onAction: () => openCustomer('orders')
        });
      } else {
        showNotice(
          'success',
          deliveryReady ? 'Teslimat bilgileriniz hazır' : 'Satın alma işleminiz tamamlandı',
          deliveryReady
            ? 'Ödemeniz tamamlandı. Dijital ürününüz hesabınızdaki Teslim alanına güvenle eklendi.'
            : 'Ödemeniz tamamlandı. Siparişinizin güncel durumunu hesabınızdan takip edebilirsiniz.',
          {
            actionLabel: deliveryReady ? 'Teslimat Bilgilerini Görüntüle' : 'Siparişimi Görüntüle',
            actionIcon: deliveryReady ? 'fa-key' : 'fa-box',
            duration: 10_000,
            onAction: () => openCustomer(deliveryReady ? 'deliveries' : 'orders')
          }
        );
      }
    }
  } catch (error) {
    telegramWindow?.close();
    if (String(state.auth.user?.uid || '') !== requestedUserId) return;
    if (!isUncertainMutationError(error)) resetCheckoutAttempt();
    showNotice('error', 'Siparişinizi tamamlayamadık', friendlyStoreError(error));
  } finally {
    setButtonBusy(button, false);
    if (button === $('#checkoutButton')) syncPaymentChoice();
  }
}

function formatOrderDate(value = 0) {
  const date = new Date(Number(value) || 0);
  if (Number.isNaN(date.getTime())) return 'Tarih bilgisi yok';
  return new Intl.DateTimeFormat('tr-TR', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function clientTelegramMessage(order) {
  const lines = ['Merhaba, SHELBY STORE üzerinden Telegram ile sipariş vermek istiyorum.', `Sipariş No: ${order.orderNumber}`];
  (order.items || []).forEach((item, index) => {
    const prefix = (order.items || []).length > 1 ? `${index + 1}. ` : '';
    lines.push(
      `${prefix}Ürün: ${item.productName}`,
      `${prefix}Paket: ${item.planLabel}`,
      `${prefix}Adet: ${item.quantity}`,
      `${prefix}Tutar: ${formatStorePrice(item.lineTotalKurus)}`,
      `${prefix}Platform: ${platformName(item.platform)}`
    );
  });
  if (Number(order.discountKurus || 0) > 0) {
    lines.push(`Ara toplam: ${formatStorePrice(order.subtotalKurus)}`);
    lines.push(`İndirim (${order.promotion?.code || 'Kampanya'}): -${formatStorePrice(order.discountKurus)}`);
  }
  lines.push(`Ödenecek toplam: ${formatStorePrice(order.totalKurus)}`);
  lines.push('Siparişimin ödeme ve stok durumunun kontrol edilmesini rica ederim.');
  return lines.join('\n');
}

function telegramOrderUrl(order) {
  const username = state.catalog?.telegramUsername || 'shelbyios';
  return `https://t.me/${encodeURIComponent(username)}?text=${encodeURIComponent(clientTelegramMessage(order))}`;
}

function orderProductVisual(order = {}) {
  const item = Array.isArray(order.items) ? order.items[0] : null;
  const product = item?.productId ? getStoreProduct(state.catalog, item.productId) : null;
  if (product) return productImage(product, { compact: true, eager: true });
  return productPlaceholder({
    id: String(item?.productId || 'store-product'),
    name: String(item?.productName || 'SHELBY STORE'),
    accent: '#e64067',
    icon: 'fa-box-open'
  }, true);
}

function orderCardMarkup(order) {
  return renderOrderCardView(order, {
    status: ORDER_STATUS[order.status] || ORDER_STATUS.awaiting_payment,
    mediaHtml: orderProductVisual(order),
    formatPrice: formatStorePrice,
    formatDate: formatOrderDate,
    telegramUrl: telegramOrderUrl,
    cancelConfirmId: state.cancelConfirmOrderId,
    busyOrderId: state.orderOperationId
  });
}

function deliveryCardMarkup(order) {
  return renderDeliveryCardView(order, {
    mediaHtml: orderProductVisual(order),
    openedDelivery: state.deliverySecrets.get(order.id),
    formatDate: formatOrderDate
  });
}

function clearExposedDeliverySecrets({ rerender = true } = {}) {
  state.deliverySecretTimers.forEach((timer) => window.clearTimeout(timer));
  state.deliverySecretTimers.clear();
  state.deliverySecrets.clear();
  if (rerender) renderOrders();
}

function clearCustomerSessionState({ closeProtectedLayer = false } = {}) {
  if (closeProtectedLayer && state.activeLayer === $('#customerApp')) {
    closeActiveLayer({ restoreFocus: false });
  }
  state.cart.clear();
  state.orders = [];
  state.ordersLoadedAt = 0;
  state.ordersPromise = null;
  state.orderNextCursor = '';
  state.orderPageLoading = false;
  state.orderOperationId = '';
  state.cancelConfirmOrderId = '';
  state.deliveryAccessSequence += 1;
  state.deliveryAccessOrderId = '';
  state.deliveryAccessFocus = null;
  state.orderFilter = 'all';
  state.orderSearch = '';
  state.couponFilter = 'available';
  state.paymentMethod = 'wallet';
  state.promotions = [];
  state.promotionsLoadedAt = 0;
  state.promotionsPromise = null;
  state.promotionBusy = false;
  state.restockSubscriptions.clear();
  if ($('#couponHeroCount')) $('#couponHeroCount').textContent = '0';
  if ($('#accountCouponCode')) $('#accountCouponCode').value = '';
  if ($('#cartPromotionCode')) $('#cartPromotionCode').value = '';
  if ($('#orderSearchInput')) $('#orderSearchInput').value = '';
  const orderSearch = $('#orderSearchForm');
  if (orderSearch) {
    orderSearch.hidden = true;
    orderSearch.inert = true;
  }
  $('#couponWallet')?.replaceChildren();
  clearAppliedPromotion();
  clearExposedDeliverySecrets({ rerender: false });
  renderOrders();
  renderCart();
}

async function openDelivery(orderId = '', accessSequence = 0) {
  const id = String(orderId || '').trim();
  const requestedUserId = String(state.auth.user?.uid || '');
  if (!id || !requestedUserId || state.orderOperationId) return;
  state.orderOperationId = id;
  try {
    const [payload] = await Promise.all([
      storeApi(`/api/store/orders/${encodeURIComponent(id)}/delivery`, { auth: 'bearer', timeoutMs: 5_000 }),
      new Promise((resolve) => window.setTimeout(resolve, 3_000))
    ]);
    if (String(state.auth.user?.uid || '') !== requestedUserId || state.deliveryAccessSequence !== accessSequence) return;
    if (payload.delivery?.items?.length) {
      const previousTimer = state.deliverySecretTimers.get(id);
      if (previousTimer) window.clearTimeout(previousTimer);
      state.deliverySecrets.set(id, payload.delivery);
      state.deliveryAccessOrderId = '';
      state.deliverySecretTimers.set(id, window.setTimeout(() => {
        state.deliverySecrets.delete(id);
        state.deliverySecretTimers.delete(id);
        renderOrders();
        showNotice('info', 'Teslimat görünümü kapatıldı', 'Açık teslimat bilgileri 30 saniye sonra yeniden maskelendi.', { sound: false });
      }, 30_000));
      setDeliveryAccessPhase(3, 'Teslimat bilgileriniz güvenle hazırlandı.');
      renderOrders();
      await new Promise((resolve) => window.setTimeout(resolve, 260));
      if (state.deliveryAccessSequence === accessSequence) closeDeliveryAccess({ restoreFocus: false });
      showNotice('success', 'Teslimat bilgileriniz açıldı', 'Bilgileriniz yalnızca bu oturumda ve kısa süreli olarak güvenle görüntüleniyor.');
    }
  } catch (error) {
    if (String(state.auth.user?.uid || '') === requestedUserId && state.deliveryAccessSequence === accessSequence) {
      closeDeliveryAccess({ restoreFocus: true });
      showNotice('error', 'Teslimat bilgilerinizi açamadık', friendlyStoreError(error));
    }
  } finally {
    if (String(state.auth.user?.uid || '') === requestedUserId) {
      state.orderOperationId = '';
      renderOrders();
    }
  }
}

async function copyDeliveryKey(reference = '') {
  const [orderId, indexValue, field = 'key'] = String(reference).split(':');
  const item = state.deliverySecrets.get(orderId)?.items?.[Number(indexValue)];
  const value = field === 'username'
    ? item?.account?.username
    : field === 'password'
      ? item?.account?.password
      : item?.key || (!item?.account ? item?.copyValue : '');
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    showNotice('warning', 'Teslimat bilgisi kopyalandı', 'Cihaz panosu başka uygulamalar tarafından okunabilir. Bilgiyi kullandıktan sonra panonu temizle.');
  }
  catch (_) { showNotice('warning', 'Kopyalama izni gerekli', 'Dilerseniz teslimat bilgisini seçerek elle kopyalayabilirsiniz.'); }
}

function couponMarkup(coupon = {}) {
  return renderCouponCardView(coupon, {
    group: customerCouponGroup(coupon),
    usable: couponIsUsable(coupon),
    accent: couponAccent(coupon),
    scopeLabel: couponScopeLabel(coupon),
    formatPrice: formatStorePrice
  });
}

function renderCouponCollection() {
  const host = $('#couponWallet');
  const summary = summarizeCustomerCoupons(state.promotions);
  if ($('#couponHeroCount')) $('#couponHeroCount').textContent = String(summary.usable);
  $$('#couponFilterBar [data-coupon-filter]').forEach((button) => {
    const active = button.dataset.couponFilter === state.couponFilter;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  if (!host) return;
  const selected = state.promotions.filter((coupon) => couponMatchesFilter(coupon, state.couponFilter));
  const labels = { available: 'Kullanılabilir kupon yok', used: 'Kullanılmış kupon yok', expired: 'Süresi dolan kupon yok' };
  host.innerHTML = selected.length
    ? selected.map(couponMarkup).join('')
    : renderCustomerEmpty({ icon: 'fa-ticket', title: labels[state.couponFilter] || labels.available, message: 'Bu durumdaki kampanyalar burada görünecek.' });
}

async function loadCoupons({ force = false } = {}) {
  if (!state.auth.user) return [];
  if (!force && state.promotionsLoadedAt && Date.now() - state.promotionsLoadedAt < 120_000) return state.promotions;
  if (state.promotionsPromise) return state.promotionsPromise;
  const host = $('#couponWallet');
  const requestedUserId = String(state.auth.user.uid || '');
  if (host && (!state.promotionsLoadedAt || force)) host.innerHTML = '<div class="store-skeleton store-skeleton--card"></div><div class="store-skeleton store-skeleton--card"></div>';
  const operation = (async () => {
    try {
      const response = await storeApi('/api/store/promotions');
      if (String(state.auth.user?.uid || '') !== requestedUserId) return [];
      state.promotions = Array.isArray(response.promotions) ? response.promotions : [];
      state.promotionsLoadedAt = Date.now();
      renderCouponCollection();
      return state.promotions;
    } catch (error) {
      if (host && String(state.auth.user?.uid || '') === requestedUserId) host.innerHTML = renderCustomerEmpty({ icon: 'fa-circle-exclamation', title: 'Kuponlar yüklenemedi', message: friendlyStoreError(error) });
      throw error;
    } finally {
      if (state.promotionsPromise === operation) state.promotionsPromise = null;
    }
  })();
  state.promotionsPromise = operation;
  return operation;
}

function renderOrders() {
  const ordersHost = $('#ordersList');
  const deliveriesHost = $('#deliveriesList');
  const metrics = summarizeCustomerOrders(state.orders);
  if ($('#orderMetricTotal')) $('#orderMetricTotal').textContent = String(metrics.total);
  if ($('#orderMetricDelivered')) $('#orderMetricDelivered').textContent = String(metrics.delivered);
  if ($('#orderMetricPending')) $('#orderMetricPending').textContent = String(metrics.pending);
  if ($('#deliveryMetricDelivered')) $('#deliveryMetricDelivered').textContent = String(metrics.delivered);
  if ($('#deliveryMetricLatest')) $('#deliveryMetricLatest').textContent = latestDeliveryLabel(state.orders);
  $$('#orderFilterBar [data-order-filter]').forEach((button) => {
    const active = button.dataset.orderFilter === state.orderFilter;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  if (ordersHost) {
    const query = normalizeSearch(state.orderSearch || '');
    const selected = state.orders.filter((order) => orderMatchesFilter(order, state.orderFilter)
      && (!query || normalizeSearch(`${order.orderNumber} ${(order.items || []).map((item) => `${item.productName} ${item.planLabel}`).join(' ')}`).includes(query)));
    ordersHost.innerHTML = selected.length
      ? selected.map(orderCardMarkup).join('')
      : renderCustomerEmpty({
        icon: 'fa-box-open',
        title: state.orders.length ? 'Bu durumda sipariş bulunmuyor' : 'Henüz siparişin yok',
        message: state.orders.length ? 'Başka bir durum filtresi seçerek siparişlerini görüntüleyebilirsin.' : 'Sepetine ürün ekleyip sipariş verdiğinde kayıtların burada görünecek.'
      });
  }
  if (deliveriesHost) {
    const activeOrders = state.orders.filter((order) => order.deliveryVisible === true && ['paid', 'processing', 'delivery_pending', 'delivered'].includes(order.status));
    deliveriesHost.innerHTML = activeOrders.length
      ? activeOrders.map(deliveryCardMarkup).join('')
      : renderCustomerEmpty({ icon: 'fa-key', title: 'Onaylanmış teslimat yok', message: 'Telegram ödemen onaylandığında veya bakiye ödemen tamamlandığında teslim alanı otomatik açılır.' });
  }
  const more = $('#loadMoreOrdersButton');
  if (more) {
    more.hidden = !state.orderNextCursor;
    more.disabled = state.orderPageLoading;
  }
  syncDeliveryTabVisibility();
}

function deliveryEligibleOrders() {
  return state.orders.filter((order) => order.deliveryVisible === true && ['paid', 'processing', 'delivery_pending', 'delivered'].includes(order.status));
}

function syncDeliveryTabVisibility() {
  const mobile = $('#mobileDeliveryNav');
  const visible = deliveryEligibleOrders().length > 0;
  if (mobile) {
    mobile.disabled = !visible;
    mobile.setAttribute('aria-disabled', String(!visible));
  }
  $$('[data-customer-nav="deliveries"]').forEach((button) => {
    button.disabled = !visible;
    button.setAttribute('aria-disabled', String(!visible));
  });
  if (!visible && customerAppController?.view === 'deliveries') setCustomerView('orders');
}

async function cancelOrder(orderId = '') {
  const id = String(orderId || '').trim();
  const order = state.orders.find((item) => item.id === id);
  const requestedUserId = String(state.auth.user?.uid || '');
  if (!id || !order || !requestedUserId || state.orderOperationId) return;
  state.orderOperationId = id;
  state.cancelConfirmOrderId = id;
  renderOrders();
  try {
    const payload = await storeApi(`/api/store/orders/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
      body: { reason: 'Kullanıcı hesap alanından iptal etti.' },
      timeoutMs: 20_000
    });
    if (String(state.auth.user?.uid || '') !== requestedUserId) return;
    if (payload.order) state.orders = state.orders.map((item) => item.id === id ? payload.order : item);
    if (state.auth.account && Number.isFinite(Number(payload.balanceKurus))) {
      state.auth.account.balanceKurus = Number(payload.balanceKurus);
      renderAccountHeader();
    }
    state.cancelConfirmOrderId = '';
    showNotice('success', 'Siparişiniz iptal edildi', order.paymentMethod === 'wallet'
      ? 'Sipariş tutarı SHELBY STORE bakiyenize güvenle iade edildi.'
      : 'Ödeme bekleyen siparişiniz iptal edildi.');
  } catch (error) {
    if (String(state.auth.user?.uid || '') === requestedUserId) showNotice('error', 'Siparişinizi iptal edemedik', friendlyStoreError(error));
  } finally {
    if (String(state.auth.user?.uid || '') === requestedUserId) {
      state.orderOperationId = '';
      state.ordersLoadedAt = Date.now();
      renderOrders();
    }
  }
}

async function loadOrders(force = false) {
  if (!state.auth.user) return [];
  if (!force && state.ordersLoadedAt && Date.now() - state.ordersLoadedAt < 90_000) return state.orders;
  if (state.ordersPromise) return state.ordersPromise;
  const hasExistingOrders = state.orders.length > 0;
  const requestedUserId = String(state.auth.user.uid || '');
  const loading = '<div class="store-skeleton store-skeleton--card"></div><div class="store-skeleton store-skeleton--card"></div>';
  if (!hasExistingOrders && $('#ordersList')) $('#ordersList').innerHTML = loading;
  if (!hasExistingOrders && $('#deliveriesList')) $('#deliveriesList').innerHTML = loading;
  const operation = storeApi('/api/store/orders?limit=40')
    .then((payload) => {
      if (String(state.auth.user?.uid || '') !== requestedUserId) return [];
      state.orders = Array.isArray(payload.orders) ? payload.orders : [];
      state.orderNextCursor = String(payload.nextCursor || '');
      state.ordersLoadedAt = Date.now();
      renderOrders();
      return state.orders;
    })
    .catch((error) => {
      if (String(state.auth.user?.uid || '') !== requestedUserId) return [];
      if (state.orders.length > 0) {
        renderOrders();
      } else {
        const markup = renderCustomerEmpty({ icon: 'fa-triangle-exclamation', title: 'Siparişler şu anda yenilenemedi', message: friendlyStoreError(error) });
        if ($('#ordersList')) $('#ordersList').innerHTML = markup;
        if ($('#deliveriesList')) $('#deliveriesList').innerHTML = markup;
      }
      throw error;
    })
    .finally(() => {
      if (state.ordersPromise === operation) state.ordersPromise = null;
    });
  state.ordersPromise = operation;
  return operation;
}

async function loadMoreCustomerOrders() {
  if (!state.orderNextCursor || state.orderPageLoading || !state.auth.user) return;
  const requestedUserId = String(state.auth.user.uid || '');
  const button = $('#loadMoreOrdersButton');
  state.orderPageLoading = true;
  setButtonBusy(button, true, 'Önceki siparişler yükleniyor...');
  try {
    const payload = await storeApi(`/api/store/orders?limit=40&cursor=${encodeURIComponent(state.orderNextCursor)}`);
    if (String(state.auth.user?.uid || '') !== requestedUserId) return;
    const incoming = Array.isArray(payload.orders) ? payload.orders : [];
    const existing = new Set(state.orders.map((order) => order.id));
    state.orders.push(...incoming.filter((order) => !existing.has(order.id)));
    state.orderNextCursor = String(payload.nextCursor || '');
    state.ordersLoadedAt = Date.now();
  } catch (error) {
    if (String(state.auth.user?.uid || '') === requestedUserId) showNotice('error', 'Önceki siparişler yüklenemedi', friendlyStoreError(error));
  } finally {
    setButtonBusy(button, false);
    if (String(state.auth.user?.uid || '') === requestedUserId) {
      state.orderPageLoading = false;
      renderOrders();
    }
  }
}

function applyAvatar(shell, avatarId = '1') {
  if (!shell) return;
  const requestedAvatar = String(avatarId || '1');
  const catalogAvatar = avatarOption(requestedAvatar);
  const accountAvatarTrusted = String(state.auth?.account?.avatarId || '') === requestedAvatar && !!state.auth?.account?.avatarUrl;
  const safeAvatar = catalogAvatar || accountAvatarTrusted || FALLBACK_AVATAR_ICONS[requestedAvatar] ? requestedAvatar : '1';
  const image = trustedAvatarImage(safeAvatar);
  shell.dataset.avatarId = safeAvatar;
  shell.classList.toggle('has-photo', !!image);
  const core = $('.avatar-core', shell);
  if (core) {
    delete core.dataset.avatarFallbackApplied;
    if (image) {
      const photo = document.createElement('img');
      photo.className = 'avatar-image';
      photo.src = image;
      photo.alt = '';
      photo.loading = shell.id === 'topbarAvatar' || shell.id === 'accountAvatar' ? 'eager' : 'lazy';
      photo.decoding = 'async';
      photo.referrerPolicy = 'no-referrer';
      core.replaceChildren(photo);
    } else {
      const icon = document.createElement('i');
      icon.className = `fa-solid ${FALLBACK_AVATAR_ICONS[safeAvatar] || FALLBACK_AVATAR_ICONS['1']}`;
      icon.setAttribute('aria-hidden', 'true');
      core.replaceChildren(icon);
    }
  }
}

function renderAvatarPicker() {
  const avatarPicker = $('#avatarPicker');
  const serverAvatars = Array.isArray(state.catalog?.avatars) ? state.catalog.avatars : [];
  const avatars = serverAvatars.length
    ? serverAvatars
    : Object.keys(FALLBACK_AVATAR_ICONS).map((id) => ({ id, label: `SHELBY STORE Avatar ${id}`, image: '' }));
  if (avatarPicker) avatarPicker.innerHTML = renderAvatarPickerView(avatars, state.selectedAvatarId, FALLBACK_AVATAR_ICONS);
  if ($('#avatarChoiceCount')) $('#avatarChoiceCount').textContent = `${avatars.length} SEÇENEK`;
  applyAvatar($('#accountAvatar'), state.selectedAvatarId);
}

function renderAccountSecurity() {
  const auth = state.auth || {};
  const user = auth.user;
  const account = auth.account || {};
  const card = $('#accountEmailSecurityCard');
  if (!card) return;
  const email = account.email || user?.email || '—';
  card.classList.toggle('is-verified', !!user);
  card.classList.remove('is-unverified');
  $('#accountEmailSecurityStatus').textContent = user ? 'E-posta adresin hazır' : 'Hesap gerekli';
  $('#accountEmailSecurityDetail').textContent = user
    ? `${email} · Yeni adres mevcut hesap şifrenle anında güncellenir.`
    : 'E-posta adresini yönetmek için hesabına giriş yap.';
  const action = $('#accountEmailActionButton');
  if (action) {
    action.disabled = !user || !!state.accountSecurityBusy;
  }
  const birthDate = String(account.birthDate || '');
  const formattedBirthDate = /^\d{4}-\d{2}-\d{2}$/.test(birthDate)
    ? birthDate.split('-').reverse().join('.') : 'Doğum tarihi belirtilmedi';
  const fields = [
    { field: 'username', button: '#accountUsernameActionButton', detail: '#accountUsernameDetail', badge: '#accountUsernameRemaining', fallback: 3, value: account.username || 'Kullanıcı adı belirtilmedi' },
    { field: 'fullName', button: '#accountNameActionButton', detail: '#accountFullNameDetail', badge: '#accountNameRemaining', fallback: 1, value: account.fullName || [account.firstName, account.lastName].filter(Boolean).join(' ') || 'İsim bilgisi belirtilmedi' },
    { field: 'birthDate', button: '#accountBirthDateActionButton', detail: '#accountBirthDateDetail', badge: '#accountBirthDateRemaining', fallback: 1, value: formattedBirthDate }
  ];
  fields.forEach(({ field, button, detail, badge, fallback, value }) => {
    const remaining = Math.max(0, Number(account.profileChanges?.[field]?.remaining ?? fallback) || 0);
    const control = $(button);
    if ($(detail)) $(detail).textContent = value;
    if ($(badge)) {
      $(badge).textContent = remaining > 0 ? `${remaining} HAK` : 'HAK DOLDU';
      $(badge).classList.toggle('is-exhausted', remaining < 1);
    }
    if (control) {
      control.disabled = !user || !!state.accountSecurityBusy || remaining < 1;
      control.setAttribute('aria-disabled', String(control.disabled));
      control.title = remaining < 1 ? 'Bu bilgi için değişiklik hakkı doldu.' : '';
    }
    if (field === 'username' && $('#accountUsernameModalRemaining')) $('#accountUsernameModalRemaining').textContent = String(remaining);
  });
}

function renderAccountHeader() {
  const auth = state.auth;
  const account = auth.account;
  const signedIn = !!auth.user;
  document.body.dataset.authenticated = String(signedIn);
  $$('[data-auth-only]').forEach((node) => {
    node.hidden = !signedIn;
    node.inert = !signedIn;
  });
  $$('[data-guest-only]').forEach((node) => {
    node.hidden = signedIn;
    node.inert = signedIn;
  });
  if ($('#guestActions')) $('#guestActions').hidden = signedIn;
  if ($('#accountButton')) $('#accountButton').hidden = !signedIn;
  const username = account?.username || auth.user?.displayName || auth.user?.email?.split('@')[0] || 'SHELBY STORE Üyesi';
  const email = account?.email || auth.user?.email || '—';
  const balanceKurus = Number(account?.balanceKurus || 0);
  const avatarId = String(account?.avatarId || state.selectedAvatarId || '1');
  state.selectedAvatarId = avatarId;
  if ($('#topbarUsername')) $('#topbarUsername').textContent = username;
  if ($('#storeGreetingName')) $('#storeGreetingName').textContent = signedIn ? username : 'Oyuncu';
  if ($('#accountUsername')) $('#accountUsername').textContent = username;
  if ($('#accountEmail')) $('#accountEmail').textContent = email;
  if ($('#accountLogoutName')) $('#accountLogoutName').textContent = username;
  if ($('#topBalanceValue')) $('#topBalanceValue').textContent = formatTopbarBalance(balanceKurus);
  if ($('#topBalanceButton')) $('#topBalanceButton').setAttribute('aria-label', `Bakiyen ${formatTopbarBalance(balanceKurus)} · Hesabını aç`);
  if ($('#accountBalance')) $('#accountBalance').textContent = formatTopbarBalance(balanceKurus);
  if ($('#cartWalletAmount')) $('#cartWalletAmount').textContent = formatTopbarBalance(balanceKurus);
  if ($('#cartWalletBalance')) $('#cartWalletBalance').textContent = `Mevcut bakiye: ${formatStorePrice(balanceKurus)}`;
  const status = $('#accountStatusLabel');
  if (status) {
    const label = account?.accountStatus === 'suspended'
      ? 'Hesap askıda'
      : account?.accountStatus === 'purchase_blocked' ? 'Satın alma kısıtlı' : 'Hesabın güvende';
    const statusIcon = document.createElement('i');
    statusIcon.className = `fa-solid ${account?.accountStatus === 'active' || !account?.accountStatus ? 'fa-shield-halved' : 'fa-circle-exclamation'}`;
    statusIcon.setAttribute('aria-hidden', 'true');
    status.replaceChildren(statusIcon, document.createTextNode(` ${label}`));
    status.classList.toggle('is-warning', !!account?.accountStatus && account.accountStatus !== 'active');
  }
  applyAvatar($('#topbarAvatar'), avatarId);
  applyAvatar($('#accountAvatar'), avatarId);
  renderAvatarPicker();
  renderAccountSecurity();
  if (state.selectedProduct && state.selectedPlan) renderPurchaseSummary();
}

function syncCustomerNavigation(view = 'profile') {
  const selected = ['cart', 'orders', 'deliveries', 'coupons', 'profile'].includes(view) ? view : 'profile';
  const headerAction = $('#customerHeaderAction');
  if (headerAction) {
    const unavailable = selected === 'profile' || (selected === 'cart' && cartLines().length === 0);
    headerAction.hidden = unavailable;
    headerAction.inert = unavailable;
  }
}

function setCustomerView(view = 'profile', { focus = false } = {}) {
  const safe = customerAppController?.setView(view, { focus })
    || (view === 'deliveries' && deliveryEligibleOrders().length === 0 ? 'orders' : view);
  syncCustomerNavigation(safe);
  if (safe === 'orders' || safe === 'deliveries') loadOrders().catch(() => null);
  if (safe === 'coupons') loadCoupons().catch(() => null);
  const main = $('#customerApp .customer-main');
  main?.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  return safe;
}

function openCustomer(view = 'profile', trigger = null) {
  const requested = ['cart', 'orders', 'deliveries', 'coupons', 'profile'].includes(view) ? view : 'profile';
  if (!requireSignedIn(requested === 'profile' ? 'account' : requested)) return;
  const requestedUserId = String(state.auth.user?.uid || '');
  renderAccountHeader();
  setCustomerView(requested);
  openLayer($('#customerApp'), trigger);
  if (requested === 'profile') {
    refreshStoreIdentity().then((snapshot) => {
      if (String(state.auth.user?.uid || '') !== requestedUserId || String(snapshot?.user?.uid || '') !== requestedUserId) return;
      state.auth = snapshot;
      renderAccountHeader();
    }).catch(() => null);
  }
}

function clearFieldIssue(field) {
  if (!field) return;
  field.removeAttribute('aria-invalid');
  field.closest?.('.form-field__input,.birth-field')?.classList.remove('is-invalid');
}

function clearAuthValidation(form) {
  $$('[aria-invalid="true"]', form).forEach(clearFieldIssue);
}

function formIssue(field, title, message) {
  field?.setAttribute('aria-invalid', 'true');
  field?.closest?.('.form-field__input,.birth-field')?.classList.add('is-invalid');
  showNotice('warning', title, message);
  field?.focus({ preventScroll: true });
  window.setTimeout(() => field?.scrollIntoView({ block: 'center', inline: 'nearest' }), 80);
  return false;
}

function loginFormValid() {
  const identifier = $('#loginIdentifier');
  const password = $('#loginPassword');
  clearAuthValidation($('#loginForm'));
  if (!String(identifier?.value || '').trim()) return formIssue(identifier, 'Hesap bilginizi girin', 'Lütfen e-posta adresinizi veya kullanıcı adınızı yazın.');
  if (String(password?.value || '').length < 6) return formIssue(password, 'Şifrenizi kontrol edin', 'Lütfen en az 6 karakterden oluşan şifrenizi yazın.');
  return true;
}

function registerFormValid() {
  const firstName = $('#registerFirstName');
  const lastName = $('#registerLastName');
  const username = $('#registerUsername');
  const email = $('#registerEmail');
  const day = $('#birthDay');
  const month = $('#birthMonth');
  const year = $('#birthYear');
  const password = $('#registerPassword');
  const passwordRepeat = $('#registerPasswordRepeat');
  clearAuthValidation($('#registerForm'));
  const validPersonName = (value) => {
    const normalized = String(value || '').trim().replace(/\s+/g, ' ');
    return normalized.length >= 2 && normalized.length <= 50 && /^[\p{L}]+(?:[ .'’\-][\p{L}]+)*$/u.test(normalized);
  };
  if (!validPersonName(firstName?.value)) return formIssue(firstName, 'Adınızı kontrol edin', 'Lütfen en az 2 karakter kullanın. Harf, boşluk, kesme işareti ve tire kullanabilirsiniz.');
  if (!validPersonName(lastName?.value)) return formIssue(lastName, 'Soyadınızı kontrol edin', 'Lütfen en az 2 karakter kullanın. Harf, boşluk, kesme işareti ve tire kullanabilirsiniz.');
  if (!/^[\p{L}\p{N}._-]{5,20}$/u.test(String(username?.value || '').trim())) return formIssue(username, 'Kullanıcı adınızı kontrol edin', 'Lütfen boşluk kullanmadan 5-20 karakter arasında bir kullanıcı adı yazın.');
  if (!/^\S+@\S+\.\S+$/.test(String(email?.value || '').trim())) return formIssue(email, 'E-posta adresinizi kontrol edin', 'Lütfen geçerli bir e-posta adresi yazın.');
  const birthDate = birthDateValue();
  if (!birthDate) return formIssue(!day?.value ? day : !month?.value ? month : year, 'Doğum tarihinizi tamamlayın', 'Lütfen gün, ay ve yıl alanlarının tamamını seçin.');
  const birth = new Date(`${birthDate}T00:00:00Z`);
  if (Number.isNaN(birth.getTime()) || birth.toISOString().slice(0, 10) !== birthDate || birth.getTime() > Date.now() || birth.getUTCFullYear() < 1900) {
    return formIssue(year, 'Doğum tarihinizi kontrol edin', 'Lütfen geçerli ve geçmiş bir doğum tarihi seçin.');
  }
  if (String(password?.value || '').length < 8) return formIssue(password, 'Şifrenizi güçlendirin', 'Lütfen en az 8 karakterden oluşan bir şifre belirleyin.');
  if (password?.value !== passwordRepeat?.value) return formIssue(passwordRepeat, 'Şifreler eşleşmiyor', 'Lütfen iki şifre alanına da aynı şifreyi yazın.');
  return true;
}

function setAuthTab(tab = 'login') {
  const safe = tab === 'register' ? 'register' : 'login';
  $$('#authTabs [data-auth-tab]').forEach((button) => {
    const active = button.dataset.authTab === safe;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', String(active));
  });
  if ($('#loginForm')) {
    $('#loginForm').hidden = safe !== 'login';
    $('#loginForm').inert = safe !== 'login';
  }
  if ($('#registerForm')) {
    $('#registerForm').hidden = safe !== 'register';
    $('#registerForm').inert = safe !== 'register';
  }
  if ($('#authTitle')) $('#authTitle').textContent = safe === 'register' ? 'Yeni hesap oluştur' : 'Hesabına eriş';
  clearAuthValidation(safe === 'register' ? $('#registerForm') : $('#loginForm'));
  $('#authSheetBody')?.scrollTo({ top: 0, left: 0, behavior: 'auto' });
}

function openAuth(tab = 'login', trigger = null) {
  if (state.auth.user) {
    openCustomer('profile', trigger);
    return;
  }
  setAuthTab(tab);
  openLayer($('#authSheet'), trigger);
  if (state.auth.ready && !state.auth.available) {
    showNotice('warning', 'Hesabınıza şu anda ulaşamıyoruz', 'Lütfen internet bağlantınızı kontrol edip kısa bir süre sonra yeniden deneyin.');
  }
}

function birthDateValue() {
  const year = String($('#birthYear')?.value || '');
  const month = String($('#birthMonth')?.value || '').padStart(2, '0');
  const day = String($('#birthDay')?.value || '').padStart(2, '0');
  return year && month !== '00' && day !== '00' ? `${year}-${month}-${day}` : '';
}

function populateBirthSelectors() {
  ['', 'account'].forEach((prefix) => {
    const day = $(`#${prefix ? `${prefix}Birth` : 'birth'}Day`);
    const month = $(`#${prefix ? `${prefix}Birth` : 'birth'}Month`);
    const year = $(`#${prefix ? `${prefix}Birth` : 'birth'}Year`);
    if (day && day.options.length === 1) {
      for (let value = 1; value <= 31; value += 1) day.add(new Option(String(value), String(value)));
    }
    if (month && month.options.length === 1) {
      ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'].forEach((label, index) => month.add(new Option(label, String(index + 1))));
    }
    if (year && year.options.length === 1) {
      const current = new Date().getFullYear();
      for (let value = current; value >= 1900; value -= 1) year.add(new Option(String(value), String(value)));
    }
  });
}

async function handleLogin(event) {
  event.preventDefault();
  if (state.authOperation || !loginFormValid()) return;
  const form = event.currentTarget;
  const submit = $('button[type="submit"]', form);
  state.authOperation = 'login';
  setButtonBusy(submit, true, 'Giriş yapılıyor...');
  try {
    await signInStore({
      identifier: $('#loginIdentifier')?.value,
      password: $('#loginPassword')?.value,
      remember: !!$('#loginRemember')?.checked
    });
    closeActiveLayer({ restoreFocus: false });
    showNotice('success', 'Hoş geldiniz', 'Hesabınız ve mağaza bakiyeniz güvenle hazırlandı.');
    const pending = state.pendingLayer;
    state.pendingLayer = '';
    if (pending === 'cart') openCustomer('cart');
    else if (pending === 'orders' || pending === 'deliveries') openCustomer(pending);
    else if (pending === 'account') openCustomer('profile');
  } catch (error) {
    showNotice('error', 'Giriş işleminizi tamamlayamadık', friendlyStoreError(error));
  } finally {
    setButtonBusy(submit, false);
    state.authOperation = '';
  }
}

async function handleRegister(event) {
  event.preventDefault();
  if (state.authOperation || !registerFormValid()) return;
  const form = event.currentTarget;
  const submit = $('button[type="submit"]', form);
  state.authOperation = 'register';
  setButtonBusy(submit, true, 'Hesabın oluşturuluyor...');
  try {
    await registerStore({
      firstName: $('#registerFirstName')?.value,
      lastName: $('#registerLastName')?.value,
      username: $('#registerUsername')?.value,
      email: $('#registerEmail')?.value,
      password: $('#registerPassword')?.value,
      passwordRepeat: $('#registerPasswordRepeat')?.value,
      birthDate: birthDateValue(),
      remember: !!$('#registerRemember')?.checked
    });
    closeActiveLayer({ restoreFocus: false });
    form.reset();
    showNotice('success', 'Hesabınız hazır', 'Kaydınız tamamlandı. Beklemeden ürünlerinizi inceleyebilir ve güvenle sipariş verebilirsiniz.');
    const pending = state.pendingLayer;
    state.pendingLayer = '';
    if (pending === 'cart') openCustomer('cart');
    else if (pending === 'orders' || pending === 'deliveries') openCustomer(pending);
    else if (pending === 'account') openCustomer('profile');
  } catch (error) {
    showNotice('error', 'Kayıt işleminizi tamamlayamadık', friendlyStoreError(error));
  } finally {
    setButtonBusy(submit, false);
    state.authOperation = '';
  }
}

async function handlePasswordReset() {
  const identifier = String($('#loginIdentifier')?.value || '').trim();
  if (!identifier) {
    $('#loginIdentifier')?.focus();
    showNotice('warning', 'Hesap bilginizi girin', 'Şifre yenileme bağlantısı için lütfen e-posta adresinizi veya kullanıcı adınızı yazın.');
    return;
  }
  const button = $('#forgotPasswordButton');
  setButtonBusy(button, true, 'Gönderiliyor...');
  try {
    await resetStorePassword(identifier);
    showNotice('success', 'Talebiniz alındı', 'Bilgileriniz bir hesapla eşleşiyorsa yenileme bağlantısı kayıtlı e-posta adresinize gönderildi.');
  } catch (error) {
    showNotice('error', 'Yenileme bağlantısını gönderemedik', friendlyStoreError(error));
  } finally {
    setButtonBusy(button, false);
  }
}

async function saveAvatar() {
  if (!requireSignedIn('account') || state.accountAvatarBusy) return;
  const requestedUserId = String(state.auth.user?.uid || '');
  const button = $('#saveAvatarButton');
  state.accountAvatarBusy = true;
  setButtonBusy(button, true, 'Kaydediliyor...');
  try {
    const payload = await storeApi('/api/store/profile/avatar', {
      method: 'PATCH',
      body: { avatarId: state.selectedAvatarId }
    });
    if (String(state.auth.user?.uid || '') !== requestedUserId) return;
    if (payload.account) state.auth.account = payload.account;
    renderAccountHeader();
    customerAppController?.closeAction({ force: true });
    showNotice('success', 'Profil görselin güncellendi', 'Seçtiğin avatar hesabına güvenle kaydedildi.');
  } catch (error) {
    if (String(state.auth.user?.uid || '') === requestedUserId) showNotice('error', 'Profil görselin kaydedilemedi', friendlyStoreError(error));
  } finally {
    state.accountAvatarBusy = false;
    setButtonBusy(button, false);
  }
}

function handleAccountEmailAction() {
  if (!state.auth.user || state.accountSecurityBusy) return;
  customerAppController?.openAction('email', $('#accountEmailActionButton'));
}

async function handleAccountEmailChange(event) {
  event.preventDefault();
  const requestedUserId = String(state.auth.user?.uid || '');
  if (!requestedUserId || state.accountSecurityBusy) return;
  const form = event.currentTarget;
  const newEmail = String($('#accountNewEmail')?.value || '').trim();
  const currentPassword = String($('#accountEmailCurrentPassword')?.value || '');
  if (!/^\S+@\S+\.\S+$/.test(newEmail)) return formIssue($('#accountNewEmail'), 'Yeni e-posta adresinizi kontrol edin', 'Lütfen geçerli bir yeni e-posta adresi yazın.');
  if (currentPassword.length < 6) return formIssue($('#accountEmailCurrentPassword'), 'Mevcut şifrenizi girin', 'E-posta güncellemesi için lütfen mevcut şifrenizi doğrulayın.');
  const button = $('button[type="submit"]', form);
  state.accountSecurityBusy = 'change-email';
  setButtonBusy(button, true, 'E-posta güncelleniyor...');
  try {
    const result = await changeStoreEmail({ newEmail, currentPassword });
    if (String(state.auth.user?.uid || '') !== requestedUserId) return;
    if (result.account) state.auth.account = result.account;
    renderAccountHeader();
    customerAppController?.closeAction({ force: true });
    showNotice('success', 'E-posta adresin güncellendi', `${result.email} adresi doğrudan hesabına kaydedildi.`);
  } catch (error) {
    if (String(state.auth.user?.uid || '') === requestedUserId) showNotice('error', 'E-posta adresini güncelleyemedik', friendlyStoreError(error));
  } finally {
    state.accountSecurityBusy = '';
    setButtonBusy(button, false);
    renderAccountSecurity();
  }
}

async function handleAccountIdentityChange(event, field = '') {
  event.preventDefault();
  const requestedUserId = String(state.auth.user?.uid || '');
  if (!requestedUserId || state.accountSecurityBusy) return;
  const limits = state.auth.account?.profileChanges?.[field];
  if (limits && Number(limits.remaining || 0) < 1) {
    showNotice('warning', 'Değişiklik hakkın doldu', 'Bu hesap bilgisi için kullanılabilir değişiklik hakkı bulunmuyor.');
    return;
  }
  let values;
  let passwordField;
  let label;
  if (field === 'username') {
    const input = $('#accountNewUsername');
    const username = String(input?.value || '').trim();
    if (!/^[\p{L}\p{N}._-]{5,20}$/u.test(username)) {
      return formIssue(input, 'Kullanıcı adını kontrol et', 'Kullanıcı adı 5-20 karakter olmalı ve yalnızca harf, sayı, nokta, alt çizgi veya tire içermelidir.');
    }
    values = { username };
    passwordField = $('#accountUsernameCurrentPassword');
    label = 'Kullanıcı adın';
  } else if (field === 'fullName') {
    const first = $('#accountNewFirstName');
    const last = $('#accountNewLastName');
    const firstName = String(first?.value || '').trim();
    const lastName = String(last?.value || '').trim();
    const valid = (value) => /^[\p{L}]+(?:[ .'’\-][\p{L}]+)*$/u.test(value) && value.length >= 2;
    if (!valid(firstName)) return formIssue(first, 'İsmini kontrol et', 'Lütfen en az 2 karakterden oluşan geçerli bir isim yaz.');
    if (!valid(lastName)) return formIssue(last, 'Soyismini kontrol et', 'Lütfen en az 2 karakterden oluşan geçerli bir soyisim yaz.');
    values = { firstName, lastName };
    passwordField = $('#accountNameCurrentPassword');
    label = 'İsim ve soyismin';
  } else if (field === 'birthDate') {
    const year = String($('#accountBirthYear')?.value || '');
    const month = String($('#accountBirthMonth')?.value || '').padStart(2, '0');
    const day = String($('#accountBirthDay')?.value || '').padStart(2, '0');
    const birthDate = year && month !== '00' && day !== '00' ? `${year}-${month}-${day}` : '';
    const date = new Date(`${birthDate}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== birthDate || date.getTime() > Date.now()) {
      showNotice('warning', 'Doğum tarihini kontrol et', 'Lütfen geçerli bir gün, ay ve yıl seç.');
      $('#accountBirthDay')?.focus();
      return;
    }
    values = { birthDate };
    passwordField = $('#accountBirthCurrentPassword');
    label = 'Doğum tarihin';
  } else return;
  const currentPassword = String(passwordField?.value || '');
  if (currentPassword.length < 6) return formIssue(passwordField, 'Mevcut şifreni gir', 'Bu bilgiyi güncellemek için mevcut hesap şifreni doğrula.');
  const button = $('button[type="submit"]', event.currentTarget);
  state.accountSecurityBusy = field;
  setButtonBusy(button, true, 'Güvenli olarak kaydediliyor...');
  try {
    const updated = await changeStoreIdentity({ field, currentPassword, values });
    if (String(state.auth.user?.uid || '') !== requestedUserId || String(updated.user?.uid || '') !== requestedUserId) return;
    state.auth = updated;
    renderAccountHeader();
    customerAppController?.closeAction({ force: true });
    const remaining = Math.max(0, Number(updated.account?.profileChanges?.[field]?.remaining || 0));
    showNotice('success', `${label} güncellendi`, remaining > 0 ? `Bilgilerin güvenle kaydedildi. Kalan değişiklik hakkın: ${remaining}.` : 'Bilgilerin güvenle kaydedildi. Bu alan için tüm değişiklik hakların kullanıldı.');
  } catch (error) {
    if (String(state.auth.user?.uid || '') === requestedUserId) showNotice('error', `${label} güncellenemedi`, friendlyStoreError(error));
  } finally {
    state.accountSecurityBusy = '';
    setButtonBusy(button, false);
    renderAccountSecurity();
  }
}

async function handleAccountPasswordChange(event) {
  event.preventDefault();
  const requestedUserId = String(state.auth.user?.uid || '');
  if (!requestedUserId || state.accountSecurityBusy) return;
  const form = event.currentTarget;
  const currentPassword = String($('#accountPasswordCurrent')?.value || '');
  const newPassword = String($('#accountPasswordNew')?.value || '');
  const newPasswordRepeat = String($('#accountPasswordRepeat')?.value || '');
  if (currentPassword.length < 6) return formIssue($('#accountPasswordCurrent'), 'Mevcut şifrenizi girin', 'Lütfen mevcut şifrenizi doğrulayın.');
  if (newPassword.length < 8) return formIssue($('#accountPasswordNew'), 'Yeni şifrenizi güçlendirin', 'Lütfen en az 8 karakterden oluşan yeni bir şifre belirleyin.');
  if (newPassword !== newPasswordRepeat) return formIssue($('#accountPasswordRepeat'), 'Şifreler eşleşmiyor', 'Lütfen yeni şifre ve tekrar alanlarına aynı şifreyi yazın.');
  if (newPassword === currentPassword) return formIssue($('#accountPasswordNew'), 'Farklı bir şifre belirleyin', 'Yeni şifreniz mevcut şifrenizle aynı olamaz.');
  const button = $('button[type="submit"]', form);
  state.accountSecurityBusy = 'password';
  setButtonBusy(button, true, 'Şifre güncelleniyor...');
  try {
    await changeStorePassword({ currentPassword, newPassword, newPasswordRepeat });
    if (String(state.auth.user?.uid || '') !== requestedUserId) return;
    customerAppController?.closeAction({ force: true });
    showNotice('success', 'Şifreniz güncellendi', 'Hesap şifreniz güvenle değiştirildi ve oturumunuz yenilendi.');
  } catch (error) {
    if (String(state.auth.user?.uid || '') === requestedUserId) showNotice('error', 'Şifrenizi güncelleyemedik', friendlyStoreError(error));
  } finally {
    state.accountSecurityBusy = '';
    setButtonBusy(button, false);
    renderAccountSecurity();
  }
}

function renderAccountPasswordFeedback() {
  const password = String($('#accountPasswordNew')?.value || '');
  const repeat = String($('#accountPasswordRepeat')?.value || '');
  const meter = $('#accountPasswordMeter');
  const meterLabel = $('small', meter);
  const match = $('#accountPasswordMatch');
  const checks = [
    password.length >= 8,
    /[a-zçğıöşü]/u.test(password) && /[A-ZÇĞİÖŞÜ]/u.test(password),
    /\d/u.test(password),
    /[^\p{L}\p{N}\s]/u.test(password)
  ];
  const score = password ? checks.filter(Boolean).length : 0;
  const labels = ['En az 8 karakter, büyük/küçük harf ve sayı kullan.', 'Zayıf şifre', 'Orta güçte şifre', 'Güçlü şifre', 'Çok güçlü şifre'];
  const tones = ['#ff7d8b', '#ff7d8b', '#ffb15c', '#65d2ff', '#63e9a8'];
  if (meter) {
    meter.style.setProperty('--password-strength', `${score * 25}%`);
    meter.style.setProperty('--password-tone', tones[score]);
  }
  if (meterLabel) meterLabel.textContent = labels[score];
  if (match) {
    match.classList.toggle('is-valid', !!repeat && repeat === password);
    match.classList.toggle('is-invalid', !!repeat && repeat !== password);
    match.textContent = !repeat
      ? 'Şifreler henüz eşleşmedi.'
      : repeat === password
        ? 'Şifreler eşleşiyor.'
        : 'Şifreler eşleşmiyor.';
  }
}

async function handleAccountLogout() {
  if (!state.auth.user || state.accountLogoutBusy) return;
  const button = $('#accountLogoutConfirm');
  state.accountLogoutBusy = true;
  setButtonBusy(button, true, 'Oturum kapatılıyor...');
  try {
    await logoutStore();
    closeActiveLayer({ restoreFocus: false });
    showNotice('success', 'Güvenle çıkış yaptınız', 'Hesap oturumunuz güvenli biçimde kapatıldı.');
  } catch (error) {
    showNotice('error', 'Çıkış işleminizi tamamlayamadık', friendlyStoreError(error));
  } finally {
    state.accountLogoutBusy = false;
    setButtonBusy(button, false);
  }
}

function installLayerControls() {
  document.addEventListener('keydown', (event) => {
    const layer = state.activeLayer;
    if (!layer) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (layer === $('#customerApp') && !$('#deliveryAccessModal')?.hidden) {
        closeDeliveryAccess();
        return;
      }
      if (layer === $('#customerApp') && customerAppController?.action) {
        customerAppController.closeAction();
        return;
      }
      closeActiveLayer();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = layerFocusable(layer);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  $$('.modal-layer,.sheet-layer').forEach((layer) => {
    layer.addEventListener('click', (event) => {
      if (!event.target.closest?.('[data-close-layer]')) return;
      if (layer === $('#customerApp') && customerAppController?.action) {
        customerAppController.closeAction();
        return;
      }
      closeActiveLayer();
    });
  });
}

function installInteractions() {
  document.addEventListener('error', (event) => {
    const image = event.target;
    if (!(image instanceof HTMLImageElement) || !image.classList.contains('avatar-image')) return;
    const choiceMedia = image.closest('.customer-avatar-choice__media');
    if (choiceMedia && choiceMedia.dataset.avatarFallbackApplied !== '1') {
      choiceMedia.dataset.avatarFallbackApplied = '1';
      choiceMedia.innerHTML = iconMarkup(FALLBACK_AVATAR_ICONS[String(choiceMedia.dataset.avatarId || '1')] || FALLBACK_AVATAR_ICONS['1']);
      return;
    }
    const core = image.closest('.avatar-core');
    const shell = image.closest('.avatar-shell');
    if (!core || !shell || core.dataset.avatarFallbackApplied === '1') return;
    core.dataset.avatarFallbackApplied = '1';
    core.innerHTML = iconMarkup(FALLBACK_AVATAR_ICONS[String(shell.dataset.avatarId || '1')] || FALLBACK_AVATAR_ICONS['1']);
    shell.classList.remove('has-photo');
  }, true);
  document.addEventListener('click', (event) => {
    const retry = event.target.closest?.('[data-catalog-retry]');
    if (!retry) return;
    setButtonBusy(retry, true, 'Katalog yenileniyor...');
    loadCatalog(true).catch(() => null).finally(() => setButtonBusy(retry, false));
  });
  $('#brandStorefront')?.addEventListener('click', () => scrollToStore('storefront'));
  $('#storeAnnouncement')?.addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-announcement-target]');
    if (!button) return;
    if (button.dataset.announcementTarget === 'orders') openCustomer('orders', button);
    else scrollToStore(button.dataset.announcementTarget || 'catalog');
  });
  $$('[data-store-scroll]').forEach((button) => button.addEventListener('click', () => scrollToStore(button.dataset.storeScroll)));
  $$('#catalog [data-filter]').forEach((button) => button.addEventListener('click', () => {
    const value = button.dataset.filter;
    const deselectCategory = button.classList.contains('game-category') && state.activeFilter === value;
    setActiveFilter(deselectCategory ? 'all' : value, { scroll: false });
  }));
  $('#filterToggle')?.addEventListener('click', (event) => {
    const button = event.currentTarget;
    const expanded = button.getAttribute('aria-expanded') !== 'true';
    button.setAttribute('aria-expanded', String(expanded));
    button.setAttribute('aria-label', expanded ? 'Ürün filtrelerini kapat' : 'Ürün filtrelerini aç');
    $('#filterRow')?.classList.toggle('is-expanded', expanded);
  });

  $('#productSearch')?.addEventListener('input', (event) => {
    state.searchQuery = event.currentTarget.value || '';
    if ($('#clearSearch')) $('#clearSearch').hidden = !state.searchQuery;
    renderCatalog();
  });
  $('#clearSearch')?.addEventListener('click', () => {
    state.searchQuery = '';
    if ($('#productSearch')) {
      $('#productSearch').value = '';
      $('#productSearch').focus();
    }
    $('#clearSearch').hidden = true;
    renderCatalog();
  });
  $('#resetCatalog')?.addEventListener('click', () => {
    state.searchQuery = '';
    if ($('#productSearch')) $('#productSearch').value = '';
    if ($('#clearSearch')) $('#clearSearch').hidden = true;
    setActiveFilter('all');
  });

  $('#catalog')?.addEventListener('click', (event) => {
    const favoriteButton = event.target.closest?.('[data-store-favorite]');
    if (favoriteButton) {
      const productId = String(favoriteButton.dataset.storeFavorite || '');
      if (state.favorites.has(productId)) state.favorites.delete(productId);
      else state.favorites.add(productId);
      persistFavoriteProducts();
      const added = state.favorites.has(productId);
      renderCatalog();
      showNotice('success', added ? 'Favorilere eklendi' : 'Favorilerden çıkarıldı', added ? 'Ürün Favoriler filtresinde hazır.' : 'Favori tercihin bu cihazdan kaldırıldı.');
      return;
    }
    const trigger = event.target.closest?.('[data-store-buy]');
    if (trigger) openPurchase(trigger.dataset.storeBuy, trigger.dataset.storePlan, trigger);
  });
  $('#catalog')?.addEventListener('error', (event) => {
    const image = event.target.closest?.('[data-product-image]');
    const product = image ? getStoreProduct(state.catalog, image.dataset.productImage) : null;
    if (!image || !product) return;
    const template = document.createElement('template');
    template.innerHTML = productPlaceholder(product).trim();
    image.replaceWith(template.content.firstElementChild);
  }, true);
  $('#customerApp')?.addEventListener('error', (event) => {
    const image = event.target.closest?.('[data-product-image]');
    const product = image ? getStoreProduct(state.catalog, image.dataset.productImage) : null;
    if (!image || !product) return;
    const template = document.createElement('template');
    template.innerHTML = productPlaceholder(product, true).trim();
    image.replaceWith(template.content.firstElementChild);
  }, true);

  $('#purchaseModal')?.addEventListener('click', (event) => {
    const planButton = event.target.closest?.('[data-purchase-plan]');
    if (planButton && state.selectedProduct) {
      state.selectedPlan = getStorePlan(state.selectedProduct, planButton.dataset.purchasePlan) || state.selectedPlan;
      renderPurchaseSummary();
    }
  });
  $('#addToCartButton')?.addEventListener('click', () => {
    if (!state.selectedProduct || !state.selectedPlan) return;
    addToCart(state.selectedProduct, state.selectedPlan);
    if (!state.auth.user) {
      requireSignedIn('cart');
      return;
    }
    closeActiveLayer({ restoreFocus: false });
    openCustomer('cart', $('#addToCartButton'));
  });
  $('#buyTelegramButton')?.addEventListener('click', () => {
    if (!state.selectedProduct || !state.selectedPlan) return;
    if (!state.auth.user) {
      addToCart(state.selectedProduct, state.selectedPlan);
      closeActiveLayer({ restoreFocus: false });
      state.pendingLayer = 'cart';
      openAuth('login', $('#buyTelegramButton'));
      return;
    }
    const lines = [{ product: state.selectedProduct, plan: state.selectedPlan, quantity: 1, lineTotalKurus: state.selectedPlan.priceKurus }];
    submitOrder(lines, 'telegram', { button: $('#buyTelegramButton'), returnLayer: 'cart', resetAttemptOnSuccess: true, closeLayer: true });
  });
  $('#notifyStockButton')?.addEventListener('click', subscribeSelectedStock);

  $$('[data-store-open]').forEach((button) => button.addEventListener('click', () => {
    const action = button.dataset.storeOpen;
    if (action === 'cart') openCustomer('cart', button);
    else if (action === 'orders') openCustomer('orders', button);
    else if (action === 'deliveries') openCustomer('deliveries', button);
    else openCustomer('profile', button);
  }));
  $$('[data-store-auth]').forEach((button) => button.addEventListener('click', () => openAuth(button.dataset.storeAuth, button)));
  $$('[data-close-and-scroll]').forEach((button) => button.addEventListener('click', () => {
    const target = button.dataset.closeAndScroll;
    closeActiveLayer({ restoreFocus: false });
    scrollToStore(target);
  }));

  $('#mobileBottomNav')?.addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-store-action]');
    if (!button || button.disabled) return;
    const action = button.dataset.storeAction;
    if (action === 'cart') openCustomer('cart', button);
    else if (action === 'orders') openCustomer('orders', button);
    else if (action === 'deliveries') openCustomer('deliveries', button);
    else if (action === 'account') openCustomer('profile', button);
    else scrollToStore(action);
  });

  $('#customerNav')?.addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-customer-nav]');
    if (!button || button.disabled) return;
    setCustomerView(button.dataset.customerNav, { focus: false });
  });
  $('#customerNav')?.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const buttons = $$('#customerNav button').filter((button) => !button.disabled);
    if (!buttons.length) return;
    const current = Math.max(0, buttons.indexOf(event.target.closest?.('button')));
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? buttons.length - 1
        : (current + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    event.preventDefault();
    buttons[next].focus({ preventScroll: true });
  });
  $('#customerApp')?.addEventListener('click', (event) => {
    if (event.target.closest?.('[data-customer-home]')) {
      closeActiveLayer({ restoreFocus: false });
      scrollToStore('storefront');
      return;
    }
    if (event.target.closest?.('[data-customer-products]')) {
      closeActiveLayer({ restoreFocus: false });
      scrollToStore('catalog');
      return;
    }
    const target = event.target.closest?.('[data-customer-nav-target]');
    if (target) setCustomerView(target.dataset.customerNavTarget);
  });

  $('#cartClearButton')?.addEventListener('click', () => {
    if (!state.cart.size) return;
    state.cart.clear();
    clearAppliedPromotion();
    renderCart();
    showNotice('info', 'Sepetin temizlendi', 'Seçtiğin ürünler sepetinden kaldırıldı.');
  });

  $('#cartItems')?.addEventListener('click', (event) => {
    const remove = event.target.closest?.('[data-cart-remove]');
    if (remove) {
      state.cart.delete(remove.dataset.cartRemove);
      clearAppliedPromotion({ message: 'Sepet değiştiği için indirim kodunu yeniden doğrulayın.' });
      renderCart();
      showNotice('info', 'Sepetiniz güncellendi', 'Seçtiğiniz ürün sepetinizden kaldırıldı.');
      return;
    }
    const quantity = event.target.closest?.('[data-cart-quantity]');
    if (!quantity) return;
    const line = state.cart.get(quantity.dataset.cartKey);
    if (!line) return;
    if (quantity.dataset.cartQuantity === 'increase') {
      const product = getStoreProduct(state.catalog, line.productId);
      const plan = getStorePlan(product, line.planKey);
      line.quantity = Math.max(1, Math.min(5, Number(line.quantity || 1) + 1));
    }
    else line.quantity = Math.max(1, Number(line.quantity || 1) - 1);
    state.cart.set(quantity.dataset.cartKey, line);
    clearAppliedPromotion({ message: 'Sepet değiştiği için indirim kodunu yeniden doğrulayın.' });
    renderCart();
  });

  $('#ordersList')?.addEventListener('click', (event) => {
    const delivery = event.target.closest?.('[data-order-delivery]');
    if (delivery) {
      openCustomer('deliveries', delivery);
      return;
    }
    const start = event.target.closest?.('[data-order-cancel-start]');
    if (start) {
      state.cancelConfirmOrderId = start.dataset.orderCancelStart || '';
      renderOrders();
      return;
    }
    const dismiss = event.target.closest?.('[data-order-cancel-dismiss]');
    if (dismiss) {
      state.cancelConfirmOrderId = '';
      renderOrders();
      return;
    }
    const confirm = event.target.closest?.('[data-order-cancel-confirm]');
    if (confirm) cancelOrder(confirm.dataset.orderCancelConfirm);
  });
  $('#deliveriesList')?.addEventListener('click', (event) => {
    const open = event.target.closest?.('[data-delivery-open]');
    if (open) {
      openDeliveryAccess(open.dataset.deliveryOpen, open);
      return;
    }
    const copy = event.target.closest?.('[data-copy-delivery]');
    if (copy) copyDeliveryKey(copy.dataset.copyDelivery);
  });
  $('#deliveryAccessModal')?.addEventListener('click', (event) => {
    if (event.target.closest?.('[data-delivery-access-close]')) closeDeliveryAccess();
  });

  $('#orderFilterBar')?.addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-order-filter]');
    const selected = button?.dataset.orderFilter || '';
    if (!ORDER_FILTERS.includes(selected) || selected === state.orderFilter) return;
    state.orderFilter = selected;
    renderOrders();
  });

  $('#orderSearchInput')?.addEventListener('input', (event) => {
    state.orderSearch = String(event.currentTarget.value || '').slice(0, 80);
    renderOrders();
  });

  $('#orderSearchForm')?.addEventListener('submit', (event) => event.preventDefault());
  $('#orderSearchClose')?.addEventListener('click', () => {
    const form = $('#orderSearchForm');
    const input = $('#orderSearchInput');
    state.orderSearch = '';
    if (input) input.value = '';
    if (form) {
      form.hidden = true;
      form.inert = true;
    }
    renderOrders();
    $('#customerHeaderAction')?.focus({ preventScroll: true });
  });

  $('#customerHeaderAction')?.addEventListener('click', (event) => {
    const view = customerAppController?.view || 'profile';
    if (view === 'cart') {
      if (!state.cart.size) return;
      state.cart.clear();
      clearAppliedPromotion();
      renderCart();
      showNotice('info', 'Sepetin temizlendi', 'Seçtiğin ürünler sepetinden kaldırıldı.');
      return;
    }
    if (view === 'profile') {
      customerAppController?.openAction('username', event.currentTarget);
      return;
    }
    if (view === 'orders') {
      const form = $('#orderSearchForm');
      if (!form) return;
      form.hidden = false;
      form.inert = false;
      $('#orderSearchInput')?.focus({ preventScroll: true });
      return;
    }
    if (view === 'coupons') {
      loadCoupons({ force: true }).catch((error) => showNotice('error', 'Kuponlar yenilenemedi', friendlyStoreError(error)));
      return;
    }
    loadOrders(true).catch((error) => showNotice('error', 'Teslimatlar yenilenemedi', friendlyStoreError(error)));
  });

  $('#couponFilterBar')?.addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-coupon-filter]');
    const selected = button?.dataset.couponFilter || '';
    if (!COUPON_FILTERS.includes(selected) || selected === state.couponFilter) return;
    state.couponFilter = selected;
    renderCouponCollection();
  });

  $('#cartPromotionForm')?.addEventListener('submit', applyCartPromotion);
  $('#accountCouponApplyForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const code = String($('#accountCouponCode')?.value || '').trim().toLocaleUpperCase('en-US');
    if (!/^[A-Z0-9][A-Z0-9_-]{2,31}$/.test(code)) {
      return showNotice('warning', 'Kupon kodunu kontrol et', 'Kupon kodu 3-32 karakter olmalı ve yalnızca harf, sayı, tire veya alt çizgi içermelidir.');
    }
    if ($('#cartPromotionCode')) $('#cartPromotionCode').value = code;
    if (cartLines().length) {
      setCustomerView('cart');
      applyCartPromotion();
    } else {
      closeActiveLayer({ restoreFocus: false });
      scrollToStore('catalog');
      showNotice('info', 'Önce ürün seç', `${code} kuponun hazır. Bir ürün seçtiğinde kod sepette seni bekleyecek.`);
    }
  });
  $('#couponWallet')?.addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-use-coupon]');
    if (!button || button.disabled) return;
    if ($('#cartPromotionCode')) $('#cartPromotionCode').value = button.dataset.useCoupon || '';
    if (cartLines().length) {
      setCustomerView('cart');
      applyCartPromotion();
    } else {
      closeActiveLayer({ restoreFocus: false });
      scrollToStore('catalog');
      showNotice('info', 'Önce ürün seç', 'Kuponun hazır. Bir ürün seçtiğinde kod sepette seni bekleyecek.');
    }
  });

  $$('input[name="paymentMethod"]').forEach((input) => input.addEventListener('change', () => {
    if (input.disabled) return;
    state.paymentMethod = input.value === 'wallet' ? 'wallet' : 'telegram';
    resetCheckoutAttempt();
    syncPaymentChoice();
  }));
  $('#checkoutButton')?.addEventListener('click', () => {
    state.paymentMethod = 'wallet';
    const selected = $('input[name="paymentMethod"][value="wallet"]');
    if (selected) selected.checked = true;
    submitOrder(cartLines(), 'wallet', { button: $('#checkoutButton'), clearCart: true, closeLayer: true, returnLayer: 'cart' });
  });
  $('#telegramCheckoutButton')?.addEventListener('click', () => {
    state.paymentMethod = 'telegram';
    const selected = $('input[name="paymentMethod"][value="telegram"]');
    if (selected) selected.checked = true;
    submitOrder(cartLines(), 'telegram', { button: $('#telegramCheckoutButton'), clearCart: true, closeLayer: true, returnLayer: 'cart' });
  });

  $$('#authTabs [data-auth-tab]').forEach((button) => button.addEventListener('click', () => setAuthTab(button.dataset.authTab)));
  $('#loginForm')?.addEventListener('submit', handleLogin);
  $('#registerForm')?.addEventListener('submit', handleRegister);
  $('#forgotPasswordButton')?.addEventListener('click', handlePasswordReset);
  $('#authSheet')?.addEventListener('input', (event) => clearFieldIssue(event.target));
  $('#authSheet')?.addEventListener('change', (event) => clearFieldIssue(event.target));
  $$('[data-toggle-password]').forEach((button) => button.addEventListener('click', () => {
    const input = document.getElementById(button.dataset.togglePassword);
    if (!input) return;
    input.type = input.type === 'password' ? 'text' : 'password';
    const visible = input.type === 'text';
    const icon = $('i', button);
    if (icon) icon.className = `fa-solid ${visible ? 'fa-eye-slash' : 'fa-eye'}`;
    button.setAttribute('aria-pressed', String(visible));
    button.setAttribute('aria-label', visible ? 'Şifreyi gizle' : 'Şifreyi göster');
  }));

  $('#customerApp')?.addEventListener('click', (event) => {
    const close = event.target.closest?.('[data-account-action-close]');
    if (close) {
      customerAppController?.closeAction();
      return;
    }
    const action = event.target.closest?.('[data-account-action-open]');
    if (action) customerAppController?.openAction(action.dataset.accountActionOpen, action);
  });
  $('#accountActionModal')?.addEventListener('input', (event) => clearFieldIssue(event.target));
  $('#loadMoreOrdersButton')?.addEventListener('click', loadMoreCustomerOrders);
  $('#avatarPicker')?.addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-avatar-choice]');
    if (!button) return;
    state.selectedAvatarId = button.dataset.avatarChoice;
    $$('[data-avatar-choice]', event.currentTarget).forEach((choice) => {
      const selected = choice.dataset.avatarChoice === state.selectedAvatarId;
      choice.classList.toggle('is-selected', selected);
      choice.setAttribute('aria-pressed', String(selected));
    });
    applyAvatar($('#accountAvatar'), state.selectedAvatarId);
  });
  $('#saveAvatarButton')?.addEventListener('click', saveAvatar);
  $('#accountEmailActionButton')?.addEventListener('click', handleAccountEmailAction);
  $('#accountEmailChangeForm')?.addEventListener('submit', handleAccountEmailChange);
  $('#accountUsernameChangeForm')?.addEventListener('submit', (event) => handleAccountIdentityChange(event, 'username'));
  $('#accountNameChangeForm')?.addEventListener('submit', (event) => handleAccountIdentityChange(event, 'fullName'));
  $('#accountBirthDateChangeForm')?.addEventListener('submit', (event) => handleAccountIdentityChange(event, 'birthDate'));
  $('#accountPasswordForm')?.addEventListener('submit', handleAccountPasswordChange);
  $('#accountPasswordNew')?.addEventListener('input', renderAccountPasswordFeedback);
  $('#accountPasswordRepeat')?.addEventListener('input', renderAccountPasswordFeedback);
  $('#accountLogoutConfirm')?.addEventListener('click', handleAccountLogout);
  $('#logoutButton')?.addEventListener('click', (event) => customerAppController?.openAction('logout', event.currentTarget));

  installLayerControls();
}

function observeNavigation() {
  if (!('IntersectionObserver' in window)) return;
  const observer = new IntersectionObserver((entries) => {
    const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (!visible) return;
    const action = visible.target.id === 'androidProducts' ? 'android'
      : visible.target.id === 'iosProducts' ? 'ios'
        : visible.target.id === 'catalog' ? 'catalog' : 'storefront';
    setQuickNavActive(action);
  }, { rootMargin: '-35% 0px -45% 0px', threshold: [0, .2, .5] });
  ['storefront', 'catalog', 'androidProducts', 'iosProducts'].forEach((id) => {
    const node = document.getElementById(id);
    if (node) observer.observe(node);
  });
}

async function loadCatalog(force = false) {
  if (force && $('#catalogLoading')) {
    $('#catalogLoading').hidden = false;
    $('#catalogLoading').innerHTML = '<span></span><strong>Canlı katalog ve stok yenileniyor</strong>';
  }
  try {
    state.catalog = await loadStoreCatalog(storeApi, { force });
    if ($('#catalogLoading')) $('#catalogLoading').hidden = true;
    renderCatalog();
    renderCart();
    renderAccountHeader();
    if (state.selectedProduct) {
      const refreshedProduct = getStoreProduct(state.catalog, state.selectedProduct.id);
      const refreshedPlan = getStorePlan(refreshedProduct, state.selectedPlan?.key);
      if (refreshedProduct && state.activeLayer === $('#purchaseModal')) {
        openPurchase(refreshedProduct.id, refreshedPlan?.key || '', state.previousFocus);
      } else if (!refreshedProduct) {
        closeActiveLayer();
        showNotice('warning', 'Ürün güncellendi', 'Bu ürün şu anda satışta değil. Güncel katalogdan seçim yapabilirsin.');
      }
    }
    if (state.catalog.stale) showNotice('warning', 'Güncel stok doğrulanamadı', 'Son alınan katalog gösteriliyor. Otomatik satın alma, bağlantı yenilenene kadar kapalı.');
  } catch (error) {
    if ($('#catalogLoading')) {
      $('#catalogLoading').hidden = false;
      $('#catalogLoading').innerHTML = `${iconMarkup('fa-triangle-exclamation')}<strong>Ürünler şu anda yüklenemedi</strong><span>${escapeHtml(friendlyStoreError(error))}</span><button class="button button--glass" type="button" data-catalog-retry>${iconMarkup('fa-rotate')} Yeniden Dene</button>`;
    }
    showNotice('error', 'Ürünleri şu anda gösteremiyoruz', friendlyStoreError(error));
  }
}

export async function bootStorefront() {
  if (document.documentElement.dataset.storefrontBooted === '1') return;
  document.documentElement.dataset.storefrontBooted = '1';
  loadFavoriteProducts();
  installRuntimeSafety();
  installViewportStability();
  installShowcaseSlider();
  populateBirthSelectors();
  customerAppController = createCustomerAppController({
    layer: $('#customerApp'),
    authenticated: () => !!state.auth.user,
    busy: () => !!state.accountSecurityBusy || state.accountAvatarBusy || state.accountLogoutBusy,
    deliveryAvailable: () => deliveryEligibleOrders().length > 0,
    onViewChange: (view) => syncCustomerNavigation(view),
    onActionOpen: (action) => {
      if (action === 'avatar') {
        state.selectedAvatarId = String(state.auth.account?.avatarId || '1');
        renderAvatarPicker();
      }
      if (action === 'logout' && $('#accountLogoutName')) {
        $('#accountLogoutName').textContent = state.auth.account?.username || state.auth.user?.displayName || state.auth.user?.email || 'SHELBY STORE üyesi';
      }
      if (action === 'username' && $('#accountNewUsername')) $('#accountNewUsername').value = state.auth.account?.username || '';
      if (action === 'name') {
        if ($('#accountNewFirstName')) $('#accountNewFirstName').value = state.auth.account?.firstName || '';
        if ($('#accountNewLastName')) $('#accountNewLastName').value = state.auth.account?.lastName || '';
      }
      if (action === 'birthdate') {
        const [year, month, day] = String(state.auth.account?.birthDate || '').split('-');
        if ($('#accountBirthYear')) $('#accountBirthYear').value = year || '';
        if ($('#accountBirthMonth')) $('#accountBirthMonth').value = month ? String(Number(month)) : '';
        if ($('#accountBirthDay')) $('#accountBirthDay').value = day ? String(Number(day)) : '';
      }
      if (action === 'password') renderAccountPasswordFeedback();
    },
    onActionClose: (action) => {
      if (action === 'avatar') {
        state.selectedAvatarId = String(state.auth.account?.avatarId || '1');
        renderAvatarPicker();
      }
    }
  });
  installInteractions();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') return;
    if (!$('#deliveryAccessModal')?.hidden) closeDeliveryAccess({ restoreFocus: false });
    if (state.deliverySecrets.size) clearExposedDeliverySecrets();
  });
  renderCart();
  renderAccountHeader();
  subscribeStoreAuth((auth) => {
    const previouslySignedIn = !!state.auth.user;
    const previousUserId = String(state.auth.user?.uid || '');
    const nextUserId = String(auth.user?.uid || '');
    const identityChanged = !!previousUserId && previousUserId !== nextUserId;
    state.auth = auth;
    if (identityChanged || (!auth.user && previouslySignedIn)) clearCustomerSessionState({ closeProtectedLayer: true });
    renderAccountHeader();
    syncPaymentChoice();
    if (auth.user && (!previouslySignedIn || identityChanged || !state.ordersLoadedAt)) {
      loadOrders(true).catch(() => null);
      loadNotifications().catch(() => null);
    }
    if (auth.user && !previouslySignedIn && !state.authOperation && state.activeLayer === $('#authSheet')) {
      closeActiveLayer({ restoreFocus: false });
    }
  });
  observeNavigation();
  await Promise.all([initStoreAuth(), loadCatalog()]);
  document.documentElement.dataset.storefrontStatus = 'ready';
}
