"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  clearCustomerSessionView,
  dismissPrivateDialogs,
} = require("../public/js/app/session-view.mjs");
const { browserModule } = require("./helpers/browser-module.cjs");
function classes() {
  const values = new Set();
  return {
    add: (x) => values.add(x),
    remove: (x) => values.delete(x),
    toggle: (x, on) => (on ? values.add(x) : values.delete(x)),
    values,
  };
}
function surface() {
  const dialogs = [];
  const listeners = new Map();
  const windows = new Map();
  const listen = (map, key, fn) => {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(fn);
  };
  const doc = {
    documentElement: { classList: classes() },
    body: { classList: classes() },
    querySelectorAll: (selector) =>
      selector === "dialog.app-dialog" ? dialogs : [],
    addEventListener: (key, fn) => listen(listeners, key, fn),
    removeEventListener: (key, fn) => listeners.get(key)?.delete(fn),
    visibilityState: "hidden",
  };
  const win = {
    addEventListener: (key, fn) => listen(windows, key, fn),
    removeEventListener: (key, fn) => windows.get(key)?.delete(fn),
  };
  doc.defaultView = win;
  function secret() {
    const d = {
      open: true,
      textContent: "private delivery credential",
      close() {
        this.open = false;
      },
      replaceChildren() {
        this.textContent = "";
      },
      remove() {
        this.removed = true;
      },
    };
    dialogs.push(d);
    return d;
  }
  return { doc, win, dialogs, listeners, windows, secret };
}
test("identity changes discard cached orders, coupons, notifications and financial presentation state while keeping the cart", () => {
  const f = surface(),
    dialog = f.secret(),
    cart = { items: [{ productId: "kept-in-cart" }] };
  const state = {
    orders: [{ uid: "old-user" }],
    ordersLoaded: true,
    orderCursor: "old-cursor",
    notifications: [{ message: "old-private" }],
    coupons: [{ code: "old-private" }],
    promotion: { code: "old-private" },
    checkoutBusy: true,
    cart,
  };
  clearCustomerSessionView(state, f.doc);
  assert.deepEqual(state.orders, []);
  assert.deepEqual(state.coupons, []);
  assert.deepEqual(state.notifications, []);
  assert.equal(state.orderCursor, "");
  assert.equal(state.ordersLoaded, false);
  assert.equal(state.promotion, null);
  assert.equal(state.checkoutBusy, false);
  assert.equal(state.cart, cart);
  assert.equal(dialog.textContent, "");
  assert.equal(dialog.open, false);
  assert(dialog.removed);
});
test("invalidated private dialogs are cleared even when a normal modal close would be blocked by a pending request", () => {
  const f = surface(),
    dialog = f.secret();
  f.doc.documentElement.classList.add("dialog-open");
  dismissPrivateDialogs(f.doc);
  assert(dialog.removed);
  assert.equal(dialog.textContent, "");
  assert(!f.doc.documentElement.classList.values.has("dialog-open"));
});
function rootFixture(doc) {
  const title = { textContent: "" },
    nav = { querySelectorAll: () => [] };
  const root = {
    innerHTML: "",
    replaceChildren() {
      this.innerHTML = "";
    },
    querySelector(selector) {
      if (selector === ".admin-shell")
        return this.innerHTML.includes("admin-shell") ? {} : null;
      if (selector === "#admin-main") return main;
      if (selector === "#workspace-title") return title;
      if (selector === ".admin-nav") return nav;
      return null;
    },
  };
  const main = {
    innerHTML: "",
    setAttribute() {},
    removeAttribute() {},
    ownerDocument: doc,
    classList: classes(),
    get isConnected() {
      return root.innerHTML.includes("admin-shell");
    },
  };
  return { root, main };
}
test("admin invalidation removes listeners, clears private dialogs and prevents an in-flight response repainting the gate", async () => {
  const f = surface(),
    { root, main } = rootFixture(f.doc),
    dialog = f.secret();
  const originals = new Map(
    ["document", "window", "location", "sessionStorage"].map((k) => [
      k,
      Object.getOwnPropertyDescriptor(globalThis, k),
    ]),
  );
  try {
    globalThis.document = f.doc;
    globalThis.window = f.win;
    globalThis.location = { hash: "#panel/overview" };
    globalThis.sessionStorage = { getItem: () => null };
    const workspace = await browserModule("admin/workspace.js", {
      'import "../public/js/app/device.js?v=108";': "",
    });
    let finish,
      calls = 0;
    const pending = new Promise((resolve) => {
      finish = resolve;
    });
    const mount = workspace.mountWorkspace({
      root,
      context: {
        uid: "old-owner",
        email: "owner@example.test",
        role: "owner",
        permissions: ["*"],
      },
      api: async (url) => {
        calls++;
        assert.equal(url, "/api/admin/store/overview");
        return pending;
      },
      onLogout: async () => {},
    });
    assert.equal(calls, 1);
    assert(main.innerHTML.includes("skeleton"));
    workspace.unmountWorkspace();
    assert.equal(root.innerHTML, "");
    assert(dialog.removed);
    assert.equal(dialog.textContent, "");
    assert(
      [...f.listeners.values(), ...f.windows.values()].every(
        (set) => set.size === 0,
      ),
    );
    finish({ overview: { metrics: { orders: 100 }, stock: [], system: {} } });
    await mount;
    assert.equal(root.innerHTML, "");
    assert(!main.innerHTML.includes("Net onaylanan tutar"));
    await workspace.mountWorkspace({
      root,
      context: {
        uid: "new-owner",
        email: "new-owner@example.test",
        role: "owner",
        permissions: ["*"],
      },
      api: async () => ({
        overview: { metrics: { orders: 1 }, stock: [], system: {} },
      }),
      onLogout: async () => {},
    });
    assert(root.innerHTML.includes("new-owner"));
    assert.equal(f.windows.get("hashchange").size, 1);
    assert.equal(f.listeners.get("click").size, 2);
    workspace.unmountWorkspace();
    let finishStock;
    const lateStock = new Promise((resolve) => {
      finishStock = resolve;
    });
    await workspace.mountWorkspace({
      root,
      context: {
        uid: "inventory-owner",
        email: "inventory@example.test",
        role: "owner",
        permissions: ["*"],
      },
      api: async (url) =>
        url.startsWith("/api/admin/store/inventory?")
          ? lateStock
          : { overview: { metrics: {}, stock: [], system: {} } },
      onLogout: async () => {},
    });
    const handler = [...f.listeners.get("click")][0];
    const target = {
      dataset: { adminAction: "stock-list", product: "kingmod", plan: "daily" },
      isConnected: false,
    };
    const action = handler({
      target: { closest: () => target },
      preventDefault() {},
    });
    workspace.unmountWorkspace();
    finishStock({
      items: [{ masked: "OLD-PRIVATE-KEY", status: "available" }],
    });
    await action;
    assert.equal(root.innerHTML, "");
    assert(
      [...f.listeners.values(), ...f.windows.values()].every(
        (set) => set.size === 0,
      ),
    );
  } finally {
    for (const [key, descriptor] of originals)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
  }
});
