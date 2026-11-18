"use strict";
const { initFirebaseAdmin } = require("../config/firebaseAdmin");
const env = require("../config/env");
const { createWorker } = require("./workerScheduler");
const catalogService = require("./storeCatalogService");
const { invalidateStockCache } = require("./storeInventoryService");
const { recordMutationAudit } = require("./storeMutationAudit");
const { validProductId } = require("../../public/js/store/catalog-schema.mjs");
const fail = (code, statusCode = 409) => {
  throw Object.assign(new Error(code), { code, statusCode });
};
const jobs = "storeProductDeletionJobs";
const activeOrders = [
  "awaiting_payment",
  "payment_review",
  "paid",
  "processing",
  "delivery_pending",
];
const now = () => Date.now();
const selectStorage = (value) => {
  const found = new Set();
  const visit = (item) => {
    if (Array.isArray(item)) return item.forEach(visit);
    if (item && typeof item === "object")
      return Object.values(item).forEach(visit);
    if (
      typeof item !== "string" ||
      !item.startsWith("https://firebasestorage.googleapis.com/")
    )
      return;
    try {
      const url = new URL(item);
      const prefix = "/v0/b/" + env.firebase.storageBucket + "/o/";
      const object = decodeURIComponent(url.pathname.slice(prefix.length));
      if (
        url.pathname.startsWith(prefix) &&
        /^store-product-images\/[a-f0-9-]{36}\.(?:jpg|png|webp)$/i.test(object)
      )
        found.add(object);
    } catch {
      /* Invalid legacy URLs have no managed storage object. */
    }
  };
  visit(value);
  return [...found];
};

async function assertLive(tx, db, id) {
  if (
    (await tx.get(db.collection("storefrontSettings").doc("main"))).data()
      ?.catalog?.deletedProductIds?.[id]
  )
    fail("STORE_PRODUCT_NOT_FOUND", 404);
}
async function request(id, confirmation, actor) {
  if (!validProductId(id) || confirmation !== id)
    fail("STORE_DELETE_CONFIRMATION", 400);
  const { db } = initFirebaseAdmin();
  if (!db) fail("STORE_STORAGE_UNAVAILABLE", 503);
  const catalog = await catalogService.getEffectiveCatalog({
    includeInactive: true,
    fresh: true,
  });
  const ref = db.collection(jobs).doc(id),
    settings = db.collection("storefrontSettings").doc("main"),
    experience = db.collection("storefrontExperience").doc("main");
  const result = await db.runTransaction(async (tx) => {
    const [cfg, existing, exp] = await Promise.all([
      tx.get(settings),
      tx.get(ref),
      tx.get(experience),
    ]);
    const all = cfg.data(),
      current = all?.catalog;
    if (existing.exists || current?.deletedProductIds?.[id])
      return { id, state: existing.exists ? "pending" : "completed" };
    if (catalogService.catalogRevision(all) !== catalog.revision)
      fail("STORE_CATALOG_CONFLICT");
    const product = catalog.products.find((p) => p.id === id);
    if (!product || !Object.hasOwn(current?.products || {}, id))
      fail("STORE_PRODUCT_NOT_FOUND", 404);
    const [orders, reservations] = await Promise.all([
      tx.get(
        db
          .collection("storeOrders")
          .where("status", "in", activeOrders)
          .select("items"),
      ),
      tx.get(
        db
          .collection("storeReservations")
          .where("state", "==", "active")
          .select("items"),
      ),
    ]);
    const matches = (doc) =>
      (doc.data().items || []).some((item) => item.productId === id);
    if (orders.docs.some(matches)) fail("STORE_DELETE_ACTIVE_ORDERS");
    if (reservations.docs.some(matches))
      fail("STORE_DELETE_ACTIVE_RESERVATIONS");
    const products = { ...current.products },
      customProducts = { ...current.customProducts };
    const media = selectStorage([products[id], customProducts[id]]);
    delete products[id];
    delete customProducts[id];
    const pool = product.inventoryPoolId || id;
    const members = catalog.products.filter(
      (candidate) =>
        candidate.id !== id &&
        (candidate.inventoryPoolId || candidate.id) === pool,
    );
    const shared = {},
      owned = new Set();
    for (const plan of product.plans) {
      const successor = members.find((candidate) =>
        candidate.plans.some((p) => p.key === plan.key),
      );
      if (successor)
        shared[plan.key] = { id: successor.id, name: successor.name };
      else owned.add(pool + "__" + plan.key);
      if (id !== pool) owned.add(id + "__" + plan.key);
    }
    const skus = [...owned];
    const at = Math.max(now(), (current.updatedAt || 0) + 1);
    // Replacing the catalog map is necessary to remove nested keys in Firestore.
    tx.update(settings, {
      catalog: {
        ...current,
        products,
        customProducts,
        deletedProductIds: { ...current.deletedProductIds, [id]: true },
        updatedAt: at,
      },
    });
    if (exp.exists) {
      const row = exp.data();
      tx.update(experience, {
        categories: (row.categories || []).map((cat) => ({
          ...cat,
          productIds: (cat.productIds || []).filter((key) => key !== id),
        })),
        banners: (row.banners || []).filter(
          (b) => b.href?.split("?")[0] !== "/urun/" + id,
        ),
        updatedAt: at,
        revision: (row.revision || 0) + 1,
      });
    }
    tx.create(ref, {
      id,
      skus,
      sharedPool: pool,
      shared,
      media,
      step: 0,
      cursor: "",
      availableAt: at,
      createdAt: at,
    });
    recordMutationAudit(tx, db, "store.product.delete", actor, {
      productId: id,
    });
    return { id, state: "pending" };
  });
  catalogService.invalidateCatalogCache();
  invalidateStockCache();
  require("./merchandisingService").invalidateExperience();
  worker.wake();
  return result;
}
const byProduct = [
  "storeStockAdditionJobs",
  "storeProductSlugs",
  "storeProductWatches",
  "storePriceHistory",
  "storePriceJobs",
  "storeCommerceNotificationReceipts",
  "storeRestockSubscriptions",
  "storeReviews",
  "storeProductReactions",
  "storeProductReactionReceipts",
  "storeContentVersions",
  "storeCommerceUploads",
  "storeNotifications",
  "storeAnalyticsEvents",
  "storeCustomerRequests",
];
const ownedStock = [
  "storeInventoryFingerprints",
  "storeManualDeliveryFingerprints",
  "storeInventoryEvents",
  "storeInventoryImports",
  "storeInventoryMaintenance",
  "storeInventoryAccessAudit",
];
function steps(db, job) {
  const filters = byProduct.map((name) => ({
    query: db.collection(name).where("productId", "==", job.id),
  }));
  filters.push({
    restock: true,
    query: db.collection("storeRestockJobs").where("productId", "==", job.id),
  });
  filters.push({
    query: db
      .collection("storeContentVersions")
      .where("targetId", "==", job.id),
  });
  filters.push({
    query: db
      .collection("storeEmailOutbox")
      .where("data.productId", "==", job.id),
  });
  for (const name of [
    "storeProductDetails",
    "storeProductSettings",
    "storeProductCommunity",
    "storeStockSignals",
  ])
    filters.push({ root: db.collection(name).doc(job.id) });
  for (const sku of job.skus) {
    for (const name of ownedStock)
      filters.push({ query: db.collection(name).where("sku", "==", sku) });
    filters.push(
      { root: db.collection("storeInventory").doc(sku) },
      { root: db.collection("storeInventorySummary").doc(sku) },
    );
  }
  for (const [plan, successor] of Object.entries(job.shared || {})) {
    const poolSku = job.sharedPool + "__" + plan;
    filters.push({
      sharedSummary: db.collection("storeInventorySummary").doc(poolSku),
      successor: successor.id,
    });
  }
  filters.push(
    { profiles: true },
    { promotions: true },
    { bulk: true },
    { notices: true },
    { storage: true },
  );
  return filters;
}
async function walk(db, query, cursor, size = 50) {
  const { admin } = initFirebaseAdmin();
  let ordered = query
    .orderBy(admin.firestore.FieldPath.documentId())
    .limit(size);
  if (cursor) ordered = ordered.startAfter(cursor);
  return ordered.get();
}
async function wipe(db, ref) {
  if (db.recursiveDelete) return db.recursiveDelete(ref);
  for (const sub of await ref.listCollections())
    for (const child of await sub.listDocuments()) await wipe(db, child);
  await ref.delete();
}
async function dropUnusedStorage(db, object) {
  const configs = (
    await db.collection("storefrontSettings").doc("main").get()
  ).data();
  if (selectStorage(configs).includes(object)) return;
  const experience = await db
    .collection("storefrontExperience")
    .doc("main")
    .get();
  if (selectStorage(experience.data()).includes(object)) return;
  for (const name of [
    "storeProductDetails",
    "storeContentVersions",
    "storeCommerceUploads",
  ]) {
    let cursor = "";
    for (;;) {
      const page = await walk(db, db.collection(name), cursor);
      if (page.docs.some((doc) => selectStorage(doc.data()).includes(object)))
        return;
      if (page.size < 50) break;
      cursor = page.docs.at(-1).id;
    }
  }
  const { admin, app } = initFirebaseAdmin();
  await admin
    .storage(app)
    .bucket(env.firebase.storageBucket)
    .file(object)
    .delete({ ignoreNotFound: true });
}
async function advance(db, ref) {
  const job = (await ref.get()).data();
  if (!job) return true;
  const task = steps(db, job)[job.step];
  if (!task) {
    await ref.delete();
    invalidateStockCache();
    return true;
  }
  let cursor = "",
    media = [];
  // Progress is committed after its work. Replaying a page after a crash is safe.
  if (task.root) {
    const snap = await task.root.get();
    media = selectStorage(snap.data());
    if (media.length) await preserveMedia(db, ref, media);
    await wipe(db, task.root);
  } else if (task.storage) {
    for (const object of job.media) await dropUnusedStorage(db, object);
  } else if (task.sharedSummary) {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(task.sharedSummary);
      if (!snap.exists) return;
      const row = snap.data();
      tx.update(snap.ref, {
        productIds: (row.productIds || []).filter((key) => key !== job.id),
        productId:
          row.productId === job.id
            ? task.successor
            : row.productId || task.successor,
      });
    });
  } else if (task.query) {
    const page = await walk(db, task.query, job.cursor);
    media = page.docs.flatMap((doc) => selectStorage(doc.data()));
    if (media.length) await preserveMedia(db, ref, media);
    for (const doc of page.docs) {
      if (!task.restock) {
        await wipe(db, doc.ref);
        continue;
      }
      await db.runTransaction(async (tx) => {
        const row = (await tx.get(doc.ref)).data();
        if (!row || row.productId !== job.id) return;
        const next = job.shared?.[row.planKey];
        if (!next || row.completedAt || row.failedAt) {
          tx.delete(doc.ref);
          return;
        }
        const sourceSkus = (row.sourceSkus || []).filter(
          (sku) => !job.skus.includes(sku),
        );
        tx.update(doc.ref, {
          productId: next.id,
          productName: next.name,
          sourceSkus,
          skuIndex: 0,
          cursor: "",
          lease: "",
          availableAt: now(),
        });
      });
    }
    if (page.size === 50) cursor = page.docs.at(-1).id;
  } else {
    const name = task.profiles
      ? "storeCommerceProfiles"
      : task.promotions
        ? "storePromotions"
        : task.bulk
          ? "storeBulkCatalogJobs"
          : "storeUserNotifications";
    if (task.notices && db.collectionGroup) {
      const query = db
        .collectionGroup("items")
        .where("productId", "==", job.id);
      let q = query
        .orderBy(initFirebaseAdmin().admin.firestore.FieldPath.documentId())
        .limit(50);
      if (job.cursor) q = q.startAfter(db.doc(job.cursor));
      const page = await q.get();
      for (const doc of page.docs)
        if (doc.ref.path.startsWith("storeUserNotifications/"))
          await doc.ref.delete();
      if (page.size === 50) cursor = page.docs.at(-1).ref.path;
    } else {
      const page = await walk(db, db.collection(name), job.cursor);
      for (const doc of page.docs) {
        if (task.notices) {
          const notes = await doc.ref
            .collection("items")
            .where("productId", "==", job.id)
            .get();
          for (const note of notes.docs) await note.ref.delete();
          continue;
        }
        await db.runTransaction(async (tx) => {
          const snap = await tx.get(doc.ref),
            row = snap.data();
          if (!row) return;
          if (
            task.profiles &&
            ((row.favorites || []).includes(job.id) ||
              (row.cart || []).some((i) => i.productId === job.id))
          ) {
            tx.update(doc.ref, {
              favorites: (row.favorites || []).filter((id) => id !== job.id),
              cart: (row.cart || []).filter((i) => i.productId !== job.id),
              revision: (row.revision || 0) + 1,
            });
          } else if (task.promotions && row.productIds?.includes(job.id)) {
            const ids = row.productIds.filter((id) => id !== job.id);
            tx.update(doc.ref, {
              productIds: ids,
              active: ids.length ? row.active : false,
              updatedAt: now(),
            });
          } else if (
            task.bulk &&
            row.updates?.some((i) => i.productId === job.id)
          )
            tx.delete(doc.ref);
        });
      }
      if (page.size === 50) cursor = page.docs.at(-1).id;
    }
  }
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref),
      live = snap.data();
    if (!live || live.step !== job.step || live.cursor !== job.cursor) return;
    tx.update(ref, {
      step: cursor ? job.step : job.step + 1,
      cursor,
      availableAt: now(),
    });
  });
  return false;
}
async function preserveMedia(db, ref, objects) {
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    tx.update(ref, { media: [...new Set([...snap.data().media, ...objects])] });
  });
}
async function drain() {
  const { db } = initFirebaseAdmin();
  if (!db) return 0;
  const page = await db
    .collection(jobs)
    .where("availableAt", "<=", now())
    .limit(2)
    .get();
  for (const doc of page.docs)
    for (let i = 0; i < 12; i++) if (await advance(db, doc.ref)) break;
  return page.size;
}
const worker = createWorker({
  run: drain,
  onError: (e) =>
    require("./errorLogger").logError(e, { event: "product.deletion" }),
});
module.exports = { request, advance, assertLive, worker };
