"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict");
const { browserModule } = require("./helpers/browser-module.cjs");
test("the original admin's thirteen sections stay distinct while legacy links resolve to current modules", async () => {
  const { primaryViews, adminNavigation, resolveView } =
    await browserModule("admin/layout.mjs");
  assert.deepEqual(
    primaryViews.map((x) => x[0]),
    [
      "overview",
      "orders",
      "inventory",
      "products",
      "users",
      "wallet",
      "content",
      "links",
      "coupons",
      "promocodes",
      "staff",
      "audit",
      "security",
    ],
  );
  assert.equal(resolveView("#panel/settings")[0], "content");
  assert.equal(resolveView("#panel/promotions")[0], "coupons");
  assert.equal(resolveView("#panel/unknown")[0], "overview");
  const html = adminNavigation(
    { permissions: ["store.orders.read"] },
    "orders",
  );
  assert(html.includes('href="#panel/orders"'));
  assert(!html.includes('href="#panel/wallet"'));
  assert(html.includes('aria-current="page"'));
});
test("the new registration sheet retains mandatory profile and OTP fields without unconfigured provider login buttons", async () => {
  const { authPanel } = await browserModule("public/js/app/auth-panel.mjs");
  const html = authPanel({ auth: {}, mode: "register" });
  for (const name of [
    "firstName",
    "lastName",
    "username",
    "birthDate",
    "email",
    "password",
    "passwordRepeat",
  ])
    assert(html.includes(`name="${name}"`));
  assert(html.includes("Doğrulama kodu gönder"));
  assert(!html.includes("Google ile"));
  assert(!html.includes("Telegram ile"));
  assert(html.includes('id="auth-sheet"'));
  const login = authPanel({ auth: {} });
  assert(login.includes('minlength="1"'));
  assert(html.includes('minlength="8"'));
});
test("shared formatting handles invalid timestamps and refuses image path traversal or credential-bearing URLs", async () => {
  const { date, safeImage } = await browserModule("public/js/app/ui.js");
  assert.equal(date("not a date"), "—");
  assert.equal(date(Infinity), "—");
  const fallback = "/public/assets/images/zentra-mark.webp";
  for (const input of [
    "/public/assets/../../server.js",
    "javascript:alert(1)",
    "https://firebasestorage.googleapis.com@evil.invalid/a",
    "https://name:secret@firebasestorage.googleapis.com/file",
    null,
  ])
    assert.equal(safeImage(input), fallback);
  assert.equal(
    safeImage("/public/assets/products/real.webp"),
    "/public/assets/products/real.webp",
  );
});
test("wallet activity cards escape customer input and preserve financial transaction references", async () => {
  const { ledgerView } = await browserModule("admin/wallet-view.mjs");
  const html = ledgerView([
    {
      amountKurus: 12345,
      balanceBeforeKurus: 0,
      balanceAfterKurus: 12345,
      reason: "<script>x</script>",
      transactionId: "real-reference",
      createdAt: Date.now(),
    },
  ]);
  assert(!html.includes("<script>"));
  assert(html.includes("real-reference"));
  assert(html.includes("123,45"));
  assert(html.includes("Sonraki bakiye"));
});
