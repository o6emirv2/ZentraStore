"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict"),
  crypto = require("node:crypto");
const { applicationFixture } = require("./helpers/application-fixture.cjs");
let f, owner, email, K, routes, product;
const providerId = () => crypto.randomUUID();
const provider =
  (id = providerId()) =>
  async () => ({ ok: true, status: 200, json: async () => ({ id }) });
const rows = () =>
  [...f.db.records.entries()]
    .filter(([k]) => k.startsWith("storeEmailOutbox/"))
    .map(([, v]) => v);
async function event(type = "test", data = {}, uid = "member") {
  let id;
  await f.db.runTransaction((tx) => {
    id = email.enqueue(tx, f.db, { uid, type, key: crypto.randomUUID(), data });
  });
  return f.db.collection("storeEmailOutbox").doc(id);
}
async function due(ref, patch = {}) {
  await ref.update({ availableAt: 0, ...patch });
}
function sign(
  body,
  timestamp = String(Math.floor(Date.now() / 1000)),
  id = "msg_" + crypto.randomUUID(),
) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const signature = crypto
    .createHmac(
      "sha256",
      Buffer.from(process.env.RESEND_WEBHOOK_SECRET.slice(6), "base64"),
    )
    .update(`${id}.${timestamp}.${raw}`)
    .digest("base64");
  return {
    raw: Buffer.from(raw),
    headers: {
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature": "v1," + signature,
    },
  };
}
function payload(type, emailId, createdAt = Date.now()) {
  return {
    type,
    created_at: new Date(createdAt).toISOString(),
    data: { email_id: emailId },
  };
}
before(async () => {
  process.env.RESEND_API_KEY =
    "re_" + crypto.randomBytes(30).toString("base64url");
  process.env.EMAIL_NOTIFICATIONS_ENABLED = "true";
  process.env.RESEND_WEBHOOK_SECRET =
    "whsec_" + crypto.randomBytes(32).toString("base64");
  f = await applicationFixture();
  owner = await f.openAdmin();
  email = require("../server/email/service");
  K = require("../server/email/config");
  routes = require("../server/email/routes");
  product = (await f.request("/api/store/catalog")).body.catalog.products.find(
    (p) =>
      p.fulfillmentMode !== "telegram_only" && p.plans[0].priceKurus < 50000,
  );
});
after(async () => {
  email?.stop();
  await f?.close();
});
test("absent credentials or a disabled channel cannot create phantom sends", async () => {
  const before = rows().length;
  process.env.EMAIL_NOTIFICATIONS_ENABLED = "false";
  await event();
  assert.equal(rows().length, before);
  process.env.EMAIL_NOTIFICATIONS_ENABLED = "true";
  const key = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = "";
  await event();
  assert.equal(rows().length, before);
  process.env.RESEND_API_KEY = key;
});
test("provider acceptance is recorded separately from delivery with real own-logo content", async () => {
  const ref = await event();
  let calls = 0;
  await email.processMessage(f.db, ref, {
    fetcher: async (url, options) => {
      calls++;
      assert.equal(url, "https://api.resend.com/emails");
      assert.equal(options.redirect, "error");
      const body = JSON.parse(options.body);
      assert.equal(body.from, "ZENTRA STORE <bildirim@zentrastore.com.tr>");
      assert.deepEqual(body.to, ["member@zentra.invalid"]);
      assert(body.html.includes("/public/assets/images/logo.png"));
      assert(body.text);
      assert(!body.html.includes("onboarding@resend.dev"));
      return provider()();
    },
  });
  assert.equal((await ref.get()).data().state, "accepted");
  assert.equal((await ref.get()).data().deliveredAt, undefined);
  await email.processMessage(f.db, ref, {
    fetcher: async () => {
      calls++;
    },
  });
  assert.equal(calls, 1);
});
test("concurrent workers claim a message once", async () => {
  const ref = await event();
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return provider()();
  };
  await Promise.all(
    [1, 2, 3].map(() => email.processMessage(f.db, ref, { fetcher })),
  );
  assert.equal(calls, 1);
});
test("lost provider replies retry the identical payload and idempotency key", async () => {
  const ref = await event(),
    requests = [],
    accepted = new Map();
  const fetcher = async (_url, options) => {
    requests.push(options);
    const key = options.headers["Idempotency-Key"];
    if (!accepted.has(key)) accepted.set(key, providerId());
    if (requests.length === 1) throw new TypeError("controlled response loss");
    return provider(accepted.get(key))();
  };
  await email.processMessage(f.db, ref, { fetcher });
  assert.equal((await ref.get()).data().state, "retry");
  await due(ref);
  await email.processMessage(f.db, ref, { fetcher });
  assert.equal(requests.length, 2);
  assert.equal(accepted.size, 1);
  assert.equal(requests[0].body, requests[1].body);
  assert.equal(
    requests[0].headers["Idempotency-Key"],
    requests[1].headers["Idempotency-Key"],
  );
});
test("expired idempotency windows require review instead of resending", async () => {
  const ref = await event();
  await due(ref, { firstAttemptAt: Date.now() - 24 * 3600000, attempts: 1 });
  let calls = 0;
  await email.processMessage(f.db, ref, {
    fetcher: async () => {
      calls++;
    },
  });
  assert.equal(calls, 0);
  assert.equal((await ref.get()).data().state, "needs_review");
});
test("a crashed sender can recover its lease within the provider window", async () => {
  const ref = await event();
  await due(ref, {
    state: "sending",
    lease: "expired",
    firstAttemptAt: Date.now() - 70000,
    attempts: 1,
  });
  await email.processMessage(f.db, ref, { fetcher: provider() });
  assert.equal((await ref.get()).data().state, "accepted");
});
test("429 is retried with a bounded delay and 403 never reports success", async () => {
  const ref = await event();
  await email.processMessage(f.db, ref, {
    fetcher: async () => ({
      ok: false,
      status: 429,
      headers: { get: () => "120" },
      json: async () => ({}),
    }),
  });
  assert.equal((await ref.get()).data().state, "retry");
  assert((await ref.get()).data().availableAt >= Date.now() + 110000);
  const bad = await event();
  await email.processMessage(f.db, bad, {
    fetcher: async () => ({ ok: false, status: 403, json: async () => ({}) }),
  });
  assert.equal((await bad.get()).data().state, "failed");
  assert(!(await bad.get()).data().acceptedAt);
});
test("unverified and suspended accounts cannot receive transaction details", async () => {
  f.users.get("member").emailVerified = false;
  const a = await event();
  await email.processMessage(f.db, a, {
    fetcher: async () => {
      throw Error("must not send");
    },
  });
  assert.equal((await a.get()).data().state, "skipped");
  f.users.get("member").emailVerified = true;
  const row = f.db.records.get("users/member");
  row.storeAccountStatus = "suspended";
  const b = await event();
  await email.processMessage(f.db, b, {
    fetcher: async () => {
      throw Error("must not send");
    },
  });
  assert.equal((await b.get()).data().state, "skipped");
  row.storeAccountStatus = "active";
});
test("a retry never transfers private details to a changed email address", async () => {
  const ref = await event();
  await email.processMessage(f.db, ref, {
    fetcher: async () => {
      throw Error("controlled timeout");
    },
  });
  await due(ref);
  f.users.get("member").email = "changed@zentra.invalid";
  await email.processMessage(f.db, ref, {
    fetcher: async () => {
      throw Error("must not send");
    },
  });
  assert.equal((await ref.get()).data().failureCode, "EMAIL_RECIPIENT_CHANGED");
  f.users.get("member").email = "member@zentra.invalid";
});
test("optional email preferences default off and survive older account preferences", async () => {
  const prefs = (
    await f.request("/api/store/commerce/profile", { uid: "member" })
  ).body.result;
  assert.equal(prefs.preferences.emailStockNotifications, false);
  assert.equal(prefs.preferences.emailOrderNotifications, true);
  f.db.records.set("storePromotions/EMAIL100", {
    code: "EMAIL100",
    type: "fixed",
    value: 10000,
    active: true,
    customerUids: ["member"],
  });
  const ref = await event("coupon_assigned", { code: "EMAIL100" });
  await email.processMessage(f.db, ref, {
    fetcher: async () => {
      throw Error("must not send");
    },
  });
  assert.equal((await ref.get()).data().state, "skipped");
});
test("unsubscribe tokens are encrypted, scoped, expiring and cannot opt users in", async () => {
  const token = K.unsubscribeToken("member", "stock");
  assert(!token.includes("member"));
  assert.equal(K.readUnsubscribe(token).category, "stock");
  assert.throws(() => K.readUnsubscribe(token + "x"));
  assert.throws(() =>
    K.readUnsubscribe(
      K.unsubscribeToken("member", "price", Date.now() - 181 * 86400000),
    ),
  );
  f.db.records.set("storeCommerceProfiles/member", {
    revision: 4,
    preferences: {
      theme: "dark",
      emailStockNotifications: true,
      emailPriceNotifications: true,
    },
  });
  await email.unsubscribe(token);
  const p = f.db.records.get("storeCommerceProfiles/member");
  assert.equal(p.revision, 5);
  assert.equal(p.preferences.emailStockNotifications, false);
  assert.equal(p.preferences.emailPriceNotifications, true);
  assert.equal(p.preferences.theme, "dark");
});
test("GET unsubscribe confirmation does not change state; POST applies the scoped choice", async () => {
  const token = K.unsubscribeToken("member", "price");
  const before = f.db.records.get("storeCommerceProfiles/member").revision;
  let r = await fetch(f.origin + "/email/unsubscribe?token=" + token);
  assert.equal(r.status, 200);
  assert((await r.text()).includes("<form"));
  assert.equal(
    f.db.records.get("storeCommerceProfiles/member").revision,
    before,
  );
  r = await fetch(f.origin + "/email/unsubscribe?token=" + token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "List-Unsubscribe=One-Click",
  });
  assert.equal(r.status, 200);
  assert.equal(
    f.db.records.get("storeCommerceProfiles/member").preferences
      .emailPriceNotifications,
    false,
  );
});
test("coupon emails use actual assigned codes with unsubscribe headers and escaped HTML", async () => {
  f.db.records.set("storeCommerceProfiles/member", {
    preferences: { emailCouponNotifications: true },
  });
  const ref = await event("coupon_assigned", { code: "EMAIL100" });
  await email.processMessage(f.db, ref, {
    fetcher: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert(body.html.includes("EMAIL100"));
      assert(body.headers["List-Unsubscribe"]);
      assert.equal(
        body.headers["List-Unsubscribe-Post"],
        "List-Unsubscribe=One-Click",
      );
      return provider()();
    },
  });
  assert.equal((await ref.get()).data().state, "accepted");
  const other = await event("coupon_assigned", { code: "EMAIL100" }, "viewer");
  f.db.records.set("storeCommerceProfiles/viewer", {
    preferences: { emailCouponNotifications: true },
  });
  await email.processMessage(f.db, other, {
    fetcher: async () => {
      throw Error("must not send");
    },
  });
  assert.equal((await other.get()).data().state, "skipped");
});
test("webhook verification uses exact raw bytes, timestamp checks and rotating signatures", () => {
  const signed = sign(payload("email.delivered", providerId()));
  assert(routes.verifyWebhook(signed.raw, signed.headers).messageId);
  assert.throws(() =>
    routes.verifyWebhook(
      Buffer.concat([signed.raw, Buffer.from(" ")]),
      signed.headers,
    ),
  );
  const stale = sign(
    payload("email.delivered", providerId()),
    String(Math.floor(Date.now() / 1000) - 601),
  );
  assert.throws(() => routes.verifyWebhook(stale.raw, stale.headers));
  assert(
    routes.verifyWebhook(signed.raw, {
      ...signed.headers,
      "svix-signature":
        "v1," +
        Buffer.alloc(32).toString("base64") +
        " " +
        signed.headers["svix-signature"],
    }),
  );
});
test("signed webhooks need no browser Origin or App Check but unsigned requests are denied", async () => {
  const signed = sign(payload("email.delivered", providerId()));
  let r = await fetch(f.origin + "/api/webhooks/resend", {
    method: "POST",
    headers: { ...signed.headers, "content-type": "application/json" },
    body: signed.raw,
  });
  assert.equal(r.status, 200);
  r = await fetch(f.origin + "/api/webhooks/resend", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: signed.raw,
  });
  assert.equal(r.status, 401);
});
test("signed delivery events update the correct job once and never downgrade a bounce", async () => {
  const ref = await event(),
    pid = providerId();
  await email.processMessage(f.db, ref, { fetcher: provider(pid) });
  const msg = "msg_" + crypto.randomUUID();
  await email.providerEvent(payload("email.delivered", pid), msg);
  assert.equal((await ref.get()).data().state, "delivered");
  assert((await ref.get()).data().deliveredAt);
  assert.equal(
    (await email.providerEvent(payload("email.delivered", pid), msg)).replay,
    true,
  );
  await email.providerEvent(
    payload("email.bounced", pid),
    "msg_" + crypto.randomUUID(),
  );
  await email.providerEvent(
    payload("email.sent", pid),
    "msg_" + crypto.randomUUID(),
  );
  assert.equal((await ref.get()).data().state, "bounced");
  assert.equal(
    f.db.records.get(
      "storeEmailSuppressions/" + K.addressHash("member@zentra.invalid"),
    ).blocked,
    true,
  );
  f.db.records.delete(
    "storeEmailSuppressions/" + K.addressHash("member@zentra.invalid"),
  );
});
test("webhooks that precede the send response are reconciled without losing delivery", async () => {
  const ref = await event(),
    pid = providerId();
  await email.providerEvent(
    payload("email.delivered", pid),
    "msg_" + crypto.randomUUID(),
  );
  await email.processMessage(f.db, ref, { fetcher: provider(pid) });
  assert.equal((await ref.get()).data().state, "delivered");
});
test("suppressed recipients are not retried even for security notices", async () => {
  f.db.records.set(
    "storeEmailSuppressions/" + K.addressHash("member@zentra.invalid"),
    { blocked: true },
  );
  const ref = await event();
  await email.processMessage(f.db, ref, {
    fetcher: async () => {
      throw Error("must not send");
    },
  });
  assert.equal((await ref.get()).data().state, "skipped");
  f.db.records.delete(
    "storeEmailSuppressions/" + K.addressHash("member@zentra.invalid"),
  );
});
test("a committed wallet credit creates exactly one email and rolls back with the ledger", async () => {
  const key = crypto.randomUUID(),
    before = rows().length;
  const service = require("../server/core/storeService");
  const args = {
    targetUid: "member",
    amountKurus: 10000,
    type: "CREDIT",
    reason: "Test hediye bakiye",
    actor: { uid: "owneruid" },
    idempotencyKey: key,
  };
  const r = await service.adjustStoreBalance(args);
  await service.adjustStoreBalance(args);
  assert.equal(rows().length, before + 1);
  const job = rows().find(
    (row) =>
      row.data.transactionId === r.transactionId &&
      row.type === "wallet_credit",
  );
  const ref = f.db.collection("storeEmailOutbox").doc(job.id);
  await email.processMessage(f.db, ref, {
    fetcher: async (_url, options) => {
      const b = JSON.parse(options.body);
      assert(b.text.includes("100,00"));
      return provider()();
    },
  });
  assert.equal((await ref.get()).data().state, "accepted");
  assert.equal(job.data.transactionId, r.transactionId);
  const count = rows().length;
  f.db.setFailure(true);
  await assert.rejects(
    service.adjustStoreBalance({
      ...args,
      idempotencyKey: crypto.randomUUID(),
    }),
  );
  f.db.setFailure(false);
  assert.equal(rows().length, count);
});
test("password changes are provider-confirmed, journalled, secret-free and idempotent", async () => {
  const body = {
    currentPassword: f.users.get("member").password,
    newPassword: "Email regression new password!",
    idempotencyKey: crypto.randomUUID(),
  };
  const r = await f.request("/api/store/profile/password", {
    uid: "member",
    method: "POST",
    body,
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.changed, true);
  const count = f.passwordChanges;
  const replay = await f.request("/api/store/profile/password", {
    uid: "member",
    method: "POST",
    body,
  });
  assert.equal(replay.status, 200);
  assert.equal(f.passwordChanges, count);
  const job = rows().find((r) => r.type === "password_changed");
  assert(job);
  const stored = JSON.stringify([...f.db.records.values()]);
  assert(!stored.includes(body.currentPassword));
  assert(!stored.includes(body.newPassword));
  assert(!stored.includes(process.env.RESEND_API_KEY));
  await email.processMessage(
    f.db,
    f.db.collection("storeEmailOutbox").doc(job.id),
    { fetcher: provider() },
  );
  assert.equal(
    f.db.records.get("storeEmailOutbox/" + job.id).state,
    "accepted",
  );
});
test("password endpoints reject guests, old authentication and wrong current passwords", async () => {
  const body = {
    currentPassword: "wrong",
    newPassword: "New password unknown!",
    idempotencyKey: crypto.randomUUID(),
  };
  assert.equal(
    (await f.request("/api/store/profile/password", { method: "POST", body }))
      .status,
    401,
  );
  assert.equal(
    (
      await f.request("/api/store/profile/password", {
        uid: "member",
        method: "POST",
        body,
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await f.request("/api/store/profile/password", {
        token: f.idToken("member", Math.floor(Date.now() / 1000) - 4000),
        method: "POST",
        body,
      })
    ).status,
    401,
  );
});
test("real username changes enqueue a security notice without exposing HTML", async () => {
  const r = await f.request("/api/store/profile/username", {
    uid: "member",
    method: "PATCH",
    body: { username: "EmailMember" },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert(
    rows().some(
      (r) => r.type === "username_changed" && r.data.current === "EmailMember",
    ),
  );
  const output = require("../server/email/templates").render(
    {
      uid: "member",
      id: crypto.randomUUID(),
      type: "username_changed",
      category: "security",
      data: { previous: '<img src=x onerror="alert(1)">', current: "name" },
      createdAt: Date.now(),
    },
    {},
    "member@zentra.invalid",
  );
  assert(!output.html.includes("<img src=x"));
  assert(output.html.includes("&lt;img"));
  assert(!output.headers);
});
test("stock and price events enqueue email in the same database transaction", async () => {
  const C = require("../server/commerce/common");
  const count = rows().length;
  await f.db.runTransaction((tx) =>
    C.notification(
      tx,
      f.db,
      "member",
      "price:" + crypto.randomUUID(),
      "Fiyat",
      "Güncellendi",
      {
        productId: product.id,
        planKey: product.plans[0].key,
        priceKurus: product.plans[0].priceKurus,
      },
    ),
  );
  await f.db.runTransaction((tx) =>
    C.notification(
      tx,
      f.db,
      "member",
      "stock:" + crypto.randomUUID(),
      "Stok",
      "Geldi",
      { productId: product.id },
    ),
  );
  assert.equal(rows().length, count + 2);
});
test("delivered text is refused without real payment and delivery records", async () => {
  f.db.records.set("storeOrders/not-paid", {
    uid: "member",
    status: "delivered",
    paymentMethod: "wallet",
    totalKurus: 100,
    approvedAt: Date.now(),
    items: [{ quantity: 1 }],
    delivery: { status: "delivered", deliveredAt: Date.now(), itemCount: 1 },
  });
  const ref = await event("paid_delivered", { orderId: "not-paid" });
  await email.processMessage(f.db, ref, {
    fetcher: async () => {
      throw Error("must not send");
    },
  });
  assert.equal((await ref.get()).data().state, "skipped");
});
test("actual encrypted inventory purchase queues one payment and delivery email under replay", async () => {
  const imported = await f.adminWrite(
    owner,
    "/api/admin/store/inventory/import",
    "POST",
    {
      productId: product.id,
      planKey: product.plans[0].key,
      keys: [
        "EMAIL-DELIVERY-PRIVATE-001",
        "EMAIL-DELIVERY-PRIVATE-002",
        "EMAIL-DELIVERY-PRIVATE-003",
      ],
      idempotencyKey: crypto.randomUUID(),
    },
  );
  assert.equal(imported.status, 201, JSON.stringify(imported.body));
  const body = {
    items: [
      { productId: product.id, planKey: product.plans[0].key, quantity: 1 },
    ],
    paymentMethod: "wallet",
    idempotencyKey: crypto.randomUUID(),
  };
  const created = await f.request("/api/store/orders", {
    uid: "member",
    method: "POST",
    body,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.order.status, "delivered");
  const repeated = await f.request("/api/store/orders", {
    uid: "member",
    method: "POST",
    body,
  });
  assert.equal(repeated.body.order.id, created.body.order.id);
  const jobs = rows().filter(
    (r) =>
      r.type === "paid_delivered" && r.data.orderId === created.body.order.id,
  );
  assert.equal(jobs.length, 1);
  const ref = f.db.collection("storeEmailOutbox").doc(jobs[0].id);
  await email.processMessage(f.db, ref, {
    fetcher: async (_url, options) => {
      assert(!options.body.includes("EMAIL-DELIVERY-PRIVATE"));
      assert(JSON.parse(options.body).text.includes("ödeme onayı"));
      return provider()();
    },
  });
  assert.equal((await ref.get()).data().state, "accepted");
});
test("stock and price workers use real subscriptions and only current product facts", async () => {
  f.db.records.set("storeCommerceProfiles/member", {
    preferences: {
      stockNotifications: true,
      priceNotifications: true,
      emailStockNotifications: true,
      emailPriceNotifications: true,
    },
  });
  await require("../server/commerce/account").watch("member", {
    productId: product.id,
    stock: true,
    price: true,
  });
  const before = rows().length;
  await require("../server/commerce/worker").stockNotifications();
  assert.equal(rows().length, before + 1);
  const stock = rows().at(-1);
  assert.equal(stock.type, "stock");
  const ref = f.db.collection("storeEmailOutbox").doc(stock.id);
  await email.processMessage(f.db, ref, { fetcher: provider() });
  assert.equal((await ref.get()).data().state, "accepted");
  await require("../server/commerce/worker").stockNotifications();
  assert.equal(rows().length, before + 1);
  const price = await event("price", {
    productId: product.id,
    planKey: product.plans[0].key,
    priceKurus: product.plans[0].priceKurus,
  });
  await email.processMessage(f.db, price, { fetcher: provider() });
  assert.equal((await price.get()).data().state, "accepted");
});
test("targeted coupon publishing creates one actual assignment message", async () => {
  const service = require("../server/core/storePromotionService");
  const code = "NOTIFY-" + crypto.randomBytes(4).toString("hex").toUpperCase();
  const input = {
    title: "Özel kupon",
    type: "fixed",
    value: 10000,
    minimumSubtotalKurus: 20000,
    maxDiscountKurus: 10000,
    usageLimit: 1,
    perUserLimit: 1,
    customerUids: ["member"],
    active: true,
    visibleInWallet: true,
    createOnly: true,
  };
  await service.savePromotion(code, input, { uid: "owneruid" });
  assert.equal(
    rows().filter((r) => r.type === "coupon_assigned" && r.data.code === code)
      .length,
    1,
  );
  await service.savePromotion(
    code,
    { ...input, createOnly: false },
    { uid: "owneruid" },
  );
  assert.equal(
    rows().filter((r) => r.type === "coupon_assigned" && r.data.code === code)
      .length,
    1,
  );
});
test("gift recipients receive only their own delivery notice without purchaser details", async () => {
  const now = Date.now(),
    order = {
      id: "email-gift",
      uid: "member",
      giftRecipientUid: "viewer",
      orderNumber: "GIFT-TEST",
      status: "delivered",
      paymentMethod: "wallet",
      totalKurus: 1000,
      approvedAt: now,
      items: [
        { productId: product.id, planKey: product.plans[0].key, quantity: 1 },
      ],
      delivery: { status: "delivered", deliveredAt: now, itemCount: 1 },
    };
  f.db.records.set("storeOrders/email-gift", order);
  f.db.records.set("storeWalletLedger/purchase_email-gift", {
    uid: "member",
    type: "DEBIT",
    amountKurus: -1000,
  });
  await f.db.runTransaction((tx) =>
    email.orderEvent(tx, f.db, order, { created: true }),
  );
  const job = rows().find(
    (r) => r.type === "gift_received" && r.data.orderId === order.id,
  );
  assert.equal(job.uid, "viewer");
  const ref = f.db.collection("storeEmailOutbox").doc(job.id);
  await email.processMessage(f.db, ref, {
    fetcher: async (_url, options) => {
      const b = JSON.parse(options.body);
      assert.deepEqual(b.to, ["viewer@zentra.invalid"]);
      assert(!b.text.includes("member@"));
      assert(!b.text.includes("1.000"));
      return provider()();
    },
  });
  assert.equal((await ref.get()).data().state, "accepted");
});
test("revoked notification preferences cancel queued optional messages", async () => {
  const ref = await event("price", {
    productId: product.id,
    planKey: product.plans[0].key,
    priceKurus: product.plans[0].priceKurus,
  });
  await email.unsubscribe(K.unsubscribeToken("member", "price"));
  await email.processMessage(f.db, ref, {
    fetcher: async () => {
      throw Error("must not send");
    },
  });
  assert.equal((await ref.get()).data().state, "skipped");
});
test("email-only price subscriptions do not enable site notifications and deduplicate job replays", async () => {
  f.db.records.set("storeCommerceProfiles/member", {
    preferences: { priceNotifications: false, emailPriceNotifications: true },
  });
  const id = "price-email-only-" + crypto.randomUUID();
  f.db.records.set("storePriceJobs/" + id, {
    productId: product.id,
    planKey: product.plans[0].key,
    priceKurus: product.plans[0].priceKurus,
    previousPriceKurus: product.plans[0].priceKurus + 100,
    state: "pending",
    createdAt: Date.now(),
    cursor: "",
  });
  const before = rows().length,
    siteBefore = [...f.db.records.keys()].filter((k) =>
      k.startsWith("storeNotifications/"),
    ).length;
  await require("../server/commerce/worker").priceNotifications();
  assert.equal(rows().length, before + 1);
  assert.equal(
    [...f.db.records.keys()].filter((k) => k.startsWith("storeNotifications/"))
      .length,
    siteBefore,
  );
  f.db.records.get("storePriceJobs/" + id).state = "pending";
  f.db.records.get("storePriceJobs/" + id).cursor = "";
  await require("../server/commerce/worker").priceNotifications();
  assert.equal(rows().length, before + 1);
});
test("admin email history requires RBAC and never returns keys or frozen message payloads", async () => {
  assert.equal(
    (await f.request("/api/admin/store/commerce/email")).status,
    401,
  );
  assert.equal(
    (await f.request("/api/admin/store/commerce/email", { uid: "member" }))
      .status,
    403,
  );
  const r = await f.request("/api/admin/store/commerce/email", owner);
  assert.equal(r.status, 200);
  assert(r.body.result.items.length <= 50);
  const text = JSON.stringify(r.body);
  assert(!text.includes(process.env.RESEND_API_KEY));
  assert(!text.includes(process.env.RESEND_WEBHOOK_SECRET));
  assert(!text.includes('"payload"'));
});
test("personal exports include only the account's email history and exclude authentication digests", async () => {
  const result = await f.request("/api/store/commerce/export", {
    uid: "member",
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert(result.body.result.emailNotifications.length > 0);
  assert(result.body.result.passwordChanges.length > 0);
  const exported = JSON.stringify(result.body.result);
  assert(!exported.includes('"inputDigest"'));
  assert(!exported.includes('"payload"'));
  assert(!exported.includes("viewer@zentra.invalid"));
  const ownIds = new Set(
    rows()
      .filter((r) => r.uid === "member")
      .map((r) => r.id),
  );
  assert(result.body.result.emailNotifications.every((r) => ownIds.has(r.id)));
});
test("admin test is scoped to the current verified admin and requires a fresh action proof", async () => {
  const path = "/api/admin/store/commerce/email/test",
    body = { idempotencyKey: crypto.randomUUID() };
  assert.notEqual(
    (await f.request(path, { ...owner, method: "POST", body })).status,
    200,
  );
  const r = await f.adminWrite(owner, path, "POST", body);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.result.queued, true);
  assert.equal(
    f.db.records.get("storeEmailOutbox/" + r.body.result.id).uid,
    "owneruid",
  );
  assert.equal(
    (
      await f.adminWrite(owner, path, "POST", {
        ...body,
        to: "other@zentra.invalid",
      })
    ).status,
    400,
  );
});
