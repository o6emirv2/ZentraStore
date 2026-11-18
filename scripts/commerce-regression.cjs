"use strict";
const { test, before, after } = require("node:test"),
  assert = require("node:assert/strict");
const { applicationFixture } = require("./helpers/application-fixture.cjs");
let f, owner, p;
const base = "/api/store/commerce",
  admin = "/api/admin/store/commerce";
const post = (path, body = {}, uid = "member") =>
  f.request(base + path, { uid, method: "POST", body });
const get = (path, uid = "member") => f.request(base + path, { uid });
before(async () => {
  f = await applicationFixture();
  owner = await f.openAdmin();
  p = (await f.request("/api/store/catalog")).body.catalog.products.find(
    (x) =>
      x.fulfillmentMode !== "telegram_only" && x.plans[0].priceKurus < 50000,
  );
});
after(async () => f?.close());
test("commerce endpoints require authentication and strict bodies", async () => {
  assert.equal((await f.request(base + "/profile")).status, 401);
  assert.equal(
    (await post("/quote", { uid: "viewer", items: [] })).status,
    400,
  );
  assert.equal(
    (
      await post("/events", {
        productId: p.id,
        event: "cart",
        eventId: "event-1",
      })
    ).status,
    400,
  );
});
test("account cart and favorites commit once with optimistic revision and ownership", async () => {
  let r = await f.request(base + "/profile", {
    uid: "member",
    method: "PATCH",
    body: {
      expectedRevision: 0,
      cart: [{ productId: p.id, planKey: p.plans[0].key, quantity: 1 }],
      favorites: [p.id],
    },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.result.revision, 1);
  assert.equal((await get("/profile", "viewer")).body.result.cart.length, 0);
  assert.equal(
    (
      await f.request(base + "/profile", {
        uid: "member",
        method: "PATCH",
        body: { expectedRevision: 0, favorites: [] },
      })
    ).status,
    409,
  );
  assert.equal(
    [...f.db.records.values()].filter((x) => x.event === "cart").length,
    1,
  );
});
test("profile pagination cannot override the authenticated account", async () => {
  f.db.records.set("storeCustomerRequests/other-request", {
    uid: "viewer",
    createdAt: Date.now(),
    subject: "private",
  });
  assert.equal(
    (await get("/requests?uid=viewer&field=uid")).body.result.items.length,
    0,
  );
});
test("quotes use real catalog prices, report changes and reject tampering or expired claims", async () => {
  const r = await post("/quote", {
    items: [
      {
        productId: p.id,
        planKey: p.plans[0].key,
        quantity: 1,
        expectedUnitPriceKurus: 1,
      },
    ],
    paymentMethod: "wallet",
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.result.changes.length, 1);
  assert.equal(r.body.result.totalKurus, p.plans[0].priceKurus);
  const q = require("../server/commerce/quotes");
  assert.throws(() => q.verify(r.body.result.token + "x", "member"));
  assert.throws(() => q.verify(r.body.result.token, "viewer"));
  assert.throws(() =>
    q.verify(q.encode({ uid: "member", expiresAt: Date.now() - 1 }), "member"),
  );
});
test("draft content is private and publishing requires the actual revision", async () => {
  const r = await f.adminWrite(
    owner,
    admin + "/products/" + p.id + "/draft",
    "PUT",
    {
      expectedRevision: 0,
      content: {
        version: "2.0",
        requirements: { tr: "Android 12", en: "Android 12" },
        guide: { tr: "Kurulum açıklaması", en: "Setup instructions" },
        unitCostKurus: 100,
        volumeTiers: [{ quantity: 2, percentOff: 10 }],
        giftEligible: true,
        seo: { title: "Zentra ürün", slug: "zentra-urun" },
      },
    },
  );
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(
    (await get("/products/" + p.id)).body.result.product.version,
    "",
  );
  assert.equal(
    (
      await f.adminWrite(
        owner,
        admin + "/products/" + p.id + "/publish",
        "POST",
        { expectedRevision: 0 },
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await f.adminWrite(
        owner,
        admin + "/products/" + p.id + "/publish",
        "POST",
        { expectedRevision: 1 },
      )
    ).status,
    200,
  );
  const pub = (await get("/products/" + p.id)).body.result.product;
  assert.equal(pub.version, "2.0");
  assert.equal(pub.unitCostKurus, undefined);
});
test("volume discounts come from published product metadata", async () => {
  const r = await post("/quote", {
    items: [{ productId: p.id, planKey: p.plans[0].key, quantity: 2 }],
    paymentMethod: "wallet",
  });
  assert.equal(r.status, 200);
  assert.equal(
    r.body.result.totalKurus,
    Math.floor(p.plans[0].priceKurus * 0.9) * 2,
  );
});
test("verified reviews require a real delivered order and publish only one review per account/product", async () => {
  const body = {
    orderId: "review-order",
    productId: p.id,
    rating: 5,
    title: "Ürün",
    message: "İyi",
  };
  assert.equal((await post("/reviews", body)).status, 404);
  f.db.records.set("storeOrders/review-order", {
    uid: "member",
    status: "delivered",
    approvedAt: Date.now(),
    createdAt: Date.now(),
    totalKurus: 100,
    items: [{ productId: p.id }],
  });
  assert.equal((await post("/reviews", body, "viewer")).status, 404);
  assert.equal((await post("/reviews", body)).status, 200);
  assert.equal((await post("/reviews", body)).status, 409);
  const result = (await get("/products/" + p.id)).body.result;
  assert.equal(result.reviews[0].verifiedPurchase, true);
});
test("support tickets are order scoped, revision protected and satisfaction is once after resolution", async () => {
  const r = await post("/tickets", {
    orderId: "review-order",
    subject: "Kurulum",
    message: "Yardım",
    idempotencyKey: "ticket-001",
  });
  assert.equal(r.status, 200);
  const id = r.body.result.id;
  assert.equal((await get("/tickets/" + id, "viewer")).status, 404);
  assert.equal(
    (await post("/tickets/" + id + "/rating", { rating: 5 })).status,
    409,
  );
  assert.equal(
    (
      await f.adminWrite(owner, admin + "/tickets/" + id + "/reply", "POST", {
        expectedRevision: 1,
        message: "Çözüldü",
        status: "resolved",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await post("/tickets/" + id + "/rating", {
        rating: 5,
        message: "Teşekkürler",
      })
    ).status,
    200,
  );
  assert.equal(
    (await post("/tickets/" + id + "/rating", { rating: 1 })).status,
    409,
  );
});
test("a refund request cannot be falsely marked complete by an admin", async () => {
  const r = await post("/requests", {
    kind: "refund",
    orderId: "review-order",
    subject: "İade",
    message: "İade talebi",
    idempotencyKey: "refund-001",
  });
  assert.equal(r.status, 200);
  assert.equal(
    (
      await f.adminWrite(
        owner,
        admin + "/requests/" + r.body.result.id + "/decision",
        "POST",
        { status: "resolved", reply: "Tamamlandı" },
      )
    ).status,
    409,
  );
});
test("delivery acknowledgement is separate from payment and rejects another account", async () => {
  assert.equal(
    (await post("/orders/review-order/acknowledge", {}, "viewer")).status,
    404,
  );
  const r = await post("/orders/review-order/acknowledge");
  assert.equal(r.status, 200);
  assert.equal(
    (await get("/orders/review-order")).body.result.delivery.acknowledgedAt,
    r.body.result.acknowledgedAt,
  );
});
test("CSV export is formula safe and malformed imports cannot create a job", async () => {
  const ops = require("../server/commerce/operations");
  assert.equal(ops.csvCell("=IMPORTXML(A1)"), '"\'=IMPORTXML(A1)"');
  assert.throws(() => ops.csvParse("productId,invalid\nx,y"));
  assert.throws(() => ops.csvParse('productId\n"broken'));
  assert.equal(
    (
      await f.adminWrite(owner, admin + "/bulk/preview", "POST", {
        csv: "productId,priceKurus\ninvalid,99",
      })
    ).status,
    400,
  );
});
test("previewed catalog edits commit once and record actual price history", async () => {
  let r = await f.adminWrite(owner, admin + "/bulk/preview", "POST", {
    updates: [
      {
        productId: p.id,
        settings: {
          plans: {
            [p.plans[0].key]: { priceKurus: p.plans[0].priceKurus + 100 },
          },
        },
      },
    ],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const id = r.body.result.id;
  r = await f.adminWrite(owner, admin + "/bulk/" + id + "/execute", "POST", {
    confirmation: "UYGULA",
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(
    f.db.records.get("storeBulkCatalogJobs/" + id).state,
    "completed",
  );
  assert.equal(
    (
      await f.adminWrite(owner, admin + "/bulk/" + id + "/execute", "POST", {
        confirmation: "UYGULA",
      })
    ).status,
    200,
  );
  assert.equal(
    [...f.db.records.keys()].filter((x) => x.startsWith("storePriceHistory/"))
      .length,
    1,
  );
});
test("profit report marks missing cost and fee evidence incomplete", async () => {
  const r = await f.request(admin + "/reports", owner);
  assert.equal(r.status, 200);
  assert.equal(r.body.result.profit.verified, false);
  assert.equal(r.body.result.profit.contributionKurus, null);
});
test("backup and restore fail closed without configured storage and isolated target", async () => {
  assert.equal(
    (
      await f.adminWrite(owner, admin + "/backups", "POST", {
        idempotencyKey: "backup-001",
      })
    ).status,
    503,
  );
  assert.equal(
    (
      await f.adminWrite(owner, admin + "/backups/invalid/restore", "POST", {
        confirmation: "TEST ORTAMINA GERI YUKLE",
      })
    ).status,
    503,
  );
});
test("privacy export excludes vault, admin notes and other customer data", async () => {
  const r = await get("/export");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.result.account.uid, "member");
  assert(!JSON.stringify(r.body.result).includes("private"));
  assert.equal(r.body.result.financialRecordsRetained, true);
});
