"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  crypto = require("node:crypto"),
  { spawnSync } = require("node:child_process");
const { testEnvironment, runTests } = require("./run-tests.cjs");
test("test environment keeps OS essentials while excluding known and future application secrets", () => {
  const parent = {
    PATH: process.env.PATH,
    LANG: "C.UTF-8",
    TZ: "Europe/Istanbul",
    NODE_ENV: "production",
    FIREBASE_KEY: "private-service-account",
    RESEND_API_KEY: "private-mail-key",
    ADMIN_TOTP_SECRET_BASE32: "private-totp",
    STORE_KEY_ENCRYPTION_SECRET: "private-vault",
    NEW_PROVIDER_SECRET: "unknown-future-key",
    NODE_OPTIONS: "unsafe inherited option",
    PORT: "10000",
    RENDER: "true",
  };
  const copy = structuredClone(parent),
    result = testEnvironment(parent);
  assert.equal(result.NODE_ENV, "test");
  assert.equal(result.TZ, "UTC");
  assert.equal(result.PATH, parent.PATH);
  assert.equal(result.LANG, parent.LANG);
  for (const key of [
    "FIREBASE_KEY",
    "RESEND_API_KEY",
    "ADMIN_TOTP_SECRET_BASE32",
    "STORE_KEY_ENCRYPTION_SECRET",
    "NEW_PROVIDER_SECRET",
    "NODE_OPTIONS",
    "PORT",
    "RENDER",
  ])
    assert.equal(Object.hasOwn(result, key), false, key);
  assert.deepEqual(parent, copy);
});
test("a real child process receives no parent application credentials", () => {
  const environment = testEnvironment({
    PATH: process.env.PATH,
    FIREBASE_KEY: "parent-credential",
    RESEND_API_KEY: "parent-email-key",
    FUTURE_API_SECRET: "parent-secret",
  });
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      "const keys=['FIREBASE_KEY','RESEND_API_KEY','FUTURE_API_SECRET'];if(keys.some(k=>process.env[k]))process.exit(1);console.log(process.env.NODE_ENV)",
    ],
    { env: environment, encoding: "utf8" },
  );
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), "test");
});
test("the production missing-credential security test passes with synthetic parent production credentials present", () => {
  const pair = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const account = {
    type: "service_account",
    project_id: "demo",
    client_email: "fixture@demo.iam.gserviceaccount.com",
    private_key: pair.privateKey.export({ type: "pkcs8", format: "pem" }),
  };
  const result = runTests({
    files: ["scripts/security-regression.cjs"],
    environment: {
      PATH: process.env.PATH,
      NODE_ENV: "production",
      FIREBASE_KEY: JSON.stringify(account),
      APP_CHECK_MODE: "monitor",
      NEW_PROVIDER_SECRET: "parent-only",
    },
  });
  assert.equal(
    result.status,
    0,
    String(result.stdout || result.stderr).slice(-2000),
  );
});
test("the shared runner discovers all regression files and bounds concurrent test processes", () => {
  let calls = 0;
  const result = runTests({
    run(executable, args, options) {
      calls++;
      assert.equal(executable, process.execPath);
      assert.ok(args.includes("--test-concurrency=2"));
      assert.ok(args.includes("scripts/security-regression.cjs"));
      assert.ok(args.includes("scripts/test-runner-regression.cjs"));
      assert.ok(args.includes("scripts/firestore-index-regression.cjs"));
      assert.equal(options.env.NODE_ENV, "test");
      return { status: 0 };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.status, 0);
});
test("the CLI rejects arbitrary paths or Node flags instead of executing another program", () => {
  for (const target of [
    "../server.js",
    "--test-name-pattern=skip",
    "scripts/nonexistent-regression.cjs",
  ]) {
    const result = spawnSync(
      process.execPath,
      ["scripts/run-tests.cjs", target],
      { env: testEnvironment(), encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /REGRESSION_TARGET_INVALID/);
  }
});
