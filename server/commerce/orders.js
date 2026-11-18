"use strict";
const C = require("./common");
async function experience(uid, orderId) {
  const order = await C.orderForUser(uid, orderId, { recipient: true }),
    database = C.db(),
    row =
      (
        await database.collection("storeOrderExperience").doc(orderId).get()
      ).data() || {};
  const events = await database
    .collection("storeOrderTimeline")
    .where("orderId", "==", orderId)
    .orderBy("createdAt", "asc")
    .limit(100)
    .get();
  const timeline = events.docs.map((d) => ({
    id: d.id,
    type: d.data().type,
    status: d.data().status,
    createdAt: d.data().createdAt,
  }));
  if (!timeline.length) {
    timeline.push({
      id: "created",
      type: "order",
      status: "created",
      createdAt: order.createdAt,
    });
    if (order.approvedAt)
      timeline.push({
        id: "paid",
        type: "payment",
        status: "paid",
        createdAt: order.approvedAt,
      });
    if (order.delivery?.deliveredAt)
      timeline.push({
        id: "delivery",
        type: "delivery",
        status: "delivered",
        createdAt: order.delivery.deliveredAt,
      });
  }
  return {
    orderId,
    status: order.status,
    paymentStatus:
      order.status === "refunded"
        ? "refunded"
        : order.approvedAt
          ? "confirmed"
          : "pending",
    timeline,
    delivery: {
      viewedAt: row.viewedAt || 0,
      acknowledgedAt: row.acknowledgedAt || 0,
    },
    license: row.license
      ? {
          startsAt: row.license.startsAt,
          expiresAt: row.license.expiresAt,
          source: row.license.source,
          verifiedAt: row.license.verifiedAt,
        }
      : null,
    assignee: row.assigneeUid ? "assigned" : "unassigned",
    gift: !!order.giftRecipientUid,
    payer: order.uid === uid,
  };
}
async function acknowledge(uid, orderId) {
  const database = C.db(),
    ref = database.collection("storeOrderExperience").doc(C.id(orderId));
  return database.runTransaction(async (tx) => {
    const order = await C.orderForUser(uid, orderId, {
        transaction: tx,
        database,
        recipient: true,
      }),
      old = await tx.get(ref);
    if (order.giftRecipientUid && order.giftRecipientUid !== uid)
      C.fail("COMMERCE_GIFT_RECIPIENT_REQUIRED", 403);
    if (order.status !== "delivered")
      C.fail("COMMERCE_DELIVERY_NOT_COMPLETED", 409);
    const at = old.data()?.acknowledgedAt || Date.now();
    tx.set(
      ref,
      {
        uid: order.uid,
        orderId,
        acknowledgedAt: at,
        acknowledgedBy: uid,
        updatedAt: Date.now(),
      },
      { merge: true },
    );
    return { orderId, acknowledgedAt: at };
  });
}
async function viewed(uid, orderId) {
  const order = await C.orderForUser(uid, orderId, { recipient: true });
  if (order.giftRecipientUid && order.giftRecipientUid !== uid)
    C.fail("COMMERCE_GIFT_RECIPIENT_REQUIRED", 403);
  const ref = C.db().collection("storeOrderExperience").doc(orderId);
  await ref.set(
    { viewedAt: Date.now(), viewedBy: uid, uid: order.uid, orderId },
    { merge: true },
  );
  return { viewed: true };
}
async function license(orderId, input, actor) {
  C.object(input, ["startsAt", "expiresAt", "source"]);
  const startsAt = C.integer(input.startsAt, 1, Date.now() + 60000),
    expiresAt = C.integer(
      input.expiresAt,
      startsAt + 1,
      startsAt + 10 * 366 * 86400000,
    ),
    source = C.text(input.source, 160, { required: true }),
    database = C.db(),
    ref = database.collection("storeOrderExperience").doc(C.id(orderId));
  return database.runTransaction(async (tx) => {
    const orderSnap = await tx.get(
      database.collection("storeOrders").doc(orderId),
    );
    const order = orderSnap.data();
    if (!order || order.status !== "delivered")
      C.fail("COMMERCE_DELIVERY_NOT_COMPLETED", 409);
    const license = {
      startsAt,
      expiresAt,
      source,
      verifiedAt: Date.now(),
      verifiedBy: actor.uid,
    };
    tx.set(
      ref,
      {
        uid: order.uid,
        orderId,
        license,
        licenseReminderDueAt: Math.max(1, expiresAt - 3 * 86400000),
        updatedAt: Date.now(),
      },
      { merge: true },
    );
    C.audit(tx, database, "commerce.license.verify", actor, {
      orderId,
      startsAt,
      expiresAt,
      source,
    });
    return { orderId, license };
  });
}
function timeline(tx, database, orderId, status, now, actor = "system") {
  const ref = database
    .collection("storeOrderTimeline")
    .doc(C.hash(orderId, status, String(now)));
  tx.set(ref, {
    orderId,
    status,
    type: ["paid", "refunded", "payment_review", "payment_rejected"].includes(
      status,
    )
      ? "payment"
      : "order",
    createdAt: now,
    actor,
  });
}
async function gifts(uid, query = {}) {
  return C.publicRows(
    await C.page("storeOrders", { uid, field: "giftRecipientUid", ...query }),
    (row) => ({
      id: row.id,
      orderNumber: row.orderNumber,
      status: row.status,
      items: (row.items || []).map((x) => ({
        productId: x.productId,
        productName: x.productName,
        planKey: x.planKey,
        planLabel: x.planLabel,
        quantity: x.quantity,
      })),
      createdAt: row.createdAt,
      deliveryReady: row.status === "delivered",
    }),
  );
}
async function recipient(uid, input) {
  C.object(input, ["username"]);
  await C.activeUser(uid);
  const name = C.text(input.username, 40, { required: true })
      .normalize("NFC")
      .toLocaleLowerCase("tr-TR"),
    database = C.db(),
    rows = await database
      .collection("users")
      .where("usernameLower", "==", name)
      .limit(2)
      .get();
  if (rows.size !== 1) C.fail("COMMERCE_RECIPIENT_NOT_FOUND", 404);
  const user = rows.docs[0];
  if (user.id === uid || user.data().storeAccountStatus === "suspended")
    C.fail("COMMERCE_RECIPIENT_NOT_FOUND", 404);
  const { auth } = require("../config/firebaseAdmin").initFirebaseAdmin();
  const account = await auth.getUser(user.id);
  if (account.disabled || !account.emailVerified)
    C.fail("COMMERCE_RECIPIENT_NOT_FOUND", 404);
  return { uid: user.id, username: user.data().username };
}
module.exports = {
  experience,
  acknowledge,
  viewed,
  license,
  timeline,
  gifts,
  recipient,
};
