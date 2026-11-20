"use strict";
const C = require("./common");
const { getEffectiveCatalog } = require("../core/storeCatalogService");
const { uploadProductImage } = require("../core/storeProductImages");
const { publicProfile, readPublicProfiles, unavailableProfile } = require("./publicProfiles");
const EMPTY = Object.freeze({
  version: "",
  requirements: { tr: "", en: "" },
  guide: { tr: "", en: "" },
  description: { tr: "", en: "" },
  seo: { title: "", description: "", slug: "", image: "" },
  gallery: [],
  volumeTiers: [],
  giftEligible: false,
  unitCostKurus: null,
  deliveryEstimate: "",
  releaseNotes: [],
});
function image(value) {
  const v = C.text(value, 1000);
  if (!v) return "";
  if (
    /^\/public\/assets\/[A-Za-z0-9_./-]+$/.test(v) &&
    !v.split("/").includes("..")
  ) {
    const fs = require("node:fs"),
      path = require("node:path");
    if (!fs.existsSync(path.join(__dirname, "../..", v)))
      C.fail("COMMERCE_IMAGE_INVALID");
    return v;
  }
  let u;
  try {
    u = new URL(v);
  } catch {
    C.fail("COMMERCE_IMAGE_INVALID");
  }
  const bucket = require("../config/env").firebase.storageBucket;
  if (
    u.protocol !== "https:" ||
    u.hostname !== "firebasestorage.googleapis.com" ||
    u.username ||
    u.password ||
    !bucket ||
    !u.pathname.startsWith("/v0/b/" + bucket + "/o/")
  )
    C.fail("COMMERCE_IMAGE_INVALID");
  return u.href;
}
function localized(input, previous = { tr: "", en: "" }, max = 4000) {
  C.object(input, ["tr", "en"]);
  const out = { ...previous };
  for (const [k, v] of Object.entries(input)) out[k] = C.text(v, max);
  return out;
}
function normalize(input = {}, previous = EMPTY, { financial = false } = {}) {
  C.object(input, Object.keys(EMPTY));
  const out = structuredClone(previous);
  for (const [k, v] of Object.entries(input)) {
    if (["requirements", "guide", "description"].includes(k))
      out[k] = localized(v, previous[k], k === "guide" ? 12000 : 4000);
    else if (k === "seo") {
      C.object(v, ["title", "description", "slug", "image"]);
      out.seo = { ...previous.seo };
      if (v.title !== undefined) out.seo.title = C.text(v.title, 80);
      if (v.description !== undefined)
        out.seo.description = C.text(v.description, 240);
      if (v.slug !== undefined) {
        out.seo.slug = C.text(v.slug, 80);
        if (out.seo.slug && !/^[a-z0-9][a-z0-9-]{1,79}$/.test(out.seo.slug))
          C.fail("COMMERCE_SLUG_INVALID");
      }
      if (v.image !== undefined) out.seo.image = image(v.image);
    } else if (k === "gallery") {
      out[k] = C.array(v, 12).map((x) => {
        C.object(x, ["url", "alt"]);
        return {
          url: image(x.url),
          alt: C.text(x.alt, 160, { required: true }),
        };
      });
      if (out[k].some((x) => !x.url)) C.fail("COMMERCE_IMAGE_INVALID");
    } else if (k === "volumeTiers") {
      out[k] = C.array(v, 4)
        .map((x) => {
          C.object(x, ["quantity", "percentOff"]);
          return {
            quantity: C.integer(x.quantity, 2, 5),
            percentOff: C.integer(x.percentOff, 1, 50),
          };
        })
        .sort((a, b) => a.quantity - b.quantity);
      if (new Set(out[k].map((x) => x.quantity)).size !== out[k].length)
        C.fail("COMMERCE_TIERS_INVALID");
    } else if (k === "giftEligible") out[k] = C.flag(v);
    else if (k === "unitCostKurus") {
      if (!financial) C.fail("ADMIN_FINANCIAL_PERMISSION_REQUIRED", 403);
      out[k] = v === null ? null : C.integer(v, 0);
    } else if (k === "releaseNotes") {
      out[k] = C.array(v, 30).map((x) => {
        C.object(x, ["version", "message", "publishedAt"]);
        return {
          version: C.text(x.version, 40, { required: true }),
          message: C.text(x.message, 2000, { required: true }),
          publishedAt: C.integer(x.publishedAt, 0, Date.now() + 60000),
        };
      });
    } else out[k] = C.text(v, k === "version" ? 40 : 240);
  }
  return out;
}
function visible(row = {}) {
  const { unitCostKurus: _cost, ...published } = row.published || EMPTY;
  return {
    productId: row.productId,
    publishedRevision: row.publishedRevision || 0,
    publishedAt: row.publishedAt || 0,
    ...structuredClone(published),
  };
}
async function product(productId, includeInactive = false) {
  C.id(productId, 80);
  const catalog = await getEffectiveCatalog({ includeInactive });
  const p = catalog.products.find((p) => p.id === productId);
  if (!p) C.fail("STORE_ITEM_UNAVAILABLE", 404);
  return p;
}
async function resolveProduct(productId) {
  C.id(productId, 80);
  const catalog = await getEffectiveCatalog({ includeInactive: false });
  let result = catalog.products.find((p) => p.id === productId);
  if (!result) {
    const slug = await C.db()
      .collection("storeProductSlugs")
      .doc(productId)
      .get();
    result = catalog.products.find((p) => p.id === slug.data()?.productId);
  }
  if (!result) C.fail("STORE_ITEM_UNAVAILABLE", 404);
  return result;
}
async function compatibility(productId) {
  const p = await resolveProduct(productId);
  const snap = await C.db().collection("storeProductDetails").doc(p.id).get();
  const details = visible(snap.data() || { productId: p.id });
  return {
    productId: p.id,
    platform: p.platform,
    requirements: details.requirements,
  };
}
async function publicProduct(productId) {
  productId = (await resolveProduct(productId)).id;
  const database = C.db(),
    [snap, reviews, history] = await Promise.all([
      database.collection("storeProductDetails").doc(productId).get(),
      database
        .collection("storeReviews")
        .where("productId", "==", productId)
        .where("status", "==", "published")
        .orderBy("createdAt", "desc")
        .limit(50)
        .get(),
      database
        .collection("storePriceHistory")
        .where("productId", "==", productId)
        .where("createdAt", ">=", Date.now() - 30 * 86400000)
        .orderBy("createdAt", "desc")
        .limit(200)
        .get(),
    ]);
  const profiles = await readPublicProfiles(database, reviews.docs.map(doc => doc.data().uid));
  const rated = reviews.docs.map(d => reviewView(d.data(), d.id, profiles.get(d.data().uid)));
  return {
    product: visible(snap.data() || { productId }),
    reviews: rated,
    rating: rated.length
      ? {
          average: rated.reduce((n, r) => n + r.rating, 0) / rated.length,
          count: rated.length,
          sampleLimit: 50,
        }
      : null,
    priceHistory: history.docs.map((d) => {
      const x = d.data();
      return {
        planKey: x.planKey,
        priceKurus: x.priceKurus,
        createdAt: x.createdAt,
      };
    }),
    historyScope: { days: 30, limit: 200, recordingOnly: true },
  };
}
async function details(productId, { financial = false } = {}) {
  const p = await product(productId, true),
    snap = await C.db().collection("storeProductDetails").doc(productId).get(),
    row = snap.data() || {
      productId,
      revision: 0,
      published: structuredClone(EMPTY),
    };
  if (!financial) {
    if (row.published) row.published.unitCostKurus = null;
    if (row.draft) row.draft.unitCostKurus = null;
  }
  return {
    ...row,
    catalogProduct: {
      id: p.id,
      name: p.name,
      platform: p.platform,
      active: p.active,
      plans: p.plans.map((x) => ({
        key: x.key,
        label: x.label,
        priceKurus: x.priceKurus,
      })),
    },
  };
}
async function saveDraft(productId, input, actor = {}) {
  C.object(input, ["expectedRevision", "content"]);
  await product(productId, true);
  const database = C.db(),
    ref = database.collection("storeProductDetails").doc(productId);
  return database.runTransaction(async (tx) => {
    const before = await tx.get(ref),
      row = before.data() || {},
      base = row.draft || row.published || EMPTY;
    C.requireRevision(row.revision, input.expectedRevision);
    const draft = normalize(input.content, base, {
        financial: actor.financialPermission === true,
      }),
      next = {
        ...row,
        productId,
        revision: (row.revision || 0) + 1,
        draft,
        draftAt: Date.now(),
        updatedAt: Date.now(),
        updatedBy: C.uid(actor.uid),
      };
    tx.set(ref, next);
    C.audit(tx, database, "commerce.product.draft", actor, {
      productId,
      revision: next.revision,
    });
    return { productId, revision: next.revision, draft };
  });
}
async function publish(productId, input, actor = {}) {
  C.object(input, ["expectedRevision"]);
  const catalog = await getEffectiveCatalog({
    includeInactive: true,
    fresh: true,
  });
  const database = C.db(),
    ref = database.collection("storeProductDetails").doc(C.id(productId));
  return database.runTransaction(async (tx) => {
    const snap = await tx.get(ref),
      row = snap.data() || {};
    C.requireRevision(row.revision, input.expectedRevision);
    if (!row.draft) C.fail("COMMERCE_DRAFT_REQUIRED", 409);
    const slug = row.draft.seo?.slug || "";
    const settings = await tx.get(
      database.collection("storefrontSettings").doc("main"),
    );
    if (
      catalog.revision &&
      require("../core/storeCatalogService").catalogRevision(
        settings.data() || {},
      ) !== catalog.revision
    )
      C.fail("STORE_CATALOG_CHANGED", 409);
    if (
      slug &&
      catalog.products.some((p) => p.id === slug && p.id !== productId)
    )
      C.fail("COMMERCE_SLUG_IN_USE", 409);
    const slugRef = slug
        ? database.collection("storeProductSlugs").doc(slug)
        : null,
      collision = slugRef ? await tx.get(slugRef) : null;
    if (collision?.exists && collision.data().productId !== productId)
      C.fail("COMMERCE_SLUG_IN_USE", 409);
    const revision = (row.revision || 0) + 1,
      now = Date.now();
    if (row.published)
      tx.create(database.collection("storeContentVersions").doc(), {
        kind: "product",
        targetId: productId,
        content: row.published,
        sourceRevision: row.publishedRevision || 0,
        createdAt: now,
        uid: actor.uid,
      });
    tx.set(ref, {
      ...row,
      published: row.draft,
      draft: null,
      revision,
      publishedRevision: revision,
      publishedAt: now,
      updatedAt: now,
    });
    if (slugRef) tx.set(slugRef, { productId, createdAt: now });
    C.audit(tx, database, "commerce.product.publish", actor, {
      productId,
      revision,
    });
    return { productId, revision, published: true };
  });
}
async function restore(productId, input, actor) {
  C.object(input, ["expectedRevision", "versionId"]);
  const version = await C.db()
    .collection("storeContentVersions")
    .doc(C.id(input.versionId))
    .get();
  if (
    !version.exists ||
    version.data().kind !== "product" ||
    version.data().targetId !== productId
  )
    C.fail("COMMERCE_VERSION_NOT_FOUND", 404);
  const content = { ...version.data().content };
  if (actor.financialPermission !== true) delete content.unitCostKurus;
  return saveDraft(
    productId,
    { expectedRevision: input.expectedRevision, content },
    actor,
  );
}
async function versions(productId) {
  await product(productId, true);
  const rows = await C.db()
    .collection("storeContentVersions")
    .where("targetId", "==", productId)
    .orderBy("createdAt", "desc")
    .limit(30)
    .get();
  return rows.docs.map((d) => ({
    id: d.id,
    kind: d.data().kind,
    sourceRevision: d.data().sourceRevision,
    createdAt: d.data().createdAt,
  }));
}
async function upload(productId, input, actor) {
  C.object(input, ["imageUpload"]);
  await product(productId, true);
  const result = await uploadProductImage(input.imageUpload);
  try {
    await C.db().collection("storeCommerceUploads").doc().set({
      productId,
      url: result.url,
      uid: actor.uid,
      createdAt: Date.now(),
    });
    return { url: result.url };
  } catch (e) {
    await result.discard();
    throw e;
  }
}
function reviewView(row, id, profile = unavailableProfile()) {
  return {
    id,
    rating: row.rating,
    title: row.title,
    message: row.message,
    displayName: profile.username || "Zentra üyesi",
    profile,
    verifiedPurchase: true,
    createdAt: row.createdAt,
  };
}
async function review(uid, input) {
  C.object(input, ["orderId", "productId", "rating", "title", "message"]);
  const orderId = C.id(input.orderId),
    productId = C.id(input.productId, 80),
    rating = C.integer(input.rating, 1, 5),
    title = C.text(input.title, 100, { required: true }),
    message = C.text(input.message, 2000, { required: true }),
    database = C.db(),
    ref = database.collection("storeReviews").doc(C.hash(uid, productId));
  const result = await database.runTransaction(async (tx) => {
    const person = await C.activeUser(uid, { transaction: tx, database }),
      order = await C.orderForUser(uid, orderId, { transaction: tx, database }),
      old = await tx.get(ref);
    if (
      order.status !== "delivered" ||
      !order.approvedAt ||
      !(order.items || []).some((x) => x.productId === productId)
    )
      C.fail("COMMERCE_VERIFIED_PURCHASE_REQUIRED", 403);
    if (old.exists) C.fail("COMMERCE_REVIEW_EXISTS", 409);
    const row = {
      uid,
      orderId,
      productId,
      rating,
      title,
      message,
      displayName: C.text(person.username || "Zentra üyesi", 40),
      verifiedPurchase: true,
      status: "published",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    tx.create(ref, row);
    return reviewView(row, ref.id, publicProfile(person));
  });
  require("../core/firestorePagination").invalidateCreatedAtPageCache(
    "storeReviews",
  );
  return result;
}
async function moderate(reviewId, input, actor) {
  C.object(input, ["status", "reason"]);
  const status = C.choice(input.status, ["published", "hidden"]),
    reason = C.text(input.reason, 240, { required: true }),
    database = C.db(),
    ref = database.collection("storeReviews").doc(C.id(reviewId));
  const result = await database.runTransaction(async (tx) => {
    const old = await tx.get(ref);
    if (!old.exists) C.fail("COMMERCE_REVIEW_NOT_FOUND", 404);
    tx.update(ref, {
      status,
      moderationReason: reason,
      moderatedAt: Date.now(),
      moderatedBy: actor.uid,
    });
    C.audit(tx, database, "commerce.review.moderate", actor, {
      reviewId,
      status,
      reason,
    });
    return { id: reviewId, status };
  });
  require("../core/firestorePagination").invalidateCreatedAtPageCache(
    "storeReviews",
  );
  return result;
}
function recordPrices(tx, database, before = {}, after = {}, now = Date.now()) {
  for (const plan of after.plans || []) {
    const old = before.plans?.find((x) => x.key === plan.key);
    if (old?.priceKurus === plan.priceKurus) continue;
    tx.create(database.collection("storePriceHistory").doc(), {
      productId: after.id,
      planKey: plan.key,
      priceKurus: plan.priceKurus,
      previousPriceKurus: old?.priceKurus ?? null,
      createdAt: now,
    });
    if (old && plan.priceKurus < old.priceKurus)
      tx.set(
        database
          .collection("storePriceJobs")
          .doc(C.hash(after.id, plan.key, String(now))),
        {
          productId: after.id,
          planKey: plan.key,
          priceKurus: plan.priceKurus,
          previousPriceKurus: old.priceKurus,
          state: "pending",
          createdAt: now,
          cursor: "",
        },
      );
  }
}
module.exports = {
  EMPTY,
  normalize,
  image,
  visible,
  product,
  publicProduct,
  compatibility,
  resolveProduct,
  details,
  saveDraft,
  publish,
  restore,
  versions,
  upload,
  review,
  moderate,
  recordPrices,
};
