"use strict";
const crypto = require("node:crypto");
const memberActor = uid => "member:" + crypto.createHash("sha256").update(uid).digest("hex");

async function backfillCommunityProfiles(database, { apply = false, documentId = "__name__" } = {}) {
  const members = new Map(), ambiguous = new Set();
  const result = { mode: apply ? "apply" : "preview", users: 0, reactions: 0, alreadyLinked: 0, eligible: 0, linked: 0, guests: 0, unmatched: 0, conflicts: 0 };
  async function scan(name, visit) {
    let anchor;
    for (;;) {
      let query = database.collection(name).orderBy(documentId);
      if (name === "users") query = query.select();
      query = query.limit(200);
      if (anchor) query = query.startAfter(anchor);
      const snapshot = await query.get();
      for (const doc of snapshot.docs) await visit(doc);
      if (snapshot.docs.length < 200) break;
      anchor = snapshot.docs.at(-1);
    }
  }
  await scan("users", async doc => {
    const actor = memberActor(doc.id);
    if (members.has(actor) && members.get(actor) !== doc.id) ambiguous.add(actor);
    members.set(actor, doc.id);
    result.users++;
  });
  await scan("storeProductReactions", async doc => {
    result.reactions++;
    const row = doc.data(), uid = members.get(row.actor);
    if (row.actor?.startsWith("visitor:")) { result.guests++; return; }
    if (!uid || ambiguous.has(row.actor)) { result.unmatched++; return; }
    if (row.memberUid === uid) { result.alreadyLinked++; return; }
    if (row.memberUid) { result.conflicts++; return; }
    result.eligible++;
    if (!apply) return;
    const state = await database.runTransaction(async tx => {
      const fresh = await tx.get(doc.ref), current = fresh.data();
      if (!fresh.exists || current.actor !== memberActor(uid)) return "conflict";
      if (current.memberUid === uid) return "already";
      if (current.memberUid) return "conflict";
      tx.set(doc.ref, { memberUid: uid }, { merge: true });
      return "linked";
    });
    if (state === "linked") result.linked++;
    else if (state === "already") result.alreadyLinked++;
    else result.conflicts++;
  });
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => !["--preview", "--apply"].includes(arg)) || args.includes("--preview") && args.includes("--apply"))
    throw new Error("Kullanım: node scripts/backfill-community-profiles.cjs --preview veya --apply");
  const { initFirebaseAdmin } = require("../server/config/firebaseAdmin"), { db, admin } = initFirebaseAdmin();
  if (!db) throw new Error("STORE_STORAGE_UNAVAILABLE");
  const result = await backfillCommunityProfiles(db, { apply: args.includes("--apply"), documentId: admin.firestore.FieldPath.documentId() });
  console.log(JSON.stringify(result, null, 2));
  if (result.conflicts || result.unmatched) process.exitCode = 2;
}
if (require.main === module) main().catch(error => { console.error(error.code || "COMMUNITY_PROFILE_BACKFILL_FAILED"); process.exitCode = 1; });
module.exports = { backfillCommunityProfiles, memberActor };
