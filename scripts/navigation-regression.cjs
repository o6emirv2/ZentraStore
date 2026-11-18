"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  navigationModel,
  authMode,
  authPath,
  safeReturnTo,
  syncNavigation,
  measureHeader,
} = require("../public/js/app/navigation.mjs");
test("guests receive exactly two header actions and four bottom destinations", () => {
  const nav = navigationModel();
  assert.deepEqual(nav.header, ["login", "register"]);
  assert.deepEqual(nav.bottom, ["home", "products", "login", "register"]);
  assert.equal(nav.active, "home");
  assert.deepEqual(navigationModel({ signedIn: "true" }).header, nav.header);
});
test("signed-in users receive the profile and cart header plus five bottom destinations", () => {
  const nav = navigationModel({ signedIn: true, pathname: "/siparisler" });
  assert.deepEqual(nav.header, ["account", "cart"]);
  assert.deepEqual(nav.bottom, [
    "home",
    "products",
    "cart",
    "orders",
    "account",
  ]);
  assert.equal(nav.active, "orders");
});
test("direct registration links, tab switching and browser URLs resolve the correct auth view", () => {
  assert.equal(authMode("?islem=kayit"), "register");
  assert.equal(authMode("?islem=giris"), "login");
  assert.equal(authMode("?islem=unknown"), "login");
  assert.equal(
    navigationModel({ pathname: "/hesabim", search: "?islem=kayit" }).active,
    "register",
  );
  assert.equal(
    navigationModel({ pathname: "/hesabim", search: "?islem=giris" }).active,
    "login",
  );
  assert.equal(
    navigationModel({
      signedIn: true,
      pathname: "/hesabim",
      search: "?islem=kayit",
    }).active,
    "account",
  );
});
test("product and category navigation retain their products selection while protected areas select the account", () => {
  for (const pathname of ["/magaza", "/kategori/android", "/urun/kingmod"])
    assert.equal(
      navigationModel({ signedIn: true, pathname }).active,
      "products",
    );
  assert.equal(
    navigationModel({ signedIn: true, pathname: "/kuponlar" }).active,
    "account",
  );
  assert.equal(
    navigationModel({ signedIn: true, pathname: "/sepet" }).active,
    "cart",
  );
});
test("checkout return destinations survive login and registration without accepting external redirects", () => {
  for (const mode of ["login", "register"]) {
    const u = new URL(authPath(mode, "/sepet"), "https://zentra.invalid");
    assert.equal(u.searchParams.get("next"), "/sepet");
    assert.equal(authMode(u.search), mode);
  }
  for (const value of [
    "https://evil.test/",
    "//evil.test/",
    "/\\evil.test/",
    "/%2f%2fevil.test/",
    "/admin/",
    "/api/store/account",
    "/sepet\n",
    "javascript:alert(1)",
  ])
    assert.equal(safeReturnTo(value), "", value);
  assert.equal(safeReturnTo("/magaza?q=kingmod"), "/magaza?q=kingmod");
  assert.equal(
    safeReturnTo("/hesabim?islem=kayit&next=https://evil.test"),
    "/hesabim",
  );
});
function link(key) {
  const attrs = {};
  const classes = new Set();
  return {
    dataset: { storeNav: key },
    attrs,
    classes,
    classList: {
      toggle(k, v) {
        v ? classes.add(k) : classes.delete(k);
      },
    },
    setAttribute(k, v) {
      attrs[k] = v;
    },
    removeAttribute(k) {
      delete attrs[k];
    },
  };
}
test("DOM navigation swaps entire session groups and resets active markers and cart labels on logout", () => {
  const groups = [
      { dataset: { sessionVisible: "guest" } },
      { dataset: { sessionVisible: "signed" } },
    ],
    nav = { dataset: {} },
    links = [link("login"), link("register"), link("cart"), link("account")],
    counts = [{}, {}];
  const doc = {
    querySelector: () => nav,
    querySelectorAll: (q) =>
      q === "[data-session-visible]"
        ? groups
        : q === "[data-store-nav]"
          ? links
          : q === "[data-cart-count]"
            ? counts
            : [links[2]],
  };
  syncNavigation(doc, { signedIn: true, pathname: "/sepet", cartCount: 4 });
  assert.equal(groups[0].hidden, true);
  assert.equal(groups[1].hidden, false);
  assert.equal(links[2].attrs["aria-current"], "page");
  assert.equal(counts[0].textContent, "4");
  syncNavigation(doc, {
    signedIn: false,
    pathname: "/hesabim",
    search: "?islem=kayit",
    cartCount: 0,
  });
  assert.equal(groups[0].hidden, false);
  assert.equal(groups[1].hidden, true);
  assert.equal(nav.dataset.session, "guest");
  assert.equal(links[2].attrs["aria-current"], undefined);
  assert.equal(links[1].attrs["aria-current"], "page");
  assert.equal(counts[0].textContent, "0");
});
test("sticky-header measurement follows real layout changes and releases its observer", () => {
  let height = 160,
    callback,
    disconnected = false;
  const values = {};
  const header = { getBoundingClientRect: () => ({ height }) };
  const doc = {
    querySelector: () => header,
    documentElement: {
      style: {
        setProperty: (k, v) => {
          values[k] = v;
        },
      },
    },
  };
  const dispose = measureHeader(doc, {
    ResizeObserver: class {
      constructor(fn) {
        callback = fn;
      }
      observe(node) {
        assert.equal(node, header);
      }
      disconnect() {
        disconnected = true;
      }
    },
  });
  assert.equal(values["--store-header-height"], "160px");
  height = 184.2;
  callback();
  assert.equal(values["--store-header-height"], "185px");
  dispose();
  assert(disconnected);
});
test("both removed marketing components and caption styles are absent from active presentation", () => {
  const root = path.resolve(__dirname, "..");
  for (const name of [
    "index.html",
    "public/js/app/store.js",
    "public/js/app/ui.js",
    "public/css/zentra.css",
    "server/core/storefrontSeo.js",
  ]) {
    const source = fs.readFileSync(path.join(root, name), "utf8");
    for (const text of [
      "auth-visual",
      "home-hero-template",
      "hero-copy",
      "Senin için<br/>yeni bir başlangıç.",
      "DİJİTAL ÜRÜN MAĞAZASI",
    ])
      assert(!source.includes(text), name + ": " + text);
  }
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert(html.includes("/public/assets/images/apple-touch-icon.png"));
  assert(html.includes("brand-wordmark"));
});
