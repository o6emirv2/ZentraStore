import { escape as e, icon, brand } from "../public/js/app/ui.js?v=109";
export const primaryViews = [
  ["overview", "chart", "Yönetim Özeti", "store.overview.read"],
  ["orders", "receipt", "Siparişler", "store.orders.read"],
  ["inventory", "box", "Stok Kasası", "store.inventory.read"],
  ["products", "box", "Ürünler", "store.catalog.read"],
  ["users", "user", "Kullanıcılar", "store.users.read"],
  ["wallet", "wallet", "Bakiye Merkezi", "store.wallet.read"],
  ["content", "bell", "İçerikler", "store.content.read"],
  ["links", "telegram", "Bağlantılar", "store.content.read"],
  ["coupons", "ticket", "Kupon Kodları", "store.content.read"],
  ["promocodes", "ticket", "Promosyon Kodları", "store.wallet.read"],
  ["staff", "shield", "Yetkilendirme", "store.staff.read"],
  ["audit", "history", "Denetim", "store.audit.read"],
  ["security", "shield", "Güvenlik", "store.security.read"],
];
export const advancedViews = [
  ["supplier", "shield", "Hilehanem API", "store.wallet.read"],
  ["experience", "sun", "Kategoriler & vitrin", "store.content.read"],
  ["commerce-catalog", "edit", "İçerik stüdyosu", "store.catalog.read"],
  ["commerce-support", "support", "Destek & yorumlar", "store.support.read"],
  ["commerce-bulk", "grid", "Toplu ürün işlemleri", "store.catalog.write"],
  ["commerce-reports", "chart", "Satış & maliyet", "store.analytics.read"],
  [
    "commerce-operations",
    "settings",
    "Sistem operasyonları",
    "store.security.read",
  ],
  ["commerce-backups", "shield", "Yedek & geri dönüş", "store.backups.write"],
  ["commerce-privacy", "user", "Veri talepleri", "store.privacy.write"],
];
export const adminViews = [...primaryViews, ...advancedViews];
export function resolveView(hash = "") {
  const id = hash.replace(/^#panel\//, "");
  const canonical = { settings: "content", promotions: "coupons" }[id] || id;
  return adminViews.find((x) => x[0] === canonical) || primaryViews[0];
}
export function adminNavigation(context, active = "overview") {
  const can = (permission) =>
    context.permissions?.includes("*") ||
    context.permissions?.includes(permission);
  const links = (rows) =>
    rows
      .filter((x) => can(x[3]))
      .map(
        ([id, ic, label]) =>
          `<a href="#panel/${id}" data-admin-view="${id}" class="${id === active ? "active" : ""}" ${id === active ? 'aria-current="page"' : ""}>${icon(ic)}<span>${label}</span></a>`,
      )
      .join("");
  return `<nav class="admin-nav" aria-label="Yönetim bölümleri">${links(primaryViews)}${advancedViews.some((x) => can(x[3])) ? `<details ${advancedViews.some((x) => x[0] === active) ? "open" : ""}><summary>Gelişmiş araçlar</summary>${links(advancedViews)}</details>` : ""}</nav>`;
}
export function adminLayout(context) {
  return `<header class="admin-topbar">${brand()}<div class="admin-topbar-actions"><span class="security-chip">${icon("shield")} Yönetici oturumu</span><button class="icon-button" data-admin-action="refresh" aria-label="Aktif paneli yenile">${icon("refresh")}</button><a class="icon-button admin-store-link" href="/" target="_blank" rel="noopener" aria-label="Mağazayı görüntüle">${icon("home")}</a><button class="icon-button" data-admin-action="logout" aria-label="Güvenli çıkış">${icon("logout")}</button><button class="icon-button mobile-menu-toggle" data-admin-action="menu" aria-label="Yönetim menüsünü aç">${icon("menu")}</button></div></header><div class="admin-shell"><aside class="admin-sidebar"><div class="admin-profile"><span class="avatar">${icon("user")}</span><div><small>${e(context.role || "Yönetici")}</small><strong>${e((context.email || "Yönetici").split("@")[0])}</strong></div></div>${adminNavigation(context)}<div class="admin-sidebar-footer"><span>OPERASYON MERKEZİ</span><small>Yetkiler her işlemde sunucuda denetlenir.</small></div></aside><div class="admin-stage"><div class="admin-breadcrumb"><span>ZENTRA STORE</span>${icon("arrow")}<span id="workspace-title">Yönetim Özeti</span></div><main class="admin-main" id="admin-main" tabindex="-1"></main></div></div>`;
}
