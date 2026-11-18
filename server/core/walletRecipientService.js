"use strict";
const crypto = require("node:crypto");
const { initFirebaseAdmin } = require("../config/firebaseAdmin");
const { findUsernameProfiles } = require("./storeUsername");
const { readStoredBalance } = require("./storeMoney");
const { purposeKey } = require("./adminAccessService");
function failure(code, statusCode = 400) {
  return Object.assign(new Error(code), { code, statusCode });
}
function identifier(value) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 254 ||
    /[<>\\/\u0000-\u001f\u007f]/.test(value)
  )
    throw failure("STORE_USER_IDENTIFIER_INVALID");
  return value.trim().normalize("NFC");
}
const missing = (error) =>
  ["auth/user-not-found", "auth/invalid-uid", "auth/invalid-email"].includes(
    error?.code,
  );
async function identity(read) {
  try {
    return await read();
  } catch (error) {
    if (missing(error)) return null;
    throw failure("STORE_ACCOUNT_LOOKUP_UNAVAILABLE", 503);
  }
}
async function resolveIdentity(value, { allowDisabled = false } = {}) {
  const query = identifier(value),
    { db, auth } = initFirebaseAdmin();
  if (!db || !auth) throw failure("STORE_STORAGE_UNAVAILABLE", 503);
  let account;
  if (query.includes("@")) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(query))
      throw failure("STORE_USER_IDENTIFIER_INVALID");
    account = await identity(() => auth.getUserByEmail(query.toLowerCase()));
  } else {
    const direct =
      query.length <= 128 ? await identity(() => auth.getUser(query)) : null;
    let matches = [];
    try {
      matches = await findUsernameProfiles(db, query);
    } catch (error) {
      if (error.code === "USERNAME_AMBIGUOUS")
        throw failure("STORE_USER_IDENTIFIER_AMBIGUOUS", 409);
      if (!["INVALID_USERNAME", "USERNAME_RESERVED"].includes(error.code))
        throw error;
    }
    if (matches.length > 1)
      throw failure("STORE_USER_IDENTIFIER_AMBIGUOUS", 409);
    const named = matches.length
      ? await identity(() => auth.getUser(matches[0].id))
      : null;
    if (direct && named && direct.uid !== named.uid)
      throw failure("STORE_USER_IDENTIFIER_AMBIGUOUS", 409);
    account = direct || named;
  }
  if (!account) throw failure("STORE_ACCOUNT_NOT_FOUND", 404);
  if (account.disabled && !allowDisabled)
    throw failure("STORE_ACCOUNT_DISABLED", 409);
  return account;
}
async function resolve(value) {
  const account = await resolveIdentity(value);
  const { db } = initFirebaseAdmin();
  const profile =
    (await db.collection("users").doc(account.uid).get()).data() || {};
  return {
    uid: account.uid,
    username: String(profile.username || account.displayName || ""),
    email: String(account.email || ""),
    fullName: String(
      profile.fullName ||
        [profile.firstName, profile.lastName].filter(Boolean).join(" "),
    ),
    balanceKurus: readStoredBalance(profile),
    accountStatus: profile.storeAccountStatus || "active",
  };
}
function seal(data) {
  const iv = crypto.randomBytes(12),
    cipher = crypto.createCipheriv(
      "aes-256-gcm",
      purposeKey("wallet-recipient-preview-v1"),
      iv,
    );
  const content = Buffer.concat([
    cipher.update(JSON.stringify(data)),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), content]).toString(
    "base64url",
  );
}
function unseal(token, actorUid, uid, now = Date.now()) {
  try {
    if (
      typeof token !== "string" ||
      token.length > 4096 ||
      !/^[A-Za-z0-9_-]+$/.test(token)
    )
      throw Error();
    const raw = Buffer.from(token, "base64url");
    if (raw.length < 30 || raw.toString("base64url") !== token) throw Error();
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      purposeKey("wallet-recipient-preview-v1"),
      raw.subarray(0, 12),
    );
    decipher.setAuthTag(raw.subarray(12, 28));
    const data = JSON.parse(
      Buffer.concat([
        decipher.update(raw.subarray(28)),
        decipher.final(),
      ]).toString(),
    );
    if (
      data.actorUid !== actorUid ||
      data.uid !== uid ||
      !Number.isSafeInteger(data.expiresAt) ||
      !Number.isSafeInteger(data.balanceKurus) ||
      data.balanceKurus < 0
    )
      throw Error();
    if (data.expiresAt <= now)
      throw failure("STORE_WALLET_PREVIEW_EXPIRED", 409);
    identifier(data.identifier);
    return data;
  } catch (error) {
    if (error.code === "STORE_WALLET_PREVIEW_EXPIRED") throw error;
    throw failure("STORE_WALLET_PREVIEW_INVALID", 409);
  }
}
async function preview(value, actorUid) {
  const query = identifier(value),
    recipient = await resolve(query),
    expiresAt = Date.now() + 300000;
  return {
    recipient,
    expiresAt,
    recipientToken: seal({
      actorUid,
      uid: recipient.uid,
      identifier: query,
      balanceKurus: recipient.balanceKurus,
      expiresAt,
    }),
  };
}
async function verify(token, actorUid, uid) {
  const data = unseal(token, actorUid, uid),
    current = await resolve(data.identifier);
  if (current.uid !== uid) throw failure("STORE_WALLET_RECIPIENT_CHANGED", 409);
  return data;
}
module.exports = {
  resolve,
  resolveIdentity,
  preview,
  verify,
  unseal,
  identifier,
};
