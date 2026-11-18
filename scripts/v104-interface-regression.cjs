"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict");
const { createToastQueue } = require("../public/js/app/toast-center.mjs");
const {
  createActivity,
  loadingCards,
  createHistoryScroll,
} = require("../public/js/app/activity.mjs");
const fs = require("node:fs"),
  path = require("node:path");
test("toast queue limits visible messages, deduplicates and preserves serious errors until dismissal", () => {
  let visible,
    next = 0;
  const timers = new Map();
  const q = createToastQueue({
    change: (v) => (visible = v),
    schedule: (fn) => {
      timers.set(++next, fn);
      return next;
    },
    cancel: (id) => timers.delete(id),
  });
  const error = q.push({ type: "error", message: "Veri kaydı doğrulanamadı." });
  q.push({ type: "error", message: "Veri kaydı doğrulanamadı." });
  assert.equal(visible.length, 1);
  assert.equal(visible[0].count, 2);
  assert.equal(timers.size, 0);
  q.push({ type: "success", message: "Kaydedildi" });
  q.push({ type: "warning", message: "Paket seç" });
  const uncertain = q.push({ type: "uncertain", message: "Sonucu kontrol et" });
  assert.equal(visible.length, 3);
  assert(!visible.some((v) => v.id === uncertain));
  q.remove(error);
  assert.equal(visible.length, 3);
  assert(visible.some((v) => v.id === uncertain && v.persistent));
  for (const callback of [...timers.values()]) callback();
  assert.equal(visible.length, 1);
  assert.equal(visible[0].id, uncertain);
  q.clear();
  assert.deepEqual(visible, []);
  assert.equal(timers.size, 0);
});
test("ending or cancelling an old load cannot clear a newer live request indicator", () => {
  const attributes = new Map(),
    classes = new Set(),
    status = {};
  const activity = createActivity({
    target: {
      setAttribute: (k, v) => attributes.set(k, v),
      removeAttribute: (k) => attributes.delete(k),
    },
    indicator: {
      classList: {
        add: (k) => classes.add(k),
        remove: (k) => classes.delete(k),
      },
    },
    status,
  });
  const first = activity.begin("Siparişlerin yükleniyor"),
    second = activity.begin("Bildirimlerin yükleniyor");
  first();
  assert.equal(attributes.get("aria-busy"), "true");
  assert(classes.has("active"));
  assert.equal(status.textContent, "Bildirimlerin yükleniyor");
  second();
  assert(!attributes.has("aria-busy"));
  assert.equal(status.hidden, true);
  const pending = activity.begin();
  activity.cancel();
  pending();
  assert(!classes.has("active"));
  assert(!loadingCards("<img onerror=alert(1)>").includes("<img"));
});
test("navigation retains the browser entry scroll position without sharing private account data", () => {
  const events = {},
    states = [],
    view = {
      scrollY: 460,
      history: {
        state: { other: "kept" },
        scrollRestoration: "auto",
        replaceState(state) {
          this.state = state;
        },
        pushState(state, _, url) {
          states.push({ state, url });
          this.state = state;
        },
      },
      addEventListener: (n, f) => (events[n] = f),
      removeEventListener: (n) => delete events[n],
      requestAnimationFrame: (f) => {
        f();
        return 1;
      },
      cancelAnimationFrame() {},
      scrollTo(value) {
        this.scrollY = value.top;
      },
    };
  const history = createHistoryScroll(view);
  history.push("/magaza?kategori=ios");
  assert.equal(states[0].url, "/magaza?kategori=ios");
  assert.equal(states[0].state.zentraScroll, 0);
  history.restore(460);
  assert.equal(view.scrollY, 460);
  assert.equal(view.history.scrollRestoration, "manual");
  history.dispose();
  assert.equal(events.scroll, undefined);
});
test("all source HTML and generated HTML templates preserve safe areas and allow user zoom", () => {
  const root = path.resolve(__dirname, "..");
  const standard = /content="width=device-width, initial-scale=1, viewport-fit=cover"/;
  for (const file of [
    "index.html",
    "admin/index.html",
    "404.html",
    "offline.html",
    "unavailable.html",
    "server.js",
    "server/email/templates.js",
    "server/email/verification.js",
    "server/email/recovery.js",
    "server/email/routes.js",
    "scripts/dev.cjs",
  ]) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    const metas = [...source.matchAll(/<meta\b[^>]*name="viewport"[^>]*>/g)];
    assert(metas.length > 0, file);
    for (const [meta] of metas)
      assert(standard.test(meta), file);
    if (file.endsWith(".html")) assert.equal(metas.length, 1, file);
  }
});
test("status colours meet normal text contrast against their actual toast backgrounds", () => {
  const luminance = (hex) => {
    const v = hex
      .match(/\w\w/g)
      .map((x) => parseInt(x, 16) / 255)
      .map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
    return v[0] * 0.2126 + v[1] * 0.7152 + v[2] * 0.0722;
  };
  for (const [bg, fg] of [
    ["176c49", "ffffff"],
    ["b0213c", "ffffff"],
    ["ffda70", "3d2d08"],
    ["086578", "ffffff"],
  ]) {
    const a = luminance(bg),
      b = luminance(fg);
    assert((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) >= 4.5);
  }
});
