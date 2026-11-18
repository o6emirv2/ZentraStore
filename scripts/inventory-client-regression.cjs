"use strict";
const { test, before } = require("node:test"),
  assert = require("node:assert/strict");
const { browserModule } = require("./helpers/browser-module.cjs");
let createInventoryImport;
before(async () => {
  ({ createInventoryImport } = await browserModule(
    "admin/inventory-model.mjs",
  ));
});
const input = {
  productId: "product-one",
  planKey: "daily",
  keys: ["LOCAL-TEST-KEY"],
};
const preview = { result: { ...input, keys: undefined, total: 1 } };
const receipt = {
  result: {
    committed: true,
    productId: input.productId,
    planKey: input.planKey,
    imported: 1,
  },
};
const options = {
  ensureActive() {},
  reauthenticate: async () => {},
  newId: () => "stable-test-import-key",
};
test("inventory preview is read-only and a lost import response is recovered without a second POST", async () => {
  let posts = 0;
  const op = createInventoryImport({
    ...options,
    api: async (path) => {
      if (path.endsWith("/import-check")) return preview;
      if (path.endsWith("/import")) {
        posts++;
        throw Object.assign(new Error("lost response"), {
          code: "NETWORK_ERROR",
        });
      }
      return { ...receipt, found: true };
    },
  });
  await op.prepare(input, "password");
  assert.equal(posts, 0);
  assert.equal((await op.submit("password")).committed, true);
  await op.submit("password");
  assert.equal(posts, 1);
});
test("an unverified success remains uncertain and blocks changing or resending the import", async () => {
  let posts = 0;
  const op = createInventoryImport({
    ...options,
    api: async (path) => {
      if (path.endsWith("/import-check")) return preview;
      if (path.endsWith("/import")) {
        posts++;
        return { result: { imported: 1 } };
      }
      return { found: false };
    },
  });
  await op.prepare(input, "password");
  await assert.rejects(op.submit("password"), /belirsiz/);
  await assert.rejects(op.prepare(input, "password"));
  await assert.rejects(op.submit("password"));
  assert.equal(op.state().uncertain, true);
  assert.equal(posts, 1);
});
test("reauthentication failure sends no inventory import and permits a fresh confirmation", async () => {
  let fail = false,
    posts = 0;
  const op = createInventoryImport({
    ...options,
    reauthenticate: async () => {
      if (fail) throw new Error("reauth unavailable");
    },
    api: async (path) => {
      if (path.endsWith("/import-check")) return preview;
      posts++;
      return receipt;
    },
  });
  await op.prepare(input, "password");
  fail = true;
  await assert.rejects(op.submit("password"));
  assert.equal(posts, 0);
  assert.equal(op.state().uncertain, false);
  fail = false;
  await op.submit("password");
  assert.equal(posts, 1);
});
test("concurrent stock confirmations send only one immutable import payload", async () => {
  let finish,
    posts = 0;
  const value = structuredClone(input);
  const op = createInventoryImport({
    ...options,
    api: async (path) => {
      if (path.endsWith("/import-check")) return preview;
      posts++;
      return new Promise((resolve) => {
        finish = () => resolve(receipt);
      });
    },
  });
  await op.prepare(value, "password");
  value.productId = "changed-product";
  const first = op.submit("password");
  await assert.rejects(op.submit("password"), /devam ediyor/);
  finish();
  await first;
  assert.equal(posts, 1);
});
