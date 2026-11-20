"use strict";
const fs = require("node:fs");
const path = require("node:path");
const env = require("../config/env");
const { CATEGORY_PRESETS } = require("../../public/js/store/catalog-schema.mjs");
const { imageVariants } = require("../../public/js/app/images.mjs");
const { getEffectiveCatalog } = require("./storeCatalogService");
const {
  ENTRY_PARAMETER,
  entryDestination,
} = require("../../public/js/app/routes.mjs");
const root = path.resolve(__dirname, "../..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const base = () => env.canonicalOrigin || env.publicBaseUrl;
function meta(source, { title, description, canonical, image }) {
  const setAttribute = (tagName, key, match, attribute, value) => {
    const matcher = new RegExp(
      "<" + tagName + "\\b(?=[^>]*\\b" + key + '="' + match + '")[^>]*>',
      "i",
    );
    source = source.replace(matcher, (tag) =>
      tag.replace(
        new RegExp("\\b" + attribute + '="[^"]*"'),
        () => attribute + '="' + esc(value) + '"',
      ),
    );
  };
  source = source.replace(
    /<title>[\s\S]*?<\/title>/,
    () => `<title>${esc(title)} | Zentra Store</title>`,
  );
  setAttribute("meta", "name", "description", "content", description);
  setAttribute("meta", "property", "og:title", "content", title);
  setAttribute("meta", "property", "og:description", "content", description);
  setAttribute("meta", "property", "og:url", "content", canonical);
  setAttribute(
    "meta",
    "property",
    "og:image",
    "content",
    image || new URL("/public/assets/images/zentra-mark.webp", canonical).href,
  );
  setAttribute("link", "rel", "canonical", "href", canonical);
  return source;
}

function jsonLd(data) {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}
function productMarkup(source, p, canonical) {
  const price = Math.min(...p.plans.map((x) => x.priceKurus)) / 100;
  const structured = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: p.name,
    description: p.description,
    image: [new URL(p.image, new URL(canonical).origin).href],
    sku: p.id,
    brand: { "@type": "Brand", name: "Zentra Store" },
    offers: {
      "@type": "AggregateOffer",
      priceCurrency: "TRY",
      lowPrice: price.toFixed(2),
      highPrice: (Math.max(...p.plans.map((x) => x.priceKurus)) / 100).toFixed(
        2,
      ),
      offerCount: p.plans.length,
      url: canonical,
    },
  };
  const trust =
    /<section class="trust-strip"[\s\S]*?<\/section>/.exec(html)?.[0] || "";
  const summary = `<main id="main" class="container main-content" tabindex="-1"><div class="breadcrumb"><a href="/">Ana sayfa</a><span>/</span><span>${esc(p.name)}</span></div><section class="product-detail"><div class="product-detail-media"><div class="detail-image"><img src="${esc(imageVariants[p.image] || p.image)}" alt="${esc(p.name)}" width="600" height="600" fetchpriority="high"/></div></div><div class="detail-info"><span class="eyebrow">${esc(p.platform)} · ${esc(p.game)}</span><h1>${esc(p.name)}</h1><p class="detail-description">${esc(p.description)}</p><p class="detail-price">${price.toLocaleString("tr-TR", { style: "currency", currency: "TRY" })}</p><p class="fine-print">Paket seçenekleri ve güncel stok kontrol ediliyor. Kesin fiyat ve stok sipariş sırasında doğrulanır.</p><div class="skeleton" style="height:70px;margin-top:20px"></div></div></section></main><template id="home-trust-template">${trust}</template>`;
  return source
    .replace(/<main\b(?=[^>]*\bid="main")[^>]*>[\s\S]*?<\/main>/, summary)
    .replace(
      "</head>",
      `<script type="application/ld+json">${jsonLd(structured)}</script></head>`,
    );
}
function listingMarkup(source, title, products) {
  const trust =
    /<section class="trust-strip"[\s\S]*?<\/section>/.exec(html)?.[0] || "";
  const summary = `<main id="main" class="container main-content" tabindex="-1"><section class="catalog-section"><div class="section-heading"><h1>${esc(title)}</h1><span>${products.length} ürün</span></div><div class="product-grid">${products.map((p) => `<article class="product-card"><div class="product-image-wrap"><a href="/urun/${esc(p.id)}" data-nav><img src="${esc(imageVariants[p.image] || p.image)}" alt="${esc(p.name)}" class="product-image" width="360" height="288" loading="lazy"/></a></div><div class="product-info"><h2><a href="/urun/${esc(p.id)}" data-nav>${esc(p.name)}</a></h2><p class="product-description">${esc(p.description)}</p><strong class="price">${(Math.min(...p.plans.map((x) => x.priceKurus)) / 100).toLocaleString("tr-TR", { style: "currency", currency: "TRY" })}</strong></div></article>`).join("")}</div></section></main><template id="home-trust-template">${trust}</template>`;
  return source.replace(
    /<main\b(?=[^>]*\bid="main")[^>]*>[\s\S]*?<\/main>/,
    summary,
  );
}
function loadingMarkup(source, title) {
  const trust =
    /<section class="trust-strip"[\s\S]*?<\/section>/.exec(html)?.[0] || "";
  return source.replace(
    /<main\b(?=[^>]*\bid="main")[^>]*>[\s\S]*?<\/main>/,
    `<main id="main" class="container main-content" tabindex="-1"><section class="panel"><div class="section-heading"><h1>${esc(title)}</h1><p>Güvenli hesap bağlantısı hazırlanıyor…</p><span class="spinner" aria-label="Yükleniyor"></span><a class="button secondary small" href="">Sayfa açılmıyorsa yeniden yükle</a></div></section></main><template id="home-trust-template">${trust}</template>`,
  );
}
async function servePage(req, res, next) {
  try {
    res.setHeader("Cache-Control", "no-cache, max-age=0, must-revalidate");
    if (
      ["/", "/index.html"].includes(req.path) &&
      Object.hasOwn(req.query, ENTRY_PARAMETER)
    ) {
      const target = entryDestination(base() + req.originalUrl);
      if (!target) return require("./storefrontPages").sendMissing(res);
      res.setHeader("X-Robots-Tag", "noindex, nofollow");
      return res.type("html").send(
        meta(loadingMarkup(html, "Bağlantın açılıyor"), {
          title: "Bağlantın açılıyor",
          description:
            "Zentra Store hesabına ve güncel ürünlere güvenli bağlantı.",
          canonical: base() + target.split("?")[0],
        }),
      );
    }
    let image;
    let source = html,
      canonical = base() + (req.path === "/index.html" ? "/" : req.path),
      title = "Android ve iOS ürünleri",
      description =
        "Android ve iOS için dijital ürünler. Güvenli hesap, sunucuda doğrulanan sipariş ve Telegram desteği.";
    if (
      [
        "/sepet",
        "/hesabim",
        "/siparisler",
        "/favoriler",
        "/kuponlar",
        "/bildirimler",
      ].includes(req.path) ||
      req.query.q
    ) {
      res.setHeader("X-Robots-Tag", "noindex, nofollow");
    }
    const privateTitles = {
      "/sepet": "Sepetim",
      "/hesabim": req.query.islem === "kayit" ? "Kayıt Ol" : "Giriş Yap",
      "/siparisler": "Siparişlerim",
      "/favoriler": "Favorilerim",
      "/kuponlar": "Kuponlarım",
      "/bildirimler": "Bildirimler",
    };
    if (privateTitles[req.path]) {
      title = privateTitles[req.path];
      source = loadingMarkup(source, title);
    }
    if (req.params.productId) {
      const catalog = await getEffectiveCatalog({ includeInactive: false });
      let p = catalog.products.find((x) => x.id === req.params.productId);
      if (!p) {
        try {
          p = await require("../commerce/catalog").resolveProduct(
            req.params.productId,
          );
        } catch (error) {
          if (error.statusCode !== 404) throw error;
        }
      }
      if (!p) {
        return require("./storefrontPages").sendMissing(res);
      }
      let content = {};
      const database = require("../config/firebaseAdmin").initFirebaseAdmin()
        .db;
      if (database)
        content =
          (
            await database.collection("storeProductDetails").doc(p.id).get()
          ).data()?.published || {};
      title = content.seo?.title || p.name;
      description =
        content.seo?.description || content.description?.tr || p.description;
      if (content.seo?.slug) canonical = base() + "/urun/" + content.seo.slug;
      if (content.seo?.image)
        image = new URL(content.seo.image, canonical).href;
      p = { ...p, description: content.description?.tr || p.description };
      source = productMarkup(source, p, canonical);
    } else if (req.params.category) {
      const preset = CATEGORY_PRESETS[req.params.category];
      title = preset ? preset.category :
        {
          android: "Android ürünleri",
          ios: "iOS ürünleri",
          pubg: "PUBG Mobile",
          oxide: "Oxide",
          gbox: "GBOX",
        }[req.params.category] || "Ürün kategorisi";
      description =
        title + " için güncel dijital ürünleri ve paket seçeneklerini keşfet.";
      const catalog = await getEffectiveCatalog({ includeInactive: false });
      source = listingMarkup(
        source,
        title,
        catalog.products.filter((p) =>
          preset ? p.game === preset.game && p.platform === preset.platform
            : [p.platform, p.game, p.categoryKey].includes(req.params.category),
        ),
      );
    } else if (req.path === "/magaza") {
      title = "Tüm ürünler";
      const catalog = await getEffectiveCatalog({ includeInactive: false });
      source = listingMarkup(source, title, catalog.products);
    }
    source = meta(source, { title, description, canonical, image });
    res.type("html").send(source);
  } catch (error) {
    next(error);
  }
}
function robots(_req, res) {
  res
    .type("text/plain")
    .send(
      `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /admin/\nDisallow: /hesabim\nDisallow: /sepet\nDisallow: /siparisler\nDisallow: /kuponlar\nDisallow: /bildirimler\nDisallow: /favoriler\nSitemap: ${base()}/sitemap.xml\n`,
    );
}
async function sitemap(_req, res, next) {
  try {
    const catalog = await getEffectiveCatalog({ includeInactive: false });
    const database = require("../config/firebaseAdmin").initFirebaseAdmin().db;
    const published =
      database && catalog.products.length
        ? await database.getAll(
            ...catalog.products.map((p) =>
              database.collection("storeProductDetails").doc(p.id),
            ),
          )
        : [];
    const slugs = new Map(
      published.map((doc) => [
        doc.id,
        doc.data()?.published?.seo?.slug || doc.id,
      ]),
    );
    const urls = [
      "/",
      "/magaza",
      "/destek",
      ...["android", "ios", "pubg", "oxide", "gbox", ...Object.keys(CATEGORY_PRESETS)].map(
        (x) => "/kategori/" + x,
      ),
      ...catalog.products.map((p) => "/urun/" + (slugs.get(p.id) || p.id)),
    ];
    res.setHeader("Cache-Control", "public, max-age=300");
    res
      .type("application/xml")
      .send(
        '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
          urls
            .map((u) => "<url><loc>" + esc(base() + u) + "</loc></url>")
            .join("") +
          "</urlset>",
      );
  } catch (error) {
    next(error);
  }
}
module.exports = {
  servePage,
  robots,
  sitemap,
  jsonLd,
  meta,
  productMarkup,
  listingMarkup,
  loadingMarkup,
};
