"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { browserModule } = require("./helpers/browser-module.cjs");
const load = (file) => browserModule(`public/js/${file}`);
const storage = () => {
  const map = new Map();
  return {
    getItem: (key) => map.get(key) || null,
    setItem: (key, value) => map.set(key, value),
    removeItem: (key) => map.delete(key),
    entries: () => [...map.values()],
  };
};
const body = {
  paymentMethod: "wallet",
  idempotencyKey: "stable-purchase-request-123",
  items: [
    { productId: "demo-product", planKey: "m", quantity: 1, priceKurus: 1 },
  ],
};

test("pending purchase restoration preserves its identity and never resubmits a financial write automatically", async () => {
  const { createPurchaseTracker } = await load("store/purchase-tracker.js");
  const local = storage();
  const calls = [];
  const api = async (url, options) => {
    calls.push({ url, options });
    return { found: true, order: { id: "confirmed" } };
  };
  const first = createPurchaseTracker({
    api,
    storage: local,
    userId: () => "user-a",
  });
  first.start(body, { clearCart: true });
  const second = createPurchaseTracker({
    api,
    storage: local,
    userId: () => "user-a",
  });
  const restored = second.pending();
  assert.equal(restored.body.idempotencyKey, body.idempotencyKey);
  assert.equal(Object.hasOwn(restored.body.items[0], "priceKurus"), false);
  const result = await second.verify();
  assert.equal(result.order.id, "confirmed");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, undefined);
  assert.ok(calls[0].url.startsWith("/api/store/order-attempt?"));
  second.finish(restored);
  assert.equal(second.pending(), null);
  assert.equal(local.entries().length, 0);
});
test("pending purchase restoration retains the displayed price only as an expected server comparison", async () => {
  const { createPurchaseTracker } = await load("store/purchase-tracker.js");
  const local = storage(),
    input = {
      ...body,
      items: [{ ...body.items[0], expectedUnitPriceKurus: 10000 }],
    };
  const first = createPurchaseTracker({
    api: async () => ({}),
    storage: local,
    userId: () => "user-a",
  });
  first.start(input);
  const next = createPurchaseTracker({
    api: async () => ({}),
    storage: local,
    userId: () => "user-a",
  });
  assert.equal(next.pending().body.items[0].expectedUnitPriceKurus, 10000);
  assert.equal(
    Object.hasOwn(next.pending().body.items[0], "priceKurus"),
    false,
  );
});

test("pending financial intent is isolated per user and another account cannot erase it", async () => {
  const { createPurchaseTracker } = await load("store/purchase-tracker.js");
  let uid = "user-a";
  const local = storage();
  const tracker = createPurchaseTracker({
    api: async () => {
      throw new Error("must not read another account");
    },
    storage: local,
    userId: () => uid,
  });
  tracker.start(body);
  uid = "user-b";
  assert.equal(tracker.pending(), null);
  assert.equal(await tracker.verify(), null);
  tracker.clear();
  uid = "user-a";
  assert.equal(tracker.pending().uid, "user-a");
  tracker.clear();
  assert.equal(tracker.pending(), null);
});

test("a late purchase status response cannot enter a different user session", async () => {
  const { createPurchaseTracker } = await load("store/purchase-tracker.js");
  let uid = "user-a",
    resolve;
  const tracker = createPurchaseTracker({
    storage: storage(),
    userId: () => uid,
    api: () =>
      new Promise((done) => {
        resolve = done;
      }),
  });
  tracker.start(body);
  const pending = tracker.verify();
  uid = "user-b";
  resolve({ found: true, order: { id: "private-order" } });
  assert.equal(await pending, null);
});

test("blocked browser storage still permits in-memory purchase tracking", async () => {
  const { createPurchaseTracker } = await load("store/purchase-tracker.js");
  const tracker = createPurchaseTracker({
    userId: () => "user-a",
    storage: {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      },
      removeItem() {
        throw new Error("blocked");
      },
    },
    api: async () => ({ found: true, order: { id: "confirmed" } }),
  });
  const attempt = tracker.start(body);
  assert.equal(tracker.pending().body.idempotencyKey, body.idempotencyKey);
  assert.equal((await tracker.verify()).order.id, "confirmed");
  tracker.finish(attempt);
  assert.equal(tracker.pending(), null);
});

test("external abort and request timeout remain distinct and listeners are cleaned up", async () => {
  const { requestController, waitForSignal } = await load("request-utils.js");
  const external = new AbortController();
  const request = requestController(1000, external.signal);
  const waiting = waitForSignal(
    new Promise(() => {}),
    request.controller.signal,
  );
  external.abort();
  await assert.rejects(waiting, { name: "AbortError" });
  assert.equal(request.timedOut, false);
  request.cleanup();
  const timeout = requestController(5);
  await assert.rejects(
    waitForSignal(new Promise(() => {}), timeout.controller.signal),
    { name: "AbortError" },
  );
  assert.equal(timeout.timedOut, true);
  timeout.cleanup();
});

test("store writes bind the initial identity and do not fall back to another account cookie", async () => {
  const utils =
    "data:text/javascript;base64," +
    fs
      .readFileSync(path.join(__dirname, "../public/js/request-utils.js"))
      .toString("base64");
  const source = fs
    .readFileSync(path.join(__dirname, "../public/js/store/api.js"), "utf8")
    .replace(/([\'\"])\.\.\/request-utils\.js\?v=108\1/, JSON.stringify(utils));
  const previous = {
    window: global.window,
    document: global.document,
    fetch: global.fetch,
  };
  let fetches = 0;
  global.window = {
    location: { href: "https://store.test/", origin: "https://store.test" },
    __ZENTRA_RUNTIME__: { apiBase: "https://store.test", version: 78 },
  };
  global.document = { querySelector: () => null };
  global.fetch = async (_url, options) => {
    fetches++;
    assert.equal(options.headers.get("Authorization"), "Bearer initial-user");
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const api = await import(
      "data:text/javascript;base64," + Buffer.from(source).toString("base64")
    );
    api.setStoreTokenProvider(async () => "initial-user");
    await api.storeApi("/api/store/orders", { method: "POST", body: {} });
    assert.equal(fetches, 1);
    let release;
    api.setStoreTokenProvider(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = api.storeApi("/api/store/orders", {
      method: "POST",
      body: {},
    });
    await Promise.resolve();
    await Promise.resolve();
    api.setStoreTokenProvider(async () => "different-user");
    release("initial-user");
    await assert.rejects(pending, { code: "AUTH_SESSION_CHANGED" });
    assert.equal(fetches, 1);
    api.setStoreTokenProvider(async () => {
      throw new Error("token unavailable");
    });
    await assert.rejects(
      api.storeApi("/api/store/orders", { method: "POST", body: {} }),
      { code: "NETWORK_ERROR", mutationNotSent: true },
    );
    assert.equal(fetches, 1);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete global[key];
      else global[key] = value;
    }
  }
});

test("a private response arriving after an account switch is rejected before reaching the interface", async () => {
  const utils =
    "data:text/javascript;base64," +
    fs
      .readFileSync(path.join(__dirname, "../public/js/request-utils.js"))
      .toString("base64");
  const source =
    fs
      .readFileSync(path.join(__dirname, "../public/js/store/api.js"), "utf8")
      .replace(
        /([\'\"])\.\.\/request-utils\.js\?v=108\1/,
        JSON.stringify(utils),
      ) + "\n// delayed private response boundary";
  const previous = {
    window: global.window,
    document: global.document,
    fetch: global.fetch,
  };
  let respond, started;
  const dispatched = new Promise((resolve) => {
    started = resolve;
  });
  global.window = {
    location: { href: "https://store.test/", origin: "https://store.test" },
    __ZENTRA_RUNTIME__: {
      apiBase: "https://store.test",
      version: 78,
      clientCompatibility: { storeRead: 2 },
    },
  };
  global.document = { querySelector: () => null };
  global.fetch = async () => {
    started();
    return new Promise((resolve) => {
      respond = resolve;
    });
  };
  try {
    const api = await import(
      "data:text/javascript;base64," + Buffer.from(source).toString("base64")
    );
    api.setStoreTokenProvider(async () => "first-account");
    const request = api.storeApi("/api/store/orders");
    await dispatched;
    api.setStoreTokenProvider(async () => "second-account");
    respond(
      new Response(
        JSON.stringify({
          ok: true,
          orders: [{ id: "private-first-account-order" }],
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    await assert.rejects(request, { code: "AUTH_SESSION_CHANGED" });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete global[key];
      else global[key] = value;
    }
  }
});
