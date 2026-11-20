"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const {
  safeStorePath,
  storeRoute,
  storeEntryPath,
  storeEntryUrl,
  entryDestination,
  restoreStoreEntry,
  recoveryDestination,
} = require("../public/js/app/routes.mjs");
const {
  authPath,
  authReturnTarget,
} = require("../public/js/app/navigation.mjs");
const { applicationFixture } = require("./helpers/application-fixture.cjs");
const canonical = "https://zentrastore.com.tr";
let f;
before(async () => {
  f = await applicationFixture({ canonicalOrigin: canonical });
});
after(async () => f?.close());

test("email entry links reach the root and retain actual product, package and account destinations", () => {
  for (const path of [
    "/siparisler",
    "/hesabim?bolum=gifts",
    "/hesabim?bolum=preferences",
    "/urun/kingmod?paket=weekly",
    "/magaza?q=" + encodeURIComponent("Türkçe ürün") + "&sort=price-up",
    "/kuponlar",
  ]) {
    const url = new URL(storeEntryUrl(canonical, path));
    assert.equal(url.origin, canonical);
    assert.equal(url.pathname, "/");
    assert.equal(entryDestination(url.href), path);
    assert.equal(safeStorePath(path), path);
  }
  assert.equal(storeRoute("/siparisler/").name, "orders");
  assert.equal(storeRoute("/index.html").name, "home");
});

test("external URLs, traversal, hidden routes and malformed destinations never become redirects", () => {
  for (const path of [
    "https://evil.test/hesabim",
    "//evil.test/hesabim",
    "/\\evil.test/hesabim",
    "/sepet\n",
    "/%2f%2fevil.test",
    "/%68esabim",
    "/x/../hesabim",
    "/urun/%2e%2e/hesabim",
    "/sepet//",
    "/sepet/fazla",
    "/admin/",
    "/api/store/orders",
    "/__/auth/action?oobCode=private-action",
    "/hesabim#https://evil.test",
    "/hesabim?q=" + "x".repeat(2048),
    "javascript:alert(1)",
  ]) {
    assert.equal(safeStorePath(path), "", path);
    assert.throws(() => storeEntryPath(path), /STORE_DESTINATION_INVALID/);
    assert.equal(
      entryDestination(canonical + "/?devam=" + encodeURIComponent(path)),
      "",
    );
  }
  assert.throws(
    () => storeEntryUrl("javascript:alert(1)", "/hesabim"),
    /STORE_ORIGIN_INVALID/,
  );
  assert.equal(
    entryDestination(canonical + "/?devam=%2Fhesabim&devam=%2Fsepet"),
    "",
  );
  assert.equal(entryDestination(canonical + "/magaza?devam=%2Fhesabim"), "");
});

test("root entry restores a route once without another HTTP navigation and keeps the package", () => {
  const calls = [];
  const view = {
    location: {
      href: storeEntryUrl(canonical, "/urun/kingmod?paket=weekly"),
      replace: () => assert.fail("entry must not issue a second navigation"),
    },
    history: {
      replaceState(_state, _title, path) {
        calls.push(path);
        view.location.href = new URL(path, canonical).href;
      },
    },
  };
  assert.equal(restoreStoreEntry(view), "/urun/kingmod?paket=weekly");
  assert.equal(restoreStoreEntry(view), "");
  assert.deepEqual(calls, ["/urun/kingmod?paket=weekly"]);
  const url = new URL(view.location.href);
  assert.equal(
    storeRoute(url.pathname, url.search).query.get("paket"),
    "weekly",
  );
});

test("missing static routes recover only known app destinations and unknown links remain missing", () => {
  assert.equal(
    recoveryDestination(canonical + "/siparisler/"),
    storeEntryPath("/siparisler"),
  );
  assert.equal(
    recoveryDestination(canonical + "/urun/kingmod?paket=weekly"),
    storeEntryPath("/urun/kingmod?paket=weekly"),
  );
  for (const path of [
    "/404.html",
    "/olmayan-sayfa",
    "/api/missing",
    "/admin/private.js",
    "/",
  ]) {
    assert.equal(recoveryDestination(canonical + path), "");
  }
  for (const path of ["/olmayan-sayfa", "/siparisler/fazla", "/urun/"])
    assert.equal(storeRoute(path).name, "notFound");
  assert.equal(storeRoute("/", "?devam=https://evil.test").name, "notFound");
});

test("sign-in and registration preserve an email's package, gifts or preferences without an external next", () => {
  for (const target of [
    "/siparisler",
    "/urun/kingmod?paket=weekly",
    "/hesabim?bolum=gifts",
    "/hesabim?bolum=preferences",
  ]) {
    for (const mode of ["login", "register"]) {
      const url = new URL(authPath(mode, target), canonical);
      assert.equal(authReturnTarget(url.pathname, url.search), target);
    }
  }
  assert.equal(
    authReturnTarget("/hesabim", "?bolum=gifts"),
    "/hesabim?bolum=gifts",
  );
  assert.equal(authReturnTarget("/hesabim", "?next=https://evil.test"), "");
  assert.equal(authReturnTarget("/hesabim", "?bolum=not-a-section"), "");
  assert.equal(authReturnTarget("/siparisler"), "/siparisler");
});

test("all eleven email templates send root-entry action links whose HTTP entry is served", async () => {
  const { render, TYPES } = require("../server/email/templates");
  const expected = {
    stock: "/urun/kingmod",
    price: "/urun/kingmod?paket=weekly",
    license: "/siparisler",
    order_created: "/siparisler",
    paid_delivered: "/siparisler",
    gift_received: "/hesabim?bolum=gifts",
    wallet_credit: "/hesabim",
    coupon_assigned: "/kuponlar",
    username_changed: "/hesabim",
    password_changed: "/hesabim",
    test: "/hesabim",
  };
  for (const [type, category] of Object.entries(TYPES)) {
    const message = render(
      {
        id: "link-" + type,
        uid: "member",
        type,
        category,
        createdAt: Date.now(),
        data: { previous: "Previous", current: "Current" },
      },
      {
        product: { id: "kingmod", name: "KİNGMOD" },
        plan: { key: "weekly", label: "Haftalık", priceKurus: 12500 },
        oldPriceKurus: 15000,
        expiresAt: Date.now() + 86400000,
        amountKurus: 10000,
        balanceAfterKurus: 12500,
        statusLabel: "Ödeme bekliyor",
        order: {
          orderNumber: "ZT-TEST",
          totalKurus: 12500,
          delivery: { deliveredAt: Date.now() },
        },
        coupon: { code: "TEST100", type: "fixed", value: 10000 },
      },
      "member@zentra.invalid",
    );
    const action = new URL(
      /<a href="([^"]+)"/.exec(message.html)[1].replaceAll("&amp;", "&"),
    );
    assert.equal(action.origin, canonical, type);
    assert.equal(action.pathname, "/", type);
    assert.equal(entryDestination(action.href), expected[type], type);
    assert(message.text.includes(action.href), type);
    assert(!action.href.includes("member"));
    const response = await fetch(f.origin + action.pathname + action.search);
    assert.equal(response.status, 200, type);
    assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
    assert((await response.text()).includes("Bağlantın açılıyor"));
  }
});

test("unsubscribe remains on the backend, requires POST and returns to the actual preference screen", async () => {
  const K = require("../server/email/config");
  const token = K.unsubscribeToken("member", "price");
  const before = JSON.stringify(
    f.db.records.get("storeCommerceProfiles/member"),
  );
  const confirmation = await fetch(
    f.origin + "/email/unsubscribe?token=" + token,
  );
  assert.equal(confirmation.status, 200);
  assert((await confirmation.text()).includes('method="post"'));
  assert.equal(
    JSON.stringify(f.db.records.get("storeCommerceProfiles/member")),
    before,
  );
  const invalid = await fetch(f.origin + "/email/unsubscribe?token=invalid");
  assert.equal(invalid.status, 400);
  const html = await invalid.text();
  const href = /class="recovery-button primary" href="([^"]+)"/.exec(html)[1];
  assert.equal(entryDestination(href), "/hesabim?bolum=preferences");
  assert.equal(new URL(href).origin, canonical);
  assert.equal(invalid.headers.get("referrer-policy"), "no-referrer");
});

test("missing pages and missing products return real branded 404s while API errors stay JSON", async () => {
  for (const path of [
    "/olmayan-sayfa",
    "/urun/nonexistent-email-product",
    "/?devam=https://evil.test",
  ]) {
    const response = await fetch(f.origin + path);
    assert.equal(response.status, 404, path);
    const html = await response.text();
    assert(html.includes("Aradığın sayfa burada değil."));
    assert(html.includes("/public/assets/images/logo.png"));
    assert(html.includes('data-recovery="final"'));
    assert(!html.includes("store.js"));
    assert(!html.includes("GitHub"));
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  const api = await f.request("/api/nonexistent", {
    uid: "member",
    headers: { Accept: "text/html" },
  });
  assert.equal(api.status, 404);
  assert.equal(api.body.error, "API_ROUTE_NOT_FOUND");
});

test("admin wallet and inventory modules load as JavaScript through the actual server allowlist", async () => {
  for (const name of ["wallet.js", "wallet-model.mjs", "inventory-model.mjs"]) {
    const response = await fetch(f.origin + "/admin/" + name + "?v=108");
    assert.equal(response.status, 200, name);
    assert(/javascript/.test(response.headers.get("content-type")), name);
    assert(!(await response.text()).includes("<!doctype html>"));
  }
  assert.equal((await fetch(f.origin + "/admin/not-allowed.js")).status, 404);
});

test("the newly added repository JPG remains a real allowed image and can be saved through protected catalog routes", async () => {
  const image = "/public/assets/products/Jarvis-oxide.JPG";
  assert.equal(
    require("../server/core/storeProductCreation").isValidProductImage(image),
    true,
  );
  const owner = await f.openAdmin();
  const result = await f.adminWrite(
    owner,
    "/api/admin/store/products/kingmod",
    "PATCH",
    { image },
  );
  assert.equal(result.status, 200);
  const catalog = await f.request("/api/store/catalog");
  assert.equal(
    catalog.body.catalog.products.find((p) => p.id === "kingmod").image,
    image,
  );
  const response = await fetch(f.origin + image);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/jpeg");
  assert.equal(
    Buffer.from(await response.arrayBuffer()).readUInt16BE(0),
    0xffd8,
  );
});

test("an HTML storefront outage retains its failure status and never exposes provider details", async () => {
  const collection = f.db.collection;
  f.db.collection = (name) => {
    const value = collection(name);
    if (name !== "storeProductDetails") return value;
    return {
      ...value,
      doc: (id) => ({
        ...value.doc(id),
        get: async () => {
          throw Object.assign(new Error("private-provider-detail"), {
            code: "PROVIDER_UNAVAILABLE",
            statusCode: 503,
          });
        },
      }),
    };
  };
  try {
    const response = await fetch(f.origin + "/urun/kingmod", {
      headers: { Accept: "text/html" },
    });
    assert.equal(response.status, 503);
    const html = await response.text();
    assert(html.includes("Mağazaya şu anda ulaşılamıyor."));
    assert(!html.includes("private-provider-detail"));
    assert(!html.includes("PROVIDER_UNAVAILABLE"));
  } finally {
    f.db.collection = collection;
  }
});

function worker() {
  const handlers = {},
    cache = new Map();
  let fetcher = async () => new Response("online", { status: 200 });
  const stored = [];
  for (const name of ["offline", "unavailable"])
    cache.set("/" + name + ".html", fs.readFileSync(name + ".html", "utf8"));
  const context = {
    URL,
    Headers,
    Response,
    fetch: (request) => fetcher(request),
    caches: {
      open: async () => ({
        match: async (name) =>
          cache.has(name) ? new Response(cache.get(name)) : undefined,
        put: async () => assert.fail("navigation must not be cached"),
        addAll: async (paths) => stored.push(...paths),
      }),
    },
    self: {
      location: { origin: canonical },
      addEventListener: (name, fn) => {
        handlers[name] = fn;
      },
    },
  };
  vm.runInNewContext(fs.readFileSync("sw.js", "utf8"), context);
  return {
    handlers,
    stored,
    setFetch: (fn) => {
      fetcher = fn;
    },
    navigate: () => {
      let result;
      handlers.fetch({
        request: {
          url: canonical + "/siparisler",
          method: "GET",
          mode: "navigate",
          headers: new Headers(),
        },
        respondWith: (p) => {
          result = p;
        },
      });
      return result;
    },
  };
}

test("an installed PWA replaces upstream 5xx with a branded failure, without caching or inventing success", async () => {
  const w = worker();
  w.setFetch(
    async () => new Response("GitHub upstream error", { status: 502 }),
  );
  const unavailable = await w.navigate();
  assert.equal(unavailable.status, 502);
  assert.equal(unavailable.headers.get("cache-control"), "no-store");
  const html = await unavailable.text();
  assert(html.includes("Mağazaya şu anda ulaşılamıyor."));
  assert(!html.includes("GitHub upstream error"));
  w.setFetch(async () => {
    throw new TypeError("offline");
  });
  const offline = await w.navigate();
  assert.equal(offline.status, 503);
  assert((await offline.text()).includes("Şu anda çevrimdışısın."));
  const missing = new Response("real missing page", { status: 404 });
  w.setFetch(async () => missing);
  assert.equal(await w.navigate(), missing);
});

test("all PWA recovery dependencies exist and are served with successful responses", async () => {
  const w = worker();
  let installed;
  w.handlers.install({
    waitUntil: (p) => {
      installed = p;
    },
  });
  await installed;
  assert(w.stored.includes("/unavailable.html"));
  assert(w.stored.includes("/public/js/app/routes.mjs?v=108"));
  for (const path of w.stored) {
    const response = await fetch(f.origin + path);
    assert.equal(response.status, 200, path);
    await response.arrayBuffer();
  }
});
