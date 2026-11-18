"use strict";
const C = require("./common");
async function record(uid, input) {
  C.object(input, ["productId", "event", "eventId"]);
  const productId = C.id(input.productId, 80),
    event = C.choice(input.event, ["view"]),
    eventId = C.id(input.eventId, 100);
  await require("./catalog").product(productId);
  const database = C.db(),
    ref = database
      .collection("storeAnalyticsEvents")
      .doc(C.hash(uid || "public", eventId, event, productId));
  return database.runTransaction(async (tx) => {
    const old = await tx.get(ref);
    if (old.exists) return { recorded: true, duplicate: true };
    tx.create(ref, {
      uid: uid || "",
      productId,
      event,
      createdAt: Date.now(),
      expiresAt: new Date(Date.now() + 90 * 86400000),
    });
    return { recorded: true, duplicate: false };
  });
}
async function report({ financial = false } = {}) {
  const database = C.db(),
    [events, orders, costs] = await Promise.all([
      database
        .collection("storeAnalyticsEvents")
        .orderBy("createdAt", "desc")
        .limit(2000)
        .get(),
      database
        .collection("storeOrders")
        .orderBy("createdAt", "desc")
        .limit(1000)
        .get(),
      financial
        ? database
            .collection("storeOrderCostSnapshots")
            .orderBy("createdAt", "desc")
            .limit(1000)
            .get()
        : Promise.resolve({ docs: [], size: 0 }),
    ]);
  const products = new Map(),
    get = (id) => {
      if (!products.has(id))
        products.set(id, {
          productId: id,
          views: 0,
          cartAdds: 0,
          paidOrders: 0,
          units: 0,
          revenueKurus: 0,
        });
      return products.get(id);
    };
  for (const d of events.docs) {
    const e = d.data(),
      row = get(e.productId);
    if (e.event === "view") row.views++;
    if (e.event === "cart") row.cartAdds++;
  }
  const paidIds = new Set();
  for (const d of orders.docs) {
    const o = d.data();
    if (
      !o.approvedAt ||
      !["paid", "processing", "delivery_pending", "delivered"].includes(
        o.status,
      )
    )
      continue;
    paidIds.add(d.id);
    for (const i of o.items || []) {
      const row = get(i.productId);
      row.paidOrders++;
      row.units += i.quantity || 0;
      if (financial) row.revenueKurus += i.lineTotalKurus || 0;
    }
  }
  const profit = {
    verified: true,
    paidOrders: paidIds.size,
    coveredOrders: 0,
    revenueKurus: 0,
    costKurus: 0,
    feesKurus: 0,
    contributionKurus: 0,
  };
  if (financial) {
    for (const d of costs.docs) {
      const row = d.data();
      if (!paidIds.has(row.orderId)) continue;
      if (!row.verified || row.feesVerified !== true) {
        profit.verified = false;
        continue;
      }
      profit.coveredOrders++;
      profit.revenueKurus += row.totalKurus;
      profit.costKurus += row.costKurus;
      profit.feesKurus += row.feesKurus || 0;
    }
    profit.verified = profit.verified && profit.coveredOrders === paidIds.size;
    profit.contributionKurus = profit.verified
      ? profit.revenueKurus - profit.costKurus - profit.feesKurus
      : null;
  }
  return {
    products: [...products.values()].map((row) => {
      if (!financial) delete row.revenueKurus;
      return row;
    }),
    profit: financial ? profit : null,
    scope: {
      events: events.size,
      eventLimit: 2000,
      orders: orders.size,
      orderLimit: 1000,
      mayBeTruncated: events.size === 2000 || orders.size === 1000,
      tracking: "observed-events-and-confirmed-orders",
      generatedAt: Date.now(),
    },
  };
}
let alertWindow = new Map();
async function alert(code, path, status) {
  if (!/^\/[A-Za-z0-9/_:.-]{0,200}$/.test(path) || !Number.isInteger(status))
    return;
  const key = C.hash(
    code,
    path,
    String(status),
    String(Math.floor(Date.now() / 60000)),
  );
  if (alertWindow.has(key)) return;
  alertWindow.set(key, Date.now());
  if (alertWindow.size > 200)
    alertWindow = new Map(
      [...alertWindow].filter(([, at]) => at > Date.now() - 120000),
    );
  try {
    await C.db()
      .collection("storeCommerceAlerts")
      .doc(key)
      .set({
        code: C.text(code, 80),
        path,
        status,
        createdAt: Date.now(),
        acknowledgedAt: 0,
        observation: "first-occurrence-per-minute",
      });
  } catch {}
}
async function alerts() {
  const result = await C.page("storeCommerceAlerts", { limit: 100 });
  return C.publicRows(result);
}
async function acknowledge(alertId, actor) {
  const ref = C.db().collection("storeCommerceAlerts").doc(C.id(alertId));
  const row = await ref.get();
  if (!row.exists) C.fail("COMMERCE_ALERT_NOT_FOUND", 404);
  await ref.update({ acknowledgedAt: Date.now(), acknowledgedBy: actor.uid });
  return { acknowledged: true };
}
module.exports = { record, report, alert, alerts, acknowledge };
async function costs(orderId, input, actor) {
  C.object(input, ["costKurus", "feesKurus", "source", "expectedRevision"]);
  const costKurus = C.integer(input.costKurus),
    feesKurus = C.integer(input.feesKurus),
    source = C.text(input.source, 200, { required: true });
  const database = C.db(),
    ref = database.collection("storeOrderCostSnapshots").doc(C.id(orderId));
  return database.runTransaction(async (tx) => {
    const [order, old] = await Promise.all([
      tx.get(database.collection("storeOrders").doc(orderId)),
      tx.get(ref),
    ]);
    if (!order.exists) C.fail("STORE_ORDER_NOT_FOUND", 404);
    C.requireRevision(old.data()?.revision, input.expectedRevision);
    const row = {
      ...old.data(),
      orderId,
      uid: order.data().uid,
      totalKurus: order.data().totalKurus,
      costKurus,
      feesKurus,
      verified: true,
      feesVerified: true,
      source,
      verifiedBy: actor.uid,
      verifiedAt: Date.now(),
      revision: (old.data()?.revision || 0) + 1,
      createdAt: old.data()?.createdAt || order.data().createdAt,
    };
    tx.set(ref, row);
    C.audit(tx, database, "commerce.costs.verify", actor, {
      orderId,
      costKurus,
      feesKurus,
      source,
    });
    return row;
  });
}
module.exports.costs = costs;
