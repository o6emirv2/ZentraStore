"use strict";
const { test, before, after } = require("node:test"),
  assert = require("node:assert/strict");
const { browserModule } = require("./helpers/browser-module.cjs");
let makeClient, makeCart;
const prior = Object.getOwnPropertyDescriptor(global, "document");
before(async () => {
  global.document = {
    documentElement: { lang: "tr", dataset: {}, style: { setProperty() {} } },
    addEventListener() {},
    querySelector: () => null,
  };
  makeClient = (await browserModule("public/js/app/commerce-client.js"))
    .createCommerceClient;
  makeCart = (await import("../public/js/app/cart.mjs")).createCart;
});
after(() => {
  if (prior) Object.defineProperty(global, "document", prior);
  else delete global.document;
});
function setup({ load = async (row) => row } = {}) {
  let uid = "member",
    row = {
      revision: 0,
      cart: [
        {
          productId: "product-one",
          planKey: "daily",
          quantity: 1,
          acceptedUnitPriceKurus: 1000,
        },
      ],
      favorites: [],
      preferences: {},
    };
  const cart = makeCart(),
    writes = [];
  const client = makeClient({
    userId: () => uid,
    cart,
    getFavorites: () => new Set(),
    setFavorites() {},
    getProduct: () => ({ plans: [{ key: "daily", priceKurus: 1000 }] }),
    navigate() {},
    refresh() {},
    logout() {},
    api: async (path, options) => {
      if (path.endsWith("/sessions")) return { result: {} };
      if (options?.method !== "PATCH")
        return { result: structuredClone(await load(row)) };
      assert.equal(options.method, "PATCH");
      assert.equal(options.body.expectedRevision, row.revision);
      writes.push(structuredClone(options.body.cart));
      row = { ...row, ...options.body, revision: row.revision + 1 };
      return { result: structuredClone(row) };
    },
  });
  return {
    client,
    cart,
    writes,
    switchUser: (value) => {
      uid = value;
    },
    row: () => row,
  };
}
test("an add during account-cart loading waits and preserves the existing server cart", async () => {
  let release;
  const f = setup({
    load: (row) =>
      new Promise((resolve) => {
        release = () => resolve(row);
      }),
  });
  const connection = f.client.connect("member");
  const add = f.client.changeCart(() => f.cart.add("product-one", "daily"));
  assert.equal(f.writes.length, 0);
  release();
  await Promise.all([connection, add]);
  assert.equal(f.row().cart[0].quantity, 2);
  assert.equal(f.writes.length, 1);
});
test("rapid cart actions commit in order without overwriting the preceding quantity", async () => {
  const f = setup();
  await f.client.connect("member");
  await Promise.all([
    f.client.changeCart(() => f.cart.add("product-one", "daily")),
    f.client.changeCart(() => f.cart.add("product-one", "daily")),
  ]);
  assert.deepEqual(
    f.writes.map((rows) => rows[0].quantity),
    [2, 3],
  );
  assert.equal(f.cart.items()[0].quantity, 3);
});
test("a temporary cart-load failure can be retried without creating an empty replacement cart", async () => {
  let first = true;
  const f = setup({
    load: async (row) => {
      if (first) {
        first = false;
        throw new Error("network unavailable");
      }
      return row;
    },
  });
  await assert.rejects(f.client.connect("member"));
  await f.client.changeCart(() => f.cart.add("product-one", "daily"));
  assert.equal(f.row().cart[0].quantity, 2);
});
test("a queued action cannot write to a different signed-in account", async () => {
  const f = setup();
  const add = f.client.changeCart(() => f.cart.add("product-one", "daily"));
  f.switchUser("other-member");
  await assert.rejects(add, /Oturum değişti/);
  assert.equal(f.writes.length, 0);
});
