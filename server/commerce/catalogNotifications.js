"use strict";

const C = require("./common");
const pageSize = 20;

function queueStockAddition(tx, db, receiptId, product, plan, added, now) {
  const ref = db
    .collection("storeStockAdditionJobs")
    .doc(C.hash(receiptId, product.id));
  tx.create(ref, {
    productId: product.id,
    productName: product.name,
    planKey: plan.key,
    added,
    createdAt: now,
    availableAt: now,
    cursor: "",
  });
  tx.set(
    db.collection("storeStockSignals").doc(product.id),
    { lastAdditionAt: now },
    { merge: true },
  );
}

async function notifyPage(db, jobRef, type) {
  await db.runTransaction(async (tx) => {
    const job = (await tx.get(jobRef)).data();
    if (!job || (type === "price" && job.state !== "pending")) return;
    const favorites = type === "price" && job.stage === "favorites";
    const profiles = db.collection("storeCommerceProfiles");
    let query = favorites
      ? profiles.where("favorites", "array-contains", job.productId)
      : db
          .collection("storeProductWatches")
          .where("productId", "==", job.productId)
          .where(type, "==", true);
    query = query.orderBy("__name__").limit(pageSize);
    if (job.cursor) query = query.startAfter(job.cursor);
    const page = await tx.get(query);
    const key = type + ":" + jobRef.id;
    const recipients = await Promise.all(
      page.docs.map(async (document) => {
        const info = document.data(),
          uid = favorites ? document.id : info.uid;
        if (
          !uid ||
          (type === "stock" &&
            (info.stockSince || info.createdAt || 0) > job.createdAt)
        )
          return null;
        const receipt = db
          .collection("storeCommerceNotificationReceipts")
          .doc(C.hash(uid, key));
        const [profile, seen, notice] = await Promise.all([
          favorites ? document : tx.get(profiles.doc(uid)),
          tx.get(receipt),
          tx.get(db.collection("storeNotifications").doc(receipt.id)),
        ]);
        if (seen.exists || notice.exists) return null;
        const prefs = profile.data()?.preferences || {};
        const site = prefs[type + "Notifications"] === true;
        const mail =
          prefs[
            type === "price"
              ? "emailPriceNotifications"
              : "emailStockNotifications"
          ] === true;
        return site || mail ? { uid, receipt, site } : null;
      }),
    );
    for (const recipient of recipients) {
      if (!recipient) continue;
      const data = {
        productId: job.productId,
        planKey: job.planKey,
        productName: job.productName || "",
      };
      if (type === "price") {
        data.priceKurus = job.priceKurus;
        if (Number.isSafeInteger(job.oldPriceKurus))
          data.oldPriceKurus = job.oldPriceKurus;
      } else data.added = job.added;
      C.notification(
        tx,
        db,
        recipient.uid,
        key,
        type === "price"
          ? "Takip ettiğin ürünün fiyatı düştü"
          : "Takip ettiğin ürüne stok eklendi",
        type === "price"
          ? "İndirimli paketi ve güncel fiyatı ürün sayfasında inceleyebilirsin."
          : job.productName +
              " için yeni stok eklendi. İlgili paketi ürün sayfasında inceleyebilirsin.",
        data,
        { site: recipient.site },
      );
      tx.create(recipient.receipt, {
        uid: recipient.uid,
        type,
        productId: job.productId,
        createdAt: Date.now(),
      });
    }
    if (page.size === pageSize)
      tx.update(jobRef, { cursor: page.docs.at(-1).id, updatedAt: Date.now() });
    else if (type === "stock") tx.delete(jobRef);
    else if (!favorites)
      tx.update(jobRef, {
        cursor: "",
        stage: "favorites",
        updatedAt: Date.now(),
      });
    else
      tx.update(jobRef, {
        cursor: "",
        state: "completed",
        updatedAt: Date.now(),
      });
  });
}

async function stockAdditions(db) {
  const jobs = await db
    .collection("storeStockAdditionJobs")
    .where("availableAt", "<=", Date.now())
    .limit(3)
    .get();
  for (const job of jobs.docs) await notifyPage(db, job.ref, "stock");
  return jobs.size;
}

module.exports = { queueStockAddition, notifyPage, stockAdditions };
