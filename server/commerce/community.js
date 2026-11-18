"use strict";
const crypto = require("node:crypto");
const C = require("./common");
const catalog = require("./catalog");
const { purposeKey } = require("../core/adminAccessService");
const { createdAtPage } = require("../core/firestorePagination");
const { readPublicProfiles, unavailableProfile } = require("./publicProfiles");
const { sealCursor, openCursor } = require("./communityPaging");
const sign = (value) =>
  crypto
    .createHmac("sha256", purposeKey("community-visitor-v1"))
    .update(value)
    .digest("base64url");
function issueVisitor() {
  const expiresAt = Date.now() + 365 * 86400000;
  const payload = Buffer.from(
    JSON.stringify({
      nonce: crypto.randomBytes(32).toString("base64url"),
      expiresAt,
    }),
  ).toString("base64url");
  return { visitorToken: payload + "." + sign(payload), expiresAt };
}
function actor(uid = "", token = "") {
  if (uid) return "member:" + C.hash(C.uid(uid));
  if (typeof token !== "string" || token.length > 500)
    C.fail("COMMUNITY_VISITOR_REQUIRED", 401);
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra || !/^[A-Za-z0-9_-]+$/.test(payload))
    C.fail("COMMUNITY_VISITOR_REQUIRED", 401);
  const expected = Buffer.from(sign(payload)),
    supplied = Buffer.from(signature);
  if (
    supplied.length !== expected.length ||
    !crypto.timingSafeEqual(supplied, expected)
  )
    C.fail("COMMUNITY_VISITOR_REQUIRED", 401);
  let row;
  try {
    row = JSON.parse(Buffer.from(payload, "base64url").toString());
  } catch {
    C.fail("COMMUNITY_VISITOR_REQUIRED", 401);
  }
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(row.nonce || "") ||
    !Number.isSafeInteger(row.expiresAt) ||
    row.expiresAt <= Date.now()
  )
    C.fail("COMMUNITY_VISITOR_REQUIRED", 401);
  return "visitor:" + C.hash(row.nonce);
}
function reactionView(counter = {}, record = {}) {
  const likes = counter.likes ?? 0;
  if (!Number.isSafeInteger(likes) || likes < 0)
    C.fail("COMMUNITY_INTEGRITY_REQUIRED", 503);
  return {
    likes,
    liked: record.liked === true,
    revision: record.revision || 0,
  };
}
async function reviewEligibility(uid, productId) {
  if (!uid) return { eligible: false, reason: "sign-in" };
  const { auth } = require("../config/firebaseAdmin").initFirebaseAdmin();
  let user;
  try {
    user = await auth.getUser(uid);
  } catch {
    C.fail("AUTH_UNAVAILABLE", 503);
  }
  if (user.disabled || !user.emailVerified)
    return { eligible: false, reason: "verification-required" };
  const access = await require("../core/accountActivation").accountAccess(
    { uid, email: user.email },
    { user },
  );
  if (!access.ready)
    return { eligible: false, reason: "verification-required" };
  const database = C.db();
  const existing = await database
    .collection("storeReviews")
    .doc(C.hash(uid, productId))
    .get();
  if (existing.exists) return { eligible: false, reason: "already-reviewed" };
  const orders = await database
    .collection("storeOrders")
    .where("uid", "==", uid)
    .limit(2001)
    .get();
  if (orders.size > 2000) return { eligible: false, reason: "choose-order" };
  const record = orders.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .find(
      (o) =>
        o.status === "delivered" &&
        o.approvedAt &&
        o.items?.some((x) => x.productId === productId),
    );
  return record
    ? { eligible: true, orderId: record.id }
    : { eligible: false, reason: "purchase-required" };
}
async function read(
  productId,
  { uid = "", visitorToken = "", cursor = "" } = {},
) {
  productId = (await catalog.resolveProduct(productId)).id;
  const database = C.db(),
    identity = uid || visitorToken ? actor(uid, visitorToken) : "";
  const [counter, record, reviews, eligibility] = await Promise.all([
    database.collection("storeProductCommunity").doc(productId).get(),
    identity
      ? database
          .collection("storeProductReactions")
          .doc(C.hash(productId, identity))
          .get()
      : null,
    createdAtPage({
      db: database,
      collection: "storeReviews",
      filters: [
        ["productId", productId],
        ["status", "published"],
      ],
      limit: 20,
      cursor,
    }),
    reviewEligibility(uid, productId),
  ]);
  const verifiedReviews = (
    await Promise.all(
      reviews.docs.map(async (doc) => {
        const row = doc.data();
        if (row.verifiedPurchase === true) return doc;
        // Older genuine reviews predate the explicit flag. Verify their original order without rewriting customer data.
        if (!row.uid || !row.orderId) return null;
        const order = (
          await database.collection("storeOrders").doc(row.orderId).get()
        ).data();
        return order?.uid === row.uid &&
          order.status === "delivered" &&
          order.approvedAt &&
          order.items?.some((item) => item.productId === productId)
          ? doc
          : null;
      }),
    )
  ).filter(Boolean);
  const profiles = await readPublicProfiles(database, [...verifiedReviews.map(doc => doc.data().uid), uid]);
  return {
    productId,
    ...reactionView(counter.data(), record?.data()),
    reviews: verifiedReviews.map((d) => {
      const r = d.data();
      return {
        id: d.id,
        title: r.title,
        message: r.message,
        rating: r.rating,
        displayName: profiles.get(r.uid)?.username || "Zentra üyesi",
        profile: profiles.get(r.uid) || unavailableProfile(),
        createdAt: r.createdAt,
        verifiedPurchase: true,
      };
    }),
    nextCursor: reviews.nextCursor,
    eligibility,
    ...(uid ? { viewerProfile: profiles.get(uid) || unavailableProfile() } : {}),
  };
}

async function likers(productId, { cursor = "" } = {}) {
  productId = (await catalog.resolveProduct(productId)).id;
  const database = C.db(), collection = database.collection("storeProductReactions");
  let query = collection.where("productId", "==", productId).where("liked", "==", true).orderBy("updatedAt", "desc");
  if (cursor) {
    const anchor = await collection.doc(openCursor(productId, cursor)).get();
    if (!anchor.exists || anchor.data().productId !== productId)
      C.fail("COMMUNITY_CURSOR_INVALID", 400);
    query = query.startAfter(anchor);
  }
  const snapshot = await query.limit(21).get(), docs = snapshot.docs.slice(0, 20);
  const members = docs.map(doc => {
    const row = doc.data();
    let member = "";
    try { if (row.memberUid && actor(row.memberUid) === row.actor) member = row.memberUid; } catch {}
    return member;
  });
  const profiles = await readPublicProfiles(database, members);
  return { productId, people: docs.map((doc, index) => {
    const row = doc.data();
    return { id: crypto.createHmac("sha256", purposeKey("community-person-v1")).update(productId + "|" + doc.id).digest("base64url").slice(0, 24), profile: row.actor?.startsWith("visitor:")
      ? { kind: "guest", username: "", avatarUrl: "" }
      : profiles.get(members[index]) || unavailableProfile() };
  }), nextCursor: snapshot.docs.length > 20 ? sealCursor(productId, docs.at(-1).id) : "" };
}
async function like(productId, { uid = "", visitorToken = "" } = {}, input) {
  C.object(input, ["liked", "mutationId", "expectedRevision"]);
  const liked = C.flag(input.liked),
    mutationId = C.id(input.mutationId, 100),
    revision = C.integer(input.expectedRevision, 0);
  if (mutationId.length < 12) C.fail("COMMERCE_ID_INVALID");
  productId = (await catalog.resolveProduct(productId)).id;
  const identity = actor(uid, visitorToken),
    database = C.db();
  const counterRef = database
    .collection("storeProductCommunity")
    .doc(productId);
  const recordRef = database
    .collection("storeProductReactions")
    .doc(C.hash(productId, identity));
  const receiptRef = database
    .collection("storeProductReactionReceipts")
    .doc(C.hash(productId, identity, mutationId));
  return database.runTransaction(async (tx) => {
    const [counter, record, receipt] = await Promise.all([
      tx.get(counterRef),
      tx.get(recordRef),
      tx.get(receiptRef),
    ]);
    const current = reactionView(counter.data(), record.data());
    if (receipt.exists) {
      if (
        receipt.data().liked !== liked ||
        receipt.data().expectedRevision !== revision
      )
        C.fail("COMMUNITY_OPERATION_CONFLICT", 409);
      return { productId, ...current, replayed: true };
    }
    if (current.revision !== revision)
      C.fail("COMMUNITY_REVISION_CONFLICT", 409);
    const likes = current.likes + Number(liked) - Number(current.liked);
    if (likes < 0 || !Number.isSafeInteger(likes))
      C.fail("COMMUNITY_INTEGRITY_REQUIRED", 503);
    const next = {
      liked,
      revision: current.revision + 1,
      updatedAt: Date.now(),
    };
    tx.set(recordRef, { ...next, productId, actor: identity, ...(uid ? { memberUid: uid } : {}) });
    tx.set(
      counterRef,
      { productId, likes, updatedAt: Date.now() },
      { merge: true },
    );
    tx.create(receiptRef, {
      liked,
      expectedRevision: revision,
      createdAt: Date.now(),
    });
    return {
      productId,
      likes,
      liked,
      revision: next.revision,
      replayed: false,
    };
  });
}
module.exports = { issueVisitor, actor, read, like, likers, reviewEligibility };
