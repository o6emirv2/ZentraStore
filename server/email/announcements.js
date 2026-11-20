"use strict";
const { initFirebaseAdmin } = require("../config/firebaseAdmin");
const { createWorker } = require("../core/workerScheduler");
const { enqueue } = require("./service");
const crypto = require("node:crypto");
const name = "storeCampaignAnnouncements",
  pageSize = 45;
function schedule(tx, db, campaign) {
  const type = campaign.type === "balance" ? "promo_added" : "coupon_assigned";
  const ref = db.collection(name).doc(type + "_" + campaign.code);
  tx.set(
    ref,
    {
      type,
      code: campaign.code,
      cursor: "",
      availableAt: Math.max(campaign.startsAt || 0, Date.now()),
      createdAt: campaign.createdAt,
    },
    { merge: false },
  );
}
async function processPage(database, admin, ref) {
  await database.runTransaction(async (tx) => {
    const job = (await tx.get(ref)).data();
    if (!job || job.availableAt > Date.now()) return;
    const row = (
      await tx.get(database.collection("storePromotions").doc(job.code))
    ).data();
    const allowed =
      row?.active &&
      !row.customerUids?.length &&
      (job.type === "promo_added" ? row.announce : row.visibleInWallet);
    if (
      !allowed ||
      (row.endsAt && row.endsAt <= Date.now()) ||
      (row.usageLimit && row.usedCount >= row.usageLimit)
    ) {
      tx.delete(ref);
      return;
    }
    if (row.startsAt > Date.now()) {
      tx.update(ref, { availableAt: row.startsAt });
      return;
    }
    let query = database
      .collection("storeCommerceProfiles")
      .where("preferences.emailCouponNotifications", "==", true)
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(pageSize);
    if (job.cursor) query = query.startAfter(job.cursor);
    const page = await tx.get(query);
    const notices = page.docs.map((doc) =>
      database
        .collection("storeNotifications")
        .doc(
          crypto
            .createHash("sha256")
            .update([doc.id, job.type, job.code].join("\0"))
            .digest("hex"),
        ),
    );
    const existing = await Promise.all(notices.map((doc) => tx.get(doc)));
    page.docs.forEach((doc, i) => {
      if (existing[i].exists) return;
      const promo = job.type === "promo_added";
      tx.create(notices[i], {
        uid: doc.id,
        type: promo ? "promo_added" : "coupon",
        code: job.code,
        title: promo ? "Yeni bakiye promosyonu" : "Yeni indirim kuponu",
        message:
          job.code +
          (promo
            ? " kodunu promosyon alanında kullanabilirsin."
            : " kuponunu uygun sepetinde kullanabilirsin."),
        readAt: 0,
        createdAt: Date.now(),
      });
      enqueue(tx, database, {
        uid: doc.id,
        type: job.type,
        key: "announcement:" + job.code,
        data: { code: job.code },
      });
    });
    if (page.size < pageSize) tx.delete(ref);
    else
      tx.update(ref, { cursor: page.docs.at(-1).id, availableAt: Date.now() });
  });
}
const worker = createWorker({
  run: async () => {
    const { db, admin } = initFirebaseAdmin();
    if (!db) return 0;
    const page = await db
      .collection(name)
      .where("availableAt", "<=", Date.now())
      .limit(3)
      .get();
    for (const doc of page.docs) await processPage(db, admin, doc.ref);
    return page.size;
  },
  onError: (error) =>
    require("../core/errorLogger").logError(error, {
      event: "campaign.notification",
    }),
});
module.exports = { schedule, processPage, worker };
