import { categoryKey, categoryLabel } from "../store/catalog-schema.mjs?v=109";
import { cardStyle } from '../store/card-appearance.mjs?v=109';
import { escape as e, money, icon, safeImage, empty } from "./ui.js?v=109";
import { productGallery, galleryIndex } from "./gallery.mjs?v=109";
import { PRODUCT_CATEGORIES, STORE_NAVIGATION, HOME_CATEGORIES, HOME_CHANNELS, channelDestination, activeDiscovery } from "./discovery.mjs?v=109";

export const pageHeading = (title, kicker = "", description = "") =>
  `<div class="section-heading"><div>${kicker ? `<span class="eyebrow">${e(kicker)}</span>` : ""}<h1>${e(title)}</h1>${description ? `<p>${e(description)}</p>` : ""}</div></div>`;

export function createStorePages({ state, filtered, product, stockLabel, getFavorites, currentRoute }) {
  function card(p) {
    const plans = (p.plans || []).filter(plan => Number.isSafeInteger(plan.priceKurus) && plan.priceKurus >= 0);
    if (!plans.length) return "";
    const favorite = getFavorites().has(p.id),
      minimum = Math.min(...plans.map(plan => plan.priceKurus)),
      href = "/urun/" + e(p.id);
    return `<article class="product-card${p.featured ? ' product-card--featured' : ''}" data-card-style="${cardStyle(p.cardStyle)}">${p.featured ? '<span class="featured-ribbon">ÖNE ÇIKAN ÜRÜN</span>' : ''}
      <div class="product-image-wrap"><a href="${href}" data-nav tabindex="-1" aria-hidden="true"><img class="product-image" src="${e(safeImage(p.image))}" alt="" width="360" height="320" loading="lazy" decoding="async" draggable="false"/></a>
        ${p.badge ? `<span class="product-label">${e(p.badge)}</span>` : ""}
        <button type="button" class="favorite-btn ${favorite ? "active" : ""}" data-action="favorite" data-id="${e(p.id)}" aria-label="${e(p.name)} ${favorite ? "favorilerimden çıkar" : "favorilerime ekle"}" aria-pressed="${favorite}">${icon("heart")}</button>
        <span class="product-platform">${icon(p.platform === "ios" ? "phone" : "game")} ${p.platform === "ios" ? "iOS" : "Android"}</span>
      </div>
      <div class="product-info"><div class="product-meta"><span>${e(p.game === "pubg" ? "PUBG MOBILE" : (p.game || "DİJİTAL ÜRÜN").toLocaleUpperCase("tr-TR"))}</span><span class="stock-tag ${p.stock?.available ? "" : "unavailable"}">${e(stockLabel(p))}</span></div>
        <h3><a href="${href}" data-nav>${e(p.name)}</a></h3><p class="product-description">${e(p.description)}</p>
        <div class="product-bottom"><div><span class="price-label">${plans.length > 1 ? "Başlangıç fiyatı" : "Paket fiyatı"}</span><strong class="price">${money(minimum)}</strong></div><span class="product-plan-count">${plans.length} paket</span></div>
        <a class="product-detail-link" href="${href}" data-nav aria-label="${e(p.name)} ürününü ve paketlerini incele">Ürünü incele ${icon("arrow")}</a>
      </div></article>`;
  }
  function catalog(r, { home = false } = {}) {
    const featured = home ? filtered({ name: "catalog", query: new URLSearchParams({ featured: "1" }) }) : [],
      rows = home && featured.length ? featured : filtered(r), active = activeDiscovery(r),
      title = r.name === "favorites" ? "Favorilerim" : r.query.get("q") ? `“${r.query.get("q")}” için sonuçlar` : home ? (featured.length ? "Öne çıkan ürünler" : "Ürünleri keşfet") : r.query.get("featured") === "1" ? "Öne çıkan ürünler" : r.name === "category" ? (PRODUCT_CATEGORIES.find(category => category.id === active)?.label || { android: "Android", ios: "iOS", pubg: "PUBG Mobile", oxide: "Oxide", gbox: "GBOX", "gbox-ios": "GBOX" }[r.id] || (state.experience?.categories || []).find(category => category.id === r.id)?.name || "Kategori") : "Tüm Ürünler";
    return `<section class="catalog-section" id="catalog" aria-label="Ürünler"><div class="section-heading"><div><span class="eyebrow">${home ? "ZENTRA SEÇKİSİ" : "DİJİTAL ÜRÜNLER"}</span><${home ? "h2" : "h1"}>${e(title)}</${home ? "h2" : "h1"}></div>${home ? `<a href="/magaza" data-nav class="section-link">Tümünü gör ${icon("arrow")}</a>` : `<span class="result-count">${rows.length} ürün</span>`}</div>
      <div class="catalog-toolbar"><nav class="filter-tabs" aria-label="Ürün grupları">${PRODUCT_CATEGORIES.map(category => `<a class="filter-tab ${active === category.id ? "active" : ""}" href="${category.href}" data-nav ${active === category.id ? 'aria-current="page"' : ""}>${e(category.label)}</a>`).join("")}</nav><label><span class="sr-only">Ürün sıralaması</span><select class="sort-select" id="sort-products">${[["", "Önerilen sıralama"], ["price-up", "Fiyat: düşükten yükseğe"], ["price-down", "Fiyat: yüksekten düşüğe"], ["name", "İsme göre A–Z"]].map(([value, label]) => `<option value="${value}" ${r.query.get("sort") === value ? "selected" : ""}>${label}</option>`).join("")}</select></label><button type="button" class="filter-tab" data-action="filters">${icon("filter")} Filtrele</button></div>
      ${rows.length ? `<div class="product-grid">${rows.map(card).join("")}</div>` : empty("Aradığın ürün burada görünmüyor.", "Farklı bir kategori seçebilir veya filtrelerini değiştirebilirsin.", "/magaza", "Tüm ürünleri gör")}</section>`;
  }
  function home() {
    const announcement = state.catalog?.storefront?.announcement,
      links = state.catalog?.storefront?.quickLinks || [];
    return `${announcement?.enabled ? `<aside class="notice"><div><b>${e(announcement.title)}</b><p>${e(announcement.message)}</p></div></aside>` : ""}
      <section class="home-discovery"><h1>Zentra Store dijital ürün mağazası</h1><div class="home-platforms">${HOME_CATEGORIES.map(category => `<a class="category-tile" href="${category.href}" data-nav aria-label="${e(category.label)} ürünleri"><span class="category-symbol"><img src="${category.image}" alt="" width="240" height="240" decoding="async"/></span><span><b>${category.game}</b><small>${category.platform}</small></span></a>`).join("")}</div></section>
      <section class="home-actions" aria-label="Zentra topluluk kanalları">${HOME_CHANNELS.map(channel => {
        const href = channelDestination(links, channel.id), content = `${icon(channel.icon)}<span><b>${channel.title}</b><small>${href ? channel.description : "Bağlantı şu anda kullanılamıyor"}</small></span>${icon(href ? "arrow" : "clock")}`;
        return href ? `<a class="action-tile ${channel.tone}" href="${e(href)}" target="_blank" rel="noopener noreferrer">${content}</a>` : `<div class="action-tile ${channel.tone} unavailable" aria-disabled="true">${content}</div>`;
      }).join("")}</section>
      ${(state.experience?.banners || []).filter(banner => banner.enabled !== false).map(banner => `<section class="community-banner">${banner.image ? `<img src="${e(safeImage(banner.image))}" alt="" width="85" height="65" loading="lazy"/>` : ""}<div><span class="eyebrow">ZENTRA VİTRİNİ</span><h2>${e(banner.title)}</h2><p>${e(banner.message)}</p></div><a class="button outline" href="${e(banner.href)}" data-nav>İncele ${icon("arrow")}</a></section>`).join("")}
      ${catalog({ name: "home", query: new URLSearchParams() }, { home: true })}
      <section class="trust-strip" aria-label="Mağaza bilgileri">${[["shield", "Sunucuda doğrulanan işlemler"], ["box", "Ürüne uygun teslimat"], ["support", "Sipariş ve ürün desteği"]].map(([ic, label]) => `<div>${icon(ic)}<b>${label}</b></div>`).join("")}</section>`;
  }
  function gallery(p) {
    const images = productGallery(p), index = galleryIndex(state.selectedImages.get(p.id), images.length);
    return `<div class="product-detail-media" data-product="${e(p.id)}" role="group" aria-label="${e(p.name)} ürün galerisi" tabindex="0"><div class="detail-image"><img data-gallery-image src="${e(safeImage(images[index].src))}" alt="${e(images[index].alt || p.name)}" width="620" height="560" fetchpriority="high" decoding="async"/>${images.length > 1 ? `<button type="button" class="gallery-nav gallery-prev" data-action="gallery-step" data-id="${e(p.id)}" data-step="-1" aria-label="Önceki görsel">${icon("back")}</button><button type="button" class="gallery-nav gallery-next" data-action="gallery-step" data-id="${e(p.id)}" data-step="1" aria-label="Sonraki görsel">${icon("arrow")}</button><span class="gallery-counter" aria-live="polite">${index + 1} / ${images.length}</span>` : ""}</div>${images.length > 1 ? `<div class="gallery-thumbnails">${images.map((image, i) => `<button type="button" class="${i === index ? "active" : ""}" data-action="gallery-select" data-id="${e(p.id)}" data-index="${i}" aria-label="${i + 1}. ürün görseli" aria-pressed="${i === index}"><img src="${e(safeImage(image.src))}" alt="" width="65" height="60" loading="lazy"/></button>`).join("")}</div>` : ""}<p class="gallery-caption">${icon("phone")} ${p.platform === "ios" ? "iPhone ve iPad · iOS" : "Android cihazlar"}</p></div>`;
  }
  function detail(id) {
    const p = product(id);
    if (!p || !p.plans?.length) return empty("Bu ürün bulunamadı.", "Güncel mağazayı inceleyebilirsin.");
    const key = currentRoute().query.get("paket") || state.selectedPlans.get(p.id), plan = p.plans.find(item => item.key === key) || p.plans[0], favorite = getFavorites().has(p.id);
    return `<nav class="breadcrumb" aria-label="Sayfa yolu"><a href="/" data-nav>Ana sayfa</a>${icon("chevron")}<a href="/kategori/${e(categoryKey(p))}" data-nav>${e(categoryLabel(p))}</a>${icon("chevron")}<span>${e(p.name)}</span></nav>
      <section class="product-detail">${gallery(p)}<div class="detail-info"><div class="detail-heading"><span class="eyebrow">${e(p.game === "pubg" ? "PUBG MOBILE" : (p.game || "DİJİTAL ÜRÜN").toLocaleUpperCase("tr-TR"))} · ${p.platform === "ios" ? "iOS" : "ANDROID"}</span><button type="button" class="favorite-btn ${favorite ? "active" : ""}" data-action="favorite" data-id="${e(p.id)}" aria-pressed="${favorite}" aria-label="${e(p.name)} favori seçimi">${icon("heart")}</button></div>
        <h1>${e(p.name)}</h1><span class="status-pill ${p.stock?.available ? "green" : "amber"}">${e(stockLabel(p))}</span><p class="detail-description">${e(p.description)}</p>
        ${p.features?.length ? `<ul class="detail-features">${p.features.map(feature => `<li>${icon("check")}<span>${e(feature)}</span></li>`).join("")}</ul>` : ""}
        <div class="detail-purchase"><div class="purchase-caption"><span>${icon("box")} SEÇİLİ PAKET</span><small>${p.plans.length} seçenek</small></div><button type="button" class="selected-package" data-action="select-package" data-id="${e(p.id)}" aria-haspopup="dialog"><span>${icon("clock")}<span><b>${e(plan.label)}</b><small>${e(plan.duration)}</small></span></span><span>Paketi değiştir ${icon("down")}</span></button>
          <div class="detail-price-row"><div><small>Paket tutarı</small><strong class="detail-price">${money(plan.priceKurus)}</strong></div><span class="status-pill">${p.platform === "ios" ? "iOS" : "Android"} paketi</span></div>
          <button type="button" class="button primary detail-cart" data-action="add" data-id="${e(p.id)}" data-plan="${e(plan.key)}">${icon("bag")} Sepete ekle ${icon("arrow")}</button><p class="detail-trust">${icon("shield")} Güncel fiyat ve stok sipariş sırasında doğrulanır.</p>
        </div><div class="detail-fulfillment">${icon(p.fulfillmentMode === "telegram_only" ? "telegram" : "box")}<div><b>${p.fulfillmentMode === "telegram_only" ? "Destek üzerinden teslimat" : "Stok ve bakiye ile teslimat"}</b><p>${p.fulfillmentMode === "telegram_only" ? "Ödeme ve teslimat, destek ekibi tarafından ayrıca teyit edilir." : "Otomatik teslimat, uygun stok ve doğrulanmış bakiye ile hazırlanır."}</p></div></div><button type="button" class="text-button" data-action="restock" data-id="${e(p.id)}" data-plan="${e(plan.key)}">${icon("bell")} Stok gelince haber ver</button>
      </div></section>`;
  }
  function packageOptions(p, key) {
    const selected = p.plans.find(plan => plan.key === key) || p.plans[0];
    return `<div class="package-product"><img src="${e(safeImage(p.image))}" alt="" width="64" height="64"/><div><span class="eyebrow">${p.platform === "ios" ? "iOS" : "ANDROID"} PAKETLERİ</span><h3>${e(p.name)}</h3><small>${e(stockLabel(p))}</small></div></div><p class="package-intro">Kullanım süreni seç. Sepete eklemeden önce seçimini ürün detayında inceleyebilirsin.</p><fieldset class="package-choices"><legend class="sr-only">${e(p.name)} paket seçenekleri</legend>${p.plans.map(plan => `<label class="package-choice"><input type="radio" name="planKey" value="${e(plan.key)}" ${selected.key === plan.key ? "checked" : ""} required/><span class="package-choice-content"><span class="package-radio">${icon("check")}</span><span><b>${e(plan.label)}</b><small>${e(plan.duration)}</small></span><strong>${money(plan.priceKurus)}</strong></span></label>`).join("")}</fieldset><div class="package-total"><span>Seçilen paket</span><strong data-package-total aria-live="polite">${money(selected.priceKurus)}</strong></div><p class="fine-print">${icon("shield")} Kesin fiyat ve stok sipariş sırasında sunucuda doğrulanır.</p>`;
  }
  function drawer() {
    const signed = !!state.auth.user, active = activeDiscovery(currentRoute());
    return `<div class="drawer-welcome"><p>${signed ? `Merhaba, ${e(state.auth.account?.username || "Zentra üyesi")}.` : "ZENTRA STORE"}</p>${!signed ? '<div class="drawer-auth"><a class="button secondary" href="/hesabim?islem=giris" data-nav>Giriş Yap</a><a class="button primary" href="/hesabim?islem=kayit" data-nav>Kayıt Ol</a></div>' : ""}</div><nav class="drawer-nav" aria-label="Mağaza menüsü">${[{ href: "/", id: "home", icon: "home", label: "Ana Sayfa" }, ...STORE_NAVIGATION, ...(signed ? [{ href: "/favoriler", id: "favorites", icon: "heart", label: "Favorilerim" }, { href: "/bildirimler", id: "notifications", icon: "bell", label: "Bildirimler" }] : []), ...(state.experience?.categories || []).filter(category => !PRODUCT_CATEGORIES.some(item => item.id === category.id)).map(category => ({ href: "/kategori/" + category.id, id: category.id, icon: "box", label: category.name }))].map(item => `<a href="${e(item.href)}" data-nav ${active === item.id ? 'aria-current="page"' : ""}>${icon(item.icon)}<span>${e(item.label)}</span>${icon("arrow")}</a>`).join("")}</nav><div class="drawer-social">${(state.catalog?.storefront?.quickLinks || []).filter(item => item.enabled !== false && /^https:\/\//.test(item.url)).map(item => `<a href="${e(item.url)}" target="_blank" rel="noopener noreferrer">${e(item.title)}</a>`).join("")}</div>`;
  }
  return { card, catalog, home, detail, gallery, drawer, packageOptions };
}
