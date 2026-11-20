"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { installDevicePolicy } = require("../public/js/app/device.mjs");
const { presentScreen } = require("../public/js/app/motion.mjs");
const {
  productGallery,
  galleryIndex,
} = require("../public/js/app/gallery.mjs");
function target(kind = "span") {
  return {
    kind,
    closest(selector) {
      return selector.split(",").some((x) => x.trim() === kind) ? this : null;
    },
  };
}
function fixture(coarse = true) {
  const listeners = new Map();
  const doc = {
    documentElement: { dataset: {} },
    addEventListener(name, handler) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(handler);
    },
    removeEventListener(name, handler) {
      listeners.get(name)?.delete(handler);
    },
  };
  const view = { matchMedia: () => ({ matches: coarse }) };
  const remove = installDevicePolicy(doc, view);
  function emit(name, extra = {}) {
    const event = {
      target: target(),
      cancelable: true,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      ...extra,
    };
    for (const handler of listeners.get(name) || []) handler(event);
    return event;
  }
  return { doc, view, remove, emit, listeners };
}
test("native one-finger page scrolling is not cancelled", () => {
  const f = fixture();
  assert.equal(f.emit("touchstart", { touches: [{}] }).defaultPrevented, false);
  assert.equal(f.emit("touchmove", { touches: [{}] }).defaultPrevented, false);
  f.remove();
});
test("touch controls suppress accidental selection while readable content, editing and paste remain available", () => {
  const f = fixture();
  for (const name of ["contextmenu", "selectstart", "dblclick"]) {
    assert.equal(
      f.emit(name, { target: target("button") }).defaultPrevented,
      true,
      name,
    );
    assert.equal(f.emit(name).defaultPrevented, false, name);
    assert.equal(
      f.emit(name, { target: target("input") }).defaultPrevented,
      false,
      name,
    );
    assert.equal(
      f.emit(name, { target: target("textarea") }).defaultPrevented,
      false,
      name,
    );
  }
  f.remove();
});
test("pinch and Safari accessibility zoom stay available without programmatically changing page scale", () => {
  const f = fixture();
  assert(!f.emit("touchstart", { touches: [{}, {}] }).defaultPrevented);
  assert(!f.emit("touchmove", { touches: [{}, {}] }).defaultPrevented);
  for (const name of ["gesturestart", "gesturechange", "gestureend"])
    assert(!f.emit(name).defaultPrevented, name);
  assert.equal(
    f.emit("gesturechange", { cancelable: false }).defaultPrevented,
    false,
  );
  f.remove();
});
test("rapid repeated button taps stay actionable and text keeps its native zoom behavior", () => {
  const f = fixture(),
    button = target("button"),
    text = target();
  for (const timeStamp of [100, 240])
    assert.equal(
      f.emit("touchend", {
        target: button,
        timeStamp,
        changedTouches: [{ clientX: 10, clientY: 10 }],
      }).defaultPrevented,
      false,
    );
  assert.equal(
    f.emit("touchend", {
      target: text,
      timeStamp: 500,
      changedTouches: [{ clientX: 10, clientY: 10 }],
    }).defaultPrevented,
    false,
  );
  assert.equal(
    f.emit("touchend", {
      target: text,
      timeStamp: 680,
      changedTouches: [{ clientX: 12, clientY: 10 }],
    }).defaultPrevented,
    false,
  );
  f.remove();
});
test("desktop mouse selection remains available after switching back from touch input", () => {
  const f = fixture(false);
  assert.equal(f.emit("contextmenu").defaultPrevented, false);
  f.emit("pointerdown", { pointerType: "touch" });
  assert(f.emit("selectstart", { target: target("button") }).defaultPrevented);
  f.emit("pointerdown", { pointerType: "mouse" });
  assert.equal(f.emit("selectstart").defaultPrevented, false);
  f.remove();
});
test("device policy installation is idempotent and removes all listeners cleanly", () => {
  const f = fixture();
  assert.equal(installDevicePolicy(f.doc, f.view), f.remove);
  assert.equal(f.listeners.get("touchstart").size, 1);
  f.remove();
  assert([...f.listeners.values()].every((x) => x.size === 0));
});
function screen({ reduced = false, native = false } = {}) {
  const callbacks = [];
  const classes = new Set();
  const doc = {
    visibilityState: "visible",
    defaultView: {
      matchMedia: () => ({ matches: reduced }),
      requestAnimationFrame: (fn) => fn(),
    },
  };
  if (native)
    doc.startViewTransition = (callback) => {
      let resolve;
      const done = new Promise((r) => {
        resolve = r;
      });
      callbacks.push(() => {
        callback();
        resolve();
      });
      return { updateCallbackDone: done, finished: done, skipTransition() {} };
    };
  return {
    element: {
      ownerDocument: doc,
      isConnected: true,
      innerHTML: "previous",
      classList: {
        remove: (x) => classes.delete(x),
        add: (x) => classes.add(x),
      },
    },
    callbacks,
    classes,
    doc,
  };
}
test("reduced motion renders immediately without starting a transition", async () => {
  const f = screen({ reduced: true, native: true });
  assert.equal(await presentScreen(f.element, "new"), true);
  assert.equal(f.element.innerHTML, "new");
  assert.equal(f.callbacks.length, 0);
  assert.equal(f.classes.size, 0);
});
test("a stale presentation cannot overwrite a newer route or a changed account view", async () => {
  const f = screen({ native: true });
  const old = presentScreen(f.element, "old private view");
  const next = presentScreen(f.element, "current view");
  assert.deepEqual(await Promise.all([old, next]), [false, true]);
  assert.equal(f.element.innerHTML, "current view");
  let current = true;
  const late = presentScreen(f.element, "private response", {
    isCurrent: () => current,
  });
  current = false;
  assert.equal(await late, false);
  assert.equal(f.element.innerHTML, "current view");
});
test("unsupported animation keeps content functional without capturing the document or its private dialogs", async () => {
  const f = screen({ native: true });
  f.element.animate = () => {
    throw Error("unsupported");
  };
  await presentScreen(f.element, "still functional");
  assert.equal(f.element.innerHTML, "still functional");
  assert.equal(f.callbacks.length, 0);
});
test("new navigation cancels an earlier local animation and respects the saved reduced-motion preference", async () => {
  const f = screen();
  let cancelled = 0,
    animated = 0;
  f.element.animate = () => {
    animated++;
    return {
      cancel() {
        cancelled++;
      },
      finished: new Promise(() => {}),
    };
  };
  await presentScreen(f.element, "first");
  await presentScreen(f.element, "second");
  assert.equal(animated, 2);
  assert.equal(cancelled, 1);
  f.doc.documentElement = { dataset: { motion: "reduce" } };
  await presentScreen(f.element, "reduced");
  assert.equal(animated, 2);
});
test("product galleries use only the supplied product images and preserve the current catalog cover", () => {
  const catalog = require("../public/data/store-products.json");
  for (const p of catalog.products) {
    const pictures = productGallery(p);
    assert.equal(pictures[0].src, p.image);
    for (const image of pictures) {
      if (image.src.startsWith("/"))
        assert(fs.existsSync(path.join(__dirname, "..", image.src)));
      assert(image.alt.includes(p.name));
    }
  }
  assert.equal(
    productGallery({
      id: "kingmod",
      name: "KİNGMOD",
      image: "/public/assets/products/kingmod.jpeg",
    }).length,
    10,
  );
  assert.equal(
    productGallery({ id: "unknown-product", name: "Unknown" }).length,
    1,
  );
});
test("gallery URLs cannot inject script, credentials, traversal or an untrusted provider", () => {
  for (const image of [
    "javascript:alert(1)",
    "/public/assets/../private.png",
    "https://attacker.test/image.png",
    "https://user:pass@firebasestorage.googleapis.com/image",
    "data:image/svg+xml,<svg/>",
  ])
    assert.equal(
      productGallery({ image })[0].src,
      "/public/assets/images/zentra-mark.webp",
    );
  assert.equal(galleryIndex(-1, 10), 9);
  assert.equal(galleryIndex(11, 10), 1);
  assert.equal(galleryIndex(NaN, 0), 0);
});
test("all brand placements use the supplied original logo assets", () => {
  for (const file of [
    "index.html",
    "admin/index.html",
    "admin/portal.js",
    "admin/workspace.js",
    "public/js/app/ui.js",
  ]) {
    const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    assert(!source.includes("brand-mark"), file);
  }
  const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
  assert(html.includes("/public/assets/images/apple-touch-icon.png"));
  assert(!html.includes('class="hero"'));
  for (const id of [
    "search-form",
    "search-input",
    "main",
    "cart-count",
    "mobile-cart-count",
    "footer-social",
    "toasts",
  ])
    assert(html.includes(`id="${id}"`), id);
});
