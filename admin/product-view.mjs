import { escape as e, money, icon, safeImage } from "../public/js/app/ui.js?v=109";

export function productCards(products, editable = false) {
  return `<div class="admin-product-grid">${products.map(p => {
    const prices = p.plans.filter(plan => plan.active !== false).map(plan => plan.priceKurus);
    return `<article class="admin-product-card"><div class="admin-product-image"><img src="${e(safeImage(p.image))}" alt="${e(p.name)}" width="320" height="180" loading="lazy"/></div><header><h2>${e(p.name)}</h2><p class="admin-product-meta">${e(p.category)}<span>${p.archived ? "Arşivde" : p.active !== false ? "Yayında" : "Yayında değil"}</span></p></header><p class="admin-product-description">${e(p.description)}</p><div class="admin-product-status"><span class="status-pill ${p.automaticEnabled ? "green" : "amber"}">${p.fulfillmentMode === "telegram_only" ? "Telegram ile teslimat" : p.automaticEnabled ? "Otomatik teslimat" : "Otomatik satış kapalı"}</span><small>Sıra: ${e(p.sortOrder ?? 500)}</small></div><footer><div class="admin-product-price"><small>Başlangıç fiyatı</small><strong>${prices.length ? money(Math.min(...prices)) : "Aktif paket yok"}</strong></div>${editable ? `<button type="button" class="button secondary small" data-admin-action="product-edit" data-id="${e(p.id)}" aria-label="${e(p.name)} ürününü düzenle">${icon("edit")}<span>Düzenle</span></button>` : ""}</footer></article>`;
  }).join("")}</div>`;
}
