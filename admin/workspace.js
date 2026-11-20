import { createActivity } from "../public/js/app/activity.mjs?v=108";
import { inventoryView, bindInventory } from "./inventory-view.mjs?v=108";
import { initPasswordFields } from "../public/js/app/ui.js?v=108";
import {
  adminViews,
  adminLayout,
  adminNavigation,
  resolveView,
} from "./layout.mjs?v=108";
import { walletView, bindWallet } from "./wallet-view.mjs?v=108";
import { openWalletDialog, clearWalletState } from "./wallet.js?v=108";
import { createCommerceWorkspace } from "./commerce.js?v=108";
import { dismissPrivateDialogs } from "../public/js/app/session-view.mjs?v=108";
import "../public/js/app/device.js?v=108";
import { presentScreen } from "../public/js/app/motion.mjs?v=108";
import { metricLabel, metricValue } from "./metrics.mjs?v=108";
import {
  escape as e,
  copyText,
  money,
  date,
  icon,
  toast,
  modal,
  field,
  busy,
  status,
  statusNames,
  empty,
} from "../public/js/app/ui.js?v=108";
import { productCards } from "./product-view.mjs?v=108";
import { openProductEditor } from "./product-editor.mjs?v=108";
import { isProductSettingsUpdate } from "./product-policy.mjs?v=108";
import { supplierView } from "./supplier-view.mjs?v=108";
const views = adminViews;
let workspaceActivity;
let disposeInventory = () => {};
let disposeWallet = () => {};
let commerceWorkspace,
  retainedInventory = null;
let api,
  context,
  root,
  onLogout,
  version = 0,
  main,
  filterStatus = "",
  userQuery = "",
  orderCursor = "",
  userCursor = "",
  catalog = null,
  rows = [],
  experience = null,
  activeJob = null,
  jobTimer = null,
  currentView = "",
  mounted = false;
const can = (p) =>
  context?.permissions?.includes("*") || context?.permissions?.includes(p);
const qs = (s) => root?.querySelector(s);
const select = (name, label, options, value = "") => {
  const id = "select-" + crypto.randomUUID();
  return `<div class="field"><label for="${id}">${e(label)}</label><select id="${id}" name="${e(name)}">${options.map(([k, v]) => `<option value="${e(k)}" ${String(k) === String(value) ? "selected" : ""}>${e(v)}</option>`).join("")}</select></div>`;
};
const check = (name, label, value = false) =>
  `<label class="checkbox"><input type="checkbox" name="${e(name)}" ${value ? "checked" : ""}/>${e(label)}</label>`;
const area = (name, label, value = "", attrs = "") =>
  `<label class="field"><span>${e(label)}</span><textarea name="${e(name)}" ${attrs}>${e(value)}</textarea></label>`;
const viewHeader = (title, description = "", action = "") =>
  `<header class="admin-view-header"><div><span class="eyebrow">ZENTRA YÖNETİM MERKEZİ</span><h1>${e(title)}<span class="accent-dot">.</span></h1><p>${e(description)}</p></div>${action}</header>`;
const button = (action, label, ic = "plus", attrs = "") =>
  `<button type="button" class="button secondary small" data-admin-action="${e(action)}" ${attrs}>${icon(ic)} ${e(label)}</button>`;
const jsonValue = (value) =>
  typeof value === "object"
    ? JSON.stringify(value, null, 2)
    : String(value ?? "—");
const permission = () =>
  '<div class="panel permission-note">Bu alan için yetkin bulunmuyor. Yetkili yöneticiyle iletişime geç.</div>';
const errorView = (error) =>
  `<div class="notice error"><div><b>Veri doğrulanamadı.</b><p>${e(error.message || "Bağlantıyı kontrol edip yeniden dene.")}</p></div></div>${button("refresh", "Yeniden dene", "arrow")}`;
function shell() {
  root.innerHTML = adminLayout(context);
  main = qs("#admin-main");
  document.removeEventListener("click", click);
  document.removeEventListener("change", change);
  document.removeEventListener("submit", submit);
  document.addEventListener("click", click);
  document.addEventListener("change", change);
  document.addEventListener("submit", submit);
  window.addEventListener("hashchange", hashChange);
}
function hashChange() {
  document.body.classList.remove("menu-open");
  void show();
}
async function show() {
  if (!mounted || !main?.isConnected) return;
  workspaceActivity?.cancel();
  workspaceActivity = createActivity({ target: main });
  const selected = resolveView(location.hash);
  disposeInventory();
  disposeWallet();
  currentView = selected[0];
  const v = ++version;
  clearTimeout(jobTimer);
  qs("#workspace-title").textContent = selected[2];
  qs(".admin-nav")
    ?.querySelectorAll("a")
    .forEach((a) => {
      a.classList.toggle("active", a.dataset.adminView === currentView);
      a.dataset.adminView === currentView
        ? a.setAttribute("aria-current", "page")
        : a.removeAttribute("aria-current");
    });
  if (!can(selected[3])) {
    main.innerHTML = permission();
    return;
  }
  main.innerHTML =
    viewHeader(
      selected[2],
      "Güncel veriler güvenli bağlantı üzerinden yükleniyor.",
    ) +
    '<div class="stat-grid">' +
    Array.from(
      { length: 4 },
      () => '<div class="skeleton" style="height:140px"></div>',
    ).join("") +
    "</div>";
  workspaceActivity ||= createActivity({ target: main });
  const finishLoading = workspaceActivity.begin();
  try {
    const markup = currentView.startsWith("commerce-")
      ? await commerceWorkspace.render(currentView)
      : await {
          overview,
          orders,
          products,
          inventory,
          experienceView,
          coupons: promotions,
          promocodes: balanceCodes,
          content: settings,
          users,
          wallet,
          links,
          audit,
          security,
          settings,
          staff,
          supplier,
        }[currentView === "experience" ? "experienceView" : currentView]();
    if (v !== version) return;
    await presentScreen(main, markup, { isCurrent: () => v === version });
    if (v !== version) return;
    initPasswordFields(main);
    if (currentView === "inventory") {
      const session = context;
      disposeInventory = bindInventory({
        root: main,
        catalog,
        api,
        ensureActive: () => {
          if (!mounted || context !== session)
            throw new Error("Yönetici oturumu değişti.");
        },
        reauthenticate: (p) => window.ZENTRA_ADMIN_AUTH.reauthenticate(p),
        retained:
          retainedInventory?.uid === session.uid ? retainedInventory : null,
        onRetain: (value) => {
          if (mounted && context === session)
            retainedInventory = value ? { ...value, uid: session.uid } : null;
        },
        refresh: show,
      });
    }
    if (currentView === "wallet") {
      const session = context;
      disposeWallet = bindWallet({
        root: main,
        api,
        ensureActive: () => {
          if (!mounted || context !== session)
            throw new Error("Yönetici oturumu değişti.");
        },
        onAdjust: (identifier) => walletAdjust(identifier),
      });
    }
    if (activeJob && ["orders", "audit"].includes(currentView)) {
      drawJob();
      pollJob();
    }
  } catch (error) {
    if (v === version)
      main.innerHTML = viewHeader(selected[2]) + errorView(error);
  } finally {
    finishLoading();
  }
}
async function overview() {
  const { overview: o } = await api("/api/admin/store/overview"),
    m = o.metrics || {},
    total = metricValue(m, "orders");
  return (
    viewHeader(
      "Mağazana genel bakış",
      "Gerçek sipariş, stok ve hesap verileri. " +
        (m.ordersComplete === false
          ? `Analiz son ${m.ordersAnalyzed} siparişi kapsıyor.`
          : "Veriler son sorgu anını yansıtır."),
    ) +
    `<section class="stat-grid">${[
      [
        "Toplam sipariş",
        metricLabel(m, "orders"),
        "bag",
        `Bugün: ${metricLabel(m, "todayOrders")} sipariş`,
      ],
      [
        "Net onaylanan tutar",
        metricLabel(m, "netRevenueKurus", money),
        "wallet",
        "İadeler düşülmüş sipariş tutarı",
      ],
      [
        "Ödeme bekleyen",
        metricLabel(m, "awaitingPayment"),
        "clock",
        "Ödeme teyidi gereken siparişler",
      ],
      [
        "Kullanılabilir stok",
        metricLabel(m, "availableStock"),
        "box",
        `Düşük stoklu paket: ${metricLabel(m, "lowStockSkus")}`,
      ],
    ]
      .filter((_row, i) =>
        can(
          [
            "store.orders.read",
            "store.wallet.read",
            "store.orders.read",
            "store.inventory.read",
          ][i],
        ),
      )
      .map(
        ([title, value, ic, sub]) =>
          `<article class="stat-card"><header><span>${title}</span>${icon(ic)}</header><div class="stat-number">${e(value)}</div><small>${sub}</small></article>`,
      )
      .join(
        "",
      )}</section><div class="admin-grid-two"><section class="panel"><h2>Siparişlerin durumu</h2><p class="panel-subtitle">İncelenen gerçek siparişlerin dağılımı</p><div class="admin-chart" role="img" aria-label="${e(`Teslim edilen ${metricLabel(m, "delivered")}, ödeme bekleyen ${metricLabel(m, "awaitingPayment")}, işlemde ${metricLabel(m, "processing")}, iptal edilen ${metricLabel(m, "cancelled")}`)}">${
      total === null
        ? '<p class="fine-print">Bu rol için sipariş analizi sunulmuyor.</p>'
        : [
            ["Teslim edildi", m.delivered],
            ["Ödeme bekliyor", m.awaitingPayment],
            ["Hazırlanıyor", m.processing],
            ["İptal edildi", m.cancelled],
            ["İade tamamlandı", m.refunded],
          ]
            .map(
              ([label, value]) =>
                `<div class="chart-row"><span>${label}</span><div class="chart-track"><div class="chart-fill" style="width:${Math.min(100, Math.max(0, ((Number(value) || 0) / Math.max(total, 1)) * 100))}%"></div></div><b>${Number(value) || 0}</b></div>`,
            )
            .join("")
    }</div></section><section class="panel"><h2>Sistem bağlantıları</h2><p class="panel-subtitle">Yapılandırma durumu; canlı ödeme testinin yerine geçmez</p>${[
      ["Kimlik hizmeti", o.system?.firebaseAuth],
      ["Veritabanı yapılandırması", o.system?.firestore],
      ["Şifreli teslimat kasası", o.system?.keyVault],
      ["Telegram sipariş kanalı", o.system?.telegram],
    ]
      .map(
        ([label, ok]) =>
          `<div class="system-row"><span>${label}</span><span><i class="system-dot ${ok ? "" : "off"}"></i>${typeof ok !== "boolean" ? "Bu rol için gösterilmiyor" : ok ? "Yapılandırılmış" : "Kontrol gerekli"}</span></div>`,
      )
      .join(
        "",
      )}<a class="section-link" style="margin-top:25px" href="#panel/security">Güvenlik kontrolleri ${icon("arrow")}</a></section></div><section class="panel"><h2>Stok takibi</h2><p class="panel-subtitle">Düşük stoklu paketlerden başlayarak</p><div class="stock-list">${
      (o.stock || [])
        .slice(0, 8)
        .map(
          (x) =>
            `<div class="stock-row">${icon("box")}<span><b>${e(x.productName)}</b><small>${e(x.planLabel)}</small></span><strong>${Number(x.available) || 0} adet</strong></div>`,
        )
        .join("") ||
      (Array.isArray(o.stock)
        ? '<p class="fine-print">Bu sorguda stok satırı bulunmadı.</p>'
        : "")
    }</div>${!Array.isArray(o.stock) ? '<p class="fine-print">Stok ayrıntıları bu rol için gösterilmiyor.</p>' : ""}</section>`
  );
}
async function supplier() {
  const result = await api("/api/admin/store/suppliers/hilehanem");
  return supplierView(result.connection);
}
async function orders() {
  const u = new URLSearchParams({ limit: "40" });
  if (filterStatus) u.set("status", filterStatus);
  if (orderCursor) u.set("cursor", orderCursor);
  const r = await api("/api/admin/store/orders?" + u);
  rows = r.orders || [];
  orderCursor = r.nextCursor || "";
  return (
    viewHeader(
      "Siparişler",
      "Sipariş ve ödeme durumlarını ayrı olarak doğrula.",
      can("store.orders.bulk")
        ? button("bulk-menu", "Toplu işlemler", "settings")
        : "",
    ) +
    `<div class="admin-toolbar"><label><span class="sr-only">Sipariş durumu</span><select id="admin-order-filter" class="sort-select"><option value="">Tüm durumlar</option>${Object.entries(
      statusNames,
    )
      .map(
        ([k, v]) =>
          `<option value="${k}" ${filterStatus === k ? "selected" : ""}>${v}</option>`,
      )
      .join(
        "",
      )}</select></label>${button("orders-reset", "Baştan yenile", "arrow")}<span class="result-count">Bu sayfada ${rows.length} sipariş</span></div><div id="job-slot"></div>${rows.length ? rows.map((o) => `<article class="order-card"><header><div><b>#${e(o.orderNumber || o.id)}</b><small>${e(o.username || o.uid)} · ${date(o.createdAt)}</small></div>${status(o.status)}</header>${(o.items || []).map((x) => `<div class="order-line"><div><b>${e(x.productName)}</b><small>${e(x.planLabel)} · ${x.quantity} adet</small></div><span>${money(x.lineTotalKurus)}</span></div>`).join("")}<p class="order-payment">Kanal: ${o.paymentMethod === "telegram" ? "Telegram" : o.paymentMethod === "wallet" ? "Bakiye" : "İnceleme gerekli"} · Ödeme: ${e({ captured: "Tahsil edildi", refunded: "İade tamamlandı", confirmed_manually: "Manuel teyit", pending: "Bekliyor" }[o.paymentState] || o.paymentWorkflow?.label || "Doğrulanmalı")}</p><footer><strong>${money(o.totalKurus)}</strong>${can("store.orders.write") ? button("order-status", "Yeni durum", "edit", `data-id="${e(o.id)}"`) + `<button class="button secondary small" type="button" data-commerce-admin="assign-order" data-id="${e(o.id)}">Sorumlu ata</button>` : ""}</footer></article>`).join("") : '<div class="panel admin-empty">Bu filtreyle eşleşen sipariş yok.</div>'}${orderCursor ? `<div class="admin-pagination">${button("orders-next", "Sonraki sayfa", "arrow")}</div>` : ""}`
  );
}
async function loadAdminCatalog() {
  const r = await api("/api/admin/store/catalog?stock=0");
  catalog = r.catalog;
  return catalog;
}
async function products() {
  await loadAdminCatalog();
  return (
    viewHeader(
      "Ürünler",
      "Ürün, paket, fiyat ve yayın durumunu tek yerden yönet.",
      can("store.catalog.write") ? button("product-create", "Ürün ekle") : "",
    ) +
    productCards(catalog.products, can("store.catalog.write"))
  );
}
async function inventory() {
  const result = await api("/api/admin/store/inventory-summary");
  await loadAdminCatalog();
  return (
    viewHeader(
      "Key ve hesap yönetimi",
      "Stoklar benzersiz, şifrelenmiş ve gerçek teslimat kayıtlarından hesaplanır.",
    ) +
    inventoryView(
      result.summary || result.inventory || [],
      catalog,
      can("store.inventory.write"),
    )
  );
}
async function experienceView() {
  const r = await api("/api/admin/store/experience");
  experience = r.experience;
  await loadAdminCatalog();
  return (
    viewHeader(
      "Kategoriler & vitrin",
      "Yayın tarihli bannerlar ve ürün grupları. Değişiklikler sürüm kontrolüyle kaydedilir.",
    ) +
    `<div class="admin-grid-two"><section class="panel"><div class="section-heading"><h2>Kategoriler</h2>${can("store.content.write") ? button("category-new", "Kategori ekle") : ""}</div>${experience.categories.length ? experience.categories.map((c) => `<div class="stock-row"><span><b>${e(c.name)}</b><small>${c.productIds.length} ürün · ${c.enabled ? "Yayında" : "Kapalı"}</small></span>${can("store.content.write") ? button("category-edit", "Düzenle", "edit", `data-id="${e(c.id)}"`) : ""}</div>`).join("") : '<p class="fine-print">Özel kategori henüz oluşturulmadı. Standart platform kategorileri kullanılmaya devam eder.</p>'}</section><section class="panel"><div class="section-heading"><h2>Vitrin bannerları</h2>${can("store.content.write") ? button("banner-new", "Banner ekle") : ""}</div>${experience.banners.length ? experience.banners.map((b) => `<div class="stock-row"><span><b>${e(b.title)}</b><small>${b.enabled ? "Etkin" : "Kapalı"} · ${b.startsAt ? date(b.startsAt) : "Hemen"} — ${b.endsAt ? date(b.endsAt) : "Süresiz"}</small></span>${can("store.content.write") ? button("banner-edit", "Düzenle", "edit", `data-id="${e(b.id)}"`) : ""}</div>`).join("") : '<p class="fine-print">Tarih aralığına uygun, etkin bannerlar mağazada gösterilir.</p>'}</section></div>`
  );
}
async function promotions() {
  const r = await api("/api/admin/store/promotions");
  rows = r.promotions || [];
  return (
    viewHeader(
      "Kupon kodları",
      "İndirimler sunucuda tarih, kapsam ve kullanım limitleriyle doğrulanır.",
      can("store.content.write")
        ? button("promotion-new", "Kampanya ekle")
        : "",
    ) +
    `<div class="admin-product-grid">${rows.map((c) => `<article class="admin-product-card"><span class="eyebrow">${e(c.code)}</span><h2>${e(c.title)}</h2><p>${c.type === "percent" ? c.value + "% indirim" : money(c.value)} · ${e(c.status)}<br/>${c.startsAt ? date(c.startsAt) : "Hemen"} — ${c.endsAt ? date(c.endsAt) : "Süresiz"}</p><p>Kullanım: ${Number(c.usedCount) || 0} / ${c.usageLimit || "Sınırsız"}</p>${can("store.content.write") ? button("promotion-edit", "Düzenle", "edit", `data-id="${e(c.code)}"`) : ""}</article>`).join("")}</div>${rows.length ? "" : '<div class="panel admin-empty">Henüz kampanya kaydı yok.</div>'}`
  );
}
async function balanceCodes() {
  const response = await api("/api/admin/store/balance-codes");
  rows = response.codes || response.promotions || [];
  return (
    viewHeader(
      "Promosyon kodları",
      "Bakiye kodları; gerçek değer, kullanım limiti ve hesap kontrolüyle yönetilir.",
      can("store.wallet.write")
        ? button("balance-code-new", "Promosyon kodu oluştur")
        : "",
    ) +
    `<section class="panel"><h2>Kayıtlı promosyonlar</h2>${rows.length ? rows.map((c) => `<article class="stock-row"><div><b>${e(c.code)} · ${e(c.title)}</b><small>${e(c.status)} · Kullanım: ${Number(c.usedCount) || 0} / ${c.usageLimit || "Sınırsız"}</small></div><strong>${money(c.value)}</strong></article>`).join("") : '<p class="fine-print">Henüz promosyon kodu oluşturulmadı.</p>'}</section>`
  );
}
async function users() {
  const q = new URLSearchParams({ limit: "40" });
  if (userQuery) q.set("query", userQuery);
  if (userCursor) q.set("pageToken", userCursor);
  const r = await api("/api/admin/store/users?" + q);
  rows = r.users || [];
  userCursor = r.nextPageToken || "";
  return (
    viewHeader(
      "Müşteriler",
      "Kendi yetkilerin kapsamında hesap durumlarını ve sipariş bilgilerini incele.",
    ) +
    `<form class="admin-toolbar" id="customer-search">${field("query", "Kullanıcı adı, e-posta veya UID", "search", userQuery, 'maxlength="254"')}<button class="button secondary small" type="submit">${icon("search")} Müşteri bul</button></form><div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>MÜŞTERİ</th><th>HESAP DURUMU</th><th>SİPARİŞLER</th><th>BAKİYE</th><th>İŞLEM</th></tr></thead><tbody>${rows.map((u) => `<tr><td><b>${e(u.username || u.displayName || u.uid)}</b><small>${e(u.email)}</small><small>${e(u.uid)}</small></td><td>${e(u.accountStatus || "active")}</td><td>${Number(u.orderCount || u.storeOrderCount) || 0}</td><td>${u.balanceKurus !== undefined ? money(u.balanceKurus) : "Yetki gerekli"}</td><td>${can("store.users.write") ? button("user-edit", "Düzenle", "edit", `data-id="${e(u.uid)}"`) : ""}</td></tr>`).join("")}</tbody></table></div>${userCursor ? `<div class="admin-pagination">${button("users-next", "Sonraki sayfa", "arrow")}</div>` : ""}`
  );
}
async function wallet() {
  const r = await api("/api/admin/store/wallet-summary"),
    s = r.summary || {};
  return (
    viewHeader(
      "Bakiye yönetimi",
      "Tüm düzeltmeler gerekçe, işlem kimliği ve çift kayıt korumasıyla kaydedilir.",
      can("store.wallet.write")
        ? button("wallet-adjust", "Bakiye işlemi", "wallet")
        : "",
    ) + walletView(s, can("store.wallet.write"))
  );
}
async function links() {
  const r = await api("/api/admin/store/links");
  rows = r.links || r.quickLinks || [];
  const revision = r.revision ?? r.quickLinksRevision ?? 0;
  return (
    viewHeader(
      "Sosyal bağlantılar",
      "Onaylı alan adları, gerçek kayıt ve merkezi mağaza güncellemesi.",
      can("store.content.write")
        ? button("links-save", "Bağlantıları kaydet", "check")
        : "",
    ) +
    `<form id="social-links-form" class="admin-form-panel" data-revision="${Number(revision)}"><div class="audit-grid">${rows
      .map(
        (l, i) =>
          `<section class="panel" data-link-index="${i}"><div class="field-row">${field("title", "Başlık", "text", l.title, 'required maxlength="48"')}${select(
            "platform",
            "Platform",
            ["telegram", "tiktok", "whatsapp", "instagram"].map((x) => [x, x]),
            l.platform,
          )}</div>${field("description", "Açıklama", "text", l.description, 'required maxlength="80"')}${field("url", "Bağlantı", "url", l.url, 'required maxlength="500"')}${check("enabled", "Bağlantı etkin", l.enabled !== false)}${check("showOnHome", "Ana sayfada göster", l.showOnHome !== false)}</section>`,
      )
      .join(
        "",
      )}</div></form>${can("store.content.write") ? `<div style="margin-top:20px">${button("link-new", "Yeni bağlantı ekle")}</div>` : ""}`
  );
}
async function audit() {
  const r = await api("/api/admin/store/audit?limit=100");
  rows = r.audit || [];
  return (
    viewHeader(
      "Denetim kayıtları",
      "Yönetici, işlem, tarih ve sonuç alanları ayrı olarak gösterilir.",
      can("store.audit.delete")
        ? button("audit-delete", "Silinebilir denetimleri temizle", "settings")
        : "",
    ) +
    `<div id="job-slot"></div><div class="audit-grid">${rows.map((a) => `<article class="audit-card"><header><h2>${e(a.action)}</h2><time>${date(a.createdAt)}</time></header><dl class="audit-fields"><div><dt>Yönetici</dt><dd>${e(a.actor?.email || a.actor?.uid)}</dd></div><div><dt>İşlem sonucu</dt><dd>${e(a.result)}</dd></div><div><dt>İşlem kimliği</dt><dd>${e(a.requestId || a.eventId)}</dd></div><div><dt>Eski durum</dt><dd>${e(jsonValue(a.before))}</dd></div><div><dt>Yeni durum</dt><dd>${e(jsonValue(a.after))}</dd></div><div><dt>Saklama durumu</dt><dd>${a.deletable ? "Politika kapsamında silinebilir" : "Saklama politikasıyla korunuyor"}</dd></div></dl></article>`).join("") || '<div class="panel admin-empty">Bu sorguda denetim kaydı bulunmadı.</div>'}</div>`
  );
}
async function security() {
  const r = await api("/api/admin/store/security"),
    s = r.security || {},
    checks = s.checks || s.controls || [];
  return (
    viewHeader(
      "Güvenlik durumu",
      "Skor bir risk göstergesidir. Doğrulanmamış alanlar başarılı sayılmaz.",
    ) +
    `<section class="stat-grid">${[
      [
        "Risk göstergesi",
        s.score !== undefined ? s.score + "/100" : "Doğrulanmadı",
      ],
      [
        "Başarılı kontroller",
        checks.filter((c) => c.status === "passed").length,
      ],
      [
        "Doğrulama bekleyen",
        checks.filter((c) => ["unverified", "partial"].includes(c.status))
          .length,
      ],
      [
        "Başarısız kontroller",
        checks.filter((c) => c.status === "failed").length,
      ],
    ]
      .map(
        ([label, value]) =>
          `<article class="stat-card"><header>${label}</header><div class="stat-number">${e(value)}</div></article>`,
      )
      .join(
        "",
      )}</section><p class="fine-print" style="margin-bottom:20px">Son sorgu: ${date(r.runtime?.generatedAt)} · Bu ekran bağımsız penetrasyon testinin yerine geçmez.</p><section class="security-grid">${checks.map((c) => `<article class="security-card"><header><h2>${e(c.label)}</h2><span class="security-status ${e(c.status)}">${{ passed: "GEÇTİ", failed: "BAŞARISIZ", partial: "KISMİ", unverified: "DOĞRULANMADI" }[c.status] || "İNCELE"}</span></header><p>${e(c.detail)}</p>${c.remediation ? `<p><b>İyileştirme:</b> ${e(c.remediation)}</p>` : ""}</article>`).join("")}</section>`
  );
}
async function settings() {
  const r = await api("/api/admin/store/content"),
    s = r.storefront || {};
  return (
    viewHeader(
      "Duyuru ve hizmet ayarları",
      "Ana sayfa içeriklerini ve gerçek satış kanallarını yönet.",
    ) +
    `<form id="settings-form" class="panel admin-form-panel"><h2>Mağaza vitrini</h2>${check("announcementEnabled", "Duyuru etkin", s.announcement?.enabled)}${field("announcementTitle", "Duyuru başlığı", "text", s.announcement?.title || "", 'maxlength="80"')}${area("announcementMessage", "Duyuru metni", s.announcement?.message || "", 'maxlength="240"')}<h2 style="margin-top:25px">Satış ve destek</h2>${field("telegramUsername", "Telegram destek kullanıcı adı", "text", s.support?.telegramUsername || "ZENTRA_STORE", 'required pattern="[A-Za-z0-9_]{5,32}" maxlength="32"')}${check("automaticDelivery", "Otomatik teslimat açık", s.services?.automaticDelivery !== false)}${check("balancePayment", "Bakiye ile ödeme açık", s.services?.balancePayment !== false)}${check("telegramSupport", "Telegram siparişleri açık", s.services?.telegramSupport !== false)}${check("maintenance", "Mağazayı bakım moduna al", s.maintenance)}${can("store.content.write") ? '<button class="button primary" type="submit">Ayarları kaydet</button>' : ""}</form>`
  );
}
async function staff() {
  if (!context.systemOwner && !["owner", "admin"].includes(context.role))
    return permission();
  const r = await api("/api/admin/store/staff");
  rows = r.staff || [];
  return (
    viewHeader(
      "Ekip & roller",
      "En az yetki ilkesi. Rol değişiklikleri mevcut yönetici oturumlarını iptal eder.",
      can("store.staff.write") ? button("staff-new", "Ekip üyesi ekle") : "",
    ) +
    `<div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>HESAP</th><th>ROL</th><th>DURUM</th><th>İŞLEM</th></tr></thead><tbody>${rows.map((s) => `<tr><td>${e(s.email)}<small>${e(s.uid)}</small></td><td>${e(s.role)}</td><td>${s.active ? "Etkin" : "Kapalı"}</td><td>${button("staff-edit", "Düzenle", "edit", `data-id="${e(s.uid)}"`)}</td></tr>`).join("")}</tbody></table></div>`
  );
}
function mutation({
  title,
  body = "",
  url,
  method = "POST",
  build,
  submit = "Kaydet",
  danger = false,
  after,
  requiresPassword = true,
} = {}) {
  if (!requiresPassword && !isProductSettingsUpdate(method, url))
    throw new Error("Bu işlem hesap parolasıyla doğrulanmalıdır.");
  return modal({
    title,
    body:
      body + (requiresPassword ?
      `<div class="admin-action-verification">${field("actionPassword", "Hesap şifrenle işlemi doğrula", "password", "", 'required autocomplete="current-password"')}</div>` : ""),
    submit,
    danger,
    onSubmit: async (data, form) => {
      const session = context;
      const request = api;
      const ensureSession = () => {
        if (!mounted || context !== session || !form.isConnected)
          throw new Error(
            "Yönetici oturumu veya işlem penceresi değişti. Sonucu yeniden kontrol et.",
          );
      };
      ensureSession();
      const payload = await build(data, form);
      ensureSession();
      if (requiresPassword)
        await window.ZENTRA_ADMIN_AUTH.reauthenticate(data.get("actionPassword"));
      ensureSession();
      const result = await request(
        typeof url === "function" ? url(data) : url,
        {
          method,
          body: payload,
          timeoutMs: 30000,
        },
      );
      ensureSession();
      toast({
        type: "success",
        title,
        message: "Değişiklik sunucuda doğrulandı ve kaydedildi.",
      });
      if (after) await after(result);
      else void show();
    },
  });
}
function productEditor(product) {
  return openProductEditor({ product, badgeOptions: catalog?.badgeOptions, mutation });
}

function orderStatusEditor(o) {
  const transitions = {
      awaiting_payment: [
        "payment_review",
        "paid",
        "cancelled",
        "payment_rejected",
      ],
      payment_review: ["paid", "payment_rejected", "cancelled"],
      payment_rejected: ["payment_review", "cancelled"],
      paid: [
        "processing",
        "delivery_pending",
        "delivered",
        "cancelled",
        "refunded",
      ],
      processing: ["delivery_pending", "delivered", "cancelled", "refunded"],
      delivery_pending: ["delivered", "cancelled", "refunded"],
      delivered: ["refunded"],
      cancelled: [],
      refunded: [],
    },
    financial = can("store.wallet.write");
  const options = (transitions[o.status] || []).filter(
    (x) =>
      financial ||
      (!["paid", "refunded"].includes(x) &&
        !(
          x === "cancelled" &&
          ["paid", "processing", "delivery_pending", "delivered"].includes(
            o.status,
          )
        )),
  );
  if (!options.length) {
    toast(
      "Bu sipariş için yetkin dahilinde kullanılabilir durum değişikliği yok.",
      "error",
    );
    return;
  }
  mutation({
    title: "Yeni durum · " + (o.orderNumber || o.id),
    url: "/api/admin/store/orders/" + encodeURIComponent(o.id),
    method: "PATCH",
    body: `<p class="fine-print">Sipariş ve ödeme durumu, geçiş kuralları ve ödeme kanıtına göre sunucuda denetlenir.</p><fieldset style="border:0;padding:0"><legend class="sr-only">Yeni sipariş durumu</legend>${options.map((x, i) => `<label class="status-choice"><input type="radio" name="status" value="${x}" ${i === 0 ? "checked" : ""}/>${e(statusNames[x])}</label>`).join("")}</fieldset>${area("adminNote", "Yönetici notu", o.adminNote || "", 'maxlength="500"')}${field("paymentReference", "Manuel ödeme / iade işlem referansı", "text", "", 'maxlength="160"')}${check("paymentConfirmed", "İlgili finansal kaydı dış kaynaktan kontrol ettim.", false)}${area("manualDeliveryText", "Manuel teslimat bilgileri (gerekliyse, her satıra bir kayıt)", "", 'maxlength="16000"')}<p class="fine-print">Bu onay bir banka veya ödeme sağlayıcısı API doğrulaması değildir. Gerçek işlem referansını doğrulama sorumluluğu yetkili finans yöneticisindedir.</p>`,
    build: (data) => ({
      status: data.get("status"),
      deliveryMessage: data.get("adminNote"),
      refundReason: data.get("adminNote"),
      paymentReference: data.get("paymentReference"),
      paymentConfirmed: data.has("paymentConfirmed"),
      manualDeliveryText: data.get("manualDeliveryText"),
      cancellationReason: data.get("adminNote") || "Yönetici iptali",
      expectedUpdatedAt: o.updatedAt || 0,
    }),
  });
}
function openBulkMenu() {
  modal({
    title: "Toplu sipariş işlemleri",
    body: `<p class="fine-print">İşlem önce önizleme oluşturur. Kapsam ve hariç tutulan kayıtlar gösterilmeden iptal veya silme başlatılmaz.</p><div class="bulk-grid">${[
      ["cancel_telegram", "Tüm Telegram siparişlerini iptal et"],
      [
        "cancel_delete_telegram",
        "Telegram siparişlerini iptal et ve silinebilir kayıtları sil",
      ],
      ["delete_refunded", "İadesi tamamlanan silinebilir siparişleri sil"],
      ["delete_cancelled", "İptali tamamlanan silinebilir siparişleri sil"],
    ]
      .map(([op, label]) =>
        button("bulk-preview", label, "settings", `data-operation="${op}"`),
      )
      .join("")}</div>`,
  });
}
function jobStorageKey() {
  return "zentra-admin-job-v1:" + context.uid;
}
function rememberJob() {
  try {
    sessionStorage.setItem(
      jobStorageKey(),
      JSON.stringify({ id: activeJob.id }),
    );
  } catch {}
}
async function startPreview(operation, button) {
  const session = context;
  busy(button, true, "Önizleme hazırlanıyor…");
  let pending;
  try {
    try {
      pending = JSON.parse(
        sessionStorage.getItem(jobStorageKey() + ":preview"),
      );
    } catch {}
    if (!pending || pending.operation !== operation)
      pending = { operation, idempotencyKey: crypto.randomUUID() };
    try {
      sessionStorage.setItem(
        jobStorageKey() + ":preview",
        JSON.stringify(pending),
      );
    } catch {}
    const r = await api("/api/admin/store/maintenance/preview", {
      body: pending,
    });
    if (!mounted || context !== session) return;
    activeJob = r.job;
    rememberJob();
    try {
      sessionStorage.removeItem(jobStorageKey() + ":preview");
    } catch {}
    document.querySelectorAll("dialog").forEach((d) => {
      d.close();
      d.remove();
    });
    document.documentElement.classList.remove("dialog-open");
    drawJob();
    pollJob();
  } finally {
    busy(button, false);
  }
}

function drawJob() {
  const slot = qs("#job-slot");
  if (!slot || !activeJob) return;
  const j = activeJob,
    states = {
      preparing: "Kayıtlar inceleniyor",
      ready: "Onay bekliyor",
      running: "İşlem sürüyor",
      completed: "İşlem sonuçlandı",
      paused: "İşlem duraklatıldı",
      failed: "İşlem tamamlanamadı",
    };
  slot.innerHTML = `<section class="job-panel"><h2>${e(states[j.state] || j.state)}</h2><p>Hedeflenen: ${j.total || 0} · Uygun: ${j.eligible || 0} · Kapsam dışı: ${j.excluded || 0}<br/>İptal edilebilir: ${j.cancellable || 0} · Silinebilir: ${j.deletable || 0}</p><progress class="job-progress" max="${Math.max(1, j.total || 1)}" value="${j.completed || 0}" aria-label="Toplu işlem ilerlemesi"></progress><div class="job-counts"><span>Tamamlanan: ${j.completed || 0}</span><span>Başarılı: ${j.succeeded || 0}</span><span>Başarısız: ${j.failed || 0}</span><span>Atlanan: ${j.skipped || 0}</span></div>${j.error ? `<p>${e(j.error)}</p>` : ""}<p>Finansal kayıtlar ve saklama kapsamındaki denetimler korunur.</p>${["ready", "paused"].includes(j.state) ? button("bulk-confirm", "Kapsamı incele ve onayla", "check") : ""}${["completed", "failed"].includes(j.state) ? button("bulk-results", "Ayrıntılı sonuçlar", "grid") : ""}</section>`;
}
async function pollJob() {
  if (
    !mounted ||
    !activeJob ||
    !["preparing", "running"].includes(activeJob.state)
  )
    return;
  const id = activeJob.id,
    generation = version;
  try {
    const r = await api(
      `/api/admin/store/maintenance/${encodeURIComponent(id)}?results=0`,
    );
    if (!mounted || generation !== version || activeJob?.id !== id) return;
    activeJob = r.job;
    rememberJob();
    drawJob();
    if (["preparing", "running"].includes(activeJob.state))
      jobTimer = setTimeout(pollJob, 2500);
    else if (activeJob.state === "completed")
      toast(
        `Toplu işlem sonuçlandı: ${activeJob.succeeded || 0} başarılı, ${activeJob.failed || 0} başarısız.`,
      );
  } catch (error) {
    if (!mounted || generation !== version) return;
    toast(
      "İlerleme sorgulanamadı. Görev sunucuda devam edebilir. Sayfayı yenileyerek sonucu kontrol et.",
      "error",
    );
  }
}
function confirmBulk() {
  const j = activeJob;
  if (!j) return;
  mutation({
    title: "Toplu sipariş işlemi",
    body: `<p class="fine-print">${j.total} kayıt hedefleniyor. ${j.eligible} kayıt uygun, ${j.excluded} kayıt kapsam dışında. ${j.permanent ? "Silme geri alınamaz. Saklama kapsamındaki mali ve güvenlik kayıtları korunur." : "Siparişler iptal edilecek; kayıtlar silinmeyecek."}</p>${j.permanent ? field("confirmation", "Onay için KALICI SIL yaz", "text", "", 'required pattern="KALICI SIL" autocomplete="off"') : ""}`,
    url: `/api/admin/store/maintenance/${encodeURIComponent(j.id)}/${j.operation === "delete_audit" ? "audit" : "orders"}/confirm`,
    submit: "İşlemi onayla",
    danger: j.permanent,
    build: (data) => ({ confirmation: data.get("confirmation") || "" }),
    after: async (r) => {
      activeJob = r.job;
      rememberJob();
      drawJob();
      pollJob();
    },
  });
}
function experienceEdit(kind, id) {
  const collection = kind === "category" ? "categories" : "banners",
    old = experience[collection].find((x) => x.id === id),
    item = old || {};
  const body =
    kind === "category"
      ? `${field("id", "Kategori kodu", "text", item.id || "", 'required pattern="[a-z0-9][a-z0-9-]{1,59}" ' + (old ? "readonly" : ""))}${field("name", "Kategori adı", "text", item.name || "", 'required maxlength="60"')}${field("description", "Açıklama", "text", item.description || "", 'maxlength="180"')}${select(
          "enabled",
          "Yayın durumu",
          [
            ["yes", "Yayında"],
            ["no", "Kapalı"],
          ],
          item.enabled === false ? "no" : "yes",
        )}<fieldset style="border:1px solid var(--line);padding:15px;border-radius:10px"><legend class="fine-print">Kategorideki ürünler</legend>${catalog.products
          .filter((p) => p.archived !== true)
          .map((p) =>
            check(
              "productIds",
              p.name,
              item.productIds?.includes(p.id),
            ).replace(
              'name="productIds"',
              'name="productIds" value="' + e(p.id) + '"',
            ),
          )
          .join("")}</fieldset>`
      : `${field("id", "Banner kodu", "text", item.id || "", 'required pattern="[a-z0-9][a-z0-9-]{1,59}" ' + (old ? "readonly" : ""))}${field("title", "Başlık", "text", item.title || "", 'required maxlength="80"')}${area("message", "Açıklama", item.message || "", 'maxlength="240"')}${field("href", "Hedef sayfa", "text", item.href || "/magaza", 'required maxlength="180"')}${field("image", "Görsel yolu (isteğe bağlı)", "text", item.image || "", 'maxlength="300"')}<div class="field-row">${field("startsAt", "Başlangıç (Türkiye saati)", "datetime-local", localDate(item.startsAt))}${field("endsAt", "Bitiş (Türkiye saati)", "datetime-local", localDate(item.endsAt))}</div>${check("enabled", "Banner etkin", item.enabled !== false)}`;
  mutation({
    title: kind === "category" ? "Kategori düzenle" : "Vitrin bannerı düzenle",
    body,
    url: "/api/admin/store/experience",
    method: "PUT",
    build: (data) => {
      const value =
        kind === "category"
          ? {
              id: data.get("id"),
              name: data.get("name"),
              description: data.get("description"),
              enabled: data.get("enabled") === "yes",
              productIds: data.getAll("productIds"),
            }
          : {
              id: data.get("id"),
              title: data.get("title"),
              message: data.get("message"),
              href: data.get("href"),
              image: data.get("image"),
              enabled: data.has("enabled"),
              startsAt: parseLocalDate(data.get("startsAt")),
              endsAt: parseLocalDate(data.get("endsAt")),
            };
      return {
        categories: experience.categories,
        banners: experience.banners,
        expectedRevision: experience.revision,
        [collection]: old
          ? experience[collection].map((x) => (x.id === id ? value : x))
          : [...experience[collection], value],
      };
    },
  });
}
function localDate(ts) {
  if (!ts) return "";
  return new Date(Number(ts) + 3 * 3600000).toISOString().slice(0, 16);
}
function parseLocalDate(value) {
  return value ? Date.parse(value + "+03:00") : 0;
}
function campaignEditor(c) {
  const isBalance = c?.type === "balance",
    value = c || {};
  mutation({
    title: c ? "Kampanyayı düzenle" : "Yeni kampanya",
    url: (data) =>
      "/api/admin/store/promotions/" + encodeURIComponent(data.get("code")),
    method: "PUT",
    body: `${field("code", "İndirim kodu", "text", value.code || "", 'required maxlength="32" ' + (c ? "readonly" : ""))}${field("title", "Kampanya adı", "text", value.title || "", 'required maxlength="100"')}${select(
      "type",
      "İndirim türü",
      [
        ["percent", "Yüzde indirim"],
        ["fixed", "Sabit tutar (₺)"],
      ],
      value.type || "percent",
    )}${field("value", "İndirim değeri", "number", value.type === "fixed" ? value.value / 100 : value.value || 10, 'required min="0.01" step="0.01"')}${field("minimum", "Asgari sepet (₺)", "number", (value.minimumSubtotalKurus || 0) / 100, 'min="0" step="0.01"')}<div class="field-row">${field("startsAt", "Başlangıç (Türkiye saati)", "datetime-local", localDate(value.startsAt))}${field("endsAt", "Bitiş (Türkiye saati)", "datetime-local", localDate(value.endsAt))}</div><div class="field-row">${field("usageLimit", "Toplam kullanım limiti (0: sınırsız)", "number", value.usageLimit || 0, 'required min="0" step="1"')}${field("perUserLimit", "Kişi başı limit", "number", value.perUserLimit || 1, 'required min="1" step="1"')}</div>${field("scopeProducts", "Ürün kimlikleri (virgülle, boş: tümü)", "text", (value.productIds || []).join(","), 'maxlength="4000"')}${field("scopePlans", "Paket anahtarları (virgülle, boş: tümü)", "text", (value.planKeys || []).join(","), 'maxlength="500"')}${field("scopeUsers", "Hesap UID kapsamı (virgülle, boş: tümü)", "text", (value.customerUids || []).join(","), 'maxlength="13000"')}${check("active", "Kampanya etkin", value.active !== false)}${check("public", "Müşterilerin kuponlarında göster", value.visibleInWallet !== false)}`,
    build: (data) => {
      if (isBalance)
        throw new Error("Bakiye kodlarını bakiye yönetimi bölümünden düzenle.");
      return {
        title: data.get("title"),
        type: data.get("type"),
        value:
          data.get("type") === "percent"
            ? Number(data.get("value"))
            : Math.round(Number(data.get("value")) * 100),
        minimumSubtotalKurus: Math.round(Number(data.get("minimum")) * 100),
        startsAt: parseLocalDate(data.get("startsAt")),
        endsAt: parseLocalDate(data.get("endsAt")),
        usageLimit: Number(data.get("usageLimit")),
        perUserLimit: Number(data.get("perUserLimit")),
        productIds: String(data.get("scopeProducts") || "")
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
        planKeys: String(data.get("scopePlans") || "")
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
        customerUids: String(data.get("scopeUsers") || "")
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
        active: data.has("active"),
        visibleInWallet: data.has("public"),
        createOnly: !c,
      };
    },
  });
}
function walletAdjust(identifier = "") {
  const session = context,
    request = api;
  return openWalletDialog({
    api: request,
    actorUid: session.uid,
    identifier,
    ensureActive: () => {
      if (!mounted || context !== session)
        throw new Error("Yönetici oturumu değişti.");
    },
    reauthenticate: (value) => window.ZENTRA_ADMIN_AUTH.reauthenticate(value),
    refresh: () => show(),
  });
}

function balanceCodeEditor() {
  mutation({
    title: "Bakiye kodu oluştur",
    url: (data) =>
      "/api/admin/store/balance-codes/" + encodeURIComponent(data.get("code")),
    method: "PUT",
    body: `${field("code", "Kod", "text", "", 'required maxlength="32"')}${field("title", "Kod adı", "text", "", 'required maxlength="100"')}${field("amount", "Bakiye tutarı (₺)", "number", "", 'required min="0.01" max="1000000" step="0.01"')}${field("usageLimit", "Toplam kullanım limiti", "number", 1, 'required min="1" max="1000000" step="1"')}<div class="field-row">${field("startsAt", "Başlangıç (Türkiye saati)", "datetime-local")}${field("endsAt", "Bitiş (Türkiye saati)", "datetime-local")}</div>${check("active", "Kod etkin", true)}`,
    build: (data) => ({
      title: data.get("title"),
      value: Math.round(Number(data.get("amount")) * 100),
      usageLimit: Number(data.get("usageLimit")),
      perUserLimit: 1,
      startsAt: parseLocalDate(data.get("startsAt")),
      endsAt: parseLocalDate(data.get("endsAt")),
      active: data.has("active"),
      createOnly: true,
    }),
  });
}
function stockImport() {
  const form = qs("#inventory-inline-form");
  form?.scrollIntoView({ block: "center" });
  form?.querySelector("textarea")?.focus();
}
async function stockList(productId, planKey) {
  const session = context;
  const r = await api(
    "/api/admin/store/inventory?" +
      new URLSearchParams({ productId, planKey, limit: "50" }),
  );
  if (!mounted || context !== session) return;
  const list =
    r.inventory?.items ||
    r.items ||
    (Array.isArray(r.inventory) ? r.inventory : []);
  modal({
    title: "Stok kayıtları",
    body: `<p class="fine-print">Bu sayfada en fazla 50 kayıt gösterilir. Gizli teslimat değerleri kendiliğinden açılmaz.</p>${list.map((x) => `<div class="stock-row"><span><b>${e(x.masked || x.mask || x.preview || x.id)}</b><small>${e(x.status)} · ${date(x.createdAt)}</small></span>${can("store.inventory.reveal") ? button("stock-reveal", "Görüntüle", "shield", `data-id="${e(x.id)}" data-product="${e(productId)}" data-plan="${e(planKey)}" data-storage-sku="${e(x.storageSku || "")}"`) : ""}${can("store.inventory.write") && x.status === "available" ? button("stock-revoke", "İptal et", "close", `data-id="${e(x.id)}" data-product="${e(productId)}" data-plan="${e(planKey)}" data-storage-sku="${e(x.storageSku || "")}"`) : ""}</div>`).join("") || '<p class="fine-print">Bu paket için kayıt bulunamadı.</p>'}`,
  });
}
function staffEditor(s) {
  mutation({
    title: "Ekip yetkilerini düzenle",
    url: (data) =>
      "/api/admin/store/staff/" + encodeURIComponent(data.get("uid")),
    method: "PUT",
    body: `${field("uid", "Hesap UID", "text", s?.uid || "", 'required maxlength="160" ' + (s ? "readonly" : ""))}${field("email", "Hesap e-postası", "email", s?.email || "", "required")}${select(
      "role",
      "Yetki rolü",
      ["admin", "finance", "inventory", "orders", "support", "viewer"].map(
        (x) => [
          x,
          {
            admin: "Yönetici",
            finance: "Finans",
            inventory: "Stok",
            orders: "Sipariş",
            support: "Destek",
            viewer: "Görüntüleyici",
          }[x],
        ],
      ),
      s?.role || "viewer",
    )}${check("active", "Erişim etkin", s?.active !== false)}<p class="fine-print">Rol değiştiğinde önceki yönetici oturumları iptal edilir. Sistem sahibi bu ekrandan değiştirilemez.</p>`,
    build: (data) => ({
      email: data.get("email"),
      role: data.get("role"),
      active: data.has("active"),
    }),
  });
}
async function click(event) {
  const target = event.target.closest("[data-admin-action]");
  if (!target) return;
  event.preventDefault();
  const { adminAction: a, id } = target.dataset;
  const session = context;
  if (!mounted || !session) return;
  try {
    if (a === "copy-secret") {
      const value = target
        .closest(".dialog-body")
        ?.querySelector(".delivery-secret")?.textContent;
      if (!value) throw new Error("Kopyalanacak bilgi bulunamadı.");
      await copyText(value);
      toast("Teslimat bilgisi kopyalandı.");
      return;
    }
    if (a === "menu") {
      const panel = modal({
        title: "Yönetim menüsü",
        appearance: "drawer",
        body: adminNavigation(context, currentView),
      });
      panel.element.addEventListener("click", (e) => {
        if (e.target.closest("[data-admin-view]")) panel.close();
      });
      return;
    }
    if (a === "logout") {
      await onLogout();
      unmountWorkspace();
      return;
    }
    if (a === "refresh") {
      if (currentView === "orders") orderCursor = "";
      return void show();
    }
    if (a === "supplier-check") {
      if (target.disabled) return;
      busy(target, true, "Yapılandırma inceleniyor…");
      try {
        const result = await api("/api/admin/store/suppliers/hilehanem/check", { method: "POST", body: {} });
        if (!mounted || context !== session) return;
        if (!result.connection) throw new Error("Yapılandırma sonucu alınamadı.");
        toast(result.connection.configured
          ? "API alanları geçerli. Bağlantı için Hilehanem API belgesi gerekiyor."
          : "Eksik veya geçersiz API alanları panelde gösteriliyor.", "info");
        await show();
      } finally { busy(target, false); }
      return;
    }
    if (a === "orders-reset") {
      orderCursor = "";
      return void show();
    }
    if (a === "orders-next") return void show();
    if (a === "users-next") return void show();
    if (a === "product-create") return productEditor();
    if (a === "product-edit")
      return productEditor(catalog.products.find((p) => p.id === id));
    if (a === "order-status")
      return orderStatusEditor(rows.find((o) => o.id === id));
    if (a === "bulk-menu") return openBulkMenu();
    if (a === "bulk-preview")
      return await startPreview(target.dataset.operation, target);
    if (a === "audit-delete") return await startPreview("delete_audit", target);
    if (a === "bulk-confirm") return confirmBulk();
    if (a === "bulk-results") {
      const r = await api(
        "/api/admin/store/maintenance/" + encodeURIComponent(activeJob.id),
      );
      if (!mounted || context !== session) return;
      modal({
        title: "Toplu işlem sonuçları",
        body: `<p class="fine-print">Sonuçlar sayfalanır. Bu görünüm ilk ${r.results?.length || 0} kaydı gösterir.</p>${(r.results || []).map((x) => `<div class="stock-row"><span><b>${e(x.reference || x.id)}</b><small>${e(x.channel)} · ${e(x.state)} · ${e(x.code || x.result)}</small></span></div>`).join("")}`,
      });
      return;
    }
    if (a === "category-new" || a === "category-edit")
      return experienceEdit("category", id);
    if (a === "banner-new" || a === "banner-edit")
      return experienceEdit("banner", id);
    if (a === "promotion-new") return campaignEditor();
    if (a === "promotion-edit")
      return campaignEditor(rows.find((x) => x.code === id));
    if (a === "wallet-adjust") return walletAdjust();
    if (a === "balance-code-new") return balanceCodeEditor();
    if (a === "balance-code-list") {
      const r = await api("/api/admin/store/balance-codes");
      if (!mounted || context !== session) return;
      modal({
        title: "Bakiye kodları",
        body: `${(r.codes || r.promotions || []).map((c) => `<div class="stock-row"><span><b>${e(c.code)} · ${e(c.title)}</b><small>${e(c.status)} · ${money(c.value)}</small></span></div>`).join("") || '<p class="fine-print">Bakiye kodu bulunamadı.</p>'}`,
      });
      return;
    }
    if (a === "stock-import") return stockImport();
    if (a === "stock-list")
      return await stockList(target.dataset.product, target.dataset.plan);
    if (a === "stock-revoke" || a === "stock-reveal") {
      mutation({
        title:
          a === "stock-reveal"
            ? "Stok bilgisini görüntüle"
            : "Stok kaydını iptal et",
        url: `/api/admin/store/inventory/${encodeURIComponent(id)}/${a === "stock-reveal" ? "reveal" : "revoke"}`,
        body: area(
          "reason",
          "İşlem gerekçesi",
          "",
          'required minlength="6" maxlength="240"',
        ),
        submit: a === "stock-reveal" ? "Güvenli görüntüle" : "Stoku iptal et",
        danger: a === "stock-revoke",
        build: (data) => ({
          productId: target.dataset.product,
          planKey: target.dataset.plan,
          storageSku: target.dataset.storageSku || "",
          reason: data.get("reason"),
        }),
        after: async (r) => {
          if (a === "stock-reveal")
            modal({
              title: "Yetkili stok görüntüleme",
              body: `<code class="delivery-secret">${e(r.item?.copyValue || r.item?.key || r.item?.credential?.password || r.key || r.secret || "Bilgi doğrulanamadı.")}</code>${button("copy-secret", "Bilgiyi kopyala", "copy")}`,
            });
          else void show();
        },
      });
      return;
    }
    if (a === "user-edit") {
      const u = rows.find((x) => x.uid === id);
      mutation({
        title: "Müşteri hesabı · " + (u.username || u.uid),
        url: "/api/admin/store/users/" + encodeURIComponent(id),
        method: "PATCH",
        body:
          select(
            "status",
            "Hesap durumu",
            [
              ["active", "Etkin"],
              ["purchase_blocked", "Alışverişe kapalı"],
              ["suspended", "Askıya alındı"],
            ],
            u.accountStatus || "active",
          ) +
          area(
            "adminNote",
            "Yönetici notu",
            u.adminNote || "",
            'maxlength="500"',
          ),
        build: (data) => ({
          status: data.get("status"),
          adminNote: data.get("adminNote"),
        }),
      });
      return;
    }
    if (a === "staff-new") return staffEditor();
    if (a === "staff-edit") return staffEditor(rows.find((x) => x.uid === id));
    if (a === "link-new") {
      if (rows.length >= 16)
        throw new Error("En fazla 16 bağlantı eklenebilir.");
      rows.push({
        id: "link-" + crypto.randomUUID().slice(0, 8),
        platform: "instagram",
        title: "Instagram",
        description: "Hesabımızı takip edin",
        url: "",
        enabled: false,
        showOnHome: true,
      });
      const form = qs("#social-links-form"),
        index = rows.length - 1,
        l = rows[index],
        node = document.createElement("section");
      node.className = "panel";
      node.dataset.linkIndex = index;
      node.innerHTML = `<div class="field-row">${field("title", "Başlık", "text", l.title, 'required maxlength="48"')}${select(
        "platform",
        "Platform",
        ["telegram", "tiktok", "whatsapp", "instagram"].map((x) => [x, x]),
        l.platform,
      )}</div>${field("description", "Açıklama", "text", l.description, 'required maxlength="80"')}${field("url", "Bağlantı", "url", l.url, 'required maxlength="500"')}${check("enabled", "Bağlantı etkin", false)}${check("showOnHome", "Ana sayfada göster", true)}`;
      form.querySelector(".audit-grid").append(node);
      return;
    }
    if (a === "links-save") {
      const form = qs("#social-links-form");
      if (!form.reportValidity()) return;
      const links = [...form.querySelectorAll("[data-link-index]")].map(
        (node) => {
          const data = new FormData();
          node.querySelectorAll("input,select").forEach((x) => {
            if (x.type === "checkbox") {
              if (x.checked) data.set(x.name, "yes");
            } else data.set(x.name, x.value);
          });
          return {
            ...rows[Number(node.dataset.linkIndex)],
            title: data.get("title"),
            description: data.get("description"),
            platform: data.get("platform"),
            url: data.get("url"),
            enabled: data.has("enabled"),
            showOnHome: data.has("showOnHome"),
          };
        },
      );
      mutation({
        title: "Sosyal bağlantıları kaydet",
        body:
          '<p class="fine-print">' +
          links.length +
          " bağlantı merkezi kayıtta güncellenecek. Değişiklik mağazadaki ilgili alanlara yansır.</p>",
        url: "/api/admin/store/links",
        method: "PUT",
        build: () => ({
          links,
          expectedRevision: Number(form.dataset.revision),
        }),
      });
      return;
    }
  } catch (error) {
    toast(error.message || "İşlem tamamlanamadı.", "error");
  } finally {
    if (target.isConnected) busy(target, false);
  }
}
function change(event) {
  if (event.target.id === "admin-order-filter") {
    filterStatus = event.target.value;
    orderCursor = "";
    void show();
  }
}
function submit(event) {
  const form = event.target;
  if (form.id === "customer-search") {
    event.preventDefault();
    userQuery = new FormData(form).get("query").trim();
    userCursor = "";
    void show();
  }
  if (form.id === "settings-form") {
    event.preventDefault();
    const data = new FormData(form);
    mutation({
      title: "Mağaza ayarlarını kaydet",
      body: '<p class="fine-print">Vitrin içerikleri ve satış kanalı ayarları gerçek kayıtta güncellenecek.</p>',
      url: "/api/admin/store/content",
      method: "PATCH",
      build: () => ({
        announcement: {
          enabled: data.has("announcementEnabled"),
          title: data.get("announcementTitle"),
          message: data.get("announcementMessage"),
          tone: "info",
          ctaTarget: "catalog",
          ctaLabel: "Ürünleri keşfet",
        },
        support: { telegramUsername: data.get("telegramUsername") },
        services: {
          automaticDelivery: data.has("automaticDelivery"),
          balancePayment: data.has("balancePayment"),
          telegramSupport: data.has("telegramSupport"),
        },
        maintenance: data.has("maintenance"),
      }),
    });
  }
}
export function unmountWorkspace() {
  disposeInventory();
  disposeWallet();
  disposeInventory = () => {};
  disposeWallet = () => {};
  clearWalletState();
  retainedInventory = null;
  commerceWorkspace?.dispose();
  commerceWorkspace = null;
  mounted = false;
  ++version;
  clearTimeout(jobTimer);
  jobTimer = null;
  document.removeEventListener("click", click);
  document.removeEventListener("change", change);
  document.removeEventListener("submit", submit);
  window.removeEventListener("hashchange", hashChange);
  document.body.classList.remove("menu-open");
  dismissPrivateDialogs(document);
  if (root?.querySelector(".admin-shell")) root.replaceChildren();
  context = null;
  api = null;
  main = null;
  rows = [];
  catalog = null;
  experience = null;
  activeJob = null;
}
export async function mountWorkspace(options) {
  unmountWorkspace();
  ({ root, context, api, onLogout } = options);
  mounted = true;
  commerceWorkspace = createCommerceWorkspace({
    api,
    can,
    refresh: show,
    context,
  });
  const generation = ++version;
  filterStatus = "";
  orderCursor = "";
  userCursor = "";
  activeJob = null;
  try {
    const saved = JSON.parse(sessionStorage.getItem(jobStorageKey()));
    if (/^[a-f0-9]{64}$/.test(saved?.id || ""))
      activeJob = (
        await api("/api/admin/store/maintenance/" + saved.id + "?results=0")
      ).job;
  } catch {}
  if (!mounted || generation !== version) return;
  shell();
  await show();
}
