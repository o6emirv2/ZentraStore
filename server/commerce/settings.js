"use strict";
const C = require("./common");
const DEFAULT = Object.freeze({
  revision: 0,
  maintenance: { catalog: false, account: false, orders: false, message: "" },
  loyalty: {
    enabled: false,
    pointsPer100TL: 1,
    rewardPoints: 100,
    rewardDiscountKurus: 1000,
    minimumSubtotalKurus: 10000,
    enabledAt: 0,
  },
  secondApproval: false,
});
let cache = null,
  cacheUntil = 0;
async function get({ fresh = false, optional = false } = {}) {
  let database;
  try {
    database = C.db();
  } catch (e) {
    if (optional) return structuredClone(DEFAULT);
    throw e;
  }
  if (!fresh && cache && Date.now() < cacheUntil) return structuredClone(cache);
  const snap = await database
    .collection("storeCommerceSettings")
    .doc("main")
    .get();
  cache = { ...structuredClone(DEFAULT), ...snap.data() };
  cacheUntil = Date.now() + 15000;
  return structuredClone(cache);
}
async function save(input, actor) {
  C.object(input, [
    "expectedRevision",
    "maintenance",
    "loyalty",
    "secondApproval",
  ]);
  C.integer(input.expectedRevision);
  const database = C.db(),
    ref = database.collection("storeCommerceSettings").doc("main");
  const result = await database.runTransaction(async (tx) => {
    const snap = await tx.get(ref),
      old = { ...structuredClone(DEFAULT), ...snap.data() };
    C.requireRevision(old.revision, input.expectedRevision);
    const next = { ...old, revision: old.revision + 1, updatedAt: Date.now() };
    if (input.secondApproval !== undefined)
      next.secondApproval = C.flag(input.secondApproval);
    if (input.maintenance) {
      C.object(input.maintenance, ["catalog", "account", "orders", "message"]);
      next.maintenance = { ...old.maintenance };
      for (const [k, v] of Object.entries(input.maintenance))
        next.maintenance[k] = k === "message" ? C.text(v, 240) : C.flag(v);
    }
    if (input.loyalty) {
      C.object(input.loyalty, [
        "enabled",
        "pointsPer100TL",
        "rewardPoints",
        "rewardDiscountKurus",
        "minimumSubtotalKurus",
      ]);
      next.loyalty = { ...old.loyalty };
      for (const [k, v] of Object.entries(input.loyalty))
        next.loyalty[k] =
          k === "enabled"
            ? C.flag(v)
            : C.integer(
                v,
                k === "minimumSubtotalKurus" ? 0 : 1,
                k === "rewardDiscountKurus" ? 100000 : 1000000,
              );
      if (next.loyalty.enabled && !old.loyalty.enabled)
        next.loyalty.enabledAt = Date.now();
      if (next.loyalty.rewardDiscountKurus > next.loyalty.minimumSubtotalKurus)
        C.fail("COMMERCE_LOYALTY_CONFIGURATION_INVALID");
    }
    tx.set(ref, next);
    C.audit(tx, database, "commerce.settings.update", actor, {
      revision: next.revision,
      maintenance: next.maintenance,
      secondApproval: next.secondApproval,
    });
    return next;
  });
  cache = null;
  cacheUntil = 0;
  return result;
}
async function assertAvailable(kind) {
  const config = await get({ optional: true });
  if (config.maintenance[kind] === true)
    C.fail("COMMERCE_MAINTENANCE", 503, {
      publicMessage:
        config.maintenance.message ||
        "Bu işlem bakım nedeniyle geçici olarak kapalı.",
    });
  return config;
}
function clearCache() {
  cache = null;
  cacheUntil = 0;
}
module.exports = { DEFAULT, get, save, assertAvailable, clearCache };
