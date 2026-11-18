"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict"),
  fs = require("node:fs");
const { browserModule } = require("./helpers/browser-module.cjs");
const modulePromise = browserModule("public/js/app/verification.mjs");
test("the verification form supports one-time-code autofill, numeric entry, errors and a finite timer", async () => {
  const { verificationMarkup, remainingTime } = await modulePromise;
  const now = Date.now();
  const html = verificationMarkup({
    challengeId: "x",
    email: "a***@zentra.invalid",
    delivery: "accepted",
    remainingAttempts: 5,
    expiresAt: now + 300000,
    serverNow: now,
    error: "<script>unsafe</script>",
  });
  assert(html.includes('autocomplete="one-time-code"'));
  assert(html.includes('inputmode="numeric"'));
  assert(html.includes('maxlength="6"'));
  assert(html.includes('id="verification-form"'));
  assert(!html.includes("<script>unsafe</script>"));
  assert(html.includes("&lt;script&gt;unsafe&lt;/script&gt;"));
  assert.equal(remainingTime(now + 300000, now), "5:00");
  assert.equal(remainingTime(now - 1, now), "0:00");
});
test("a consumed code displays a completion control instead of another redemption form", async () => {
  const html = (await modulePromise).verificationMarkup({
    canComplete: true,
    challengeId: "x",
    state: "verified",
  });
  assert(html.includes('data-action="verification-complete"'));
  assert(!html.includes('id="verification-form"'));
});
test("the timer respects the send cooldown, server offset, expiry and in-flight button locks", async () => {
  const { mountVerificationClock } = await modulePromise;
  let now = 1000,
    tick,
    cancelled = false;
  const timer = {},
    resend = { textContent: "", disabled: false, getAttribute: () => null };
  const button = { disabled: true, getAttribute: () => "true" },
    input = { disabled: false, getAttribute: () => null };
  const doc = {
    querySelector: (key) =>
      key === ".verification-panel"
        ? {}
        : key === "#verification-time"
          ? timer
          : key === "#verification-resend"
            ? resend
            : key === "#verification-form"
              ? { querySelectorAll: () => [input, button] }
              : null,
  };
  const stop = mountVerificationClock(
    doc,
    {
      serverNow: 5000,
      expiresAt: 305000,
      resendAt: 65000,
      remainingAttempts: 5,
    },
    {
      clock: () => now,
      schedule: (callback) => {
        tick = callback;
        return 42;
      },
      cancel: (id) => {
        assert.equal(id, 42);
        cancelled = true;
      },
    },
  );
  assert.equal(timer.textContent, "Kalan süre: 5:00");
  assert.equal(resend.disabled, true);
  assert.equal(button.disabled, true);
  now += 61000;
  tick();
  assert.equal(resend.disabled, false);
  assert.equal(button.disabled, true);
  now += 300000;
  tick();
  assert.equal(input.disabled, true);
  assert(timer.textContent.includes("süresi doldu"));
  stop();
  assert.equal(cancelled, true);
});
test("the rollout uses one version of the auth/API singleton and all browser entry points load changed assets", () => {
  const versions = new Set();
  for (const name of ["public/js/app/store.js", "public/js/store/auth.js"]) {
    const imports = [
      ...fs.readFileSync(name, "utf8").matchAll(/api\.js\?v=([^"']+)/g),
    ];
    assert.equal(imports.length, 1, name);
    versions.add(imports[0][1]);
  }
  assert.deepEqual([...versions], [String(Number.parseInt(require("../package.json").version, 10))]);
  assert(
    fs
      .readFileSync("index.html", "utf8")
      .includes("/public/js/app/store.js?v=108"),
  );
  assert(
    fs
      .readFileSync("admin/index.html", "utf8")
      .includes("/admin/portal.js?v=108"),
  );
  assert(
    fs
      .readFileSync("index.html", "utf8")
      .includes("/public/css/verification.css?v=108"),
  );
  assert(
    !fs
      .readFileSync("admin/admin-core.js", "utf8")
      .includes("Ana sayfaya yönlendiriliyorsunuz"),
  );
});
