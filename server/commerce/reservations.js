"use strict";
const C = require("./common"),
  quotes = require("./quotes");
async function create(uid, input) {
  C.object(input, ["quoteToken"]);
  const claims = quotes.verify(input.quoteToken, uid);
  if (claims.paymentMethod !== "wallet")
    C.fail("COMMERCE_RESERVATION_CHANNEL_INVALID", 409);
  await C.activeUser(uid, { purchase: true });
  const catalog =
      await require("../core/storeCatalogService").getEffectiveCatalog({
        includeInactive: false,
        fresh: true,
      }),
    cart = require("../core/storeService").normalizeCart(
      claims.items.map(({ unitPriceKurus, ...x }) => x),
      catalog,
    ),
    database = C.db(),
    { admin } = require("../config/firebaseAdmin").initFirebaseAdmin(),
    ref = database
      .collection("storeReservations")
      .doc(C.hash(uid, input.quoteToken)),
    active = database.collection("storeReservationOwners").doc(C.hash(uid));
  const result = await database.runTransaction(async (tx) => {
    const [old, owner] = await Promise.all([tx.get(ref), tx.get(active)]);
    if (old.exists) {
      const r = old.data();
      if (r.state === "active" && r.expiresAt > Date.now())
        return { ...r, id: ref.id };
      C.fail("COMMERCE_RESERVATION_EXPIRED", 409);
    }
    if (owner.exists && owner.data().expiresAt > Date.now())
      C.fail("COMMERCE_RESERVATION_ALREADY_ACTIVE", 409, {
        reservationId: owner.data().reservationId,
      });
    await quotes.transactionContext(tx, database, claims, { uid, cart });
    const now = Date.now(),
      expiresAt = Math.min(now + quotes.TTL, claims.expiresAt),
      allocations =
        await require("../core/storeInventoryService").allocateInventoryInTransaction(
          {
            tx,
            db: database,
            admin,
            items: cart.items,
            uid,
            now,
            mode: "reserve",
            reservationId: ref.id,
            expiresAt,
          },
        );
    const row = {
      uid,
      state: "active",
      quoteHash: C.hash(input.quoteToken),
      items: claims.items,
      allocations,
      expiresAt,
      createdAt: now,
    };
    tx.create(ref, row);
    tx.set(active, { uid, reservationId: ref.id, expiresAt });
    return { ...row, id: ref.id };
  });
  require("../core/storeInventoryService").invalidateStockCache();
  return {
    id: result.id,
    state: result.state,
    expiresAt: result.expiresAt,
    items: result.items,
  };
}
async function release(uid, reservationId, { expiredOnly = false } = {}) {
  const database = C.db(),
    ref = database.collection("storeReservations").doc(C.id(reservationId));
  const result = await database.runTransaction(async (tx) => {
    const snap = await tx.get(ref),
      owner = await tx.get(
        database.collection("storeReservationOwners").doc(C.hash(uid)),
      ),
      row = snap.data();
    if (!row || row.uid !== uid) C.fail("COMMERCE_RESERVATION_NOT_FOUND", 404);
    if (row.state !== "active") return { released: false, state: row.state };
    if (expiredOnly && row.expiresAt > Date.now())
      return { released: false, state: "active" };
    const entries = [];
    for (const a of row.allocations || []) {
      if (
        !/^storeInventory\/[a-z0-9_-]+\/items\/[A-Za-z0-9_-]+$/.test(
          a.inventoryPath,
        )
      )
        C.fail("COMMERCE_RESERVATION_CORRUPT", 409);
      const item = await tx.get(database.doc(a.inventoryPath));
      if (
        item.data()?.status === "reserved" &&
        item.data()?.reservationId === reservationId
      )
        entries.push(item);
    }
    const deltas = new Map();
    for (const item of entries)
      deltas.set(item.data().sku, (deltas.get(item.data().sku) || 0) + 1);
    const summaries = new Map();
    for (const sku of deltas.keys())
      summaries.set(
        sku,
        await tx.get(database.collection("storeInventorySummary").doc(sku)),
      );
    for (const item of entries) {
      const r = item.data();
      tx.update(item.ref, {
        status: "available",
        reservationId: "",
        reservationExpiresAt: 0,
        customerUid: "",
        updatedAt: Date.now(),
      });
      tx.set(
        database.collection("storeInventoryFingerprints").doc(r.fingerprint),
        { status: "available", customerUid: "", reservationId: "" },
        { merge: true },
      );
    }
    for (const [sku, count] of deltas) {
      const s = summaries.get(sku).data() || {};
      if ((s.reservedCount || 0) < count)
        C.fail("COMMERCE_RESERVATION_CORRUPT", 409);
      tx.update(summaries.get(sku).ref, {
        availableCount: (s.availableCount || 0) + count,
        reservedCount: s.reservedCount - count,
        updatedAt: Date.now(),
      });
    }
    tx.update(ref, {
      state: expiredOnly ? "expired" : "released",
      releasedAt: Date.now(),
    });
    if (owner.data()?.reservationId === reservationId)
      tx.set(owner.ref, { uid, reservationId: "", expiresAt: 0 });
    return { released: true, state: expiredOnly ? "expired" : "released" };
  });
  require("../core/storeInventoryService").invalidateStockCache();
  return result;
}
async function expire() {
  const rows = await C.db()
    .collection("storeReservations")
    .where("state", "==", "active")
    .where("expiresAt", "<=", Date.now())
    .limit(10)
    .get();
  for (const d of rows.docs)
    await release(d.data().uid, d.id, { expiredOnly: true });
  return { processed: rows.size };
}
module.exports = { create, release, expire };
