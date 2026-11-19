"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { applicationFixture } = require("./helpers/application-fixture.cjs");
let f, owner;
const paths = ["contra-hax", "kingmod", "star"].flatMap((group, i) =>
  Array.from(
    { length: [7, 9, 4][i] },
    (_, j) =>
      "/public/assets/products/gallery/" +
      group +
      "/game-" +
      String(j + 1).padStart(2, "0") +
      ".jpeg",
  ),
);
const product = {
  id: "qa-device-product",
  name: "Cihaz Paketi",
  description: "Test ortamı için cihaz paketi.",
  categoryKey: "gbox-ipad",
  platform: "ios",
  game: "gbox",
  fulfillmentMode: "automatic",
  inventoryType: "license",
  badgeKey: "premium",
  plans: [
    { key: "month", label: "Aylık", duration: "30 gün", priceKurus: 12500 },
  ],
  image: "/public/assets/products/contra-hax.jpeg",
  featured: true,
  cardStyle: "signature",
  galleryPaths: paths,
};
before(async () => {
  f = await applicationFixture({
    canonicalOrigin: "https://zentrastore.com.tr",
  });
  owner = await f.openAdmin();
});
after(async () => f?.close());
const admin = (path, method, body) =>
  f.adminWrite(owner, "/api/admin/store/" + path, method, body);
function status(result, expected) {
  assert.equal(result.status, expected, JSON.stringify(result.body));
}

test("gallery supports twenty ordered local files on create, edit and public catalog, while rejecting invalid changes", async () => {
  const creation = await admin("products", "POST", product);
  status(creation, 201);
  assert.deepEqual(creation.body.product.galleryPaths, paths);
  assert.equal(creation.body.product.categoryKey, "gbox-ipad");
  const reversed = [...paths].reverse();
  status(
    await admin("products/" + product.id, "PATCH", {
      cardStyle: "prism",
      featured: true,
      galleryPaths: reversed,
    }),
    200,
  );
  const response = await f.request("/api/store/catalog");
  const saved = response.body.catalog.products.find((p) => p.id === product.id);
  assert.deepEqual(saved.galleryPaths, reversed);
  assert.equal(saved.cardStyle, "prism");
  assert.equal(saved.featured, true);
  const { validateAppearance } = require("../server/core/storeProductCreation");
  for (const [list, code] of [
    [paths.concat(paths[0]), "STORE_GALLERY_LIMIT"],
    [[paths[0], paths[0]], "STORE_GALLERY_DUPLICATE"],
    [
      ["/public/assets/products/../images/test.jpeg"],
      "STORE_GALLERY_PATH_INVALID",
    ],
    [
      ["public/assets/products/missing-image.jpg"],
      "STORE_GALLERY_PATH_INVALID",
    ],
  ]) {
    assert.throws(() => validateAppearance({ galleryPaths: list }), { code });
  }
  const invalid = await admin("products/" + product.id, "PATCH", {
    galleryPaths: [paths[0], paths[0]],
  });
  assert(invalid.status >= 400);
  assert.deepEqual(
    (await f.request("/api/store/catalog")).body.catalog.products.find(
      (p) => p.id === product.id,
    ).galleryPaths,
    reversed,
  );
});
test("deletion checks open orders and reservations, removes dependent records and keeps immutable order history", async () => {
  const id = product.id,
    ref = f.db.collection("storeProductDeletionJobs").doc(id),
    records = f.db.records;
  status(
    await f.request("/api/admin/store/products/" + id, {
      uid: "member",
      method: "DELETE",
      body: { confirmId: id },
    }),
    403,
  );
  status(
    await admin("products/" + id, "DELETE", { confirmId: "different-id" }),
    400,
  );
  records.set("storeOrders/blocking", {
    status: "awaiting_payment",
    items: [{ productId: id }],
  });
  status(await admin("products/" + id, "DELETE", { confirmId: id }), 409);
  records.set("storeOrders/blocking", {
    status: "delivered",
    items: [{ productId: id, productName: product.name }],
  });
  records.set("storeReservations/active", {
    state: "active",
    items: [{ productId: id }],
  });
  status(await admin("products/" + id, "DELETE", { confirmId: id }), 409);
  records.delete("storeReservations/active");
  records.set("storeProductDetails/" + id + "/versions/1", {
    title: "Old draft",
  });
  records.set("storeProductWatches/old", { productId: id });
  records.set("storeInventory/" + id + "__month/items/old", {
    status: "available",
  });
  records.set("storeContentVersions/old", { targetId: id, kind: "product" });
  records.set("storeUserNotifications/member/items/mine", { productId: id });
  records.set("storeUserNotifications/member/items/other", {
    productId: "kingmod",
  });
  records.set("storeCommerceProfiles/member", {
    favorites: [id, "kingmod"],
    cart: [{ productId: id }],
    revision: 1,
  });
  records.set("storePromotions/SCOPED", { productIds: [id], active: true });
  status(await admin("products/" + id, "DELETE", { confirmId: id }), 202);
  status(await admin("products/" + id, "DELETE", { confirmId: id }), 202);
  assert(
    !(await f.request("/api/store/catalog")).body.catalog.products.some(
      (p) => p.id === id,
    ),
  );
  const { advance } = require("../server/core/productDeletion");
  for (let step = 0; step < 150 && (await ref.get()).exists; step++)
    await advance(f.db, ref);
  for (const key of [
    ref.path,
    "storeProductDetails/" + id + "/versions/1",
    "storeProductWatches/old",
    "storeInventory/" + id + "__month/items/old",
    "storeContentVersions/old",
    "storeUserNotifications/member/items/mine",
  ])
    assert(!records.has(key), key);
  assert(records.has("storeUserNotifications/member/items/other"));
  assert(records.has("storeOrders/blocking"));
  assert.deepEqual(records.get("storeCommerceProfiles/member").favorites, [
    "kingmod",
  ]);
  assert.equal(records.get("storePromotions/SCOPED").active, false);
  status(await admin("products/" + id, "DELETE", { confirmId: id }), 200);
  status(await admin("products", "POST", product), 409);
});
test("deleting one device-specific product preserves the remaining owner's shared inventory", async (t) => {
  // Two actual catalog products are assigned to the same pool in this fixture.
  const service = require("../server/core/storeCatalogService"),
    original = service.getEffectiveCatalog;
  const catalog = await original({ includeInactive: true });
  const a = {
    ...catalog.products.find((p) => p.id === "gbox-iphone"),
    inventoryPoolId: "test-shared",
  };
  const b = {
    ...catalog.products.find((p) => p.id === "gbox-ipad"),
    inventoryPoolId: "test-shared",
  };
  t.mock.method(service, "getEffectiveCatalog", async (options) => {
    const live = await original(options);
    return {
      ...live,
      products: live.products.map((p) =>
        p.id === a.id || p.id === b.id
          ? { ...p, inventoryPoolId: a.inventoryPoolId }
          : p,
      ),
    };
  });
  const sku = a.inventoryPoolId + "__" + a.plans[0].key,
    root = "storeInventory/" + sku + "/items/shared";
  f.db.records.set(root, { status: "available" });
  f.db.records.set("storeRestockJobs/shared", {
    productId: a.id,
    planKey: a.plans[0].key,
    sourceSkus: [sku],
    availableAt: Date.now(),
    skuIndex: 0,
    cursor: "",
    lease: "",
  });
  f.db.records.set("storeInventorySummary/" + sku, {
    productId: a.id,
    productIds: [a.id, b.id],
    available: 1,
  });
  status(await admin("products/" + a.id, "DELETE", { confirmId: a.id }), 202);
  const ref = f.db.collection("storeProductDeletionJobs").doc(a.id);
  for (let step = 0; step < 240 && (await ref.get()).exists; step++)
    await require("../server/core/productDeletion").advance(f.db, ref);
  assert(!(await ref.get()).exists);
  assert(f.db.records.has(root));
  assert.equal(f.db.records.get("storeRestockJobs/shared").productId, b.id);
  assert.equal(
    f.db.records.get("storeInventorySummary/" + sku).productId,
    b.id,
  );
  assert(
    (await f.request("/api/store/catalog")).body.catalog.products.some(
      (p) => p.id === b.id,
    ),
  );
});
test("notification editing enforces permissions and revisions, preserves the signed site destination and sender", async () => {
  const api = "/api/admin/store/notification-templates";
  const listing = await f.request(api, owner);
  status(listing, 200);
  const template = {
    subject: "Hesap hareketi {tarih}",
    intro: "Giriş cihazınız {cihaz}",
    label: "Oturumları incele",
  };
  const body = { revision: listing.body.revision, template };
  status(
    await f.request(api + "/new_device", {
      uid: "member",
      method: "PUT",
      body,
    }),
    403,
  );
  status(await admin("notification-templates/new_device", "PUT", body), 200);
  status(await admin("notification-templates/new_device", "PUT", body), 409);
  const editor = require("../server/email/editor");
  assert.throws(() =>
    editor.normalize({ ...template, subject: "Yanlış\nbaşlık" }),
  );
  assert.throws(() => editor.normalize({ ...template, label: "{hedef}" }));
  const saved = (await editor.read()).templates.new_device;
  const result = require("../server/email/templates").render(
    {
      type: "new_device",
      category: "security",
      uid: "member",
      data: { label: "Test & cihaz" },
      createdAt: Date.now(),
    },
    {},
    "member@zentra.invalid",
    saved,
  );
  assert(result.html.includes("Oturumları incele"));
  assert(result.text.includes("Test & cihaz"));
  const link = new URL(/<a href="([^"]+)"/.exec(result.html)[1]);
  assert.equal(link.searchParams.get("devam"), "/hesabim?bolum=sessions");
  assert.equal(
    require("../server/email/config").configuration().from,
    "ZENTRA STORE <bildirim@zentrastore.com.tr>",
  );
});
test("a signed device cookie suppresses duplicate login alerts and a second device creates exactly one", async () => {
  const device = require("../server/core/loginDevice"),
    claims = { uid: "device-test", auth_time: Math.floor(Date.now() / 1000) };
  const first = await device.observe(
    { headers: { "user-agent": "iPhone Safari" } },
    claims,
  );
  const cookie = first.cookie.split(";")[0];
  assert.match(first.cookie, /HttpOnly/);
  assert.equal(
    (await device.observe({ headers: { cookie } }, claims)).cookie.split(
      ";",
    )[0],
    cookie,
  );
  assert.equal(
    (
      await device.observe(
        { headers: {}, body: { deviceMarker: first.marker } },
        claims,
      )
    ).marker,
    first.marker,
  );
  const second = await device.observe(
    { headers: { "user-agent": "Android Chrome" } },
    claims,
  );
  assert.notEqual(second.cookie.split(";")[0], cookie);
  const alerts = [...f.db.records].filter(
    ([key, row]) =>
      key.startsWith("storeNotifications/") &&
      row.uid === claims.uid &&
      row.type === "new_device",
  );
  assert.equal(alerts.length, 2);
});
test("issued campaigns reach only opted-in accounts, route to the correct screen and survive a retry", async () => {
  const { schedule, processPage } = require("../server/email/announcements"),
    { admin: firebase } = require("./helpers/memory-firestore.cjs");
  const row = {
    type: "balance",
    code: "PUBLIC99",
    announce: true,
    active: true,
    createdAt: Date.now(),
    usedCount: 0,
  };
  const ref = f.db
    .collection("storeCampaignAnnouncements")
    .doc("promo_added_PUBLIC99");
  f.db.records.set("storePromotions/" + row.code, row);
  f.db.records.set("storeCommerceProfiles/opted", {
    preferences: { emailCouponNotifications: true },
  });
  f.db.records.set("storeCommerceProfiles/declined", {
    preferences: { emailCouponNotifications: false },
  });
  await f.db.runTransaction((tx) => schedule(tx, f.db, row));
  const postponed = Date.now() + 86400000;
  f.db.records.set("storePromotions/" + row.code, {
    ...row,
    startsAt: postponed,
  });
  await processPage(f.db, firebase, ref);
  assert.equal((await ref.get()).data().availableAt, postponed);
  assert(
    ![...f.db.records].some(
      ([key, value]) =>
        key.startsWith("storeNotifications/") && value.code === row.code,
    ),
  );
  f.db.records.set("storePromotions/" + row.code, row);
  await f.db.runTransaction((tx) => schedule(tx, f.db, row));
  await processPage(f.db, firebase, ref);
  await f.db.runTransaction((tx) => schedule(tx, f.db, row));
  await processPage(f.db, firebase, ref);
  const notes = [...f.db.records].filter(
    ([k, v]) => k.startsWith("storeNotifications/") && v.code === row.code,
  );
  assert.deepEqual(
    notes.map(([, v]) => v.uid),
    ["opted"],
  );
  const user = await require("../server/core/customerNotificationService").list(
    "opted",
  );
  assert.equal(
    user.notifications.find((n) => n.type === "promo_added").href,
    "/promosyonlar",
  );
  for (const path of ["/kuponlar", "/promosyonlar"]) {
    const response = await fetch(f.origin + path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
  }
});
test("an applied discount remains consumed after cancellation, including historical zero-count redemptions", async () => {
  const service = require("../server/core/storePromotionService");
  const code = "ONE100",
    uid = "member",
    orderId = "once-test";
  const row = {
    code,
    type: "percent",
    value: 10,
    usageLimit: 1,
    perUserLimit: 1,
    usedCount: 0,
    active: true,
    productIds: [],
  };
  const cart = {
    items: [
      {
        productId: "kingmod",
        quantity: 1,
        lineTotalKurus: 10000,
        unitPriceKurus: 10000,
      },
    ],
    totalKurus: 10000,
  };
  f.db.records.set("storePromotions/" + code, row);
  await f.db.runTransaction(async (transaction) => {
    const promotion = await service.readPromotionInTransaction({
      transaction,
      db: f.db,
      uid,
      code,
      cart,
    });
    service.applyPromotionInTransaction({
      transaction,
      promotion,
      uid,
      orderId,
    });
  });
  await f.db.runTransaction(async (transaction) => {
    const release = await service.readPromotionReleaseInTransaction({
      transaction,
      db: f.db,
      order: { uid, promotion: { code } },
      orderId,
    });
    service.releasePromotionInTransaction({
      transaction,
      release,
      reason: "cancelled",
    });
  });
  assert.equal(f.db.records.get("storePromotions/" + code).usedCount, 1);
  await assert.rejects(service.previewPromotion({ code, uid, cart }), {
    code: "STORE_PROMOTION_ALREADY_USED",
  });
  await assert.rejects(service.previewPromotion({ code, uid: "other", cart }), {
    code: "STORE_PROMOTION_LIMIT_REACHED",
  });
  const usage = [...f.db.records].find(
    ([k, v]) => k.startsWith("storePromotionCustomerUsage/") && v.code === code,
  );
  f.db.records.set(usage[0], { ...usage[1], count: 0 });
  await assert.rejects(service.previewPromotion({ code, uid, cart }), {
    code: "STORE_PROMOTION_ALREADY_USED",
  });
});
test("new stock is announced for the selected package even when inventory was already available", async (t) => {
  const crypto = require("node:crypto"),
    inventory = require("../server/core/storeInventoryService");
  const previous = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = "re_" + crypto.randomBytes(20).toString("hex");
  t.after(() => {
    if (previous === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = previous;
  });
  const productId = "contra-hax",
    planKey = "daily",
    uid = "member";
  const add = (key) =>
    inventory.importInventory({
      productId,
      planKey,
      actor: { uid: "owneruid" },
      keys: [key],
      idempotencyKey: crypto.randomUUID(),
    });
  const notices = require("../server/commerce/catalogNotifications");
  await add("TEST-" + crypto.randomUUID());
  await notices.stockAdditions(f.db);
  f.db.records.set("storeCommerceProfiles/" + uid, {
    preferences: { emailStockNotifications: true, stockNotifications: true },
    revision: 1,
  });
  await require("../server/commerce/account").watch(uid, {
    productId,
    stock: true,
    price: false,
  });
  await add("TEST-" + crypto.randomUUID());
  await notices.stockAdditions(f.db);
  await notices.stockAdditions(f.db);
  const queued = [...f.db.records].filter(
    ([k, v]) =>
      k.startsWith("storeEmailOutbox/") &&
      v.uid === uid &&
      v.type === "stock" &&
      v.data.planKey === planKey,
  );
  assert.equal(queued.length, 1);
  let envelope;
  await require("../server/email/service").processMessage(
    f.db,
    f.db.doc(queued[0][0]),
    {
      fetcher: async (_url, options) => {
        envelope = JSON.parse(options.body);
        return new Response(JSON.stringify({ id: crypto.randomUUID() }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
  );
  assert.equal(envelope.from, "ZENTRA STORE <bildirim@zentrastore.com.tr>");
  assert.equal(envelope.to[0], "member@zentra.invalid");
  const href = /href="([^"]+devam=[^"]+)"/
    .exec(envelope.html)[1]
    .replaceAll("&amp;", "&");
  assert.equal(
    new URL(href).searchParams.get("devam"),
    "/urun/contra-hax?paket=daily",
  );
  assert.equal(f.db.records.get(queued[0][0]).state, "accepted");
});
test("a saved favorite from before the migration receives its price drop once without needing a fresh login", async () => {
  const service = require("../server/commerce/catalogNotifications");
  f.db.records.set("storeCommerceProfiles/legacy-shopper", {
    favorites: ["kingmod"],
    preferences: { priceNotifications: true },
  });
  const ref = f.db.collection("storePriceJobs").doc("old-favorite");
  await ref.set({
    productId: "kingmod",
    planKey: "weekly",
    state: "pending",
    priceKurus: 10000,
    createdAt: Date.now(),
  });
  for (let i = 0; i < 3; i++) await service.notifyPage(f.db, ref, "price");
  const notices = [...f.db.records].filter(
    ([key, row]) =>
      key.startsWith("storeNotifications/") && row.uid === "legacy-shopper",
  );
  assert.equal(notices.length, 1);
  assert.equal(notices[0][1].templateType, "price");
  assert.equal((await ref.get()).data().state, "completed");
});
test("the original storefront and account cart share quantities while retaining unrelated cloud edits", async () => {
  const { createProfileCart } = require("../public/js/store/cart-profile.mjs");
  const items = new Map();
  const storage = {
    getItem: (k) => items.get(k),
    setItem: (k, v) => items.set(k, v),
    removeItem: (k) => items.delete(k),
  };
  let cloud = { revision: 0, cart: [] },
    shown = [];
  const request = async (_url, options) => {
    if (options) {
      assert.equal(options.method, "PATCH");
      assert.equal(options.body.expectedRevision, cloud.revision);
      cloud = {
        revision: cloud.revision + 1,
        cart: structuredClone(options.body.cart),
      };
    }
    return { result: structuredClone(cloud) };
  };
  const bridge = createProfileCart({
    storage,
    request,
    report: (error) => {
      throw error;
    },
    display: (value) => {
      shown = value;
    },
  });
  bridge.restore();
  await bridge.changed([
    { productId: "kingmod", planKey: "daily", quantity: 1 },
  ]);
  await bridge.connect("member");
  assert.equal(shown[0].quantity, 1);
  cloud.cart.push({ productId: "zolo", planKey: "weekly", quantity: 1 });
  cloud.revision++;
  shown[0].quantity = 3;
  await bridge.changed(shown);
  assert.equal(cloud.cart.find((i) => i.productId === "kingmod").quantity, 3);
  assert(cloud.cart.some((i) => i.productId === "zolo"));
  await bridge.connect("");
  assert.deepEqual(shown, []);
});
