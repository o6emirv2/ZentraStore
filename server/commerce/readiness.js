"use strict";
const C = require("./common");
let cached = null,
  pending = null;
async function readiness() {
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (pending) return pending;
  pending = (async () => {
    try {
      const database = C.db();
      let timer;
      try {
        await Promise.race([
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(C.error("COMMERCE_READINESS_TIMEOUT", 503)),
              3000,
            );
            timer.unref?.();
          }),
          Promise.all([
            database
              .collection("storeReservations")
              .where("state", "==", "active")
              .where("expiresAt", "<=", Date.now())
              .limit(1)
              .get(),
            database
              .collection("storeReviews")
              .where("productId", "==", "_readiness_")
              .where("status", "==", "published")
              .orderBy("createdAt", "desc")
              .limit(1)
              .get(),
            database
              .collection("storePriceHistory")
              .where("productId", "==", "_readiness_")
              .where("createdAt", ">=", Date.now() - 86400000)
              .orderBy("createdAt", "desc")
              .limit(1)
              .get(),
            database
              .collection("storeProductWatches")
              .where("stock", "==", true)
              .orderBy("checkedAt", "asc")
              .limit(1)
              .get(),
          ]),
        ]);
      } finally {
        clearTimeout(timer);
      }
      const value = { ready: true };
      cached = { value, expiresAt: Date.now() + 600000 };
      return value;
    } catch (error) {
      const value = {
        ready: false,
        reason: ["9", "failed-precondition"].includes(String(error.code))
          ? "COMMERCE_INDEXES_REQUIRED"
          : "COMMERCE_STORAGE_UNAVAILABLE",
      };
      cached = { value, expiresAt: Date.now() + 60000 };
      return value;
    }
  })();
  try {
    return await pending;
  } finally {
    pending = null;
  }
}
function reset() {
  cached = null;
  pending = null;
}
module.exports = { readiness, reset };
