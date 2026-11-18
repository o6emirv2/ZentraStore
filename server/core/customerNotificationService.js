"use strict";
const crypto = require("node:crypto");
const { initFirebaseAdmin } = require("../config/firebaseAdmin");
const { failure } = require("../email/config");
const emailLabels = Object.freeze({
  queued: "Kuyrukta",
  processing: "Gönderiliyor",
  sending: "Gönderiliyor",
  retry: "Yeniden deneme bekliyor",
  uncertain: "Sonucu belirsiz",
  accepted: "Sağlayıcı kabul etti",
  delivered: "Teslim edildi",
  delayed: "Teslimat gecikti",
  failed: "Gönderim reddedildi",
  rejected: "Gönderim reddedildi",
  bounced: "Adres teslimatı reddetti",
  complained: "Şikâyet bildirildi",
  suppressed: "Gönderim engellendi",
  skipped: "Gönderilmedi",
  expired: "Talebin süresi doldu",
  needs_review: "Kontrol gerekiyor",
});
const types = Object.freeze({
  password: "Şifre yenileme",
  username: "Kullanıcı adı hatırlatma",
  password_changed: "Şifre güvenliği",
  username_changed: "Kullanıcı adı güvenliği",
  wallet_credit: "Bakiye bildirimi",
  coupon_assigned: "Kupon bildirimi",
  paid_delivered: "Sipariş ve teslimat",
  order_created: "Sipariş",
  stock: "Stok bildirimi",
  price: "Fiyat bildirimi",
  license: "Lisans bildirimi",
  gift_received: "Hediye",
  wallet: "Bakiye",
  coupon: "Kupon",
});
function database() {
  const { db } = initFirebaseAdmin();
  if (!db) throw failure("STORE_STORAGE_UNAVAILABLE", 503);
  return db;
}
const text = (value, max = 240) =>
  typeof value === "string" ? value.slice(0, max) : "";
function target(row) {
  if (row.orderId)
    return "/siparisler?order=" + encodeURIComponent(text(row.orderId, 160));
  if (row.productId)
    return (
      "/urun/" +
      encodeURIComponent(text(row.productId, 80)) +
      (row.planKey ? "?paket=" + encodeURIComponent(text(row.planKey, 40)) : "")
    );
  return row.type === "security"
    ? "/hesabim?bolum=sessions"
    : row.type === "coupon"
      ? "/kuponlar"
      : "/hesabim";
}
async function list(uid, requested = 30) {
  const db = database(),
    limit = Math.max(1, Math.min(50, Math.trunc(Number(requested) || 30)));
  const [legacy, current, emails, recovery] = await Promise.all([
    db
      .collection("storeUserNotifications")
      .doc(uid)
      .collection("items")
      .orderBy("createdAt", "desc")
      .limit(limit)
      .get(),
    db
      .collection("storeNotifications")
      .where("uid", "==", uid)
      .orderBy("createdAt", "desc")
      .limit(limit)
      .get(),
    db
      .collection("storeEmailOutbox")
      .where("uid", "==", uid)
      .orderBy("createdAt", "desc")
      .limit(20)
      .get(),
    db
      .collection("storeAccountRecoveryRequests")
      .where("uid", "==", uid)
      .orderBy("createdAt", "desc")
      .limit(10)
      .get(),
  ]);
  const notifications = [
    ...legacy.docs.map((d) => ({ d, source: "legacy" })),
    ...current.docs.map((d) => ({ d, source: "event" })),
  ]
    .map(({ d, source }) => {
      const r = d.data();
      return {
        id: source + "_" + d.id,
        type: text(r.type, 30),
        title: text(r.title, 100),
        message: text(r.message, 500),
        createdAt: Number(r.createdAt) || 0,
        readAt:
          Number(r.readAt) || (r.read === true ? Number(r.createdAt) || 1 : 0),
        href: target(r),
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
  const emailDelivery = [...emails.docs, ...recovery.docs]
    .map((d) => {
      const r = d.data(),
        state = Object.hasOwn(emailLabels, r.state) ? r.state : "uncertain";
      return {
        id: d.id,
        label: types[r.type || r.kind] || "Hesap bildirimi",
        state,
        stateLabel: emailLabels[state],
        createdAt: r.createdAt || 0,
        acceptedAt: r.acceptedAt || 0,
        deliveredAt: r.deliveredAt || 0,
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 20);
  return {
    notifications,
    emailDelivery,
    webhookConfigured:
      require("../email/config").configuration().webhookConfigured,
    limit,
  };
}
async function markRead(uid, id) {
  if (
    typeof id !== "string" ||
    !/^(?:legacy|event)_[A-Za-z0-9_-]{1,160}$/.test(id)
  )
    throw failure("STORE_NOTIFICATION_ID_REQUIRED", 400);
  const db = database(),
    legacy = id.startsWith("legacy_"),
    raw = id.slice(legacy ? 7 : 6);
  const ref = legacy
    ? db
        .collection("storeUserNotifications")
        .doc(uid)
        .collection("items")
        .doc(raw)
    : db.collection("storeNotifications").doc(raw);
  await db.runTransaction(async (tx) => {
    const r = (await tx.get(ref)).data();
    if (!r || (!legacy && r.uid !== uid))
      throw failure("STORE_NOTIFICATION_NOT_FOUND", 404);
    if (!r.readAt) tx.update(ref, { readAt: Date.now(), read: true });
  });
  return { read: true };
}
function recordEvent(
  tx,
  db,
  { uid, key, type, title, message, now = Date.now() },
) {
  if (
    !uid ||
    !key ||
    !["wallet", "coupon", "security", "account"].includes(type)
  )
    throw failure("STORE_NOTIFICATION_EVENT_INVALID");
  const id = crypto
    .createHash("sha256")
    .update([uid, type, key].join("\0"))
    .digest("hex");
  tx.create(db.collection("storeNotifications").doc(id), {
    id,
    uid,
    type,
    title,
    message,
    createdAt: now,
    readAt: 0,
  });
}
module.exports = { list, markRead, recordEvent };
