import { createSearch } from "./search.mjs?v=109";
import { activeDiscovery } from "./discovery.mjs?v=109";
import { mountAmbient } from "./ambient.mjs?v=109";
import {
  createActivity,
  loadingCards,
  createHistoryScroll,
} from "./activity.mjs?v=109";
import { createAccountRecovery } from "./account-recovery.mjs?v=109";
import { initPasswordFields } from "./ui.js?v=109";
import { createAccountPages } from "./account-pages.mjs?v=110";
import { createStorePages, pageHeading } from "./store-pages.mjs?v=109";
import { authPanel } from "./auth-panel.mjs?v=109";
import { createCommunity } from "./community.mjs?v=109";
import { initPwa, installStore } from "./pwa.js?v=109";
import { createCommerceClient } from "./commerce-client.js?v=110";
import { translate, tr } from "./preferences.mjs?v=109";
import {
  authMode,
  authPath,
  authReturnTarget,
  syncNavigation,
  measureHeader,
} from "./navigation.mjs?v=109";
import { restoreStoreEntry, storeRoute, safeStorePath } from "./routes.mjs?v=109";
import {
  mountVerificationClock,
} from "./verification.mjs?v=109";
import { clearCustomerSessionView } from "./session-view.mjs?v=109";
import "./device.js?v=109";
import { presentScreen } from "./motion.mjs?v=109";
import { productGallery, galleryIndex } from "./gallery.mjs?v=109";
import { filterProducts } from "./catalog.mjs?v=109";
import {
  storeApi,
  loadStoreRuntimeConfig,
  friendlyStoreError,
} from "../store/api.js?v=109";
import {
  deviceMarker,
  initStoreAuth,
  subscribeStoreAuth,
  getStoreAuthSnapshot,
  signInStore,
  registerStore,
  logoutStore,
  refreshStoreAccount,
  changeStoreIdentity,
  changeStoreEmail,
  changeStorePassword,
  sendStoreVerificationEmail,
  verifyStoreEmailCode,
  resendStoreEmailCode,
  refreshStoreVerification,
  refreshStoreIdentity,
} from "../store/auth.js?v=109";
import { createPurchaseTracker } from "../store/purchase-tracker.js?v=109";
import { createCart, priceCart, checkoutState } from "./cart.mjs?v=109";
import {
  escape as e,
  money,
  date,
  icon,
  toast,
  raiseToasts,
  busy,
  modal,
  field,
  empty,
  status,
  safeImage,
  copyText,
} from "./ui.js?v=109";
restoreStoreEntry(window);
const $ = (s) => document.querySelector(s),
  main = $("#main");
const loadingStatus = document.createElement("p");
loadingStatus.className = "route-loading";
loadingStatus.setAttribute("role", "status");
loadingStatus.hidden = true;
document.body.append(loadingStatus);
const activity = createActivity({
  target: main,
  indicator: $("#navigation-progress"),
  status: loadingStatus,
});
const scrollHistory = createHistoryScroll(window);
let storage;
try {
  storage = localStorage;
} catch {}
const cart = createCart(storage);
let favorites = new Set();
const state = {
  catalog: null,
  catalogError: "",
  auth: getStoreAuthSnapshot(),
  orders: [],
  orderCursor: "",
  ordersLoaded: false,
  notifications: [],
  coupons: [],
  payment: "wallet",
  promotion: null,
  checkoutBusy: false,
  render: 0,
  giftRecipient: "",
  selectedPlans: new Map(),
  selectedImages: new Map(),
  authError: "",
};
let disposePanelAmbient = () => {};
let disposeVerificationClock = () => {};
const tracker = createPurchaseTracker({
  api: storeApi,
  userId: () => state.auth.user?.uid || "",
});
const uid = () => state.auth.user?.uid || "";

const commerce = createCommerceClient({
  api: storeApi,
  userId: uid,
  deviceMarker,
  cart,
  getFavorites: () => favorites,
  setFavorites: (values) => {
    favorites = new Set(values);
  },
  getProduct: product,
  navigate: go,
  refresh: () => {
    header();
    return render();
  },
  logout: logoutStore,
});

const pages = createStorePages({
  state,
  filtered,
  product,
  stockLabel,
  getFavorites: () => favorites,
  currentRoute: route,
});
const search = createSearch({
  form: $("#search-form"), input: $("#search-input"), results: $("#search-suggestions"), clear: $("#search-clear"),
  search: query => filtered({ name: "catalog", query: new URLSearchParams({ q: query }) }),
  navigate: go, available: () => Boolean(state.catalog),
});
const recovery = createAccountRecovery({ api: storeApi });
const community = createCommunity({ api: storeApi, userId: uid });
const accountPages = createAccountPages({
  state,
  uid,
  cart,
  cartView,
  tracker,
  checkoutState,
  commerce,
  avatarMarkup,
  userName: () => userName(),
  currentRoute: route,
});

const userName = () =>
  state.auth.account?.username ||
  state.auth.user?.displayName ||
  "Zentra üyesi";
function route() {
  return storeRoute(location.pathname, location.search);
}
function go(path, { replace = false } = {}) {
  if (recovery.busy) return;
  if (path === "/") { window.location.assign("/"); return; }
  search.sync(new URL(path, location.origin).searchParams.get("q") || "");
  scrollHistory.push(path, replace);
  void render().then(() => main.focus({ preventScroll: true }));
  window.scrollTo({ top: 0, behavior: "instant" });
}
function product(id) {
  return state.catalog?.products?.find((p) => p.id === id || p.seoSlug === id);
}
function cartView() {
  return priceCart(cart.items(), state.catalog);
}
function message(error) {
  return friendlyStoreError(
    error?.code,
    error?.message || "İşlem tamamlanamadı. Lütfen yeniden deneyin.",
  );
}
let visibleDiscovery;
function header() {
  const bar = document.querySelector(".header-inner");
  if (bar) bar.dataset.session = uid() ? "signed" : "guest";
  const discovery = activeDiscovery(route());
  for (const link of document.querySelectorAll("[data-discovery]")) {
    const active = discovery !== null && link.dataset.discovery === discovery;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  if (discovery !== visibleDiscovery) {
    const nav = document.querySelector(".category-nav"), active = nav?.querySelector("a.active");
    if (active) nav.scrollTo({ left: Math.max(0, active.offsetLeft - nav.offsetLeft - 8), behavior: "instant" });
    visibleDiscovery = discovery;
  }
  syncNavigation(document, {
    signedIn: Boolean(uid()),
    pathname: location.pathname,
    search: location.search,
    cartCount: cart.items().reduce((sum, item) => sum + item.quantity, 0),
  });
}
function stockLabel(p) {
  if (p.fulfillmentMode === "telegram_only") return "Telegram ile";
  if (p.stock?.state === "unverified" || state.catalog?.stockVerified === false)
    return "Stok doğrulanamadı";
  const count = Number(p.stock?.available || 0);
  return count >= 10 && count <= 35
    ? `Stokta · Son ${count} adet`
    : count > 0
      ? "Stokta"
      : "Stok bekleniyor";
}
function card(p) {
  return pages.card(p);
}
const heading = pageHeading;
function filtered(r) {
  return filterProducts(state.catalog, r, {
    favorites,
    categories: state.experience?.categories || [],
  });
}
function catalogMarkup(r, options) {
  return pages.catalog(r, options);
}
function home() {
  return pages.home();
}
function galleryMarkup(p) {
  return pages.gallery(p);
}
function selectGallery(id, next) {
  const p = product(id);
  const gallery = document.querySelector(".product-detail-media");
  if (!p || gallery?.dataset.product !== id) return;
  const pictures = productGallery(p),
    index = galleryIndex(next, pictures.length);
  state.selectedImages.set(id, index);
  const image = gallery.querySelector("[data-gallery-image]");
  image.src = safeImage(pictures[index].src);
  image.alt = pictures[index].alt;
  gallery
    .querySelectorAll("[data-action=gallery-select]")
    .forEach((button, i) => {
      button.setAttribute("aria-pressed", String(i === index));
      button.classList.toggle("active", i === index);
    });
  const counter = gallery.querySelector(".gallery-counter");
  if (counter) counter.textContent = `${index + 1} / ${pictures.length}`;
}
function packagePicker(id) {
  const p = product(id);
  if (!p || !p.plans?.length || route().name !== "product" || product(route().id)?.id !== p.id)
    throw new Error("Paket seçimi için ürün detayını aç.");
  const selected = route().query.get("paket") || state.selectedPlans.get(p.id);
  const dialog = modal({
    title: "Paketini seç", description: "Sana uygun kullanım süresini belirle.", symbol: "box", appearance: "package",
    body: pages.packageOptions(p, selected), submit: "Paketi seç",
    onSubmit: data => {
      const plan = p.plans.find(item => item.key === data.get("planKey"));
      if (!plan) throw new Error("Seçilen paket doğrulanamadı.");
      state.selectedPlans.set(p.id, plan.key);
      const target = new URL(location.href); target.searchParams.set("paket", plan.key);
      history.replaceState(history.state, "", target.pathname + target.search);
      void render();
    },
  });
  dialog.element.addEventListener("change", event => {
    if (event.target.name !== "planKey") return;
    const plan = p.plans.find(item => item.key === event.target.value);
    if (plan) dialog.element.querySelector("[data-package-total]").textContent = money(plan.priceKurus);
  });
}
function detail(id) {
  return pages.detail(id);
}
function cartMarkup() {
  return accountPages.cart();
}
function avatarMarkup() {
  const a = state.catalog?.avatars?.find(
    (x) => x.id === state.auth.account?.avatarId,
  );
  return a && /^https:\/\/encrypted-tbn0\.gstatic\.com\/images\?/.test(a.image)
    ? `<img src="${e(a.image)}" alt="" width="64" height="64" referrerpolicy="no-referrer"/>`
    : e(userName().slice(0, 1).toLocaleUpperCase("tr-TR"));
}
function avatarDialog() {
  modal({
    title: "Profil görselini seç",
    body: `<fieldset class="avatar-options"><legend class="sr-only">Profil görseli</legend>${(state.catalog?.avatars || []).map((a) => `<label><input type="radio" name="avatarId" value="${e(a.id)}" ${a.id === state.auth.account?.avatarId ? "checked" : ""} required/><span><img src="${e(a.image)}" alt="${e(a.label)}" width="64" height="64" loading="lazy" referrerpolicy="no-referrer"/></span></label>`).join("")}</fieldset>`,
    onSubmit: async (data) => {
      await storeApi("/api/store/profile/avatar", {
        method: "PATCH",
        body: { avatarId: data.get("avatarId") },
      });
      await refreshStoreAccount({ force: true });
      toast("Profil görselin kaydedildi.");
      render();
    },
  });
}
function accountShell(content, active) {
  return accountPages.shell(content, active);
}
function account() {
  return accountPages.account();
}
function orderCard(order) {
  return accountPages.orderCard(order);
}
function orders() {
  return accountPages.orders();
}
function authPage() {
  return authPanel({
    auth: state.auth,
    mode: authMode(location.search),
    error: state.authError,
    background: state.catalog ? home() : "",
  });
}
function socialLinks() {
  return (state.catalog?.storefront?.quickLinks || []).filter(
    (x) => x.enabled !== false && /^https:\/\//.test(x.url),
  );
}
function support() {
  const links = socialLinks();
  return (
    `<div class="help-hero"><span class="eyebrow">ZENTRA STORE / DESTEK MERKEZİ</span><div><span>${icon("support")}</span><div>${heading("Yanınızdayız", "YARDIM & DESTEK", "Siparişleriniz, cihaz uyumluluğu ve ürünleriniz için doğru kanala ulaşın.")}</div></div><div class="help-hero__links"><a href="/siparisler" data-nav>${icon("receipt")} Siparişlerim ${icon("arrow")}</a><a href="/hesabim?bolum=support" data-nav>${icon("support")} Destek taleplerim ${icon("arrow")}</a></div></div>` +
    `<section class="support-grid">${links.map((l) => `<article class="support-card">${icon(l.platform === "telegram" ? "telegram" : "support")}<h2>${e(l.title)}</h2><p>${e(l.description)}</p><a class="button secondary" href="${e(l.url)}" target="_blank" rel="noopener noreferrer">İletişime geç ${icon("arrow")}</a></article>`).join("")}</section><section class="faq"><div class="section-heading"><h2>Aklına takılanlar.</h2></div>${[
      [
        "Siparişim ne zaman teslim edilir?",
        "Bakiye ile ve uygun otomatik stokla verilen siparişlerde teslimat sipariş kaydıyla birlikte hazırlanır. Telegram siparişlerinde ödeme ve teslimat destek ekibi tarafından ayrı olarak teyit edilir.",
      ],
      [
        "Telegram’a gitmek ödeme yapmak mı demek?",
        "Hayır. Sipariş kaydı oluşturulur ve destek mesajın hazırlanır. Gerçek ödeme teyit edilmeden sipariş ödenmiş sayılmaz.",
      ],
      [
        "Teslimat bilgilerimi nerede bulabilirim?",
        "Hesabına giriş yaptıktan sonra Siparişlerim alanını aç. Teslim edilmiş uygun siparişlerde Teslimatımı aç düğmesini kullan.",
      ],
      [
        "Siparişimi iptal edebilir miyim?",
        "Siparişinin durumuna uygun iptal seçeneği sipariş kartında gösterilir. Teslim edilmiş ve ödeme teyidi gerektiren işlemlerde destek ekibine ulaş.",
      ],
    ]
      .map(([q, a]) => `<details><summary>${q}</summary><p>${a}</p></details>`)
      .join("")}</section>`
  );
}
async function render() {
  disposeVerificationClock();
  disposePanelAmbient();
  document.documentElement.classList.remove("auth-open");
  const version = ++state.render,
    r = route();
  const paint = (markup) =>
    presentScreen(main, markup, {
      isCurrent: () => version === state.render,
    }).then(() => {
      if (version === state.render) {
        translate(document.body);
        initPasswordFields(main);
        const sheet = document.getElementById("auth-sheet");
        if (sheet && !sheet.open) {
          sheet.showModal();
          disposePanelAmbient = mountAmbient(document, {
            host: sheet,
            count: 14,
          });
          raiseToasts();
          document.documentElement.classList.add("auth-open");
          sheet.addEventListener("cancel", (event) => {
            event.preventDefault();
            if (!getStoreAuthSnapshot().busy && !recovery.busy)
              go(authReturnTarget(location.pathname, location.search) || "/");
          });
        }
      }
      if (version === state.render)
        disposeVerificationClock = mountVerificationClock(
          document,
          state.auth.verification,
        );
    });
  header();
  const titles = {
    home: "Android ve iOS ürünleri",
    catalog: "Tüm ürünler",
    category: r.id,
    product: product(r.id)?.name || "Ürün",
    cart: "Sepetim",
    account:
      r.query.get("islem") === "sifre-yenile"
        ? "Şifreni yenile"
        : uid()
          ? "Hesabım"
          : authMode(location.search) === "register"
            ? "Kayıt Ol"
            : "Giriş Yap",
    orders: "Siparişlerim",
    favorites: "Favorilerim",
    support: "Yardım & destek",
    notifications: "Bildirimler",
    coupons: "Kuponlarım",
    promotions: "Bakiye promosyonu",
    notFound: "Sayfa bulunamadı",
  };
  document.body.dataset.zentraRoute = r.name;
  document.title = `${titles[r.name]} | Zentra Store`;
  const finishLoading = activity.begin(
    `${titles[r.name] || "Sayfa"} yükleniyor…`,
  );
  try {
    if (r.name === "account" && r.query.get("islem") === "sifre-yenile") {
      const token = r.query.get("recovery") || "";
      await paint(recovery.markup(token));
      if (version === state.render) await recovery.mount(main, token);
      return;
    }
    if (r.name === "notFound") {
      await paint(
        empty(
          "Aradığın sayfa burada değil.",
          "Bağlantı değişmiş veya sayfa kaldırılmış olabilir. Güncel ürünleri keşfedebilir ya da destek merkezine ulaşabilirsin.",
          "/magaza",
          "Ürünleri keşfet",
        ) +
          '<p style="text-align:center"><a class="button secondary" href="/destek" data-nav>Destek merkezi</a></p>',
      );
      return;
    }
    if (
      ["account", "orders", "notifications", "coupons", "promotions"].includes(r.name) &&
      !uid()
    ) {
      await paint(
        state.auth.ready
          ? authPage()
          : `<div class="empty-state"><span class="spinner"></span><p>Güvenli hesap bağlantısı hazırlanıyor…</p></div>`,
      );
      return;
    }
    if (
      !state.catalog &&
      [
        "home",
        "catalog",
        "category",
        "product",
        "favorites",
        "cart",
        "support",
      ].includes(r.name)
    ) {
      if (state.catalogError)
        await paint(
          empty("Mağaza bağlantısı bekleniyor", state.catalogError, "", "") +
            '<p style="text-align:center"><button class="button primary" data-action="reload-catalog">Yeniden dene</button></p>',
        );
      return;
    }
    if (r.name === "product" && !product(r.id)) {
      try {
        const info = await commerce.productInfo(r.id);
        if (version !== state.render) return;
        const resolved = state.catalog.products.find(
          (p) => p.id === info.product.productId,
        );
        if (resolved) resolved.seoSlug = r.id;
      } catch (error) {
        if (error.status !== 404) throw error;
      }
    }
    if (r.name === "account" && r.query.has("bolum")) {
      await paint(loadingCards("Hesap kayıtların yükleniyor…"));
      const markup = await commerce.accountSection(r.query.get("bolum"));
      if (version !== state.render) return;
      await paint(markup ? accountShell(markup) : account());
    } else if (r.name === "product" && product(r.id)) {
      let info;
      try {
        info = await commerce.productInfo(r.id);
      } catch (error) {
        info = null;
      }
      await community.load(product(r.id).id).catch(() => {});
      if (version !== state.render) return;
      if (info) product(r.id).gallery = info.product.gallery;
      if (info?.product?.seo) {
        const seo = info.product.seo;
        document.title = (seo.title || product(r.id).name) + " | Zentra Store";
        if (seo.description)
          document
            .querySelector("meta[name=description]")
            ?.setAttribute("content", seo.description);
        document
          .querySelector("link[rel=canonical]")
          ?.setAttribute(
            "href",
            new URL("/urun/" + (seo.slug || product(r.id).id), location.origin)
              .href,
          );
      }
      await paint(
        detail(r.id) +
          community.markup(product(r.id).id) +
          commerce.productExtras(
            product(r.id),
            info,
            r.query.get("paket") ||
              state.selectedPlans.get(product(r.id).id) ||
              product(r.id).plans[0]?.key,
          ),
      );
      void commerce
        .call("/events", {
          auth: false,
          body: {
            productId: r.id,
            event: "view",
            eventId: crypto.randomUUID(),
          },
        })
        .catch(() => {});
    } else if (r.name === "support") {
      let knowledge;
      try {
        knowledge = await commerce.call("/knowledge", { auth: false });
      } catch {}
      if (version !== state.render) return;
      await paint(
        support() +
          `<section class="panel"><h2>${tr("Bilgi merkezi", "Knowledge center")}</h2>${knowledge ? knowledge.articles.map((x) => `<details><summary>${e(x.title)}</summary><p data-user-content>${e(x.body)}</p></details>`).join("") || `<p>${tr("Henüz yayımlanmış ek yazı yok.", "No additional articles have been published yet.")}</p>` : `<p>${tr("Bilgi merkezi şu anda doğrulanamadı.", "Knowledge center could not be verified.")}</p>`}<a class="button secondary small" href="/hesabim?bolum=support" data-nav>${tr("Sipariş desteği", "Order support")}</a></section>`,
      );
    } else if (r.name === "orders") {
      if (!state.ordersLoaded) {
        await paint(loadingCards("Siparişlerin yükleniyor…"));
        const result = await storeApi("/api/store/orders?limit=20");
        if (version !== state.render) return;
        state.orders = result.orders || [];
        state.orderCursor = result.nextCursor || "";
        state.ordersLoaded = true;
      }
      await paint(orders());
      const orderId = r.query.get("order");
      if (orderId && orderId.length <= 160 && version === state.render) {
        const opened = await commerce.openOrder(orderId, {
          isCurrent: () => version === state.render,
        });
        if (opened && version === state.render) {
          const target = new URL(location.href);
          target.searchParams.delete("order");
          history.replaceState(
            history.state,
            "",
            target.pathname + target.search,
          );
        }
      }
    } else if (r.name === "notifications") {
      await paint(loadingCards("Bildirimlerin yükleniyor…"));
      const result = await storeApi("/api/store/notifications");
      if (version !== state.render) return;
      state.notifications = result.notifications || [];
      const unread = state.notifications.filter(item => !item.readAt).length;
      const notifications = state.notifications.map((n) => {
        // A notification is stored content, not a trusted navigation instruction.
        const href = safeStorePath(n.href || "") || "/bildirimler";
        return `<article class="notification-item ${n.readAt ? "read" : "unread"}"><div class="notification-heading">${icon(n.type === "security" ? "shield" : n.type === "order" ? "box" : "bell")}<b>${e(n.title)}</b><span class="status-pill ${n.readAt ? "" : "amber"}">${n.readAt ? "Okundu" : "Yeni"}</span></div><p>${e(n.message)}</p><small>${date(n.createdAt)}</small><div class="button-row"><a class="button secondary small" href="${e(href)}" data-nav>${e(n.actionLabel || "İlgili kaydı aç")} ${icon("arrow")}</a>${!n.readAt ? `<button class="button outline small" data-action="notification-read" data-id="${e(n.id)}">${icon("check")} Okundu olarak işaretle</button>` : ""}</div></article>`;
      }).join("");
      await paint(accountShell(
        `${heading("Bildirimlerim", "HESABINIZDAKİ GELİŞMELER", "Sipariş, hesap güvenliği ve mağaza duyurularını tek merkezde takip edin.")}<div class="notification-summary" aria-label="Bildirim özeti"><div><small>TOPLAM BİLDİRİM</small><strong>${state.notifications.length}</strong></div><div><small>OKUNMAMIŞ</small><strong>${unread}</strong></div><a href="/hesabim?bolum=preferences" data-nav>${icon("settings")} Bildirim tercihleri ${icon("arrow")}</a></div><section class="panel notification-feed"><header class="notification-feed__header"><h2>${icon("bell")} Hesap bildirimleriniz</h2><span>${unread ? `${unread} yeni bildirim` : "Tümü güncel"}</span></header>${notifications || empty("Her şey güncel", "Gerçek hesap, sipariş ve stok bildirimlerin burada görünür.", "", "")}</section><section class="panel email-delivery"><h2>${icon("mail")} E-posta gönderim durumu</h2><p class="fine-print">Sağlayıcının iletiyi kabul etmesi teslim edildiği anlamına gelmez.${result.webhookConfigured ? "" : " Teslimat webhook’u yapılandırılmadığından son teslimat doğrulanamayabilir."}</p>${(result.emailDelivery || []).map((n) => `<article class="notification-item"><b>${e(n.label)}</b><p>${e(n.stateLabel)}</p><small>${date(n.createdAt)}${n.deliveredAt ? " · Teslim: " + date(n.deliveredAt) : ""}</small></article>`).join("") || "<p>Hesabınıza ait gönderim kaydı henüz yok.</p>"}</section>`,
        "notifications",
      ));
    } else if (r.name === "promotions") {
      await paint(accountPages.coupons());
    } else if (r.name === "coupons") {
      const result = await storeApi("/api/store/promotions");
      if (version !== state.render) return;
      state.coupons = result.promotions || [];
      await paint(accountPages.coupons(state.coupons));
    } else
      await paint(
        r.name === "home"
          ? home()
          : ["catalog", "category", "favorites"].includes(r.name)
            ? catalogMarkup(r)
            : r.name === "product"
              ? detail(r.id)
              : r.name === "cart"
                ? cartMarkup()
                : r.name === "account"
                  ? account()
                  : support(),
      );
  } catch (error) {
    if (version !== state.render) return;
    await paint(
      heading("Bağlantı tamamlanamadı") +
        `<div class="notice error">${e(message(error))}</div><button class="button secondary" data-action="retry-view">Yeniden dene</button>`,
    );
  } finally {
    finishLoading();
  }
}
async function loadCatalog() {
  const finish = activity.begin("Ürünler ve mağaza bilgileri yükleniyor…");
  state.catalogError = "";
  try {
    await loadStoreRuntimeConfig();
    const result = await storeApi("/api/store/catalog", {
      auth: false,
      timeoutMs: 15000,
    });
    state.catalog = result.catalog || result;
    try {
      const response = await storeApi("/api/store/experience", {
        auth: false,
        timeoutMs: 5000,
      });
      state.experience = response.experience;
    } catch {}
    const links = socialLinks();
    $("#footer-social").innerHTML = ["tiktok", "telegram", "instagram"]
      .map((type) => links.find((l) => l.platform === type))
      .filter(Boolean)
      .map(
        (l) =>
          `<a href="${e(l.url)}" target="_blank" rel="noopener noreferrer">${e(l.platform.charAt(0).toUpperCase() + l.platform.slice(1))} →</a>`,
      )
      .join("");
  } catch (error) {
    state.catalogError = message(error);
  }
  finish();
  await render();
}
async function add(id, key) {
  const addingUid = uid();
  if (!uid()) {
    state.selectedPlans.set(id, key);
    go(
      authPath(
        "login",
        "/urun/" + encodeURIComponent(id) + "?paket=" + encodeURIComponent(key),
      ),
    );
    toast("Sepete eklemek için giriş yap.", "info");
    return;
  }
  if (tracker.pending())
    throw new Error("Önce sonucu belirsiz siparişini kontrol et.");
  const p = product(id);
  if (!p || !p.plans.some((x) => x.key === key))
    throw new Error("Paket doğrulanamadı.");
  if (!(await commerce.confirmCompatibility(p, key)) || addingUid !== uid())
    return;
  await commerce.changeCart(() => cart.add(id, key));
  state.promotion = null;
  header();
  toast("Ürün sepetine eklendi.");
}
function authRequired() {
  if (uid()) return false;
  go(authPath("login", location.pathname + location.search));
  toast("Devam etmek için hesabına giriş yap.", "info");
  return true;
}
function completeOrder(result, attempt) {
  if (attempt.uid !== uid()) return;
  tracker.finish(attempt);
  if (attempt.clearCart) {
    state.giftRecipient = "";
    cart.clear();
    void commerce.saveCart().catch((error) => toast(message(error), "error"));
  }
  state.ordersLoaded = false;
  state.promotion = null;
  void refreshStoreAccount({ force: true }).catch(() => {});
  go("/siparisler");
  toast(
    result.order?.paymentMethod === "telegram"
      ? "Sipariş kaydın oluşturuldu. Ödeme teyidi bekleniyor."
      : "Sipariş kaydın doğrulandı.",
  );
  if (result.telegramUrl || result.order?.telegramUrl) {
    const url = result.telegramUrl || result.order.telegramUrl;
    if (/^https:\/\/t\.me\//.test(url))
      modal({
        title: "Sipariş kaydın hazır",
        body: `<p class="fine-print">Ödeme ve teslimat için hazırlanan mesajla destek ekibine ulaş. Bu adım bir ödeme onayı değildir.</p><a class="button primary" style="margin-top:20px" href="${e(url)}" target="_blank" rel="noopener noreferrer">Telegram’da devam et ${icon("arrow")}</a>`,
      });
  }
}
async function recover(button) {
  busy(button, true, "Sorgulanıyor…");
  try {
    const attempt = tracker.pending();
    if (!attempt) return;
    const result = await tracker.verify(attempt);
    if (result?.found && result.order) completeOrder(result, attempt);
    else if (result?.cancelled) {
      tracker.finish(attempt);
      toast("Önceki deneme kapatıldı.");
      render();
    } else
      modal({
        title: "Sipariş sonucu henüz kesinleşmedi",
        body: '<p class="fine-print">Aynı sipariş için yeni ödeme oluşturma. Sonucu yeniden sorgulayabilir veya tamamlanmamış denemeyi güvenli biçimde kapatabilirsin. Oluşmuş bir sipariş kapatılmaz; önce mevcut sonuç döndürülür.</p>',
        submit: "Tamamlanmamış denemeyi kapat",
        onSubmit: async () => {
          const result = await storeApi("/api/store/order-attempt/cancel", {
            body: { idempotencyKey: attempt.body.idempotencyKey },
          });
          if (result.found && result.order) completeOrder(result, attempt);
          else if (result.cancelled) {
            tracker.finish(attempt);
            toast("Tamamlanmamış deneme kapatıldı.");
            render();
          } else throw new Error("Denemenin kapatıldığı doğrulanamadı.");
        },
      });
  } catch (error) {
    toast(message(error), "error");
  } finally {
    busy(button, false);
  }
}
async function checkout(button) {
  if (authRequired() || state.checkoutBusy) return;
  if (tracker.pending()) return recover(button);
  const buyingUid = uid();
  const view = cartView();
  if (!view.lines.length || view.invalid.length)
    throw new Error("Sepetini kontrol et.");
  state.checkoutBusy = true;
  busy(button, true, "Sipariş doğrulanıyor…");
  let attempt = null,
    prepared = null;
  try {
    prepared = await commerce.checkoutQuote(
      view.lines,
      state.payment,
      state.promotion?.code || "",
    );
    if (!prepared || buyingUid !== uid()) return;
    attempt = tracker.start(
      {
        items: prepared.quote.items.map((x) => ({
          productId: x.productId,
          planKey: x.planKey,
          quantity: x.quantity,
          expectedUnitPriceKurus: x.unitPriceKurus,
        })),
        paymentMethod: state.payment,
        idempotencyKey: crypto.randomUUID(),
        ...(state.promotion?.code
          ? { promotionCode: state.promotion.code }
          : {}),
        commerceQuote: prepared.quote.token,
        ...(prepared.reservation
          ? { reservationId: prepared.reservation.id }
          : {}),
      },
      { clearCart: true },
    );
    const result = await storeApi("/api/store/orders", {
      body: attempt.body,
      timeoutMs: 25000,
    });
    completeOrder(result, attempt);
  } catch (error) {
    const definitive =
      error.mutationNotSent ||
      (![0, 408, 500, 502, 503, 504].includes(Number(error.status || 0)) &&
        error.code !== "REQUEST_TIMEOUT");
    if (attempt && definitive) tracker.finish(attempt);
    if (prepared?.reservation && (!attempt || definitive))
      await commerce
        .call("/reservations/" + prepared.reservation.id + "/release", {
          body: {},
        })
        .catch(() => {});
    toast(message(error), "error");
    if (tracker.pending()) await recover(button);
    else await loadCatalog();
  } finally {
    state.checkoutBusy = false;
    busy(button, false);
  }
}
function connectEditSections(dialog) {
  const element = dialog.element;
  const update = () => {
    const current = element.querySelector("select[name=kind]").value;
    for (const section of element.querySelectorAll("[data-edit-section]")) {
      section.hidden = section.dataset.editSection !== current;
      section.disabled = section.hidden;
    }
  };
  element.querySelector("select[name=kind]").addEventListener("change", update);
  update();
}
function profileDialog() {
  const a = state.auth.account || {}, kindId = "profile-kind-" + crypto.randomUUID();
  const dialog = modal({
    title: "Profil bilgilerini düzenle", description: "Her güncelleme hesap parolanla doğrulanır.", symbol: "user",
    body: `<div class="field"><label for="${kindId}">Güncellenecek bilgi</label><select id="${kindId}" name="kind"><option value="fullName">Ad ve soyad</option><option value="username">Kullanıcı adı</option><option value="birthDate">Doğum tarihi</option></select></div><fieldset data-edit-section="fullName"><legend class="sr-only">Ad ve soyad</legend><div class="field-row">${field("firstName", "Ad", "text", a.firstName || "", 'required maxlength="50" autocomplete="given-name"')}${field("lastName", "Soyad", "text", a.lastName || "", 'required maxlength="50" autocomplete="family-name"')}</div></fieldset><fieldset data-edit-section="username" hidden disabled><legend class="sr-only">Kullanıcı adı</legend>${field("username", "Kullanıcı adı", "text", a.username || "", 'required maxlength="20" autocomplete="username"')}</fieldset><fieldset data-edit-section="birthDate" hidden disabled><legend class="sr-only">Doğum tarihi</legend>${field("birthDate", "Doğum tarihi", "date", a.birthDate || "", 'required autocomplete="bday"')}</fieldset>${field("currentPassword", "Hesap şifren", "password", "", 'required autocomplete="current-password"')}`,
    onSubmit: async data => {
      const kind = data.get("kind"), values = kind === "fullName" ? { firstName: data.get("firstName"), lastName: data.get("lastName") } : kind === "username" ? { username: data.get("username") } : { birthDate: data.get("birthDate") };
      await changeStoreIdentity({ field: kind, values, currentPassword: data.get("currentPassword") });
      toast("Profil bilgin kaydedildi."); void render();
    },
  });
  connectEditSections(dialog);
}
function securityDialog() {
  const kindId = "security-kind-" + crypto.randomUUID();
  const dialog = modal({
    title: "Hesap güvenliği", description: "Hassas değişiklikler mevcut parolanı gerektirir.", symbol: "shield",
    body: `<div class="field"><label for="${kindId}">İşlem</label><select id="${kindId}" name="kind"><option value="password">Şifremi değiştir</option><option value="email">E-postamı değiştir</option></select></div>${field("currentPassword", "Mevcut şifren", "password", "", 'required autocomplete="current-password"')}<fieldset data-edit-section="password"><legend class="sr-only">Yeni şifren</legend>${field("newPassword", "Yeni şifre", "password", "", 'required minlength="8" autocomplete="new-password"')}${field("newPasswordRepeat", "Yeni şifre tekrarı", "password", "", 'required autocomplete="new-password"')}<p class="fine-print">Parolanı başka hesaplarda kullandığın parolalardan farklı seç.</p></fieldset><fieldset data-edit-section="email" hidden disabled><legend class="sr-only">Yeni e-posta adresin</legend>${field("newEmail", "Yeni e-posta", "email", "", 'required autocomplete="email"')}<p class="fine-print">Yeni adrese gelen bağlantı doğrulanmadan e-posta değişikliği tamamlanmaz.</p></fieldset>`,
    onSubmit: async data => {
      if (data.get("kind") === "email") {
        await changeStoreEmail({ newEmail: data.get("newEmail"), currentPassword: data.get("currentPassword") });
        toast("Yeni e-postaya doğrulama bağlantısı gönderildi.");
      } else { await changeStorePassword(Object.fromEntries(data)); toast("Şifren güncellendi."); }
      void render();
    },
  });
  connectEditSections(dialog);
}
async function action(button) {
  const { action: a, id, plan } = button.dataset;
  if (button.disabled || button.getAttribute("aria-busy") === "true") return;
  if (state.checkoutBusy && !["recover"].includes(a)) return;
  try {
    if (a === "store-menu")
      return modal({
        title: "Keşfet",
        appearance: "drawer",
        body: pages.drawer(),
      });
    if (a === "auth-close") {
      if (!getStoreAuthSnapshot().busy && !recovery.busy)
        go(authReturnTarget(location.pathname, location.search) || "/");
      return;
    }
    if (a === "select-package") return packagePicker(id);
    if (a === "verify-email") {
      const result = await sendStoreVerificationEmail();
      toast(
        result.alreadyVerified
          ? "E-posta adresin doğrulanmış."
          : "Doğrulama kodunun gönderim durumu güncellendi.",
      );
      await render();
      return;
    }
    if (
      [
        "verification-resend",
        "verification-refresh",
        "verification-complete",
        "verification-switch",
      ].includes(a)
    ) {
      state.authError = "";
      busy(button, true);
      try {
        if (a === "verification-switch") {
          await logoutStore();
          go(authPath("login"));
        } else {
          const result =
            a === "verification-resend"
              ? await resendStoreEmailCode()
              : await refreshStoreVerification({
                  complete: a === "verification-complete",
                });
          if (result.user) {
            toast("E-posta adresin doğrulandı. Hesabın hazır.");
            const target = authReturnTarget(location.pathname, location.search);
            go(target || "/hesabim", { replace: true });
          } else await render();
        }
      } catch (error) {
        state.authError = message(error);
        await render();
      } finally {
        busy(button, false);
      }
      return;
    }
    if (a === "refresh-email") {
      await refreshStoreIdentity();
      toast(
        getStoreAuthSnapshot().user?.emailVerified
          ? "E-posta adresin doğrulanmış."
          : "E-posta doğrulaması henüz tamamlanmadı.",
      );
      return;
    }
    if (a === "gallery-select" || a === "gallery-step") {
      const pictures = productGallery(product(id));
      const current = galleryIndex(
        state.selectedImages.get(id),
        pictures.length,
      );
      selectGallery(
        id,
        a === "gallery-select"
          ? Number(button.dataset.index)
          : current + Number(button.dataset.step),
      );
      return;
    }
    if (a === "copy-delivery") {
      const value = button
        .closest(".delivery-item")
        ?.querySelector(".delivery-secret")?.textContent;
      if (!value) throw new Error("Kopyalanacak teslimat bilgisi bulunamadı.");
      await copyText(value);
      toast("Teslimat bilgisi kopyalandı.");
      return;
    }
    if (a === "install-app") return await installStore();
    if (a === "add") {
      busy(button, true, "Kontrol ediliyor…");
      await add(id, plan);
      return;
    }
    if (a === "favorite") {
      if (authRequired()) return;
      favorites.has(id) ? favorites.delete(id) : favorites.add(id);
      await commerce.saveFavorites();
      render();
      return;
    }
    if (a === "remove" || a === "quantity") {
      if (tracker.pending())
        throw new Error("Önce bekleyen sipariş sonucunu kontrol et.");
      busy(button, true);
      await commerce.changeCart(() => {
        if (a === "remove") cart.remove(id, plan);
        else {
          const row = cart
              .items()
              .find((x) => x.productId === id && x.planKey === plan),
            qty = (row?.quantity || 0) + Number(button.dataset.change);
          if (qty > 5)
            throw new Error("Bir paketten en fazla 5 adet seçebilirsin.");
          if (qty < 1) cart.remove(id, plan);
          else cart.quantity(id, plan, qty);
        }
      });
      state.promotion = null;
      render();
      return;
    }
    if (a === "clear-promotion") { state.promotion = null; return render(); }
    if (a === "checkout") return await checkout(button);
    if (a === "recover") return await recover(button);
    if (a === "reload-catalog") return await loadCatalog();
    if (a === "retry-view") return await render();
    if (a === "auth-tab") {
      state.authError = "";
      go(
        authPath(
          button.dataset.tab,
          authReturnTarget(location.pathname, location.search),
        ),
      );
      return;
    }
    if (a === "reset-password" || a === "recover-username") {
      recovery.request(a === "recover-username" ? "username" : "password");
      return;
    }
    if (a === "logout") {
      await logoutStore();
      state.orders = [];
      state.ordersLoaded = false;
      go("/hesabim");
      toast("Oturumun kapatıldı.");
      return;
    }
    if (a === "avatar") return avatarDialog();
    if (a === "profile") return profileDialog();
    if (a === "security") return securityDialog();
    if (a === "filters") {
      const r = route();
      modal({
        title: "Aramanı daralt",
        body: `<div class="field-row">${field("min", "En düşük fiyat (₺)", "number", r.query.get("min") || "", 'min="0" step="1"')}${field("max", "En yüksek fiyat (₺)", "number", r.query.get("max") || "", 'min="0" step="1"')}</div><label class="checkbox"><input type="checkbox" name="stock" ${r.query.get("stock") === "1" ? "checked" : ""}/> Yalnızca doğrulanmış stoktaki ürünler</label>`,
        submit: "Sonuçları göster",
        onSubmit: (data) => {
          const min = Number(data.get("min")),
            max = Number(data.get("max"));
          if (min && max && max < min)
            throw new Error("En yüksek fiyat, en düşük fiyattan az olamaz.");
          const u = new URL(location.href);
          for (const k of ["min", "max", "stock"]) u.searchParams.delete(k);
          if (min) u.searchParams.set("min", min);
          if (max) u.searchParams.set("max", max);
          if (data.get("stock")) u.searchParams.set("stock", "1");
          go(u.pathname + u.search);
        },
      });
      return;
    }
    if (a === "more-orders") {
      const requestUid = uid(),
        requestView = state.render;
      busy(button, true);
      const result = await storeApi(
        "/api/store/orders?limit=20&cursor=" +
          encodeURIComponent(state.orderCursor),
      );
      if (requestUid !== uid() || requestView !== state.render) return;
      state.orders.push(...(result.orders || []));
      state.orderCursor = result.nextCursor || "";
      main.innerHTML = orders();
      return;
    }
    if (a === "cancel-order") {
      modal({
        title: "Siparişini iptal et",
        body:
          '<p class="fine-print">İptal uygunluğu sunucuda tekrar denetlenir. Ödenmiş veya teslim edilmiş siparişler otomatik iptal edilmez.</p>' +
          field(
            "reason",
            "İptal nedeni",
            "text",
            "",
            'required minlength="3" maxlength="240"',
          ),
        submit: "İptali onayla",
        danger: true,
        onSubmit: async (data) => {
          await storeApi(`/api/store/orders/${encodeURIComponent(id)}/cancel`, {
            body: { reason: data.get("reason") },
          });
          state.ordersLoaded = false;
          toast("Siparişin iptali doğrulandı.");
          render();
        },
      });
      return;
    }
    if (a === "delivery") {
      const ownerUid = uid();
      busy(button, true, "Açılıyor…");
      const result = await storeApi(
        `/api/store/orders/${encodeURIComponent(id)}/delivery`,
      );
      if (!ownerUid || ownerUid !== uid()) return;
      const d = result.delivery || {};
      const items = d.items || d.keys || [];
      modal({
        title: "Teslimat bilgilerin",
        body: `<p class="fine-print">Bu bilgiler sana özeldir. Güvenli bir yerde sakla.</p><button type="button" class="button secondary small" data-commerce="order" data-id="${e(id)}">Sipariş adımları ve teslim alındı onayı</button>${items.map((x) => (x.productId ? `<p><a class="section-link" href="/urun/${e(x.productId)}" data-nav>Ürün ve kurulum açıklaması ${icon("arrow")}</a></p>` : "")).join("")}${items.length ? items.map((x) => `<div class="delivery-item"><b>${e(x.productName || x.label || "Ürün")}</b><code class="delivery-secret">${e(x.copyValue || x.value || x.key || (x.type === "account" ? JSON.stringify(x) : x.secret) || "")}</code><button type="button" class="button secondary small" data-action="copy-delivery">${icon("copy")} Bilgiyi kopyala</button></div>`).join("") : `<p>${e(d.message || "Teslimat verileri bu görünümde gösterilemedi. Sipariş referansınla desteğe ulaş.")}</p>`}`,
      });
      return;
    }
    if (a === "restock") {
      if (authRequired()) return;
      busy(button, true);
      await storeApi("/api/store/restock-subscriptions", {
        body: { productId: id, planKey: plan },
      });
      toast("Stok bildirimi isteğin kaydedildi.");
      return;
    }
    if (a === "notification-read") {
      busy(button, true);
      await storeApi(
        `/api/store/notifications/${encodeURIComponent(id)}/read`,
        { method: "PATCH", body: {} },
      );
      render();
      return;
    }
    if (a === "copy-code") {
      await copyText(button.dataset.code);
      toast("Kod kopyalandı.");
    }
  } catch (error) {
    toast(message(error), "error");
  } finally {
    if (button.isConnected) busy(button, false);
  }
}
document.addEventListener("input", (event) => {
  if (event.target.id === "commerce-gift-recipient")
    state.giftRecipient = event.target.value;
});
document.addEventListener("click", (event) => {
  const nav = event.target.closest("a[data-nav]");
  if (
    nav &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    event.button === 0
  ) {
    const u = new URL(nav.href, location.href);
    if (u.origin === location.origin) {
      event.preventDefault();
      go(u.pathname + u.search);
      return;
    }
  }
  const button = event.target.closest("[data-action]");
  if (button) {
    event.preventDefault();
    void action(button);
  }
  const info = event.target.closest("[data-info]");
  if (info) {
    modal({
      title:
        info.dataset.info === "privacy"
          ? "Gizlilik ve veri kullanımı"
          : "Satın alma bilgileri",
      body: `<p class="fine-print">${info.dataset.info === "privacy" ? "Hesap, sipariş ve güvenlik bilgileriniz hizmetin sunulması ve işlem güvenliği için saklanır. Yalnızca kendi hesabınıza ait müşteri verilerine erişebilirsiniz. Veri talepleri için destek ekibine ulaşabilirsiniz." : "Ürün türü, platform ve paket süresini satın almadan önce kontrol edin. Bakiye ile alışverişte tutar ve stok sunucuda doğrulanır. Telegram siparişinde ödeme ve teslimat ayrıca teyit edilir. İptal ve iade talebiniz siparişin durumu ve geçerli koşullara göre değerlendirilir. Satıcıya ait sözleşme ve iletişim bilgileri için destek ekibine ulaşın."}</p><a class="button secondary" style="margin-top:16px" href="/destek" data-nav>Destek ekibine ulaş</a>`,
    });
  }
});
document.addEventListener("change", (event) => {
  if (event.target.id === "sort-products") {
    const u = new URL(location.href);
    event.target.value
      ? u.searchParams.set("sort", event.target.value)
      : u.searchParams.delete("sort");
    go((u.pathname === "/" ? "/magaza" : u.pathname) + u.search);
  }
  if (event.target.name === "product-plan") {
    state.selectedPlans.set(event.target.dataset.product, event.target.value);
    render();
  }
  if (event.target.name === "payment") { state.payment = event.target.value; void render(); }
});
document.addEventListener("submit", async (event) => {
  const form = event.target;
  if (
    ![
      "auth-form",
      "verification-form",
      "coupon-form",
      "balance-code-form",
    ].includes(form.id)
  )
    return;
  event.preventDefault();
  const data = new FormData(form),
    button = form.querySelector("[type=submit]");
  busy(button, true);
  try {
    if (form.id === "auth-form" || form.id === "verification-form") {
      state.authError = "";
      let result;
      if (form.id === "verification-form")
        result = await verifyStoreEmailCode(data.get("code"));
      else if (form.dataset.mode === "register")
        result = await registerStore({
          ...Object.fromEntries(data),
          remember: data.get("remember") === "on",
        });
      else
        result = await signInStore({
          identifier: data.get("identifier"),
          password: data.get("password"),
          remember: data.get("remember") === "on",
        });
      if (result.verificationRequired || !result.user) {
        await render();
        return;
      }
      toast(
        form.id === "verification-form"
          ? "E-posta adresin doğrulandı. Hesabın hazır."
          : "Hesap oturumun doğrulandı.",
      );
      const next = authReturnTarget(location.pathname, location.search);
      go(next || (cart.items().length ? "/sepet" : "/hesabim"), {
        replace: true,
      });
    } else if (form.id === "coupon-form") {
      if (authRequired()) return;
      const result = await storeApi("/api/store/promotions/validate", {
        body: { items: cart.items(), code: data.get("code") },
      });
      state.promotion = result.promotion;
      toast("İndirim kodu doğrulandı.");
      if (form.dataset.couponDestination === "cart") go("/sepet");
      else render();
    } else {
      const redemption = await storeApi("/api/store/balance-codes/redeem", {
        body: { code: data.get("code") },
      });
      await refreshStoreAccount({ force: true });
      if (redemption.result?.idempotentReplay || redemption.idempotentReplay) toast("Bu promosyon kodunu daha önce kullandın.", "info");
      else toast("Bakiye kodunun sonucu doğrulandı.");
      render();
    }
  } catch (error) {
    if (["auth-form", "verification-form"].includes(form.id)) {
      state.authError = message(error);
      await render();
      return;
    }
    const node = form.querySelector(".form-error");
    if (node) {
      node.hidden = false;
      node.textContent = message(error);
    } else toast(message(error), "error");
  } finally {
    busy(button, false);
  }
});
document.addEventListener("keydown", (event) => {
  if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
  const gallery = event.target.closest?.(".product-detail-media");
  if (!gallery) return;
  event.preventDefault();
  const id = gallery.dataset.product;
  selectGallery(
    id,
    (state.selectedImages.get(id) || 0) + (event.key === "ArrowRight" ? 1 : -1),
  );
});
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "k") {
    event.preventDefault();
    $("#search-input").focus();
  }
  if (event.key === "Escape") search.close();
});
document.addEventListener("input", (event) => {
  if (event.target.id === "commerce-gift-recipient")
    state.giftRecipient = event.target.value;
});
window.addEventListener("popstate", () => {
  search.sync(new URLSearchParams(location.search).get("q") || "");
  const y = history.state?.zentraScroll;
  void render().then(() => scrollHistory.restore(y));
});
window.addEventListener("storage", (event) => {
  if (uid() && event.key === "zentra-cart-v2:" + uid()) {
    toast(
      "Sepetin başka bir sekmede değişti. Güncel bilgileri almak için sayfayı yenile.",
      "info",
    );
  }
});
document
  .querySelectorAll("[data-icon]")
  .forEach((n) => (n.innerHTML = icon(n.dataset.icon)));
$("#copyright-year").textContent = new Date().getFullYear();
measureHeader(document, window);
header();
let priorUid = "",
  priorAuthKey = "";
subscribeStoreAuth((snapshot) => {
  state.auth = snapshot;
  const next = snapshot.user?.uid || "";
  if (priorUid !== next) {
    ++state.render;
    clearCustomerSessionView(state, document);
    state.giftRecipient = "";
    if (
      ["account", "orders", "coupons", "promotions", "notifications", "cart"].includes(
        route().name,
      )
    )
      main.replaceChildren();
    void commerce
      .connect(next)
      .catch((error) => toast(message(error), "error"));
    priorUid = next;
  }
  header();
  const key = JSON.stringify([
    next,
    snapshot.ready,
    snapshot.busy,
    snapshot.account?.username,
    snapshot.account?.balanceKurus,
    snapshot.account?.firstName,
    snapshot.account?.lastName,
    snapshot.account?.avatarId,
    snapshot.user?.emailVerified,
    snapshot.user?.email,
    snapshot.registrationEmail,
    snapshot.verification?.challengeId,
    snapshot.verification?.state,
    snapshot.verification?.delivery,
    snapshot.verification?.remainingAttempts,
    snapshot.verification?.profileRequired,
  ]);
  const changed = key !== priorAuthKey;
  priorAuthKey = key;
  if (
    changed &&
    !snapshot.busy &&
    ["account", "orders", "coupons", "promotions", "notifications", "cart"].includes(
      route().name,
    )
  )
    void render();
});
initPwa({
  isBusy: () =>
    state.checkoutBusy ||
    !!tracker.pending() ||
    recovery.busy ||
    !!getStoreAuthSnapshot().busy ||
    !!document.querySelector('dialog[open] [aria-busy="true"]'),
});
void loadCatalog();
void initStoreAuth().catch((error) => {
  state.auth = { ...state.auth, ready: true };
  toast(message(error), "error");
  render();
});
