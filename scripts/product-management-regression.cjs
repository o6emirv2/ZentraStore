"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { applicationFixture } = require("./helpers/application-fixture.cjs");
let f, session, product, created;
const proof = (path, method, body, extra = {}) => f.request("/api/admin/action-proof", {
  ...session, method: "POST", body: { path, method, bodyHash: crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex"), ...extra },
});
const update = async (body, token) => f.request("/api/admin/store/products/" + product.id, {
  ...session, method: "PATCH", body, ...(token ? { headers: { "x-admin-action": token } } : {}),
});
before(async () => {
  f = await applicationFixture();
  session = await f.openAdmin();
  product = (await f.request("/api/store/catalog")).body.catalog.products[0];
  created = { id: "v106-product-test", name: "Yeni Ürün Testi", description: "Gerçek servis kabul kontrolü için ürün açıklaması.",
    categoryKey: "pubg-android", platform: "android", game: "pubg", inventoryType: "license", fulfillmentMode: "automatic",
    image: product.image, features: ["Test özelliği"], badgeKey: "premium", sortOrder: 7, featured: true,
    plans: [{ key: "monthly", label: "Aylık", duration: "30 gün", priceKurus: 12345 }] };
});
after(async () => f?.close());

test("the actual HTTP server serves every extracted product module as executable JavaScript", async () => {
  for (const module of ["product-editor", "product-model", "product-policy", "product-view"]) {
    const response = await fetch(f.origin + "/admin/" + module + ".mjs?v=109");
    assert.equal(response.status, 200, module);
    assert.match(response.headers.get("content-type"), /(?:java|ecma)script/);
    assert.match(await response.text(), /export /);
  }
});

test("product editing works after the password reauthentication window while keeping gate and body-bound proof", async () => {
  const now = Date.now;
  try {
    Date.now = () => now() + 240000;
    const path = "/api/admin/store/products/" + product.id, body = { sortOrder: 12, featured: true };
    assert.equal((await update(body)).status, 401);
    const issued = await proof(path, "PATCH", body);
    assert.equal(issued.status, 200, JSON.stringify(issued.body));
    const saved = await update(body, issued.body.proof.token);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.product.sortOrder, 12);
    assert.equal(saved.body.product.featured, true);
    assert.equal((await update(body, issued.body.proof.token)).status, 409);
    assert.equal((await proof("/api/admin/store/products", "POST", created)).status, 401);
    assert.equal((await proof("/api/admin/store/wallet/adjust", "POST", { amountKurus: 100 })).status, 401);
  } finally { Date.now = now; }
});

test("editing cannot bypass an absent gate, an unrelated account, exact body binding or role permission", async () => {
  const path = "/api/admin/store/products/" + product.id, body = { sortOrder: 16 };
  const issued = await proof(path, "PATCH", body);
  assert.equal(issued.status, 200);
  assert.equal((await update({ sortOrder: 17 }, issued.body.proof.token)).status, 409);
  const input = { method: "PATCH", path, bodyHash: crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex") };
  for (const credentials of [{ uid: "member" }, { token: session.token }, { ...session, cookie: "invalid-cookie" }]) {
    const response = await f.request("/api/admin/action-proof", { ...credentials, method: "POST", body: input });
    assert([401, 403].includes(response.status), JSON.stringify(response.body));
  }
  assert.equal((await update(body, issued.body.proof.token)).status, 200);
});

test("a valid server cookie and admin gate can edit without a password but cannot authorize a financial operation", async () => {
  const cookie = await f.auth.createSessionCookie(session.token, { expiresIn: 3600000 });
  const cookieName = require("../server/core/userSessionService").COOKIE_NAME;
  const credentials = { cookie: session.cookie + "; " + cookieName + "=" + cookie };
  const path = "/api/admin/store/products/" + product.id, body = { sortOrder: 12 };
  const issued = await f.request("/api/admin/action-proof", { ...credentials, method: "POST", body: {
    path, method: "PATCH", bodyHash: crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex"),
  } });
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  const saved = await f.request(path, { ...credentials, method: "PATCH", body, headers: { "x-admin-action": issued.body.proof.token } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const finance = await f.request("/api/admin/action-proof", { ...credentials, method: "POST", body: {
    path: "/api/admin/store/wallet/adjust", method: "POST", bodyHash: crypto.createHash("sha256").update("{}").digest("hex"),
  } });
  assert.equal(finance.status, 401);
});

test("new product creation still requires the current password and persists its explicit order", async () => {
  const path = "/api/admin/store/products";
  assert.equal((await proof(path, "POST", created)).status, 401);
  assert.equal((await proof(path, "POST", created, { password: "incorrect-password" })).status, 403);
  const saved = await f.adminWrite(session, path, "POST", created);
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.equal(saved.body.product.sortOrder, 7);
  assert.equal(saved.body.product.plans[0].priceKurus, 12345);
  const catalog = (await f.request("/api/store/catalog")).body.catalog;
  assert(catalog.products.findIndex(p => p.id === created.id) < catalog.products.findIndex(p => p.id === product.id));
  assert.equal(f.db.records.get("storefrontSettings/main").catalog.customProducts[created.id].sortOrder, 7);
});

test("invalid creation and update order values are rejected without changing the catalog", async () => {
  const service = require("../server/core/storeCatalogService"), creator = require("../server/core/storeProductCreation");
  for (const sortOrder of [-1, 10001, 1.5, "2", null]) {
    assert.throws(() => creator.normalizeCreatedProduct({ ...created, sortOrder }), { code: "STORE_PRODUCT_SORT_INVALID" });
    const before = structuredClone(f.db.records.get("storefrontSettings/main"));
    const response = await f.adminWrite(session, "/api/admin/store/products/" + product.id, "PATCH", { sortOrder });
    assert.equal(response.status, 400);
    assert.deepEqual(f.db.records.get("storefrontSettings/main"), before);
  }
  await service.updateProductSettings(created.id, { sortOrder: 0 }, { uid: "owneruid" });
  assert.equal((await service.getEffectiveCatalog({ fresh: true })).products.find(p => p.id === created.id).sortOrder, 0);
});
