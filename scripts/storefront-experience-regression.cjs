"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { browserModule } = require("./helpers/browser-module.cjs");
const catalog = require("../public/data/store-products.json");
const { applicationFixture } = require("./helpers/application-fixture.cjs");
const route = (name, id = "", query = "") => ({ name, id, query: new URLSearchParams(query) });

async function pagesFixture(extra = {}) {
  const { createStorePages } = await browserModule("public/js/app/store-pages.mjs");
  const { filterProducts } = await browserModule("public/js/app/catalog.mjs");
  const state = { catalog, selectedImages: new Map(), selectedPlans: new Map(), auth: { user: null }, ...extra };
  const pages = createStorePages({ state, product: id => state.catalog.products.find(p => p.id === id), filtered: r => filterProducts(state.catalog, r), stockLabel: () => "Stok doğrulanıyor", getFavorites: () => new Set(), currentRoute: () => extra.route || route("product", state.catalog.products[0].id) });
  return { state, pages, filterProducts };
}
test("all four game/platform destinations isolate the real catalog and reserved presets cannot be shadowed", async () => {
  const { filterProducts } = await pagesFixture();
  for (const game of ["pubg", "oxide"]) for (const platform of ["ios", "android"]) {
    const id = game + "-" + platform, rows = filterProducts(catalog, route("category", id), { categories: [{ id, productIds: catalog.products.map(p => p.id) }] });
    assert(rows.length > 0);
    assert(rows.every(p => p.game === game && p.platform === platform));
    assert.equal(rows.length, catalog.products.filter(p => p.game === game && p.platform === platform).length);
  }
  assert.equal(filterProducts(catalog, route("category", "gbox")).length, 2);
  const { pages } = await pagesFixture();
  for (const id of ["gbox-iphone","gbox-ipad"]) {
    assert.deepEqual(filterProducts(catalog, route("category", id)).map(row => row.id), [id]);
    assert(pages.detail(id).includes('href="/kategori/' + id + '"'));
  }
});
test("catalog filters preserve stock, favorite and price rules inside a combined category", async () => {
  const { filterProducts } = await pagesFixture();
  const selected = catalog.products.filter(p => p.game === "oxide" && p.platform === "ios").map((p, i) => ({ ...p, stock: { available: i === 0 ? 0 : 4 } }));
  const c = { products: selected }, favorite = selected[1];
  const rows = filterProducts(c, route("favorites", "", "category=oxide-ios&stock=1&min=1&sort=price-up"), { favorites: new Set([selected[0].id, favorite.id]) });
  assert.deepEqual(rows.map(p => p.id), [favorite.id]);
});
test("header and product filters follow the same ordered destination contract", async () => {
  const { PRODUCT_CATEGORIES, STORE_NAVIGATION, HOME_CATEGORIES } = require("../public/js/app/discovery.mjs");
  assert.deepEqual(PRODUCT_CATEGORIES.map(c => c.id), ["", "pubg-ios", "pubg-android", "oxide-ios", "oxide-android", "gbox-iphone", "gbox-ipad"]);
  assert.deepEqual(STORE_NAVIGATION.slice(PRODUCT_CATEGORIES.length).map(c => c.id), ["featured", "account", "promotion", "discount", "orders", "cart", "support"]);
  const html = fs.readFileSync("store-pages.html", "utf8"), nav = /<nav class="category-nav[^]*?<\/nav>/.exec(html)[0];
  assert.deepEqual([...nav.matchAll(/data-discovery="([^"]*)"/g)].map(m => m[1]), STORE_NAVIGATION.map(c => c.id));
  for (const item of STORE_NAVIGATION) assert(nav.includes('href="' + item.href + '"'));
  for (const item of HOME_CATEGORIES) assert(fs.existsSync("." + item.image));
  assert.deepEqual(HOME_CATEGORIES.map(c => c.id), PRODUCT_CATEGORIES.slice(1, 5).map(c => c.id));
});
test("home channel actions honor real configuration, safe Telegram destinations and disabled links", async () => {
  const { channelDestination } = require("../public/js/app/discovery.mjs"), id = "official-telegram";
  for (const url of ["javascript:alert(1)", "https://t.me.evil.test/ZENTRA_STORE", "https://t.me/ZENTRA_STORE?x=1", "//t.me/ZENTRA_STORE"]) assert.equal(channelDestination([{ id, url }], id), "");
  assert.equal(channelDestination([{ id, url: "https://t.me/ZENTRA_STORE", enabled: false }], id), "");
  const { pages } = await pagesFixture({ catalog: { ...catalog, storefront: { quickLinks: [{ id, url: "https://t.me/ZENTRA_STORE" }] } } });
  const home = pages.home();
  assert(home.includes('href="https://t.me/ZENTRA_STORE"'));
  assert(!home.includes("quick-services"));
  assert(!home.includes("BAKİYEM"));
  assert.equal((home.match(/aria-disabled="true"/g) || []).length, 3);
});
test("product cards expose details only, quote the true lowest plan and escape stored content", async () => {
  const { pages } = await pagesFixture(), p = { ...catalog.products[0], name: '<img src=x onerror="alert(1)">', badge: "<script>x</script>", description: '<svg onload="alert(1)">', plans: [{ key: "month", priceKurus: 100000 }, { key: "day", priceKurus: 5000 }] };
  const html = pages.card(p);
  assert(!html.includes('data-action="add"') && !html.includes("quick-add") && !html.includes("product-add"));
  assert(html.includes("50,00"));
  assert(!html.includes("<script>") && !html.includes("<svg onload") && !html.includes("<img src=x"));
  assert(html.includes("Ürünü incele"));
  assert.equal(pages.card({ ...p, plans: [] }), "");
});
test("home selection uses real featured flags and never labels an uncurated catalog as featured", async () => {
  const { pages, state } = await pagesFixture();
  assert(pages.home().includes("Ürünleri keşfet"));
  state.catalog = { ...catalog, products: catalog.products.map((p, i) => ({ ...p, featured: i === 0 })) };
  const html = pages.home();
  assert(html.includes("Öne çıkan ürünler"));
  assert.equal((html.match(/<article class="product-card\b/g) || []).length, 1);
});
test("detail retains the chosen valid package and an invalid choice never becomes a cart plan", async () => {
  const { state, pages } = await pagesFixture(), p = catalog.products[0], plan = p.plans.at(-1);
  state.selectedPlans.set(p.id, plan.key);
  const html = pages.detail(p.id);
  assert(html.includes('data-action="select-package"'));
  assert(html.includes('data-action="add" data-id="' + p.id + '" data-plan="' + plan.key + '"'));
  const options = pages.packageOptions(p, plan.key);
  assert(options.includes('value="' + plan.key + '" checked'));
  const linked = await pagesFixture({ route: route("product", p.id, "paket="+plan.key), selectedPlans: new Map([[p.id, p.plans[0].key]]) });
  assert(linked.pages.detail(p.id).includes('data-plan="' + plan.key + '"'));
  state.selectedPlans.set(p.id, "missing");
  assert(pages.detail(p.id).includes('data-plan="' + p.plans[0].key + '"'));
});
async function accountFixture({ pending = false, empty = false } = {}) {
  const { createAccountPages } = await browserModule("public/js/app/account-pages.mjs");
  const { checkoutState } = require("../public/js/app/cart.mjs"), p = catalog.products[0], plan = p.plans[0],
    items = empty ? [] : [{ productId: p.id, planKey: plan.key, quantity: 5 }], state = { auth: { user: { email: 'test@zentra.invalid', emailVerified: true }, accountStale: true, account: { username: '<script>x</script>', balanceKurus: 99999 } }, catalog, orders: [], orderCursor: "", payment: "wallet" };
  return createAccountPages({ state, uid: () => "member", cart: { items: () => items }, cartView: () => ({ lines: items.map(row => ({ ...row, product: p, plan, totalKurus: plan.priceKurus * row.quantity })), invalid: [], totalKurus: items.length ? plan.priceKurus * 5 : 0 }), tracker: { pending: () => pending ? { id: "pending" } : null }, checkoutState, commerce: { accountLinks: () => "" }, avatarMarkup: () => "Z", userName: () => state.auth.account.username });
}
test("uncertain checkout blocks a second payment and keeps recovery visible even with an empty cart", async () => {
  for (const empty of [false, true]) {
    const pages = await accountFixture({ pending: true, empty }), html = pages.cart();
    assert(html.includes('data-action="recover"'));
    if (!empty) {
      assert(html.includes('data-action="checkout" disabled'));
      assert(/data-change="1"[^>]*disabled/.test(html));
    }
  }
});
test("account and order views distinguish stale balances and payment from delivery without leaking markup", async () => {
  const pages = await accountFixture(), account = pages.account();
  assert(account.includes("Doğrulanamadı"));
  assert(!account.includes("<script>x</script>"));
  const html = pages.orderCard({ id: 'order-1', status: "awaiting_payment", paymentMethod: "telegram", paymentState: "pending", items: [], totalKurus: 5000, createdAt: 1 });
  assert(html.includes("Ödeme bekliyor"));
  assert(!html.includes('data-action="delivery"'));
  assert(!html.includes("Teslim edildi"));
});
function searchNode() {
  const handlers = new Map(), attributes = new Map();
  return { value: "", hidden: true, dataset: {}, classList: { toggle() {} }, addEventListener: (k, f) => handlers.set(k, f), removeEventListener: k => handlers.delete(k), setAttribute: (k, v) => attributes.set(k, v), removeAttribute: k => attributes.delete(k), getAttribute: k => attributes.get(k), contains: () => false, focus() {}, scrollIntoView() {}, emit: (k, event = {}) => handlers.get(k)?.(event) };
}
test("late search responses cannot overwrite a newer query or reopen a closed result panel", async () => {
  const { createSearch } = await browserModule("public/js/app/search.mjs");
  const form = searchNode(), input = searchNode(), results = { ...searchNode(), innerHTML: "", querySelectorAll: () => [] }, clear = searchNode(), scheduled = new Map();
  let timer = 0, resolveOld, resolveLast;
  const oldDocument = global.document; global.document = searchNode();
  try {
    const ui = createSearch({ form, input, results, clear, available: () => true, navigate() {}, schedule: callback => { scheduled.set(++timer, callback); return timer; }, cancel: id => scheduled.delete(id), search: q => q === "old" ? new Promise(resolve => resolveOld = resolve) : q === "last" ? new Promise(resolve => resolveLast = resolve) : Promise.resolve([{ ...catalog.products[0], name: "Newest" }]) });
    input.value = "old"; input.emit("input"); const old = scheduled.get(timer)();
    input.value = "new"; input.emit("input"); await scheduled.get(timer)();
    assert(results.innerHTML.includes("Newest"));
    resolveOld([{ ...catalog.products[1], name: "Stale" }]); await old;
    assert(!results.innerHTML.includes("Stale"));
    input.value = "last"; input.emit("input"); const last = scheduled.get(timer)();
    ui.close(); resolveLast([{ ...catalog.products[0], name: "Reopened" }]); await last;
    assert.equal(results.hidden, true); assert(!results.innerHTML.includes("Reopened")); ui.dispose();
  } finally { global.document = oldDocument; }
});
test("server category HTML and sitemap expose the same combined destinations as the real storefront", async () => {
  const f = await applicationFixture();
  try {
    for (const id of ["pubg-ios", "pubg-android", "oxide-ios", "oxide-android"]) {
      const res = await fetch(f.origin + "/kategori/" + id), html = await res.text();
      assert.equal(res.status, 200);
      const [, platform] = id.split("-"), correct = catalog.products.filter(p => p.game + "-" + p.platform === id);
      const main = /<main[^]*?<\/main>/.exec(html)[0];
      assert(correct.every(p => main.includes("/urun/" + p.id)));
      const other = catalog.products.filter(p => p.game === id.split("-")[0] && p.platform !== platform);
      assert(other.every(p => !main.includes("/urun/" + p.id + '"')));
    }
    const sitemap = await fetch(f.origin + "/sitemap.xml").then(res => res.text());
    assert(sitemap.includes("/kategori/pubg-ios")); assert(sitemap.includes("/kategori/oxide-android"));
  } finally { await f.close(); }
});
