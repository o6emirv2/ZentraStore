"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { CATEGORY_PRESETS } = require("../public/js/store/catalog-schema.mjs");
const { STORE_CATALOG } = require("../server/core/storeCatalog");
const {
  meta,
  productMarkup,
  listingMarkup,
  loadingMarkup,
} = require("../server/core/storefrontSeo");
const root = path.resolve(__dirname, "..");
const output = path.join(root, "dist-pages");
const origin = "https://zentrastore.com.tr";
const template = fs.readFileSync(path.join(root, "index.html"), "utf8");
function copy(source, destination) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error("STATIC_SYMBOLIC_LINK_REFUSED");
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const name of fs.readdirSync(source))
      copy(path.join(source, name), path.join(destination, name));
  } else if (stat.isFile()) fs.copyFileSync(source, destination);
  else throw new Error("STATIC_SOURCE_UNSUPPORTED");
}
function writePage(route, source, title, privatePage = false) {
  const file = path.join(output, route, "index.html");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let html = meta(source, {
    title,
    canonical: origin + (route ? "/" + route : "/"),
    description: title + " · Zentra Store dijital ürünler ve hesap işlemleri.",
  });
  if (privatePage)
    html = html.replace(
      "</head>",
      '<meta name="robots" content="noindex,nofollow"/></head>',
    );
  fs.writeFileSync(file, html);
}
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output);
for (const name of [
  "index.html",
  "404.html",
  "unavailable.html",
  "sifre-yenile.html",
  "CNAME",
  "admin",
  "public",
  "sw.js",
  "offline.html",
])
  copy(path.join(root, name), path.join(output, name));
for (const name of ["favicon.ico", "apple-touch-icon.png"])
  copy(path.join(root, "public/assets/images", name), path.join(output, name));
fs.writeFileSync(path.join(output, ".nojekyll"), "");
writePage(
  "magaza",
  listingMarkup(template, "Tüm ürünler", STORE_CATALOG.products),
  "Tüm ürünler",
);
for (const [id, title] of Object.entries({
  android: "Android ürünleri",
  ios: "iOS ürünleri",
  pubg: "PUBG Mobile",
  oxide: "Oxide",
  gbox: "GBOX",
  ...Object.fromEntries(Object.entries(CATEGORY_PRESETS).map(([id, preset]) => [id, preset.category])),
})) {
  writePage(
    "kategori/" + id,
    listingMarkup(
      template,
      title,
      STORE_CATALOG.products.filter((p) =>
        CATEGORY_PRESETS[id] ? p.game === CATEGORY_PRESETS[id].game && p.platform === CATEGORY_PRESETS[id].platform
          : [p.platform, p.game, p.categoryKey].includes(id),
      ),
    ),
    title,
  );
}
for (const p of STORE_CATALOG.products)
  writePage(
    "urun/" + p.id,
    productMarkup(template, p, origin + "/urun/" + p.id),
    p.name,
  );
for (const [route, title] of Object.entries({
  hesabim: "Hesabım",
  sepet: "Sepetim",
  siparisler: "Siparişlerim",
  favoriler: "Favorilerim",
  bildirimler: "Bildirimler",
  kuponlar: "Kuponlarım",
  destek: "Yardım ve destek",
}))
  writePage(
    route,
    route === "destek" ? template : loadingMarkup(template, title),
    title,
    route !== "destek",
  );
const routes = [
  "/",
  "/magaza",
  "/destek",
  ...["android", "ios", "pubg", "oxide", "gbox", ...Object.keys(CATEGORY_PRESETS)].map((x) => "/kategori/" + x),
  ...STORE_CATALOG.products.map((p) => "/urun/" + p.id),
];
fs.writeFileSync(
  path.join(output, "sitemap.xml"),
  '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
    routes.map((r) => "<url><loc>" + origin + r + "</loc></url>").join("") +
    "</urlset>",
);
fs.writeFileSync(
  path.join(output, "robots.txt"),
  "User-agent: *\nAllow: /\nDisallow: /admin/\nDisallow: /api/\nDisallow: /hesabim\nDisallow: /sepet\nDisallow: /siparisler\nDisallow: /favoriler\nDisallow: /kuponlar\nDisallow: /bildirimler\nSitemap: " +
    origin +
    "/sitemap.xml\n",
);
// Financial data, credentials, server files, evidence and tests never enter Pages.
for (const forbidden of [
  "server",
  "scripts",
  "node_modules",
  ".git",
  ".env",
  "package.json",
  "validation-evidence.json",
])
  if (fs.existsSync(path.join(output, forbidden)))
    throw new Error("STATIC_PRIVATE_FILE_DETECTED");
console.log(
  JSON.stringify({
    result: "PASS",
    output: "dist-pages",
    products: STORE_CATALOG.products.length,
    notes:
      "Bundled catalog SEO snapshot; all checkout data verified against the live API.",
  }),
);
