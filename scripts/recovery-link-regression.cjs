"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { browserModule } = require("./helpers/browser-module.cjs");
test("only one complete fragment recovery token is accepted; request paths never carry the token", async () => {
  const { recoveryToken } = await browserModule("public/js/app/recovery-link.mjs");
  const token = crypto.randomBytes(32).toString("base64url");
  const url = new URL("https://zentra.invalid/sifre-yenile.html");
  url.hash = new URLSearchParams({ recovery: token });
  assert.equal(recoveryToken(url.href), token);
  assert(!url.pathname.includes(token) && !url.search.includes(token));
  for (const value of ["invalid", url.origin, url.origin + "?recovery=" + token, url.origin + "#recovery=short", url.href + "&recovery=" + token])
    assert.equal(recoveryToken(value), "");
});
