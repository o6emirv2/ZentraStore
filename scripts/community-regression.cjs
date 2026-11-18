"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { applicationFixture } = require("./helpers/application-fixture.cjs");
let f, p, community, visitor;
const base = "/api/store/commerce/community";
const operation = (liked = true, expectedRevision = 0) => ({
  liked,
  expectedRevision,
  mutationId: crypto.randomUUID(),
});
const like = (body, token = visitor, uid) =>
  f.request(base + "/" + p.id + "/like", {
    uid,
    method: "PUT",
    body,
    headers: token ? { "X-Zentra-Visitor": token } : {},
  });
before(async () => {
  f = await applicationFixture();
  p = (await f.request("/api/store/catalog")).body.catalog.products[0];
  community = require("../server/commerce/community");
  visitor = (await f.request(base + "/visitor", { method: "POST", body: {} }))
    .body.result.visitorToken;
});
after(async () => f?.close());
test("anonymous readers see real zero counts and no private customer data", async () => {
  const response = await f.request(base + "/" + p.id);
  assert.equal(response.status, 200);
  assert.equal(response.body.result.likes, 0);
  assert.equal(response.body.result.liked, false);
  assert.equal(response.body.result.eligibility.eligible, false);
  assert(!JSON.stringify(response.body.result).includes("@"));
});
test("a guest can like without logging in and replaying a lost request cannot increment twice", async () => {
  const body = operation();
  const first = await like(body);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.result.likes, 1);
  assert.equal(first.body.result.liked, true);
  const replay = await like(body);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.result.likes, 1);
  assert.equal(replay.body.result.replayed, true);
});
test("unlike is atomic and restoring the original receipt never reverses a later unlike", async () => {
  const body = operation(false, 1);
  const result = await like(body);
  assert.equal(result.status, 200);
  assert.equal(result.body.result.likes, 0);
  assert.equal((await like(body)).body.result.likes, 0);
});
test("stale revisions and reusing one mutation key for a different body are rejected", async () => {
  assert.equal((await like(operation(true, 0))).status, 409);
  const body = operation(true, 2);
  assert.equal((await like(body)).status, 200);
  assert.equal((await like({ ...body, liked: false })).status, 409);
});
test("distinct visitor identities get separate records and one shared consistent counter", async () => {
  const token = community.issueVisitor().visitorToken;
  const result = await like(operation(), token);
  assert.equal(result.status, 200);
  assert.equal(result.body.result.likes, 2);
  const owner = await f.request(base + "/" + p.id, {
    headers: { "X-Zentra-Visitor": token },
  });
  assert.equal(owner.body.result.liked, true);
});
test("forged, missing, expired and oversized guest tokens cannot write likes", async () => {
  for (const token of ["", visitor + "a", "x".repeat(501)])
    assert.equal((await like(operation(), token)).status, 401);
  const original = Date.now;
  let expired;
  try {
    Date.now = () => original() - 366 * 86400000;
    expired = community.issueVisitor().visitorToken;
  } finally {
    Date.now = original;
  }
  assert.throws(() => community.actor("", expired), {
    code: "COMMUNITY_VISITOR_REQUIRED",
  });
});
test("an explicit invalid bearer cannot fall back to a valid visitor identity", async () => {
  const response = await f.request(base + "/" + p.id + "/like", {
    method: "PUT",
    body: operation(),
    headers: {
      "X-Zentra-Visitor": visitor,
      Authorization: "Bearer invalid.token",
    },
  });
  assert.equal(response.status, 401);
});
test("a signed-in account can like from multiple devices without multiplying its vote", async () => {
  const body = operation();
  const first = await like(body, "", "member");
  assert.equal(first.status, 200);
  const second = await like(body, "", "member");
  assert.equal(second.body.result.likes, first.body.result.likes);
  assert.equal(second.body.result.replayed, true);
});
test("cross-origin requests and caller-nominated identities are refused", async () => {
  const response = await f.request(base + "/" + p.id + "/like", {
    method: "PUT",
    body: operation(),
    headers: {
      "X-Zentra-Visitor": visitor,
      origin: "https://attacker.invalid",
    },
  });
  assert.equal(response.status, 403);
  assert.equal((await like({ ...operation(), uid: "owneruid" })).status, 400);
  assert.equal((await like({ ...operation(), liked: "true" })).status, 400);
});
test("a missing product cannot create counters or reaction records", async () => {
  const before = f.db.stats.writes;
  await assert.rejects(
    community.like("missing-product", { visitorToken: visitor }, operation()),
    { statusCode: 404 },
  );
  assert.equal(f.db.stats.writes, before);
});
test("a failed database commit reports failure without changing the counter or recording a receipt", async () => {
  const token = community.issueVisitor().visitorToken,
    body = operation();
  const before = structuredClone(
    f.db.records.get("storeProductCommunity/" + p.id),
  );
  f.db.setFailure(true);
  try {
    await assert.rejects(community.like(p.id, { visitorToken: token }, body));
  } finally {
    f.db.setFailure(false);
  }
  assert.deepEqual(f.db.records.get("storeProductCommunity/" + p.id), before);
  const result = await community.like(p.id, { visitorToken: token }, body);
  assert.equal(result.likes, before.likes + 1);
});
test("two concurrent operations for one actor cannot both consume the same revision", async () => {
  const token = community.issueVisitor().visitorToken;
  const results = await Promise.allSettled([
    community.like(p.id, { visitorToken: token }, operation()),
    community.like(p.id, { visitorToken: token }, operation()),
  ]);
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(
    results.find((x) => x.status === "rejected").reason.code,
    "COMMUNITY_REVISION_CONFLICT",
  );
});
const reviewBody = (orderId) => ({
  orderId,
  productId: p.id,
  title: "Gerçek deneyim",
  rating: 5,
  message: "Ürünü satın aldım ve deneyimimi paylaşıyorum.",
});
test("a non-purchaser cannot post a comment or nominate someone else's order", async () => {
  f.db.records.set("storeOrders/another-owner-order", {
    uid: "viewer",
    status: "delivered",
    approvedAt: Date.now(),
    items: [{ productId: p.id }],
  });
  const result = await f.request("/api/store/commerce/reviews", {
    uid: "member",
    method: "POST",
    body: reviewBody("another-owner-order"),
  });
  assert([403, 404].includes(result.status));
  assert.equal(
    (await community.reviewEligibility("member", p.id)).eligible,
    false,
  );
});
test("an unpaid, undelivered or unrelated-product order cannot authorize a review", async () => {
  for (const [id, patch] of [
    ["no-payment", { approvedAt: 0 }],
    ["not-delivered", { status: "processing" }],
    ["other-product", { items: [{ productId: "other" }] }],
  ]) {
    f.db.records.set("storeOrders/" + id, {
      uid: "member",
      status: "delivered",
      approvedAt: Date.now(),
      items: [{ productId: p.id }],
      ...patch,
    });
    const response = await f.request("/api/store/commerce/reviews", {
      uid: "member",
      method: "POST",
      body: reviewBody(id),
    });
    assert.equal(response.status, 403);
  }
});
test("a real purchase authorizes one published comment and public output strips financial and UID fields", async () => {
  f.db.records.set("storeOrders/buyer-delivered-order", {
    uid: "member",
    status: "delivered",
    approvedAt: Date.now(),
    items: [{ productId: p.id }],
  });
  const eligible = await community.reviewEligibility("member", p.id);
  assert.equal(eligible.eligible, true);
  const response = await f.request("/api/store/commerce/reviews", {
    uid: "member",
    method: "POST",
    body: reviewBody(eligible.orderId),
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const publicData = await community.read(p.id, { uid: "member" });
  assert.equal(publicData.reviews.length, 1);
  assert.equal(publicData.reviews[0].verifiedPurchase, true);
  assert.equal(publicData.eligibility.reason, "already-reviewed");
  for (const key of ["uid", "email", "orderId", "paymentState"])
    assert.equal(Object.hasOwn(publicData.reviews[0], key), false);
  assert.equal(
    (
      await f.request("/api/store/commerce/reviews", {
        uid: "member",
        method: "POST",
        body: reviewBody(eligible.orderId),
      })
    ).status,
    409,
  );
});
test("moderated comments disappear from public output and reappear only after a real moderation write", async () => {
  const id = require("../server/commerce/common").hash("member", p.id),
    catalog = require("../server/commerce/catalog");
  await catalog.moderate(
    id,
    { status: "hidden", reason: "Kişisel bilgi incelemesi" },
    { uid: "owneruid", email: "owner@zentra.invalid" },
  );
  assert.equal((await community.read(p.id)).reviews.length, 0);
  await catalog.moderate(
    id,
    { status: "published", reason: "İnceleme tamamlandı" },
    { uid: "owneruid", email: "owner@zentra.invalid" },
  );
  assert.equal((await community.read(p.id)).reviews.length, 1);
});

test("Pages-to-Render preflight explicitly permits the visitor identity header", async () => {
  const response = await f.request(base + "/" + p.id + "/like", {
    method: "OPTIONS",
    headers: {
      "Access-Control-Request-Method": "PUT",
      "Access-Control-Request-Headers": "content-type,x-zentra-visitor",
    },
  });
  assert.equal(response.status, 204);
  assert.match(
    response.headers.get("access-control-allow-headers"),
    /x-zentra-visitor/i,
  );
});
test("unverified or disabled Firebase accounts never receive a review-authorizing order identifier", async () => {
  const user = f.users.get("finance"),
    original = { ...user };
  f.db.records.set("storeOrders/finance-delivered", {
    uid: "finance",
    status: "delivered",
    approvedAt: Date.now(),
    items: [{ productId: p.id }],
  });
  try {
    for (const patch of [{ emailVerified: false }, { disabled: true }]) {
      Object.assign(user, original, patch);
      const value = await community.reviewEligibility("finance", p.id);
      assert.equal(value.eligible, false);
      assert.equal(Object.hasOwn(value, "orderId"), false);
    }
  } finally {
    Object.assign(user, original);
  }
});
test("legacy rows without purchase verification are never presented as verified comments", async () => {
  f.db.records.set("storeReviews/unverified-legacy", {
    productId: p.id,
    status: "published",
    title: "Legacy",
    message: "No purchase proof",
    createdAt: Date.now(),
  });
  require("../server/core/firestorePagination").invalidateCreatedAtPageCache(
    "storeReviews",
  );
  assert(
    !(await community.read(p.id)).reviews.some(
      (r) => r.id === "unverified-legacy",
    ),
  );
});
