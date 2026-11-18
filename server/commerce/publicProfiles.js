"use strict";
const { getAvatarById } = require("../core/storeAvatars");

function publicProfile(row) {
  const username = typeof row?.username === "string" ? row.username.trim().normalize("NFC") : "";
  if (!row || row.storeAccountStatus === "suspended" || !/^[\p{L}\p{N}._-]{1,40}$/u.test(username))
    return { kind: "unavailable", username: "", avatarUrl: "" };
  const avatar = getAvatarById(row.storeProfile?.avatarId || row.storeAvatarId || "1");
  return { kind: "member", username, avatarUrl: avatar?.image || "" };
}

async function readPublicProfiles(database, values) {
  const uids = [...new Set(values.filter(uid => typeof uid === "string" && uid.length > 0 && uid.length <= 128 && !uid.includes("/")))];
  const result = new Map();
  for (let start = 0; start < uids.length; start += 50) {
    const refs = uids.slice(start, start + 50).map(uid => database.collection("users").doc(uid));
    const docs = await database.getAll(...refs);
    for (const doc of docs) result.set(doc.id, publicProfile(doc.data()));
  }
  return result;
}

const unavailableProfile = () => publicProfile(null);
module.exports = { publicProfile, readPublicProfiles, unavailableProfile };
