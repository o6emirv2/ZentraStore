"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  environmentFixture: configuration,
} = require("./helpers/environment-fixture.cjs");
test("explicit configuration placeholders remain rejected", () => {
  const env = configuration();
  for (const value of [
    "",
    "<FIREBASE_KEY>",
    "REPLACE_ME",
    "change_me",
    "YOUR_API_KEY",
    "example-project",
    "BURAYA_TOKEN",
    "mevcut_anahtar",
  ])
    assert.equal(env.isPlaceholder(value), true, value);
  assert.equal(env.strongSecret("YOUR_API_KEY".repeat(8)), false);
});
test("legitimate opaque credentials are not rejected for an incidental word inside their encoded value", () => {
  const env = configuration();
  const opaque =
    "hK98QmLr7vyourFxT65uVwP2B8e9R4bS0nZxAqJc3HdG5s7WpYk9NfM2x8LaD4vQ";
  assert.equal(env.isPlaceholder(opaque), false);
  assert.equal(env.strongSecret(opaque), true);
  assert.equal(env.isPlaceholder("zentra-yourshop-live"), false);
});
test("structured Firebase credentials preserve valid nested values and still reject placeholder client keys", () => {
  const pair = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const service = {
    type: "service_account",
    project_id: "zentra-regression",
    client_email: "yourshop@zentra-regression.iam.gserviceaccount.com",
    private_key: pair.privateKey.export({ type: "pkcs8", format: "pem" }),
  };
  const publicConfig = {
    apiKey: "AIzaSyA7yourR4t2U8i6O0p9Q3w5E1z8X6c4V2b",
    authDomain: "zentra-regression.firebaseapp.com",
    projectId: "zentra-regression",
    appId: "1:100:web:config-regression",
  };
  const env = configuration({
    FIREBASE_KEY: JSON.stringify(service),
    PUBLIC_FIREBASE_CONFIG: JSON.stringify(publicConfig),
  });
  assert.equal(env.configurationReport().serviceAccountReady, true);
  assert.equal(env.firebase.publicConfig.apiKey, publicConfig.apiKey);
  const invalid = configuration({
    FIREBASE_KEY: JSON.stringify(service),
    PUBLIC_FIREBASE_CONFIG: JSON.stringify({
      ...publicConfig,
      apiKey: "YOUR_API_KEY",
    }),
  });
  assert(
    invalid.configurationReport().missing.includes("PUBLIC_FIREBASE_API_KEY"),
  );
});
