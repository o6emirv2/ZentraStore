"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { applicationFixture } = require("./helpers/application-fixture.cjs");
const { browserModule } = require("./helpers/browser-module.cjs");
let f;
before(async () => { f = await applicationFixture(); });
after(async () => f?.close());
test("a reset screen can obtain App Check without initializing customer authentication or a session", async () => {
  const prior = { window: global.window, document: global.document, sdk: global.__recoverySdk };
  let initialized = 0, tokens = 0;
  const app = { name: "zentra-store" };
  global.window = { location: { origin: f.origin, href: f.origin + "/sifre-yenile.html", protocol: "http:" },
    dispatchEvent() {}, setTimeout, clearTimeout };
  global.document = { querySelector: () => ({ content: f.origin }) };
  global.__recoverySdk = {
    app: { getApps: () => [app], initializeApp: () => app },
    integrity: {
      ReCaptchaEnterpriseProvider: class {},
      initializeAppCheck: () => { initialized++; return {}; },
      getToken: async () => { tokens++; return { token: "fixture-appcheck" }; },
    },
  };
  try {
    const module = await browserModule("public/js/store/auth.js", {
      "import(FIREBASE_APP_URL)": "Promise.resolve(globalThis.__recoverySdk.app)",
      "import(FIREBASE_AUTH_URL)": "Promise.reject(new Error('Authentication SDK must not load for recovery integrity'))",
      "import(FIREBASE_APP_CHECK_URL)": "Promise.resolve(globalThis.__recoverySdk.integrity)",
    });
    const first = await module.initStoreIntegrity();
    assert.equal(first.appCheck.mode, "enforce");
    await module.initStoreIntegrity();
    assert.equal(initialized, 1);
    assert.equal(module.getStoreAuthSnapshot().user, null);
    assert.equal(tokens, 0);
    assert(![...f.db.records.keys()].some((key) => key.startsWith("storeUserSessions/")));
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      const name = key === "sdk" ? "__recoverySdk" : key;
      if (value === undefined) delete global[name]; else global[name] = value;
    }
  }
});
