"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path");
const {
  CATEGORY_PRESETS,
  normalizeCategoryVisibility,
} = require("../public/js/store/catalog-schema.mjs");
const root = path.resolve(__dirname, "..");
test("standard categories retain platform/game relationships and independent visibility", () => {
  for (const [id, c] of Object.entries(CATEGORY_PRESETS)) {
    if (["gbox-iphone","gbox-ipad"].includes(id)) { assert.equal(c.game,"gbox"); assert.equal(c.platform,"ios"); }
    else assert.equal(id, c.game + "-" + c.platform);
  }
  const flags = normalizeCategoryVisibility({ "pubg-ios": false, ios: true });
  assert.equal(flags["pubg-ios"], false);
  assert.equal(flags.ios, true);
  assert.equal(flags.android, true);
});
test("unsupported category visibility is rejected at the API boundary", () => {
  const { validateApiBody } = require("../server/core/apiContracts");
  assert.equal(
    validateApiBody("PATCH", "/api/admin/store/content", {
      categoryVisibility: { unknown: true },
    }),
    false,
  );
  assert.equal(
    validateApiBody("PATCH", "/api/admin/store/content", {
      categoryVisibility: { "pubg-ios": false },
    }),
    true,
  );
});
test("store and admin pages keep their original scale and allow zoom with safe areas", () => {
  for (const name of ["index.html", "admin/index.html"]) {
    const html = fs.readFileSync(path.join(root, name), "utf8");
    const content =
      /<meta\b(?=[^>]*\bname="viewport")[^>]*\bcontent="([^"]+)"/.exec(html)[1];
    assert(content.includes("width=device-width"));
    assert.match(content, /^width=device-width, initial-scale=0\.8, viewport-fit=cover$/);
    assert(content.includes("viewport-fit=cover"));
    assert(!content.includes("maximum-scale=1"));
    assert(!content.includes("user-scalable=no"));
  }
});
test("new storefront and portal load only the current presentation entry points", () => {
  const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
  assert(read("index.html").includes("/script.js?v=109"));
  assert(read("store-pages.html").includes("/public/js/app/store.js?v=109"));
  assert(read("admin/index.html").includes("admin-entry.js?v=109"));
  assert(!read("index.html").includes("/public/js/app/store.js"));
  assert(!read("admin/index.html").includes("portal.js"));
});
