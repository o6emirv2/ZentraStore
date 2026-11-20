"use strict";
const { initFirebaseAdmin } = require("../config/firebaseAdmin");
const { recordMutationAudit } = require("./storeMutationAudit");
const { isValidProductImage } = require("./storeProductCreation");
let cache = null,
  pending = null;
const fail = (code, statusCode = 400) => {
  throw Object.assign(new Error(code), { code, statusCode });
};
const text = (v, n) =>
  typeof v === "string"
    ? v
        .replace(/[\u0000-\u001f\u007f<>]/g, "")
        .trim()
        .slice(0, n)
    : "";
function normalizeExperience(input = {}) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (x) => !["categories", "banners", "expectedRevision"].includes(x),
    )
  )
    fail("EXPERIENCE_INPUT_INVALID");
  if (
    !Array.isArray(input.categories) ||
    input.categories.length > 40 ||
    !Array.isArray(input.banners) ||
    input.banners.length > 12
  )
    fail("EXPERIENCE_INPUT_INVALID");
  const ids = new Set();
  const categories = input.categories.map((x) => {
    const id = text(x?.id, 60),
      name = text(x?.name, 60);
    if (
      !/^[a-z0-9][a-z0-9-]{1,59}$/.test(id) ||
      !name ||
      ids.has(id) ||
      !Array.isArray(x.productIds) ||
      x.productIds.length > 150 ||
      x.productIds.some((y) => !/^[a-z0-9][a-z0-9-]{1,79}$/.test(y))
    )
      fail("EXPERIENCE_CATEGORY_INVALID");
    ids.add(id);
    return {
      id,
      name,
      description: text(x.description, 180),
      enabled: x.enabled !== false,
      productIds: [...new Set(x.productIds)],
    };
  });
  const seen = new Set();
  const banners = input.banners.map((x) => {
    const id = text(x?.id, 60),
      title = text(x?.title, 80),
      href = text(x?.href, 180),
      startsAt = Number(x.startsAt || 0),
      endsAt = Number(x.endsAt || 0),
      image = text(x.image, 300);
    if (
      !/^[a-z0-9][a-z0-9-]{1,59}$/.test(id) ||
      !title ||
      seen.has(id) ||
      !/^\/(?:magaza(?:\?[A-Za-z0-9_=%&.-]*)?|kategori\/[a-z0-9-]+|urun\/[a-z0-9-]+)$/.test(
        href,
      ) ||
      (image && !isValidProductImage(image)) ||
      ![startsAt, endsAt].every(
        (n) => Number.isSafeInteger(n) && n >= 0 && n <= 8640000000000000,
      ) ||
      (endsAt && endsAt <= startsAt)
    )
      fail("EXPERIENCE_BANNER_INVALID");
    seen.add(id);
    return {
      id,
      title,
      message: text(x.message, 240),
      image,
      href,
      enabled: x.enabled !== false,
      startsAt,
      endsAt,
    };
  });
  if (Buffer.byteLength(JSON.stringify({ categories, banners })) > 60_000)
    fail("EXPERIENCE_SIZE_LIMIT");
  return { categories, banners };
}
async function getExperience({ admin = false } = {}) {
  if (!cache || Date.now() - cache.at >= 60_000) {
    if (!pending)
      pending = (async () => {
        const { db } = initFirebaseAdmin();
        if (!db) fail("STORE_STORAGE_UNAVAILABLE", 503);
        const s = await db.collection("storefrontExperience").doc("main").get();
        const row = s.exists ? s.data() : {};
        cache = {
          at: Date.now(),
          value: {
            categories: row.categories || [],
            banners: row.banners || [],
            revision: Number(row.revision) || 0,
            updatedAt: Number(row.updatedAt) || 0,
          },
        };
      })().finally(() => {
        pending = null;
      });
    await pending;
  }
  const value = structuredClone(cache.value);
  if (admin) return value;
  const now = Date.now();
  value.categories = value.categories.filter((x) => x.enabled !== false);
  value.banners = value.banners.filter(
    (x) =>
      x.enabled !== false &&
      (!x.startsAt || x.startsAt <= now) &&
      (!x.endsAt || x.endsAt > now),
  );
  return value;
}
async function updateExperience(input, actor) {
  const body = normalizeExperience(input);
  const catalog = await require("./storeCatalogService").getEffectiveCatalog({
    includeInactive: true,
  });
  const ids = new Set(catalog.products.map((p) => p.id));
  if (body.categories.some((c) => c.productIds.some((id) => !ids.has(id))))
    fail("EXPERIENCE_PRODUCT_UNKNOWN");
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0
  )
    fail("EXPERIENCE_REVISION_REQUIRED");
  const { db } = initFirebaseAdmin();
  if (!db) fail("STORE_STORAGE_UNAVAILABLE", 503);
  const ref = db.collection("storefrontExperience").doc("main");
  await db.runTransaction(async (tx) => {
    const old = (await tx.get(ref)).data() || {};
    if ((Number(old.revision) || 0) !== input.expectedRevision)
      fail("EXPERIENCE_CONFLICT", 409);
    const next = {
      ...body,
      revision: input.expectedRevision + 1,
      updatedAt: Date.now(),
    };
    tx.set(ref, next);
    recordMutationAudit(tx, db, "store.content.update", actor, {
      before: old,
      after: next,
    });
  });
  cache = null;
  return getExperience({ admin: true });
}
module.exports = { normalizeExperience, getExperience, updateExperience };
