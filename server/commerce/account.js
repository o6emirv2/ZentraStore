"use strict";
const C = require("./common");
const { normalizeItems } = require("../../public/js/app/cart.mjs");
const { getEffectiveCatalog } = require("../core/storeCatalogService");
const { initFirebaseAdmin } = require("../config/firebaseAdmin");
const DEFAULT_PREFS = Object.freeze({
  theme: "dark",
  language: "tr",
  textScale: 100,
  highContrast: false,
  reducedMotion: false,
  stockNotifications: false,
  priceNotifications: false,
  licenseReminders: false,
  emailStockNotifications: false,
  emailPriceNotifications: false,
  emailLicenseReminders: false,
  emailCouponNotifications: false,
  emailOrderNotifications: true,
  emailWalletNotifications: true,
});
function preferences(input = {}, previous = DEFAULT_PREFS) {
  C.object(input, Object.keys(DEFAULT_PREFS));
  const out = { ...DEFAULT_PREFS, ...previous };
  for (const [key, value] of Object.entries(input)) {
    if (key === "theme")
      out[key] = C.choice(value, ["system", "light", "dark"]);
    else if (key === "language") out[key] = C.choice(value, ["tr", "en"]);
    else if (key === "textScale")
      out[key] = C.choice(value, [100, 115, 130, 150, 200]);
    else out[key] = C.flag(value);
  }
  out.theme = "dark";
  return out;
}
function profile(row = {}) {
  return {
    revision: row.revision || 0,
    cart: Array.isArray(row.cart) ? row.cart : [],
    favorites: Array.isArray(row.favorites) ? row.favorites : [],
    preferences: preferences({}, row.preferences || DEFAULT_PREFS),
    updatedAt: row.updatedAt || 0,
  };
}
async function get(uid) {
  await C.activeUser(uid);
  const snap = await C.db()
    .collection("storeCommerceProfiles")
    .doc(C.uid(uid))
    .get();
  return profile(snap.data());
}
async function update(uid, input = {}) {
  C.object(input, ["expectedRevision", "cart", "favorites", "preferences"]);
  C.integer(input.expectedRevision);
  const database = C.db(),
    ref = database.collection("storeCommerceProfiles").doc(C.uid(uid));
  let nextCart, nextFavorites;
  if (input.cart !== undefined) {
    C.array(input.cart, 20);
    nextCart = normalizeItems(input.cart);
    if (nextCart.length !== input.cart.length) C.fail("STORE_CART_INVALID");
    for (const row of input.cart)
      C.object(row, [
        "productId",
        "planKey",
        "quantity",
        "acceptedUnitPriceKurus",
      ]);
    const catalog = await getEffectiveCatalog({
      includeInactive: false,
      fresh: true,
    });
    nextCart = nextCart.map((row) => {
      const p = catalog.products.find((p) => p.id === row.productId),
        plan = p?.plans.find((p) => p.key === row.planKey);
      if (!plan) C.fail("STORE_ITEM_UNAVAILABLE", 409);
      const original = input.cart.find(
        (x) => x.productId === row.productId && x.planKey === row.planKey,
      );
      return {
        ...row,
        acceptedUnitPriceKurus:
          original.acceptedUnitPriceKurus === undefined
            ? plan.priceKurus
            : C.integer(original.acceptedUnitPriceKurus, 1),
      };
    });
  }
  if (input.favorites !== undefined) {
    nextFavorites = [
      ...new Set(C.array(input.favorites, 150).map((v) => C.id(v, 80))),
    ];
  }
  return database.runTransaction(async (tx) => {
    await C.activeUser(uid, { transaction: tx, database });
    const snap = await tx.get(ref),
      old = snap.data() || {};
    C.requireRevision(old.revision, input.expectedRevision);
    const next = {
      ...old,
      uid,
      revision: (old.revision || 0) + 1,
      updatedAt: Date.now(),
      ...(nextCart ? { cart: nextCart } : {}),
      ...(nextFavorites ? { favorites: nextFavorites } : {}),
      preferences: preferences(
        input.preferences || {},
        old.preferences || DEFAULT_PREFS,
      ),
    };
    if (nextCart)
      for (const line of nextCart) {
        const previous = (old.cart || []).find(
          (x) => x.productId === line.productId && x.planKey === line.planKey,
        );
        if (line.quantity > (previous?.quantity || 0))
          tx.create(
            database
              .collection("storeAnalyticsEvents")
              .doc(
                C.hash(
                  uid,
                  String(next.revision),
                  line.productId,
                  line.planKey,
                ),
              ),
            {
              uid,
              productId: line.productId,
              event: "cart",
              quantity: line.quantity - (previous?.quantity || 0),
              createdAt: next.updatedAt,
              expiresAt: new Date(next.updatedAt + 90 * 86400000),
            },
          );
      }
    tx.set(ref, next);
    return profile(next);
  });
}
async function watch(uid, input) {
  C.object(input, ["productId", "stock", "price"]);
  const productId = C.id(input.productId, 80);
  if (input.stock !== undefined) C.flag(input.stock);
  if (input.price !== undefined) C.flag(input.price);
  const database = C.db(),
    ref = database
      .collection("storeProductWatches")
      .doc(C.hash(uid, productId));
  return database.runTransaction(async (tx) => {
    await C.activeUser(uid, { transaction: tx, database });
    const before = await tx.get(ref),
      catalog = await getEffectiveCatalog({ includeInactive: false });
    if (!catalog.products.some((p) => p.id === productId))
      C.fail("STORE_ITEM_UNAVAILABLE", 409);
    const row = {
      ...before.data(),
      uid,
      productId,
      stock: input.stock === true,
      price: input.price === true,
      checkedAt: 0,
      lastAvailable: 0,
      updatedAt: Date.now(),
      createdAt: before.data()?.createdAt || Date.now(),
    };
    tx.set(ref, row);
    return { productId, stock: row.stock, price: row.price };
  });
}
async function watches(uid) {
  await C.activeUser(uid);
  const result = await C.db()
    .collection("storeProductWatches")
    .where("uid", "==", uid)
    .limit(150)
    .get();
  return result.docs.map((d) => {
    const r = d.data();
    return {
      productId: r.productId,
      stock: r.stock === true,
      price: r.price === true,
    };
  });
}
async function recordSession(uid, input = {}, req = {}) {
  C.object(input, ["deviceId", "label"]);
  const deviceId = C.id(input.deviceId, 80),
    label = C.text(input.label || "Tarayıcı", 80);
  const database = C.db(),
    ref = database
      .collection("storeCustomerSessions")
      .doc(C.hash(uid, deviceId));
  await C.activeUser(uid);
  const old = await ref.get(),
    now = Date.now();
  await ref.set(
    {
      uid,
      deviceId,
      label,
      createdAt: old.data()?.createdAt || now,
      lastSeenAt: now,
      authTime: Number(req.user?.auth_time || 0) * 1000,
      revokedAt: 0,
    },
    { merge: true },
  );
  return { id: ref.id, label, lastSeenAt: now };
}
async function sessions(uid) {
  await C.activeUser(uid);
  const rows = await C.db()
    .collection("storeCustomerSessions")
    .where("uid", "==", uid)
    .orderBy("lastSeenAt", "desc")
    .limit(30)
    .get();
  const cutoff =
    Number(
      (
        await C.db()
          .collection("storeCustomerSessionRevocations")
          .doc(uid)
          .get()
      ).data()?.revokedAt,
    ) || 0;
  return rows.docs.map((d) => ({
    id: d.id,
    label: d.data().label,
    createdAt: d.data().createdAt,
    lastSeenAt: d.data().lastSeenAt,
    revokedAt:
      d.data().revokedAt || (d.data().lastSeenAt <= cutoff ? cutoff : 0),
  }));
}
async function revokeSessions(uid) {
  const firebase = initFirebaseAdmin();
  await C.activeUser(uid);
  if (!firebase.auth) C.fail("AUTH_UNAVAILABLE", 503);
  await firebase.auth.revokeRefreshTokens(uid);
  await C.db()
    .collection("storeCustomerSessionRevocations")
    .doc(uid)
    .set({ revokedAt: Date.now() });
  await require("../core/adminSessionRegistry").revokeAdminSessionsForUser(uid);
  const rows = await C.db()
      .collection("storeCustomerSessions")
      .where("uid", "==", uid)
      .limit(100)
      .get(),
    batch = C.db().batch();
  for (const d of rows.docs)
    batch.set(d.ref, { revokedAt: Date.now() }, { merge: true });
  await batch.commit();
  return { revoked: true, signInRequired: true };
}
async function exportData(uid) {
  await C.activeUser(uid);
  const database = C.db(),
    names = [
      "storeOrders",
      "storeWalletLedger",
      "storeSupportTickets",
      "storeReviews",
      "storeCustomerRequests",
      "storeDataRequests",
      "storeNotifications",
      "storeEmailOutbox",
      "storePasswordOperations",
    ];
  const [person, preferences, ...snapshots] = await Promise.all([
    database.collection("users").doc(uid).get(),
    get(uid),
    ...names.map((name) =>
      database.collection(name).where("uid", "==", uid).limit(1000).get(),
    ),
  ]);
  const rows = Object.fromEntries(
    names.map((name, i) => [
      name,
      snapshots[i].docs.map((d) => ({ ...d.data(), id: d.id })),
    ]),
  );
  const p = person.data() || {};
  return {
    schemaVersion: 2,
    generatedAt: Date.now(),
    account: {
      uid,
      username: p.username || "",
      firstName: p.firstName || "",
      lastName: p.lastName || "",
      birthDate: p.birthDate || "",
      email: p.email || "",
    },
    preferences,
    orders: rows.storeOrders.map((o) => ({
      id: o.id,
      orderNumber: o.orderNumber,
      status: o.status,
      createdAt: o.createdAt,
      totalKurus: o.totalKurus,
      items: (o.items || []).map((x) => ({
        productId: x.productId,
        productName: x.productName,
        planKey: x.planKey,
        quantity: x.quantity,
        lineTotalKurus: x.lineTotalKurus,
      })),
    })),
    wallet: rows.storeWalletLedger.map((x) => ({
      id: x.id,
      type: x.type,
      amountKurus: x.amountKurus,
      balanceBeforeKurus: x.balanceBeforeKurus,
      balanceAfterKurus: x.balanceAfterKurus,
      orderId: x.orderId || "",
      createdAt: x.createdAt,
    })),
    tickets: rows.storeSupportTickets.map((x) => ({
      id: x.id,
      orderId: x.orderId,
      subject: x.subject,
      status: x.status,
      createdAt: x.createdAt,
      messages: (x.messages || []).map((m) => ({
        role: m.role,
        message: m.message,
        createdAt: m.createdAt,
      })),
      satisfaction: x.satisfaction || null,
    })),
    reviews: rows.storeReviews.map((x) => ({
      id: x.id,
      productId: x.productId,
      rating: x.rating,
      title: x.title,
      message: x.message,
      status: x.status,
      createdAt: x.createdAt,
    })),
    requests: [...rows.storeCustomerRequests, ...rows.storeDataRequests].map(
      (x) => ({
        id: x.id,
        kind: x.kind,
        orderId: x.orderId || "",
        subject: x.subject || "",
        message: x.message,
        status: x.status,
        reply: x.reply || "",
        createdAt: x.createdAt,
        updatedAt: x.updatedAt,
      }),
    ),
    notifications: rows.storeNotifications.map((x) => ({
      id: x.id,
      title: x.title,
      message: x.message,
      createdAt: x.createdAt,
      readAt: x.readAt || 0,
    })),
    emailNotifications: rows.storeEmailOutbox.map((x) => ({
      id: x.id,
      type: x.type,
      state: x.state,
      createdAt: x.createdAt,
      acceptedAt: x.acceptedAt || 0,
      deliveredAt: x.deliveredAt || 0,
      failureCode: x.failureCode || "",
    })),
    passwordChanges: rows.storePasswordOperations.map((x) => ({
      id: x.id,
      state: x.state,
      createdAt: x.createdAt,
      completedAt: x.completedAt || 0,
    })),
    scope: {
      perCollectionLimit: 1000,
      collections: names,
      mayBeTruncated: snapshots.some((s) => s.size === 1000),
      vaultSecretsIncluded: false,
    },
    financialRecordsRetained: true,
  };
}
async function dataRequest(uid, input) {
  C.object(input, ["kind", "message", "idempotencyKey"]);
  const kind = C.choice(input.kind, ["access", "correction", "deletion"]),
    message = C.text(input.message, 2000, { required: true }),
    key = C.id(input.idempotencyKey, 100),
    database = C.db(),
    ref = database.collection("storeDataRequests").doc(C.hash(uid, key));
  return database.runTransaction(async (tx) => {
    await C.activeUser(uid, { transaction: tx, database });
    const old = await tx.get(ref);
    if (old.exists) {
      if (old.data().kind !== kind || old.data().message !== message)
        C.fail("COMMERCE_IDEMPOTENCY_CONFLICT", 409);
      return { id: ref.id, status: old.data().status };
    }
    tx.create(ref, {
      uid,
      kind,
      message,
      status: "pending",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return { id: ref.id, status: "pending" };
  });
}
module.exports = {
  DEFAULT_PREFS,
  preferences,
  get,
  update,
  watch,
  watches,
  recordSession,
  sessions,
  revokeSessions,
  exportData,
  dataRequest,
};
async function dataDecision(requestId, input, actor) {
  C.object(input, ["status", "reply"]);
  const status = C.choice(input.status, ["reviewing", "replied", "rejected"]),
    reply = C.text(input.reply, 4000, { required: true }),
    database = C.db(),
    ref = database.collection("storeDataRequests").doc(C.id(requestId));
  return database.runTransaction(async (tx) => {
    const old = await tx.get(ref);
    if (!old.exists) C.fail("COMMERCE_REQUEST_NOT_FOUND", 404);
    tx.update(ref, {
      status,
      reply,
      updatedAt: Date.now(),
      updatedBy: actor.uid,
    });
    C.audit(tx, database, "commerce.privacy.reply", actor, {
      requestId,
      status,
    });
    C.notification(
      tx,
      database,
      old.data().uid,
      "privacy:" + requestId + ":" + status,
      "Veri talebin yanıtlandı",
      reply,
    );
    return { id: requestId, status, reply, financialRecordsRetained: true };
  });
}
module.exports.dataDecision = dataDecision;
