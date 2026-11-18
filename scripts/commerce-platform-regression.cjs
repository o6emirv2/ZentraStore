"use strict";
const { test, before, after } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  vm = require("node:vm");
const { applicationFixture } = require("./helpers/application-fixture.cjs");
let f, owner, p;
const base = "/api/store/commerce",
  admin = "/api/admin/store/commerce";
const post = (path, body = {}) =>
  f.request(base + path, { uid: "member", method: "POST", body });
before(async () => {
  f = await applicationFixture();
  owner = await f.openAdmin();
  p = (await f.request("/api/store/catalog")).body.catalog.products[0];
});
after(async () => f?.close());
test("partial maintenance blocks selected customer work and leaves its administrator controls accessible", async () => {
  const save = (body) => f.adminWrite(owner, admin + "/settings", "PUT", body);
  assert.equal(
    (
      await save({
        expectedRevision: 0,
        maintenance: { orders: true, message: "Sipariş bakımı" },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await post("/quote", {
        items: [{ productId: p.id, planKey: p.plans[0].key, quantity: 1 }],
        paymentMethod: "telegram",
      })
    ).status,
    503,
  );
  assert.equal((await f.request("/api/store/catalog")).status, 200);
  assert.equal((await f.request(admin + "/settings", owner)).status, 200);
  assert.equal(
    (
      await save({
        expectedRevision: 1,
        maintenance: { orders: false, account: true },
      })
    ).status,
    200,
  );
  assert.equal(
    (await f.request(base + "/profile", { uid: "member" })).status,
    503,
  );
  assert.equal(
    (await save({ expectedRevision: 2, maintenance: { account: false } }))
      .status,
    200,
  );
});
test("loyalty rewards require confirmed payments and one idempotent redemption creates one account coupon", async () => {
  await f.adminWrite(owner, admin + "/settings", "PUT", {
    expectedRevision: 3,
    loyalty: {
      enabled: true,
      pointsPer100TL: 10,
      rewardPoints: 10,
      rewardDiscountKurus: 100,
      minimumSubtotalKurus: 1000,
    },
  });
  const now = Date.now() + 1;
  f.db.records.set("storeOrders/loyalty-paid", {
    uid: "member",
    paymentMethod: "wallet",
    status: "paid",
    approvedAt: now,
    createdAt: now,
    totalKurus: 10000,
    items: [],
  });
  f.db.records.set("storeOrders/loyalty-pending", {
    uid: "member",
    paymentMethod: "telegram",
    status: "awaiting_payment",
    approvedAt: 0,
    createdAt: now,
    totalKurus: 900000,
    items: [],
  });
  let r = await f.request(base + "/loyalty", { uid: "member" });
  assert.equal(r.status, 200);
  assert.equal(r.body.result.balance, 10);
  const results = await Promise.all(
    [1, 2].map(() => post("/loyalty/redeem", { idempotencyKey: "points-001" })),
  );
  assert(results.every((x) => x.status === 200));
  assert.equal(results[0].body.result.code, results[1].body.result.code);
  assert.equal(f.db.records.get("storeLoyaltyAccounts/member").balance, 0);
  assert.equal(
    [...f.db.records.keys()].filter((x) =>
      x.startsWith("storeLoyaltyRedemptions/"),
    ).length,
    1,
  );
});
test("refund reverses previously earned points atomically even when they have already been spent", async () => {
  const r = await f.adminWrite(
    owner,
    "/api/admin/store/orders/loyalty-paid",
    "PATCH",
    { status: "refunded" },
  );
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(
    f.db.records.get("storeLoyaltyOrderLedger/loyalty-paid").points,
    0,
  );
  assert.equal(f.db.records.get("storeLoyaltyAccounts/member").balance, -10);
});
test("product watches notify only on real recorded price drops and respect account preferences", async () => {
  await f.request(base + "/profile", {
    uid: "member",
    method: "PATCH",
    body: { expectedRevision: 0, preferences: { priceNotifications: true } },
  });
  assert.equal(
    (await post("/watch", { productId: p.id, stock: false, price: true }))
      .status,
    200,
  );
  f.db.records.set("storePriceJobs/job-price", {
    productId: p.id,
    planKey: p.plans[0].key,
    priceKurus: 100,
    previousPriceKurus: 200,
    state: "pending",
    createdAt: Date.now(),
    cursor: "",
  });
  const worker = require("../server/commerce/worker");
  await worker.priceNotifications();
  const notices = [...f.db.records.entries()].filter(
    ([k, v]) => k.startsWith("storeNotifications/") && v.productId === p.id,
  );
  assert.equal(notices.length, 1);
  await worker.priceNotifications();
  assert.equal(
    [...f.db.records.entries()].filter(
      ([k, v]) => k.startsWith("storeNotifications/") && v.productId === p.id,
    ).length,
    1,
  );
});
test("verified license reminders use the recorded expiry and never invent a duration", async () => {
  await f.request(base + "/profile", {
    uid: "member",
    method: "PATCH",
    body: { expectedRevision: 1, preferences: { licenseReminders: true } },
  });
  const now = Date.now();
  f.db.records.set("storeOrders/license-order", {
    uid: "member",
    status: "delivered",
    createdAt: now,
    approvedAt: now,
    items: [],
  });
  const r = await f.adminWrite(
    owner,
    admin + "/orders/license-order/license",
    "PUT",
    {
      startsAt: now - 1000,
      expiresAt: now + 86400000,
      source: "Publisher activation record",
    },
  );
  assert.equal(r.status, 200);
  await require("../server/commerce/worker").licenseReminders();
  assert(
    [...f.db.records.values()].some(
      (x) =>
        x.type === "commerce" &&
        x.orderId === "license-order" &&
        x.expiresAt === now + 86400000,
    ),
  );
  assert.equal(
    f.db.records.get("storeOrderExperience/license-order").licenseReminderDueAt,
    0,
  );
});
test("changing a persisted display preference validates its type and stores supported text sizes", async () => {
  let r = await f.request(base + "/profile", {
    uid: "member",
    method: "PATCH",
    body: {
      expectedRevision: 2,
      preferences: {
        textScale: 200,
        theme: "dark",
        language: "en",
        reducedMotion: true,
      },
    },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.result.preferences.textScale, 200);
  r = await f.request(base + "/profile", {
    uid: "member",
    method: "PATCH",
    body: { expectedRevision: 3, preferences: { textScale: 999 } },
  });
  assert.equal(r.status, 400);
});
test("draft SEO is not public until publication, and published safe slugs resolve to the actual product", async () => {
  const r = await f.adminWrite(
    owner,
    admin + "/products/" + p.id + "/draft",
    "PUT",
    {
      expectedRevision: 0,
      content: {
        seo: {
          title: "Actual product title",
          description: "Published description",
          slug: "public-product",
        },
        description: { tr: "Yayınlanan ürün", en: "Published product" },
      },
    },
  );
  assert.equal(r.status, 200);
  assert.equal(
    (await f.request(base + "/products/public-product")).status,
    404,
  );
  assert.equal(
    (
      await f.adminWrite(
        owner,
        admin + "/products/" + p.id + "/publish",
        "POST",
        { expectedRevision: 1 },
      )
    ).status,
    200,
  );
  assert.equal(
    (await f.request(base + "/products/public-product")).body.result.product
      .productId,
    p.id,
  );
  const response = await fetch(f.origin + "/urun/public-product");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert(html.includes("Actual product title"));
  assert(html.includes("/urun/public-product"));
  assert(!html.includes("unitCostKurus"));
});
test("managed backups poll actual provider operations and replay without resubmitting an export", async () => {
  const firebase = require("../server/config/firebaseAdmin"),
    originalInit = firebase.initFirebaseAdmin,
    originalFetch = global.fetch,
    calls = [];
  process.env.FIRESTORE_BACKUP_BUCKET = "zentra-backup-test";
  process.env.FIRESTORE_RESTORE_TEST_PROJECT = "isolated-test-project";
  firebase.initFirebaseAdmin = () => ({
    ...originalInit(),
    app: {
      options: {
        projectId: "fixture-project",
        credential: {
          getAccessToken: async () => ({ access_token: "fixture-only" }),
        },
      },
    },
  });
  global.fetch = async (url, options) => {
    if (!String(url).startsWith("https://firestore.googleapis.com/"))
      return originalFetch(url, options);
    calls.push({
      url: String(url),
      body: options.body ? JSON.parse(options.body) : null,
    });
    return {
      ok: true,
      json: async () =>
        String(url).includes(":exportDocuments")
          ? {
              name: "projects/fixture-project/databases/(default)/operations/export-job",
            }
          : String(url).includes(":importDocuments")
            ? {
                name: "projects/isolated-test-project/databases/(default)/operations/import-job",
              }
            : {
                done: true,
                metadata: { progressDocuments: { workCompleted: "12" } },
              },
    };
  };
  try {
    const backups = require("../server/commerce/backups"),
      a = await backups.create(
        { idempotencyKey: "backup-test-001" },
        { uid: "owneruid" },
      );
    assert.equal(a.state, "pending");
    assert.equal(
      (
        await backups.create(
          { idempotencyKey: "backup-test-001" },
          { uid: "owneruid" },
        )
      ).id,
      a.id,
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body.collectionIds, []);
    assert.equal((await backups.refresh(a.id)).state, "completed");
    const restored = await backups.restore(
      a.id,
      { confirmation: "TEST ORTAMINA GERI YUKLE" },
      { uid: "owneruid" },
    );
    assert.equal(restored.restore.state, "pending");
    const done = await backups.refresh(a.id);
    assert.equal(done.restore.providerConfirmed, true);
    assert.equal(done.restore.recordChecksumsVerified, false);
    assert(
      calls.some((c) =>
        c.url.includes(
          "isolated-test-project/databases/(default):importDocuments",
        ),
      ),
    );
    await assert.rejects(() => backups.provider("../production", {}));
  } finally {
    firebase.initFirebaseAdmin = originalInit;
    global.fetch = originalFetch;
    delete process.env.FIRESTORE_BACKUP_BUCKET;
    delete process.env.FIRESTORE_RESTORE_TEST_PROJECT;
  }
});
function workerFixture() {
  const handlers = {},
    stored = new Map(),
    removed = [];
  let skip = 0,
    requests = 0;
  const cache = {
    addAll: async () => {},
    match: async (r) => stored.get(typeof r === "string" ? r : r.url),
    put: async (r, v) => stored.set(r.url, v),
    keys: async () => [],
    delete: async () => true,
  };
  const response = {
    ok: true,
    type: "basic",
    redirected: false,
    headers: new Headers(),
    clone() {
      return this;
    },
  };
  const context = {
    URL,
    Headers,
    console,
    fetch: async () => {
      requests++;
      return response;
    },
    caches: {
      open: async () => cache,
      keys: async () => ["zentra-public-v1", "unrelated-cache"],
      delete: async (name) => removed.push(name),
    },
    self: {
      location: { origin: "https://store.test" },
      addEventListener: (name, fn) => (handlers[name] = fn),
      skipWaiting: () => skip++,
      clients: { claim: async () => {} },
    },
  };
  vm.runInNewContext(fs.readFileSync("sw.js", "utf8"), context);
  return {
    handlers,
    stored,
    removed,
    response,
    get skip() {
      return skip;
    },
    get requests() {
      return requests;
    },
  };
}
test("PWA excludes API, admin, authorization and third-party requests from its cache handler", () => {
  const w = workerFixture();
  for (const [url, headers] of [
    ["https://store.test/api/store/orders", {}],
    ["https://store.test/admin/portal.js", {}],
    [
      "https://store.test/public/js/app/store.js",
      { authorization: "Bearer private" },
    ],
    ["https://other.test/public/a.js", {}],
  ]) {
    let intercepted = false;
    w.handlers.fetch({
      request: {
        url,
        method: "GET",
        mode: "cors",
        headers: new Headers(headers),
      },
      respondWith: () => (intercepted = true),
    });
    assert.equal(intercepted, false, url);
  }
});
test("PWA never caches navigation responses or no-store assets and applies updates only on request", async () => {
  const w = workerFixture();
  let result;
  const request = {
    url: "https://store.test/hesabim",
    method: "GET",
    mode: "navigate",
    headers: new Headers(),
  };
  w.handlers.fetch({ request, respondWith: (p) => (result = p) });
  await result;
  assert.equal(w.stored.size, 0);
  request.url = "https://store.test/public/js/app/store.js?v=109";
  request.mode = "cors";
  w.response.headers.set("cache-control", "no-store");
  w.handlers.fetch({ request, respondWith: (p) => (result = p) });
  await result;
  assert.equal(w.stored.size, 0);
  w.handlers.message({ data: { type: "OTHER" } });
  assert.equal(w.skip, 0);
  w.handlers.message({ data: { type: "APPLY_UPDATE" } });
  assert.equal(w.skip, 1);
  let activate;
  w.handlers.activate({ waitUntil: (p) => (activate = p) });
  await activate;
  assert.deepEqual(w.removed, ["zentra-public-v1"]);
});
test("account cart storage never transfers another account or legacy guest contents", () => {
  const { createCart } = require("../public/js/app/cart.mjs"),
    data = new Map([
      [
        "zentra-cart-v2",
        JSON.stringify([{ productId: "old", planKey: "daily", quantity: 1 }]),
      ],
    ]),
    storage = {
      getItem: (k) => data.get(k),
      setItem: (k, v) => data.set(k, v),
      removeItem: (k) => data.delete(k),
    },
    cart = createCart(storage);
  cart.owner("member");
  assert.equal(cart.items().length, 0);
  cart.add("product", "daily");
  cart.owner("viewer");
  assert.equal(cart.items().length, 0);
  cart.owner("member");
  assert.equal(cart.items().length, 1);
  cart.owner("");
  assert.equal(cart.items().length, 0);
});
test("release readiness rejects missing commerce indexes and succeeds only after real query probes pass", async () => {
  const check = require("../server/commerce/readiness");
  check.reset();
  f.db.setQueryHook((path) => {
    if (path === "storeReviews")
      throw Object.assign(new Error("index required"), { code: 9 });
  });
  try {
    const failed = await check.readiness();
    assert.equal(failed.ready, false);
    assert.equal(failed.reason, "COMMERCE_INDEXES_REQUIRED");
  } finally {
    f.db.setQueryHook(null);
    check.reset();
  }
  assert.equal((await check.readiness()).ready, true);
  check.reset();
});
test("language changes restore the original text and support whitespace, ARIA labels and 200 percent text", async () => {
  const previous = {
      document: global.document,
      localStorage: global.localStorage,
      NodeFilter: global.NodeFilter,
    },
    text = {
      nodeValue: "Android ve iOS için seçilmiş\n ürünler.",
      parentElement: { closest: () => null },
    },
    attrs = { "aria-label": "Ürün ara" },
    input = {
      getAttribute: (k) => attrs[k] || null,
      setAttribute: (k, v) => (attrs[k] = v),
    },
    root = { dataset: {}, style: { setProperty: () => {} }, lang: "tr" },
    body = { querySelectorAll: () => [input] };
  global.document = {
    documentElement: root,
    body,
    createTreeWalker: () => {
      let i = 0;
      return { nextNode: () => (i++ === 0 ? text : null) };
    },
  };
  global.NodeFilter = { SHOW_TEXT: 4, FILTER_REJECT: 2, FILTER_ACCEPT: 1 };
  global.localStorage = { getItem: () => null, setItem: () => {} };
  try {
    const prefs = await require("./helpers/browser-module.cjs").browserModule(
      "public/js/app/preferences.mjs",
    );
    prefs.applyPreferences({ language: "en", textScale: 200, theme: "dark" });
    prefs.translate(body);
    assert.equal(root.dataset.textScale, "200");
    assert.equal(text.nodeValue, "Selected products for Android and iOS.");
    assert.equal(attrs["aria-label"], "Search products");
    prefs.applyPreferences({ language: "tr" });
    prefs.translate(body);
    assert.equal(text.nodeValue, "Android ve iOS için seçilmiş\n ürünler.");
    assert.equal(attrs["aria-label"], "Ürün ara");
  } finally {
    for (const [k, v] of Object.entries(previous))
      if (v === undefined) delete global[k];
      else global[k] = v;
  }
});
test("the actual BOM-prefixed catalog export can be imported without changing package identity or price", async () => {
  const ops = require("../server/commerce/operations"),
    rows = ops.csvParse(await ops.exportCatalog()),
    updates = ops.makeUpdates(rows);
  assert(rows.length > 0);
  for (const update of updates) {
    const current = (
      await require("../server/core/storeCatalogService").getEffectiveCatalog({
        includeInactive: true,
      })
    ).products.find((p) => p.id === update.productId);
    for (const [key, patch] of Object.entries(update.settings.plans))
      assert.equal(
        patch.priceKurus,
        current.plans.find((x) => x.key === key).priceKurus,
      );
  }
  assert.throws(() => ops.csvParse('productId\n"value"tail'));
  assert.throws(() =>
    ops.csvParse(
      "productId\n" +
        Array.from({ length: 101 }, (_, i) => "row-" + i).join("\n"),
    ),
  );
  assert.throws(() =>
    ops.makeUpdates([
      { productId: "duplicate", planKey: "daily", priceKurus: "100" },
      { productId: "duplicate", planKey: "daily", priceKurus: "200" },
    ]),
  );
});
