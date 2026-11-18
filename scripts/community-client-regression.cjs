"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { browserModule } = require("./helpers/browser-module.cjs");
let createCommunity, originalDocument, originalStorage;
const listeners = new Map(),
  storage = new Map();
before(async () => {
  originalDocument = globalThis.document;
  originalStorage = globalThis.localStorage;
  globalThis.document = {
    documentElement: { lang: "tr" },
    addEventListener: (key, fn) => listeners.set(key, fn),
    removeEventListener: (key, fn) => {
      if (listeners.get(key) === fn) listeners.delete(key);
    },
    querySelector: () => null,
  };
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  };
  globalThis.CSS = { escape: (value) => value };
  ({ createCommunity } = await browserModule("public/js/app/community.mjs"));
});
after(() => {
  globalThis.document = originalDocument;
  globalThis.localStorage = originalStorage;
  delete globalThis.CSS;
});
const state = (patch) => ({
  productId: "product-one",
  likes: 0,
  liked: false,
  revision: 0,
  reviews: [],
  eligibility: { eligible: false, reason: "sign-in" },
  ...patch,
});
test("viewing public comments neither creates a visitor identity nor sends a pending Firebase identity", async () => {
  storage.clear();
  const calls = [];
  const c = createCommunity({
    userId: () => "",
    api: async (path, options) => {
      calls.push({ path, options });
      return { result: state() };
    },
  });
  try {
    await c.load("product-one");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.auth, false);
    assert.deepEqual(calls[0].options.headers, {});
    assert(!calls[0].path.endsWith("/visitor"));
  } finally {
    c.dispose();
  }
});
test("an uncertain guest write retries the identical mutation and reuses the visitor capability", async () => {
  storage.clear();
  const writes = [];
  let lose = true,
    identities = 0;
  const c = createCommunity({
    userId: () => "",
    api: async (path, options) => {
      if (path.endsWith("/visitor")) {
        identities++;
        return { result: { visitorToken: "test-visitor-capability" } };
      }
      if (options.method === "PUT") {
        writes.push(structuredClone(options));
        if (lose) {
          lose = false;
          throw new Error("lost response");
        }
        return {
          result: state({ likes: 1, liked: true, revision: 1, replayed: true }),
        };
      }
      return { result: state() };
    },
  });
  try {
    await c.load("product-one");
    await assert.rejects(c.react("product-one"), /lost response/);
    await c.react("product-one");
    assert.equal(identities, 1);
    assert.equal(writes.length, 2);
    assert.deepEqual(writes[0].body, writes[1].body);
    assert.equal(
      writes[1].headers["X-Zentra-Visitor"],
      "test-visitor-capability",
    );
    assert.match(c.markup("product-one"), /aria-pressed="true"/);
  } finally {
    c.dispose();
  }
});
test("double taps during an outstanding request cannot create concurrent reaction writes", async () => {
  storage.set("zentra-community-visitor-v1", "visitor");
  let release,
    writes = 0;
  const done = new Promise((resolve) => (release = resolve));
  const c = createCommunity({
    userId: () => "",
    api: async (path, options) => {
      if (options.method === "PUT") {
        writes++;
        await done;
        return { result: state({ likes: 1, liked: true, revision: 1 }) };
      }
      return { result: state() };
    },
  });
  try {
    await c.load("product-one");
    const first = c.react("product-one");
    await c.react("product-one");
    release();
    await first;
    assert.equal(writes, 1);
  } finally {
    c.dispose();
  }
});
test("receipt recovery uses the current server state even if another device subsequently unliked", async () => {
  const c = createCommunity({
    userId: () => "member",
    api: async (path, options) => ({
      result:
        options.method === "PUT"
          ? state({ replayed: true, revision: 2 })
          : state(),
    }),
  });
  try {
    await c.load("product-one");
    await c.react("product-one");
    assert.match(c.markup("product-one"), /aria-pressed="false"/);
  } finally {
    c.dispose();
  }
});
test("a response for a previous account never paints the new account's product interaction", async () => {
  let uid = "first",
    release;
  const done = new Promise((resolve) => (release = resolve));
  const c = createCommunity({
    userId: () => uid,
    api: async (path, options) => {
      if (options.method === "PUT") {
        await done;
        return { result: state({ likes: 1, liked: true, revision: 1 }) };
      }
      return { result: state() };
    },
  });
  try {
    await c.load("product-one");
    const pending = c.react("product-one");
    uid = "second";
    release();
    await assert.rejects(pending, /oturumu değişti/);
    assert(!c.markup("product-one").includes('aria-pressed="true"'));
  } finally {
    c.dispose();
  }
});
test("comments are escaped and writing is offered only for server-confirmed purchase eligibility", async () => {
  const c = createCommunity({
    userId: () => "member",
    api: async () => ({
      result: state({
        reviews: [
          {
            id: "review",
            displayName: "<img src=x onerror=alert(1)>",
            title: "<script>x</script>",
            message: "<svg onload=alert(1)>",
            rating: 5,
            createdAt: Date.now(),
          },
        ],
      }),
    }),
  });
  try {
    await c.load("product-one");
    const html = c.markup("product-one");
    assert(!html.includes("<script>"));
    assert(!html.includes("<img src=x"));
    assert(html.includes("&lt;svg"));
    assert(!html.includes('data-community="review"'));
  } finally {
    c.dispose();
  }
});
test("malformed or negative server counts cannot be displayed as success", async () => {
  const c = createCommunity({
    userId: () => "member",
    api: async () => ({ result: state({ likes: -1 }) }),
  });
  try {
    await assert.rejects(c.load("product-one"), /doğrulanamadı/);
    assert(c.markup("product-one").includes("Yeniden dene"));
  } finally {
    c.dispose();
  }
});
test("disposing the product component removes its document handlers", () => {
  const c = createCommunity({
    userId: () => "",
    api: async () => ({ result: state() }),
  });
  assert.deepEqual([...listeners.keys()].sort(), ["click", "dblclick", "error"]);
  c.dispose();
  assert.equal(listeners.size, 0);
});
