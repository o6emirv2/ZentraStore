"use strict";
const C = require("./common"),
  settings = require("./settings");
function earned(order, config) {
  if (
    !config.enabled ||
    !config.enabledAt ||
    order.createdAt < config.enabledAt ||
    !order.approvedAt ||
    !["paid", "processing", "delivery_pending", "delivered"].includes(
      order.status,
    )
  )
    return 0;
  return (
    Math.floor(C.integer(order.totalKurus, 0) / 10000) * config.pointsPer100TL
  );
}
async function reconcile(uid) {
  const database = C.db(),
    config = (await settings.get()).loyalty,
    orders = await database
      .collection("storeOrders")
      .where("uid", "==", C.uid(uid))
      .orderBy("createdAt", "desc")
      .limit(200)
      .get();
  for (const doc of orders.docs) {
    const ledger = database.collection("storeLoyaltyOrderLedger").doc(doc.id),
      wallet = database.collection("storeLoyaltyAccounts").doc(uid);
    await database.runTransaction(async (tx) => {
      const [orderSnap, oldSnap, balanceSnap] = await Promise.all([
          tx.get(doc.ref),
          tx.get(ledger),
          tx.get(wallet),
        ]),
        order = orderSnap.data() || {},
        old = oldSnap.data() || {},
        walletRow = balanceSnap.data() || {},
        oldPoints = old.points || 0,
        target =
          old.originalPoints !== undefined
            ? order.approvedAt &&
              ["paid", "processing", "delivery_pending", "delivered"].includes(
                order.status,
              )
              ? old.originalPoints
              : 0
            : earned(order, config);
      if (oldPoints === target) return;
      const balance = (walletRow.balance || 0) + target - oldPoints;
      if (!Number.isSafeInteger(balance))
        C.fail("COMMERCE_LOYALTY_VALUE_INVALID", 409);
      tx.set(ledger, {
        uid,
        orderId: doc.id,
        points: target,
        originalPoints: old.originalPoints ?? target,
        updatedAt: Date.now(),
        createdAt: old.createdAt || Date.now(),
      });
      tx.set(wallet, {
        uid,
        balance,
        earned: (walletRow.earned || 0) + target - oldPoints,
        spent: walletRow.spent || 0,
        updatedAt: Date.now(),
      });
    });
  }
  return {
    ordersAnalyzed: orders.size,
    limit: 200,
    mayBeTruncated: orders.size === 200,
  };
}
async function account(uid) {
  await C.activeUser(uid);
  const scope = await reconcile(uid),
    row =
      (await C.db().collection("storeLoyaltyAccounts").doc(uid).get()).data() ||
      {},
    config = (await settings.get()).loyalty;
  return {
    enabled: config.enabled,
    balance: row.balance || 0,
    earned: row.earned || 0,
    spent: row.spent || 0,
    rewardPoints: config.rewardPoints,
    rewardDiscountKurus: config.rewardDiscountKurus,
    minimumSubtotalKurus: config.minimumSubtotalKurus,
    scope,
  };
}
async function redeem(uid, input) {
  C.object(input, ["idempotencyKey"]);
  const key = C.id(input.idempotencyKey, 100);
  await C.activeUser(uid);
  await reconcile(uid);
  const config = (await settings.get({ fresh: true })).loyalty;
  if (!config.enabled) C.fail("COMMERCE_LOYALTY_DISABLED", 409);
  const database = C.db(),
    receipt = database
      .collection("storeLoyaltyRedemptions")
      .doc(C.hash(uid, key)),
    wallet = database.collection("storeLoyaltyAccounts").doc(uid),
    code = "ZT-" + C.hash(uid, key).slice(0, 16).toUpperCase();
  return database.runTransaction(async (tx) => {
    const [prior, balance] = await Promise.all([
      tx.get(receipt),
      tx.get(wallet),
    ]);
    if (prior.exists)
      return { code: prior.data().code, points: prior.data().points };
    const row = balance.data() || {};
    if ((row.balance || 0) < config.rewardPoints)
      C.fail("COMMERCE_LOYALTY_INSUFFICIENT", 409);
    const now = Date.now();
    tx.create(database.collection("storePromotions").doc(code), {
      code,
      title: "Sadakat ödülü",
      type: "fixed",
      value: config.rewardDiscountKurus,
      minimumSubtotalKurus: config.minimumSubtotalKurus,
      maxDiscountKurus: config.rewardDiscountKurus,
      usageLimit: 1,
      usedCount: 0,
      perUserLimit: 1,
      active: true,
      visibleInWallet: true,
      startsAt: now,
      endsAt: now + 30 * 86400000,
      platforms: [],
      productIds: [],
      planKeys: [],
      customerUids: [uid],
      createdAt: now,
      updatedAt: now,
    });
    tx.update(wallet, {
      balance: row.balance - config.rewardPoints,
      spent: (row.spent || 0) + config.rewardPoints,
      updatedAt: now,
    });
    tx.create(receipt, {
      uid,
      code,
      points: config.rewardPoints,
      createdAt: now,
    });
    require("../core/customerNotificationService").recordEvent(tx, database, {
      uid,
      key: code,
      type: "coupon", code,
      title: "Kuponun hazır",
      message:
        "Puanlarınla oluşturduğun kupon hesabına tanımlandı. Koşullarını Kuponlarım alanında görebilirsin.",
      now,
    });
    require("../email/service").enqueue(tx, database, {
      uid,
      type: "coupon_assigned",
      key: code,
      data: { code },
      now,
    });
    return { code, points: config.rewardPoints };
  });
}
module.exports = { earned, reconcile, account, redeem };
async function readAdjustment(tx, database, order, orderId, nextStatus) {
  const ledger = database.collection("storeLoyaltyOrderLedger").doc(orderId),
    wallet = database.collection("storeLoyaltyAccounts").doc(order.uid);
  const [oldSnap, balanceSnap, settingsSnap] = await Promise.all([
    tx.get(ledger),
    tx.get(wallet),
    tx.get(database.collection("storeCommerceSettings").doc("main")),
  ]);
  const old = oldSnap.data() || {},
    balance = balanceSnap.data() || {},
    config = settingsSnap.data()?.loyalty || settings.DEFAULT.loyalty;
  const paid = ["paid", "processing", "delivery_pending", "delivered"].includes(
    nextStatus,
  );
  const target = paid
    ? (old.originalPoints ??
      earned(
        {
          ...order,
          status: nextStatus,
          approvedAt: order.approvedAt || Date.now(),
        },
        config,
      ))
    : 0;
  return { ledger, wallet, old, balance, target, orderId, uid: order.uid };
}
function applyAdjustment(tx, effect) {
  const { old, balance, target, ledger, wallet, orderId, uid } = effect,
    delta = target - (old.points || 0);
  if (!delta) return;
  const next = (balance.balance || 0) + delta;
  if (!Number.isSafeInteger(next))
    C.fail("COMMERCE_LOYALTY_VALUE_INVALID", 409);
  tx.set(ledger, {
    uid,
    orderId,
    points: target,
    originalPoints: old.originalPoints ?? target,
    updatedAt: Date.now(),
    createdAt: old.createdAt || Date.now(),
  });
  tx.set(wallet, {
    uid,
    balance: next,
    earned: (balance.earned || 0) + delta,
    spent: balance.spent || 0,
    updatedAt: Date.now(),
  });
}
module.exports.readAdjustment = readAdjustment;
module.exports.applyAdjustment = applyAdjustment;
