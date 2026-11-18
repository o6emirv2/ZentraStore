"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { applicationFixture } = require("./helpers/application-fixture.cjs");
const { memoryFirestore } = require("./helpers/memory-firestore.cjs");
const { backfillCommunityProfiles, memberActor } = require("./backfill-community-profiles.cjs");
let f, product, community;
before(async () => {
  f = await applicationFixture();
  product = (await f.request("/api/store/catalog")).body.catalog.products[0];
  community = require("../server/commerce/community");
});
after(async () => f?.close());

test("member likes expose current username and selected avatar while guests retain anonymous identity", async () => {
  await community.like(product.id, { uid: "member" }, { liked: true, expectedRevision: 0, mutationId: crypto.randomUUID() });
  await community.like(product.id, { visitorToken: community.issueVisitor().visitorToken }, { liked: true, expectedRevision: 0, mutationId: crypto.randomUUID() });
  const response = await f.request("/api/store/commerce/community/" + product.id + "/likes");
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const people = response.body.result.people;
  assert.equal(people.length, 2);
  const member = people.find(person => person.profile.kind === "member").profile;
  assert.equal(member.username, "EmirHan");
  assert.match(member.avatarUrl, /^https:\/\/encrypted-tbn0\.gstatic\.com\/images\?/);
  assert.deepEqual(people.find(person => person.profile.kind === "guest").profile, { kind: "guest", username: "", avatarUrl: "" });
  const raw = JSON.stringify(response.body.result);
  for (const secret of ["member@zentra.invalid", "storeBalanceKurus", "memberUid", "visitor:", "member:", community.actor("member")]) assert(!raw.includes(secret));
});

test("review profiles update after a real profile edit without relying on a stale name snapshot", async () => {
  const C = require("../server/commerce/common");
  f.db.records.set("storeReviews/" + C.hash("member", product.id), { productId: product.id, uid: "member", verifiedPurchase: true, status: "published", rating: 5, title: "Test", message: "Gerçek kayıt", displayName: "OldName", createdAt: Date.now() });
  const record = f.db.records.get("users/member");
  f.db.records.set("users/member", { ...record, username: "new_username", storeProfile: { avatarId: "2" } });
  const data = await community.read(product.id);
  assert.equal(data.reviews[0].profile.username, "new_username");
  assert.equal(data.reviews[0].displayName, "new_username");
  assert.equal(data.reviews[0].profile.avatarUrl, require("../server/core/storeAvatars").getAvatarById("2").image);
  assert.equal((await community.likers(product.id)).people.find(person => person.profile.kind === "member").profile.username, "new_username");
  const publicProduct = await require("../server/commerce/catalog").publicProduct(product.id);
  assert.equal(publicProduct.reviews[0].profile.username, "new_username");
  f.db.records.set("users/member", record);
});

test("liker pagination is bounded, duplicate-free, opaque and cannot be reused for another product", async () => {
  const C = require("../server/commerce/common");
  for (let i = 0; i < 44; i++) {
    const uid = "sample-user-" + i, actor = community.actor(uid);
    f.db.records.set("users/" + uid, { username: "sample_" + i, storeProfile: { avatarId: "3" } });
    f.db.records.set("storeProductReactions/" + C.hash(product.id, actor), { productId: product.id, actor, memberUid: uid, liked: true, revision: 1, updatedAt: Date.now() - i * 1000 });
  }
  let page = await community.likers(product.id), people = [...page.people], pages = 1;
  assert.equal(page.people.length, 20); assert(page.nextCursor);
  const cursor = page.nextCursor;
  assert(!Buffer.from(cursor, "base64url").toString().includes("sample-user"));
  while (page.nextCursor) {
    assert(pages++ < 5);
    page = await community.likers(product.id, { cursor: page.nextCursor });
    people.push(...page.people);
  }
  assert.equal(people.length, 46);
  assert.equal(new Set(people.map(person => person.id)).size, 46);
  const other = (await f.request("/api/store/catalog")).body.catalog.products[1];
  await assert.rejects(community.likers(other.id, { cursor }), { code: "COMMUNITY_CURSOR_INVALID" });
  await assert.rejects(community.likers(product.id, { cursor: cursor.slice(0, -8) + "tampered" }), { code: "COMMUNITY_CURSOR_INVALID" });
  const now = Date.now;
  try { Date.now = () => now() + 3600001; await assert.rejects(community.likers(product.id, { cursor }), { code: "COMMUNITY_CURSOR_INVALID" }); }
  finally { Date.now = now; }
});

test("missing, suspended or malformed public profiles never leak an email, private photo URL or mismatched account", async () => {
  const { publicProfile } = require("../server/commerce/publicProfiles");
  for (const row of [null, { username: "private@example.test" }, { username: "<script>alert(1)</script>" }, { username: "valid_name", storeAccountStatus: "suspended" }])
    assert.deepEqual(publicProfile(row), { kind: "unavailable", username: "", avatarUrl: "" });
  const C = require("../server/commerce/common"), actor = community.actor("broken-user");
  f.db.records.set("storeProductReactions/" + C.hash(product.id, actor), { productId: product.id, actor, memberUid: "member", liked: true, updatedAt: Date.now() + 1000 });
  assert.equal((await community.likers(product.id)).people[0].profile.kind, "unavailable");
});

test("legacy profile matching previews without writes and applies only exact identities with repeat safety", async () => {
  const db = memoryFirestore([
    ["users/buyer", { username: "buyer_user", email: "private@example.test", storeBalanceKurus: 500 }],
    ["storeProductReactions/exact", { actor: memberActor("buyer"), productId: "product", liked: true, revision: 4 }],
    ["storeProductReactions/guest", { actor: "visitor:test", liked: true }],
    ["storeProductReactions/missing", { actor: memberActor("deleted-buyer"), liked: true }],
    ["storeProductReactions/conflict", { actor: memberActor("buyer"), memberUid: "another", liked: true }],
  ]);
  const initial = structuredClone([...db.records]);
  const preview = await backfillCommunityProfiles(db);
  assert.equal(preview.eligible, 1); assert.equal(preview.conflicts, 1); assert.equal(preview.unmatched, 1);
  assert.deepEqual([...db.records], initial);
  const applied = await backfillCommunityProfiles(db, { apply: true });
  assert.equal(applied.linked, 1);
  assert.deepEqual(db.records.get("storeProductReactions/exact"), { ...initial.find(([path]) => path.endsWith("/exact"))[1], memberUid: "buyer" });
  assert.equal(db.records.get("storeProductReactions/conflict").memberUid, "another");
  assert.equal(db.records.get("users/buyer").storeBalanceKurus, 500);
  assert.equal((await backfillCommunityProfiles(db, { apply: true })).linked, 0);
  assert(!JSON.stringify(applied).includes("private@example.test"));
});

test("legacy profile mapping survives more than one scan page and a failed commit cannot create an identity", async () => {
  const db = memoryFirestore();
  for (let i = 0; i < 205; i++) db.records.set("users/user-" + i, { username: "sample_" + i });
  db.records.set("storeProductReactions/last", { actor: memberActor("user-204"), liked: true });
  assert.equal((await backfillCommunityProfiles(db)).users, 205);
  db.setFailure(true);
  await assert.rejects(backfillCommunityProfiles(db, { apply: true }));
  assert.equal(db.records.get("storeProductReactions/last").memberUid, undefined);
  db.setFailure(false);
  assert.equal((await backfillCommunityProfiles(db, { apply: true })).linked, 1);
});
