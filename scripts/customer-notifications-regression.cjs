"use strict";
const { test, before, after } = require("node:test"),
  assert = require("node:assert/strict");
const { applicationFixture } = require("./helpers/application-fixture.cjs");
let f;
before(async () => {
  f = await applicationFixture();
});
after(async () => {
  await f?.close();
});
test("notification center combines legacy stock and verified event sources without cross-account data or mail secrets", async () => {
  const now = Date.now();
  await f.db
    .collection("storeUserNotifications")
    .doc("member")
    .collection("items")
    .doc("stock1")
    .set({
      title: "Stok yenilendi",
      message: "Aylık paket",
      productId: "kingmod",
      planKey: "monthly",
      createdAt: now,
      read: false,
    });
  await f.db
    .collection("storeNotifications")
    .doc("order1")
    .set({
      uid: "member",
      title: "Teslim edildi",
      message: "Sipariş kaydın tamamlandı",
      orderId: "order-reference",
      type: "order",
      createdAt: now + 1,
      readAt: 0,
    });
  await f.db
    .collection("storeNotifications")
    .doc("private")
    .set({ uid: "owneruid", title: "Başka hesabın sırrı", createdAt: now + 2 });
  await f.db
    .collection("storeEmailOutbox")
    .doc("sent1")
    .set({
      uid: "member",
      type: "paid_delivered",
      state: "accepted",
      createdAt: now,
      payload: { text: "SECRET_MAIL_BODY" },
      providerId: "private-provider-id",
      acceptedAt: now,
    });
  const r = await f.request("/api/store/notifications", { uid: "member" });
  assert.equal(r.status, 200);
  assert.equal(r.body.notifications.length, 2);
  assert(
    r.body.notifications.some(
      (n) => n.href === "/siparisler?order=order-reference",
    ),
  );
  assert(
    r.body.notifications.some((n) => n.href === "/urun/kingmod?paket=monthly"),
  );
  assert.equal(r.body.emailDelivery[0].stateLabel, "Sağlayıcı kabul etti");
  const serialized = JSON.stringify(r.body);
  assert(!serialized.includes("SECRET_MAIL_BODY"));
  assert(!serialized.includes("private-provider-id"));
  assert(!serialized.includes("Başka hesabın"));
  assert.match(r.headers.get("cache-control"), /no-store/);
});
test("mark-read persists on its own backend record and cannot read another customer notification", async () => {
  const r = await f.request("/api/store/notifications/event_order1/read", {
    uid: "member",
    method: "PATCH",
    body: {},
  });
  assert.equal(r.status, 200);
  const doc = await f.db.collection("storeNotifications").doc("order1").get();
  assert(doc.exists);
  assert(doc.data().readAt > 0);
  const legacy = await f.request(
    "/api/store/notifications/legacy_stock1/read",
    { uid: "member", method: "PATCH", body: {} },
  );
  assert.equal(legacy.status, 200);
  assert(
    (
      await f.db
        .collection("storeUserNotifications")
        .doc("member")
        .collection("items")
        .doc("stock1")
        .get()
    ).data().readAt > 0,
  );
  const cross = await f.request("/api/store/notifications/event_private/read", {
    uid: "member",
    method: "PATCH",
    body: {},
  });
  assert.equal(cross.status, 404);
  const reread = await f.request("/api/store/notifications", { uid: "member" });
  assert(reread.body.notifications.every((n) => n.readAt > 0));
});
test("global session revocation invalidates tokens and labels historical sessions beyond the first 100 records correctly", async () => {
  const A = require("../server/commerce/account"),
    old = f.idToken("member");
  const batch = f.db.batch();
  for (let i = 0; i < 105; i++)
    batch.set(f.db.collection("storeCustomerSessions").doc("device" + i), {
      uid: "member",
      label: "Tarayıcı " + i,
      createdAt: 1,
      lastSeenAt: i + 1,
      revokedAt: 0,
    });
  await batch.commit();
  const result = await A.revokeSessions("member");
  assert.equal(result.revoked, true);
  await assert.rejects(f.auth.verifyIdToken(old, true));
  const rows = await A.sessions("member");
  assert(rows.every((r) => r.revokedAt > 0));
});
