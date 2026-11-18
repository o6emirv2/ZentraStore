"use strict";
const { test, before } = require("node:test"),
  assert = require("node:assert/strict");
const { browserModule } = require("./helpers/browser-module.cjs");
let model;
before(async () => {
  model = await browserModule("admin/wallet-model.mjs");
});
const input = {
  identifier: "EmirHan",
  type: "credit",
  amount: "5000,50",
  reason: "Müşteri hediye bakiyesi",
};
const recipient = {
  ok: true,
  recipient: {
    uid: "member",
    balanceKurus: 50000,
    email: "member@zentra.invalid",
  },
  recipientToken: "preview-token",
  expiresAt: Date.now() + 300000,
};
const receipt = {
  committed: true,
  uid: "member",
  type: "CREDIT",
  amountKurus: 500050,
  balanceBeforeKurus: 50000,
  balanceAfterKurus: 550050,
  transactionId: "a".repeat(64),
};
const base = {
  ensureActive() {},
  reauthenticate: async () => {},
  key: "wallet-request-test",
};
test("reauthentication network failure sends no money request and permits a fresh confirmation", async () => {
  let failed = true,
    posts = 0;
  const op = model.createWalletOperation({
    ...base,
    reauthenticate: async () => {
      if (failed) throw Object.assign(new Error(), { code: "NETWORK_ERROR" });
    },
    api: async (_p, options) => {
      if (options) posts++;
      return options ? { ok: true, adjustment: receipt } : recipient;
    },
  });
  await op.prepare(input);
  await assert.rejects(op.submit("password"), { code: "NETWORK_ERROR" });
  assert.equal(op.snapshot().uncertain, false);
  assert.equal(posts, 0);
  failed = false;
  await op.submit("password");
  assert.equal(posts, 1);
});
test("money parsing is exact and never treats grouping, exponent or extra decimals as another amount", () => {
  assert.equal(model.parseWalletAmount("5000,50"), 500050);
  assert.equal(model.parseWalletAmount("0.01"), 1);
  assert.equal(model.parseWalletAmount("1000000"), 100000000);
  for (const bad of [
    "0",
    "1e3",
    "5.000,50",
    "1.000",
    "1,234",
    "-1",
    "1 000",
    "1000001",
    "Infinity",
    "NaN",
  ])
    assert.throws(() => model.parseWalletAmount(bad));
});
test("preview never writes; submission reauthenticates and uses the canonical account", async () => {
  const calls = [],
    auth = [];
  const op = model.createWalletOperation({
    ...base,
    reauthenticate: async (p) => auth.push(p),
    api: async (path, options) => {
      calls.push([path, options]);
      return options ? { ok: true, adjustment: receipt } : recipient;
    },
  });
  const preview = await op.prepare(input);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], undefined);
  assert.equal(preview.payload.uid, "member");
  assert.equal(preview.payload.amountKurus, 500050);
  const result = await op.submit("secure-password");
  assert.equal(result.committed, true);
  assert.deepEqual(auth, ["secure-password"]);
  assert.equal(calls.filter((c) => c[1]?.method === "POST").length, 1);
});
test("response loss checks receipts and never sends a second financial POST", async () => {
  const calls = [];
  const op = model.createWalletOperation({
    ...base,
    api: async (path, options) => {
      calls.push([path, options]);
      if (options) throw Object.assign(new Error(), { code: "NETWORK_ERROR" });
      return path.includes("/attempt?")
        ? { ok: true, found: true, adjustment: receipt }
        : recipient;
    },
  });
  await op.prepare(input);
  assert.equal(
    (await op.submit("password")).transactionId,
    receipt.transactionId,
  );
  await op.submit("unused");
  assert.equal(calls.filter((c) => c[1]).length, 1);
});
test("uncertain results remain recoverable and cannot be replaced with a new amount", async () => {
  let posts = 0;
  const op = model.createWalletOperation({
    ...base,
    api: async (path, options) => {
      if (options) {
        posts++;
        throw Object.assign(new Error(), { code: "REQUEST_TIMEOUT" });
      }
      return path.includes("/attempt?")
        ? { ok: true, found: false }
        : recipient;
    },
  });
  await op.prepare(input);
  await assert.rejects(op.submit("password"), {
    code: "STORE_WALLET_RESULT_PENDING",
  });
  assert.equal(op.snapshot().uncertain, true);
  await assert.rejects(op.prepare({ ...input, amount: "20" }));
  await assert.rejects(op.submit("password"));
  assert.equal(posts, 1);
});
test("a forged success response cannot display success", async () => {
  const op = model.createWalletOperation({
    ...base,
    api: async (path, options) =>
      options
        ? { ok: true, adjustment: { ...receipt, uid: "another-account" } }
        : path.includes("/attempt?")
          ? { ok: true, found: false }
          : recipient,
  });
  await op.prepare(input);
  await assert.rejects(op.submit("password"), {
    code: "STORE_WALLET_RESULT_PENDING",
  });
  assert.equal(op.snapshot().committed, false);
});
test("concurrent submits and account changes cannot send another wallet mutation", async () => {
  let release,
    active = true,
    posts = 0;
  const hold = new Promise((resolve) => (release = resolve));
  const op = model.createWalletOperation({
    ...base,
    ensureActive() {
      if (!active) throw new Error("session changed");
    },
    reauthenticate: () => hold,
    api: async (_p, options) => {
      if (options) posts++;
      return options ? { ok: true, adjustment: receipt } : recipient;
    },
  });
  await op.prepare(input);
  const first = op.submit("password");
  await assert.rejects(op.submit("password"));
  active = false;
  release();
  await assert.rejects(first);
  assert.equal(posts, 0);
});
