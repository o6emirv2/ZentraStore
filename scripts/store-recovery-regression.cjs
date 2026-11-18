"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict"),
  crypto = require("node:crypto");
const { applicationFixture } = require("./helpers/application-fixture.cjs");
let f, owner, p;
before(async () => {
  f = await applicationFixture();
  owner = await f.openAdmin();
  p = (await f.request("/api/store/catalog")).body.catalog.products.find(
    (x) =>
      x.fulfillmentMode !== "telegram_only" &&
      x.inventoryType !== "account" &&
      x.plans[0].priceKurus < 50000,
  );
  assert(p);
});
after(async () => f?.close());
test("compatibility reads real published requirements without needing review or price-history indexes", async () => {
  f.db.records.set("storeProductDetails/" + p.id, {
    productId: p.id,
    published: {
      requirements: { tr: "Android 12 ve üstü", en: "Android 12 or later" },
    },
  });
  f.db.setQueryHook((path) => {
    if (["storeReviews", "storePriceHistory"].includes(path))
      throw Object.assign(new Error("missing index"), { code: 9 });
  });
  try {
    const r = await f.request(
      "/api/store/commerce/products/" + p.id + "/compatibility",
    );
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.result.requirements.tr, "Android 12 ve üstü");
    assert.equal(r.body.result.platform, p.platform);
    assert(!("unitCostKurus" in r.body.result));
    assert.equal(
      (
        await f.request(
          "/api/store/commerce/products/not-existing/compatibility",
        )
      ).status,
      404,
    );
  } finally {
    f.db.setQueryHook(null);
  }
});
test("admin customer search distinguishes a provider outage from a missing account and still lists disabled accounts", async () => {
  for (const query of [
    "EmirHan",
    "EMİRHAN",
    "MEMBER@ZENTRA.INVALID",
    "member",
  ]) {
    const r = await f.request(
      "/api/admin/store/users?query=" + encodeURIComponent(query),
      owner,
    );
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.users[0].uid, "member");
  }
  const original = f.auth.getUserByEmail;
  f.auth.getUserByEmail = async () => {
    throw Object.assign(new Error("outage"), { code: "auth/internal-error" });
  };
  try {
    const r = await f.request(
      "/api/admin/store/users?query=member%40zentra.invalid",
      owner,
    );
    assert.equal(r.status, 503);
    assert.equal(r.body.code, "STORE_ACCOUNT_LOOKUP_UNAVAILABLE");
  } finally {
    f.auth.getUserByEmail = original;
  }
  f.users.get("member").disabled = true;
  try {
    assert.equal(
      (await f.request("/api/admin/store/users?query=member", owner)).status,
      200,
    );
    assert.equal(
      (
        await f.request(
          "/api/admin/store/wallet/recipient?identifier=member",
          owner,
        )
      ).status,
      409,
    );
  } finally {
    f.users.get("member").disabled = false;
  }
});
test("inventory receipt lookup is permission checked, actor scoped and never reveals imported credentials", async () => {
  const key = crypto.randomUUID(),
    secret = "LOCAL-ONLY-" + crypto.randomUUID();
  const r = await f.adminWrite(
    owner,
    "/api/admin/store/inventory/import",
    "POST",
    {
      productId: p.id,
      planKey: p.plans[0].key,
      keys: [secret],
      idempotencyKey: key,
    },
  );
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const path =
    "/api/admin/store/inventory/import-attempt?idempotencyKey=" + key;
  assert.equal((await f.request(path)).status, 401);
  const finance = await f.openAdmin("finance");
  assert.equal((await f.request(path, finance)).status, 403);
  const receipt = await f.request(path, owner);
  assert.equal(receipt.status, 200);
  assert.equal(receipt.body.found, true);
  assert.equal(receipt.body.result.committed, true);
  assert.equal(receipt.body.result.imported, 1);
  assert(!JSON.stringify(receipt.body).includes(secret));
  assert.match(receipt.headers.get("cache-control"), /no-store/);
  assert.equal(
    (
      await require("../server/core/storeInventoryService").inventoryImportAttempt(
        { actorUid: "other-owner", idempotencyKey: key },
      )
    ).found,
    false,
  );
});
test("wallet credit by email, persistent cart, quote, reservation and paid delivery work through actual HTTP routes", async () => {
  const target = await f.request(
    "/api/admin/store/wallet/recipient?identifier=member%40zentra.invalid",
    owner,
  );
  assert.equal(target.status, 200);
  const before = target.body.recipient.balanceKurus;
  const credit = await f.adminWrite(
    owner,
    "/api/admin/store/wallet/adjust",
    "POST",
    {
      uid: target.body.recipient.uid,
      recipientToken: target.body.recipientToken,
      type: "CREDIT",
      amountKurus: 500000,
      reason: "Local integration credit",
      idempotencyKey: crypto.randomUUID(),
    },
  );
  assert.equal(credit.status, 200, JSON.stringify(credit.body));
  assert.equal(credit.body.adjustment.balanceAfterKurus, before + 500000);
  const item = {
    productId: p.id,
    planKey: p.plans[0].key,
    quantity: 1,
    expectedUnitPriceKurus: p.plans[0].priceKurus,
  };
  const profile = await f.request("/api/store/commerce/profile", {
    uid: "member",
  });
  const cart = await f.request("/api/store/commerce/profile", {
    uid: "member",
    method: "PATCH",
    body: {
      expectedRevision: profile.body.result.revision,
      cart: [
        {
          productId: item.productId,
          planKey: item.planKey,
          quantity: 1,
          acceptedUnitPriceKurus: item.expectedUnitPriceKurus,
        },
      ],
    },
  });
  assert.equal(cart.status, 200, JSON.stringify(cart.body));
  const post = (path, body) =>
    f.request("/api/store/commerce/" + path, {
      uid: "member",
      method: "POST",
      body,
    });
  const quote = await post("quote", { items: [item], paymentMethod: "wallet" });
  assert.equal(quote.status, 200, JSON.stringify(quote.body));
  const reservation = await post("reservations", {
    quoteToken: quote.body.result.token,
  });
  assert.equal(reservation.status, 200, JSON.stringify(reservation.body));
  const body = {
    items: [item],
    paymentMethod: "wallet",
    idempotencyKey: crypto.randomUUID(),
    commerceQuote: quote.body.result.token,
    reservationId: reservation.body.result.id,
  };
  const buy = () =>
    f.request("/api/store/orders", { uid: "member", method: "POST", body });
  const order = await buy();
  assert([200, 201].includes(order.status), JSON.stringify(order.body));
  assert.equal(order.body.order.status, "delivered");
  assert.equal(
    f.db.records.get("users/member").storeBalanceKurus,
    before + 500000 - quote.body.result.totalKurus,
  );
  const replay = await buy();
  assert.equal(replay.body.order.id, order.body.order.id);
  assert.equal(
    f.db.records.get("users/member").storeBalanceKurus,
    before + 500000 - quote.body.result.totalKurus,
  );
});
test("saved appearance preferences follow the latest navy design policy", async () => {
  f.db.records.set("storeCommerceProfiles/member", {
    uid: "member",
    revision: 0,
    preferences: { theme: "dark", language: "en", reducedMotion: true },
  });
  const r = await f.request("/api/store/commerce/profile", { uid: "member" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.result.preferences.theme, "dark");
  assert.equal(r.body.result.preferences.reducedMotion, true);
});
