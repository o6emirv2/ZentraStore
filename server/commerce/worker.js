"use strict";
const C = require("./common");
const { createWorker } = require("../core/workerScheduler");
async function priceNotifications() {
  const database = C.db(),
    jobs = await database
      .collection("storePriceJobs")
      .where("state", "==", "pending")
      .orderBy("createdAt", "asc")
      .limit(1)
      .get();
  for (const job of jobs.docs) await require("./catalogNotifications").notifyPage(database,job.ref,"price");
  return jobs.size;
}
async function stockNotifications() {
  const database = C.db(),
    completed = await require("./catalogNotifications").stockAdditions(database),
    watches = await database
      .collection("storeProductWatches")
      .where("stock", "==", true)
      .orderBy("checkedAt", "asc")
      .limit(10)
      .get();
  if (!watches.size) return completed;
  const catalog = await require("../core/storeService").publicCatalog();
  if (catalog.stockVerified === false) return 0;
  for (const doc of watches.docs) {
    const row = doc.data(),
      product = catalog.products.find((p) => p.id === row.productId),
      available = Number(product?.stock?.available || 0);
    await database.runTransaction(async (tx) => {
      const [fresh, profile, signal] = await Promise.all([
        tx.get(doc.ref),
        tx.get(database.collection("storeCommerceProfiles").doc(row.uid)),
        tx.get(database.collection("storeStockSignals").doc(row.productId)),
      ]);
      if (fresh.data()?.stock !== true) return;
      if (
        available > 0 &&
        (fresh.data().lastAvailable || 0) === 0 &&
        (!signal.exists || signal.data().lastAdditionAt < Math.max(fresh.data().checkedAt || 0, fresh.data().stockSince || fresh.data().createdAt || 0)) &&
        (profile.data()?.preferences?.stockNotifications === true ||
          profile.data()?.preferences?.emailStockNotifications === true)
      )
        C.notification(
          tx,
          database,
          row.uid,
          "stock:" + doc.id + ":" + (fresh.data().checkedAt || row.createdAt),
          "Takip ettiğin ürün stokta",
          "Güncel paket ve stok durumunu inceleyebilirsin.",
          { productId: row.productId },
          { site: profile.data()?.preferences?.stockNotifications === true },
        );
      tx.update(doc.ref, { checkedAt: Date.now(), lastAvailable: available });
    });
  }
  return completed;
}
async function licenseReminders() {
  const database = C.db(),
    rows = await database
      .collection("storeOrderExperience")
      .where("licenseReminderDueAt", ">", 0)
      .where("licenseReminderDueAt", "<=", Date.now())
      .limit(10)
      .get();
  for (const doc of rows.docs)
    await database.runTransaction(async (tx) => {
      const fresh = await tx.get(doc.ref),
        row = fresh.data();
      if (!row?.licenseReminderDueAt || row.licenseReminderDueAt > Date.now())
        return;
      const order = await tx.get(
          database.collection("storeOrders").doc(row.orderId),
        ),
        uid = order.data()?.giftRecipientUid || row.uid;
      const profile = uid
        ? await tx.get(database.collection("storeCommerceProfiles").doc(uid))
        : null;
      if (
        order.data()?.status === "delivered" &&
        (profile?.data()?.preferences?.licenseReminders === true ||
          profile?.data()?.preferences?.emailLicenseReminders === true)
      )
        C.notification(
          tx,
          database,
          uid,
          "license:" + doc.id + ":" + row.license.expiresAt,
          "Lisans süren yaklaşıyor",
          "Doğrulanmış bitiş tarihini siparişinde inceleyebilirsin.",
          { orderId: doc.id, expiresAt: row.license.expiresAt },
          { site: profile?.data()?.preferences?.licenseReminders === true },
        );
      tx.update(doc.ref, {
        licenseReminderDueAt: 0,
        licenseReminderCheckedAt: Date.now(),
      });
    });
  return rows.size;
}
let phase = 0;
async function run() {
  if (!require("../config/firebaseAdmin").initFirebaseAdmin().db) return 0;
  let stage = "reservation-expiry";
  try {
    await require("./reservations").expire();
    const next = phase++ % 3;
    stage = ["price-notifications", "stock-notifications", "license-reminders"][
      next
    ];
    return await [priceNotifications, stockNotifications, licenseReminders][
      next
    ]();
  } catch (error) {
    error.commerceStage = stage;
    if (
      ["9", "failed-precondition", "FAILED_PRECONDITION"].includes(
        String(error.code),
      )
    ) {
      error.cause = { code: error.code };
      error.code =
        /(?:requires? an index|create_composite|index.*(?:required|missing))/i.test(
          String(error.message || error.details || ""),
        )
          ? "COMMERCE_INDEXES_REQUIRED"
          : "COMMERCE_FAILED_PRECONDITION";
    }
    throw error;
  }
}
const worker = createWorker({
  run,
  idleMs: 60000,
  activeMs: 15000,
  onError: (error) =>
    require("../core/errorLogger").logError(error, {
      event: "commerce.worker",
      source: error.commerceStage,
    }),
});
module.exports = {
  priceNotifications,
  stockNotifications,
  licenseReminders,
  run,
  start: worker.start,
  stop: worker.stop,
  wake: worker.wake,
  status: worker.status,
};
