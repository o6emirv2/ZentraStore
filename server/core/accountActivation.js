"use strict";
const { initFirebaseAdmin } = require("../config/firebaseAdmin");
const fail = (code, statusCode = 403) =>
  Object.assign(new Error(code), { code, statusCode });
async function liveIdentity(decoded) {
  const { auth } = initFirebaseAdmin();
  if (!auth) throw fail("AUTH_UNAVAILABLE", 503);
  let user;
  try {
    user = await auth.getUser(decoded.uid);
  } catch (error) {
    if (error?.code === "auth/user-not-found") throw fail("AUTH_INVALID", 401);
    throw fail("AUTH_UNAVAILABLE", 503);
  }
  if (
    !user ||
    user.disabled ||
    user.uid !== decoded.uid ||
    !user.email ||
    user.email.trim().toLowerCase() !==
      String(decoded.email || "")
        .trim()
        .toLowerCase()
  )
    throw fail("AUTH_ACCOUNT_MISMATCH", 401);
  return user;
}
async function accountAccess(decoded, { user } = {}) {
  user ||= await liveIdentity(decoded);
  if (user.emailVerified !== true)
    return { ready: false, reason: "EMAIL_VERIFICATION_REQUIRED", user };
  try {
    return await profileAccess(user);
  } catch {
    throw fail("AUTH_UNAVAILABLE", 503);
  }
}
async function profileAccess(user) {
  const { db } = initFirebaseAdmin();
  if (!db) throw fail("AUTH_UNAVAILABLE", 503);
  const profile = await db.collection("users").doc(user.uid).get();
  const row = profile.data() || {};
  if (row.registrationVerificationRequired === 1) {
    const receipt = (
      await db.collection("storeAccountVerifications").doc(user.uid).get()
    ).data();
    if (
      receipt?.state === "completed" &&
      receipt.uid === user.uid &&
      Number(receipt.verifiedAt) > 0 &&
      row.profileInitializationPending !== true
    )
      return { ready: true, user };
    return { ready: false, reason: "EMAIL_VERIFICATION_REQUIRED", user };
  }
  if (profile.exists && row.profileInitializationPending !== true)
    return { ready: true, user };
  if (
    await require("./adminStoreService").resolveStaffPolicy(
      user.uid,
      user.email,
    )
  )
    return { ready: true, user };
  return { ready: false, reason: "REGISTRATION_REQUIRED", user };
}
async function requireAccountAccess(decoded) {
  const result = await accountAccess(decoded);
  if (!result.ready) throw fail(result.reason);
  return result.user;
}
module.exports = { liveIdentity, accountAccess, requireAccountAccess, fail };
