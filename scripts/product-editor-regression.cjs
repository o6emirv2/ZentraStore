"use strict";
const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const { browserModule } = require("./helpers/browser-module.cjs");
let editor, model, profiles;
before(async () => {
  global.document = { documentElement: { lang: "tr" } };
  editor = await browserModule("admin/product-editor.mjs");
  model = await import("../admin/product-model.mjs");
  profiles = await browserModule("public/js/app/community-profile.mjs");
});
const product = { id: "test-product", name: "Test Ürünü", description: "Ürün açıklaması", image: "/public/assets/products/example.png", plans: [{ key: "weekly", label: "Haftalık", duration: "7 Gün", priceKurus: 30050 }], sortOrder: 27, features: ["Özellik"], fulfillmentMode: "automatic" };
test("both forms expose the stored product order and the requested fields without crossing create/edit responsibilities", () => {
  const edit = editor.productEditorBody(product), create = editor.productEditorBody();
  for (const value of [edit, create]) for (const name of ["name", "description", "image", "features", "badgeKey", "price", "sortOrder", "featured"])
    assert(value.includes('name="' + name + '"'), name);
  assert(edit.includes('name="sortOrder" type="number" value="27"'));
  for (const name of ["active", "archived", "automaticEnabled", "telegramEnabled"]) assert(edit.includes('name="' + name + '"'));
  for (const name of ["id", "categoryKey", "fulfillmentMode", "inventoryType", "planKey"]) {
    assert(create.includes('name="' + name + '"'), name);
    assert(!edit.includes('name="' + name + '"'), name);
  }
  assert(!edit.includes("actionPassword"));
  assert.match(editor.productEditorBody({ ...product, name: '"><img src=x onerror=alert(1)>' }), /&lt;img/);
});
test("money uses exact minor units and order accepts only bounded integers including zero", () => {
  for (const [raw, cents] of [["300,50", 30050], ["0.29", 29], ["1000000", 100000000], ["0.01", 1]]) assert.equal(model.productPrice(raw), cents);
  for (const raw of ["", "1e3", "-1", "0", "1.999", "1,000,50", "1000000.01"]) assert.throws(() => model.productPrice(raw));
  assert.equal(model.productSortOrder("0"), 0);
  for (const raw of ["", "-1", "1.5", "10001", "1e3"]) assert.throws(() => model.productSortOrder(raw));
});
test("temporarily disabling automatic sales does not turn a normal product into an immutable Telegram-only product", () => {
  const editable = editor.productEditorBody({ ...product, fulfillmentMode: "telegram_only", immutableFulfillment: false, automaticEnabled: false });
  assert.match(editable, /name="automaticEnabled"\s*\/?>/);
  const fixed = editor.productEditorBody({ ...product, fulfillmentMode: "telegram_only", immutableFulfillment: true });
  assert.match(fixed, /name="automaticEnabled"[^>]*disabled/);
  assert.match(fixed, /name="telegramEnabled"[^>]*checked[^>]*disabled/);
});
test("duplicate package keys fail and editing preserves immutable keys and disabled plan state", () => {
  const row = { key: "monthly", label: "Aylık", duration: "30 Gün", price: "129,99" };
  assert.throws(() => model.productPlans([row, row], { creating: true }));
  const [result] = model.productPlans([row], { previous: [{ key: "weekly", active: false }] });
  assert.equal(result.key, "weekly"); assert.equal(result.active, false); assert.equal(result.priceKurus, 12999);
});
test("community avatars use only the approved profile host and never turn guest or malicious content into identity", () => {
  const good = { kind: "member", username: "real_user", avatarUrl: "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcExample&s=10" };
  assert.equal(profiles.profileLabel(good), "@real_user");
  assert.match(profiles.profileAvatar(good), /<img data-community-avatar/);
  for (const avatarUrl of ["javascript:alert(1)", "https://attacker.invalid/image.png", "https://encrypted-tbn0.gstatic.com.attacker.invalid/images?q=x"]) assert(!profiles.profileAvatar({ ...good, avatarUrl }).includes("<img"));
  assert.equal(profiles.profileLabel({ kind: "guest", username: "forged" }), "Misafir");
  assert.equal(profiles.profileLabel({ kind: "member", username: "private@example.test" }), "Zentra üyesi");
  assert(!profiles.likerRow({ profile: { kind: "member", username: '"><img src=x>' } }).includes("<img"));
});
