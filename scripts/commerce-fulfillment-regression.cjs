"use strict";
const { test, before, after } = require("node:test"),
  assert = require("node:assert/strict"),
  crypto = require("node:crypto");
const { applicationFixture } = require("./helpers/application-fixture.cjs");
let f, owner, second, p, quote, held, order;
const base = "/api/store/commerce",
  admin = "/api/admin/store/commerce";
const post = (path, body = {}, uid = "member") =>
  f.request(base + path, { uid, method: "POST", body });
const prepare = () =>
  post("/quote", {
    items: [{ productId: p.id, planKey: p.plans[0].key, quantity: 1 }],
    paymentMethod: "wallet",
  });
before(async () => {
  f = await applicationFixture();
  owner = await f.openAdmin();
  f.db.records.set("adminUsers/viewer", {
    email: "viewer@zentra.invalid",
    role: "inventory",
    active: true,
    policyVersion: 1,
  });
  second = await f.openAdmin("viewer");
  p = (await f.request("/api/store/catalog")).body.catalog.products.find(
    (x) =>
      x.fulfillmentMode !== "telegram_only" && x.plans[0].priceKurus < 50000,
  );
  f.db.records.set("users/member", {
    ...f.db.records.get("users/member"),
    storeBalanceKurus: 500000,
  });
  f.db.records.set("users/viewer", {
    username: "GiftUser",
    usernameLower: "giftuser",
    email: "viewer@zentra.invalid",
    storeAccountStatus: "active",
  });
});
after(async () => f?.close());
test("reserve uses actual encrypted inventory and reduces sellable stock", async () => {
  const imported = await f.adminWrite(
    owner,
    "/api/admin/store/inventory/import",
    "POST",
    {
      productId: p.id,
      planKey: p.plans[0].key,
      keys: [
        "LICENSE-REAL-0001",
        "LICENSE-REAL-0002",
        "LICENSE-REAL-0003",
        "LICENSE-REAL-0004",
        "LICENSE-REAL-0005",
      ],
      idempotencyKey: crypto.randomUUID(),
    },
  );
  assert.equal(imported.status, 201, JSON.stringify(imported.body));
  quote = (await prepare()).body.result;
  const r = await post("/reservations", { quoteToken: quote.token });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  held = r.body.result;
  assert.equal(
    f.db.records.get("storeReservations/" + held.id).state,
    "active",
  );
  const summary = [...f.db.records.entries()].find(([k]) =>
    k.startsWith("storeInventorySummary/"),
  )[1];
  assert.equal(summary.reservedCount, 1);
  assert.equal(summary.availableCount, 4);
  assert.equal(
    (await post("/reservations", { quoteToken: quote.token }, "viewer")).status,
    409,
  );
});
test("reserved purchase consumes the exact held secret and debits once under replay", async () => {
  const body = {
    items: quote.items.map((x) => ({
      productId: x.productId,
      planKey: x.planKey,
      quantity: x.quantity,
    })),
    paymentMethod: "wallet",
    commerceQuote: quote.token,
    reservationId: held.id,
    idempotencyKey: crypto.randomUUID(),
  };
  const [a, b] = await Promise.all(
    [1, 2].map(() =>
      f.request("/api/store/orders", { uid: "member", method: "POST", body }),
    ),
  );
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.equal(b.status, 201, JSON.stringify(b.body));
  order = a.body.order;
  assert.equal(order.id, b.body.order.id);
  assert.equal(
    f.db.records.get("storeReservations/" + held.id).state,
    "consumed",
  );
  assert.equal(
    [...f.db.records.values()].filter((r) => r.type === "DEBIT").length,
    1,
  );
  assert.equal(
    f.db.records.get(
      "storeReservationOwners/" +
        require("../server/commerce/common").hash("member"),
    ).expiresAt,
    0,
  );
  const d = await f.request("/api/store/orders/" + order.id + "/delivery", {
    uid: "member",
  });
  assert.equal(d.status, 200);
  assert(JSON.stringify(d.body).includes("LICENSE-REAL-"));
  assert.equal(
    (
      await f.request("/api/store/orders/" + order.id + "/delivery", {
        uid: "viewer",
      })
    ).status,
    403,
  );
});
test("release cannot return consumed inventory or another customer reservation to stock", async () => {
  assert.equal(
    (await post("/reservations/" + held.id + "/release", {}, "viewer")).status,
    404,
  );
  const r = await post("/reservations/" + held.id + "/release");
  assert.equal(r.status, 200);
  assert.equal(r.body.result.released, false);
  quote = (await prepare()).body.result;
  held = (await post("/reservations", { quoteToken: quote.token })).body.result;
  assert(held.id);
  const released = await post("/reservations/" + held.id + "/release");
  assert.equal(released.status, 200);
  assert.equal(released.body.result.released, true);
  assert.equal(
    (await post("/reservations/" + held.id + "/release")).body.result.released,
    false,
  );
  const summary = [...f.db.records.entries()].find(([k]) =>
    k.startsWith("storeInventorySummary/"),
  )[1];
  assert.equal(summary.reservedCount, 0);
  assert.equal(summary.availableCount, 4);
});
test("expired reservations are released in a bounded worker pass", async () => {
  quote = (await prepare()).body.result;
  held = (await post("/reservations", { quoteToken: quote.token })).body.result;
  const ref = f.db.records.get("storeReservations/" + held.id);
  f.db.records.set("storeReservations/" + held.id, {
    ...ref,
    expiresAt: Date.now() - 1,
  });
  await require("../server/commerce/reservations").expire();
  assert.equal(
    f.db.records.get("storeReservations/" + held.id).state,
    "expired",
  );
});
test("gift quote requires published eligibility and delivers only to its verified recipient", async () => {
  const body = {
    items: [{ productId: p.id, planKey: p.plans[0].key, quantity: 1 }],
    paymentMethod: "wallet",
    giftRecipientUid: "viewer",
  };
  assert.equal((await post("/quote", body)).status, 409);
  f.db.records.set("storeProductDetails/" + p.id, {
    productId: p.id,
    revision: 1,
    publishedRevision: 1,
    published: { giftEligible: true, volumeTiers: [], unitCostKurus: 100 },
  });
  const q = await post("/quote", body);
  assert.equal(q.status, 200, JSON.stringify(q.body));
  const r = await f.request("/api/store/orders", {
    uid: "member",
    method: "POST",
    body: {
      items: body.items,
      paymentMethod: "wallet",
      commerceQuote: q.body.result.token,
      idempotencyKey: crypto.randomUUID(),
    },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const id = r.body.order.id;
  assert.equal(
    (
      await f.request("/api/store/orders/" + id + "/delivery", {
        uid: "member",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request("/api/store/orders/" + id + "/delivery", {
        uid: "viewer",
      })
    ).status,
    200,
  );
  assert.equal(
    (await post("/orders/" + id + "/acknowledge", {}, "member")).status,
    403,
  );
  assert.equal(
    (await post("/orders/" + id + "/acknowledge", {}, "viewer")).status,
    200,
  );
  assert.equal(
    (await f.request(base + "/gifts", { uid: "viewer" })).body.result.items[0]
      .id,
    id,
  );
});
test("assigned coupons are hidden from other accounts and restricted by plan on the server", async () => {
  const code = "MEMBER-ONLY";
  const saved = await f.adminWrite(
    owner,
    "/api/admin/store/promotions/" + code,
    "PUT",
    {
      title: "Scope",
      type: "fixed",
      value: 100,
      active: true,
      visibleInWallet: true,
      usageLimit: 10,
      perUserLimit: 1,
      productIds: [p.id],
      planKeys: [p.plans[0].key],
      customerUids: ["member"],
    },
  );
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const body = {
    items: [{ productId: p.id, planKey: p.plans[0].key, quantity: 1 }],
    paymentMethod: "telegram",
    promotionCode: code,
  };
  assert.equal((await post("/quote", body, "viewer")).status, 409);
  assert.equal((await post("/quote", body)).status, 200);
  const wallet = await f.request("/api/store/promotions", { uid: "viewer" });
  assert(!wallet.body.promotions.some((x) => x.code === code));
  if (p.plans[1])
    assert.equal(
      (
        await post("/quote", {
          ...body,
          items: [{ productId: p.id, planKey: p.plans[1].key, quantity: 1 }],
        })
      ).status,
      409,
    );
});
test("a catalog price change invalidates a previously signed quote before any debit", async () => {
  const q = (await prepare()).body.result,
    balance = f.db.records.get("users/member").storeBalanceKurus;
  await f.adminWrite(owner, "/api/admin/store/products/" + p.id, "PATCH", {
    plans: { [p.plans[0].key]: { priceKurus: p.plans[0].priceKurus + 100 } },
  });
  const r = await f.request("/api/store/orders", {
    uid: "member",
    method: "POST",
    body: {
      items: [{ productId: p.id, planKey: p.plans[0].key, quantity: 1 }],
      paymentMethod: "wallet",
      commerceQuote: q.token,
      idempotencyKey: crypto.randomUUID(),
    },
  });
  assert.equal(r.status, 409);
  assert.equal(f.db.records.get("users/member").storeBalanceKurus, balance);
});
test("second approval is by a different administrator and legacy bulk writes cannot bypass it", async () => {
  let r = await f.adminWrite(owner, admin + "/settings", "PUT", {
    expectedRevision: 0,
    secondApproval: true,
  });
  assert.equal(r.status, 200);
  r = await f.adminWrite(owner, admin + "/bulk/preview", "POST", {
    updates: [{ productId: p.id, settings: { active: false } }],
  });
  assert.equal(r.status, 200);
  const id = r.body.result.id;
  assert.equal(
    (await f.adminWrite(owner, admin + "/bulk/" + id + "/approve", "POST", {}))
      .status,
    403,
  );
  assert.equal(
    (
      await f.adminWrite(owner, admin + "/bulk/" + id + "/execute", "POST", {
        confirmation: "UYGULA",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.adminWrite(owner, "/api/admin/store/products/bulk", "POST", {
        updates: [{ productId: p.id, settings: { active: false } }],
      })
    ).status,
    403,
  );
  assert.equal(
    (await f.adminWrite(second, admin + "/bulk/" + id + "/approve", "POST", {}))
      .status,
    200,
  );
  assert.equal(
    (
      await f.adminWrite(owner, admin + "/bulk/" + id + "/execute", "POST", {
        confirmation: "UYGULA",
      })
    ).status,
    200,
  );
});
