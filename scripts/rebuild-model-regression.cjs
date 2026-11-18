"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const model = import("../public/js/app/cart.mjs"),
  filters = import("../public/js/app/catalog.mjs");
const products = [
  {
    id: "alpha",
    name: "KİNGMOD",
    description: "Android paketi",
    platform: "android",
    game: "pubg",
    categoryKey: "pubg-android",
    stock: { available: 3 },
    plans: [{ key: "daily", priceKurus: 25000 }],
    featured: true,
  },
  {
    id: "beta",
    name: "GBOX",
    description: "iOS paketi",
    platform: "ios",
    game: "gbox",
    categoryKey: "gbox-ios",
    stock: { available: 0 },
    plans: [{ key: "year", priceKurus: 100000 }],
  },
];
const route = (q = {}, extra = {}) => ({
  name: "catalog",
  query: new URLSearchParams(q),
  ...extra,
});
test("persisted carts restore only bounded product/package/quantity identifiers", async () => {
  const { createCart } = await model;
  let value = JSON.stringify([
    {
      productId: "alpha",
      planKey: "daily",
      quantity: 2,
      totalKurus: 1,
      balance: 999999,
    },
  ]);
  const storage = {
    getItem: () => value,
    setItem: (_, v) => {
      value = v;
    },
  };
  const c = createCart(storage);
  assert.deepEqual(c.items(), [
    { productId: "alpha", planKey: "daily", quantity: 2 },
  ]);
  c.add("beta", "year");
  assert.equal(createCart(storage).items().length, 2);
  assert(!value.includes("totalKurus"));
});
test("corrupt storage and storage denial do not invent cart records", async () => {
  const { createCart } = await model;
  assert.deepEqual(createCart({ getItem: () => "{bad" }).items(), []);
  const c = createCart({
    getItem() {
      throw Error("blocked");
    },
    setItem() {
      throw Error("blocked");
    },
  });
  c.add("alpha", "daily");
  assert.equal(c.items()[0].quantity, 1);
});
test("malformed, overlarge and prototype-shaped cart entries cannot survive normalization", async () => {
  const { normalizeItems } = await model;
  assert.deepEqual(
    normalizeItems([
      { productId: "../secret", planKey: "x", quantity: 1 },
      { productId: "alpha", planKey: "x", quantity: 6 },
      { productId: "alpha", planKey: "x", quantity: 1.5 },
      null,
    ]),
    [],
  );
  assert.equal(
    normalizeItems(
      Array.from({ length: 100 }, (_, i) => ({
        productId: "item-" + i,
        planKey: "daily",
        quantity: 1,
      })),
    ).length,
    20,
  );
});
test("merged duplicate quantities are bounded and additions cannot exceed per-line limits", async () => {
  const { normalizeItems, createCart } = await model;
  assert.equal(
    normalizeItems([
      { productId: "alpha", planKey: "daily", quantity: 3 },
      { productId: "alpha", planKey: "daily", quantity: 4 },
    ])[0].quantity,
    5,
  );
  const c = createCart();
  for (let i = 0; i < 5; i++) c.add("alpha", "daily");
  assert.throws(() => c.add("alpha", "daily"));
  assert.equal(c.items()[0].quantity, 5);
});
test("cart display reprices from the freshly fetched catalog and flags removed packages", async () => {
  const { priceCart } = await model;
  const c = { products: structuredClone(products) };
  const intent = [
    { productId: "alpha", planKey: "daily", quantity: 2, priceKurus: 1 },
  ];
  assert.equal(priceCart(intent, c).totalKurus, 50000);
  c.products[0].plans[0].priceKurus = 30000;
  assert.equal(priceCart(intent, c).totalKurus, 60000);
  c.products[0].archived = true;
  assert.equal(priceCart(intent, c).invalid.length, 1);
  assert.equal(priceCart(intent, c).lines.length, 0);
});
test("cart removal and clear survive the next storage restoration", async () => {
  const { createCart } = await model;
  let value;
  const s = { getItem: () => value, setItem: (_, v) => (value = v) };
  const c = createCart(s);
  c.add("alpha", "daily");
  c.remove("alpha", "daily");
  assert.deepEqual(createCart(s).items(), []);
  c.add("beta", "year");
  c.clear();
  assert.deepEqual(createCart(s).items(), []);
});
test("search supports Turkish case and one-character misspellings on real catalog values", async () => {
  const { filterProducts } = await filters;
  assert.equal(
    filterProducts({ products }, route({ q: "kingmod" }))[0].id,
    "alpha",
  );
  assert.equal(
    filterProducts({ products }, route({ q: "kingmo" }))[0].id,
    "alpha",
  );
  assert.equal(
    filterProducts({ products }, route({ q: "no-such-product" })).length,
    0,
  );
});
test("category, price, stock, favorites and sort filters operate on actual product membership", async () => {
  const { filterProducts: f } = await filters,
    c = { products };
  assert.deepEqual(
    f(c, route({}, { name: "category", id: "ios" })).map((x) => x.id),
    ["beta"],
  );
  assert.deepEqual(
    f(c, route({ max: "300", stock: "1" })).map((x) => x.id),
    ["alpha"],
  );
  assert.deepEqual(
    f(c, route({ sort: "price-down" })).map((x) => x.id),
    ["beta", "alpha"],
  );
  assert.deepEqual(
    f(c, route({}, { name: "favorites" }), {
      favorites: new Set(["beta"]),
    }).map((x) => x.id),
    ["beta"],
  );
  assert.deepEqual(
    f(c, route({}, { name: "category", id: "selected" }), {
      categories: [{ id: "selected", productIds: ["alpha"] }],
    }).map((x) => x.id),
    ["alpha"],
  );
});
test("Instagram URL validation rejects credentials, queries and misleading domains", () => {
  const { normalizeQuickLinkUrl: f } = require("../server/core/storeLinks");
  assert.equal(
    f("instagram", "https://instagram.com/zentra.store"),
    "https://www.instagram.com/zentra.store",
  );
  for (const u of [
    "https://instagram.com.evil.invalid/name",
    "https://user:pass@instagram.com/name",
    "javascript:alert(1)",
    "https://instagram.com/name?next=x",
  ])
    assert.throws(() => f("instagram", u));
});
test("a cancelled and fully refunded wallet order exposes refund state separately from cancellation", () => {
  process.env.NODE_ENV = "development";
  const { publicOrder } = require("../server/core/storeService");
  const o = publicOrder(
    {
      status: "cancelled",
      paymentMethod: "wallet",
      uid: "member",
      totalKurus: 500,
      walletRefundedAt: 1,
      walletRefundedKurus: 500,
      items: [],
    },
    "test-order",
  );
  assert.equal(o.status, "cancelled");
  assert.equal(o.paymentState, "refunded");
});

test("redacted or unavailable dashboard metrics cannot become invented zero values", async () => {
  const { metricLabel, metricValue } = await import("../admin/metrics.mjs");
  for (const value of [undefined, null, NaN, Infinity, "0", -1]) {
    assert.equal(metricValue({ revenue: value }, "revenue"), null);
    assert.equal(metricLabel({ revenue: value }, "revenue"), "Doğrulanamadı");
  }
  assert.equal(metricLabel({}, "hidden"), "Doğrulanamadı");
});
test("verified dashboard zeroes remain zero and financial formatting only receives verified numbers", async () => {
  const { metricLabel } = await import("../admin/metrics.mjs");
  let calls = 0;
  const format = (value) => {
    calls++;
    return "TRY " + value;
  };
  assert.equal(metricLabel({ revenue: 0 }, "revenue", format), "TRY 0");
  assert.equal(metricLabel({ revenue: 12500 }, "revenue", format), "TRY 12500");
  assert.equal(metricLabel({}, "revenue", format), "Doğrulanamadı");
  assert.equal(calls, 2);
});

test("guest checkout opens sign-in even when a sales channel or a saved item is unavailable", async () => {
  const { checkoutState } = await model;
  const gate = checkoutState({
    signedIn: false,
    invalidItems: true,
    payment: "telegram",
    telegramEnabled: false,
  });
  assert.equal(gate.disabled, false);
  assert.equal(gate.label, "Giriş yap ve devam et");
});
test("authenticated checkout explains unavailable channels and invalid items instead of offering an inert action", async () => {
  const { checkoutState } = await model;
  const closed = checkoutState({
    signedIn: true,
    payment: "telegram",
    telegramEnabled: false,
  });
  assert.equal(closed.disabled, true);
  assert(closed.message.includes("kapalı"));
  assert.equal(
    checkoutState({ signedIn: true, invalidItems: true }).disabled,
    true,
  );
  assert.equal(
    checkoutState({ signedIn: true, payment: "wallet", telegramEnabled: false })
      .disabled,
    false,
  );
});
test("pending checkout stays disabled through auth state transitions to prevent a duplicate submission", async () => {
  const { checkoutState } = await model;
  for (const signedIn of [true, false])
    assert.equal(checkoutState({ signedIn, busy: true }).disabled, true);
});
