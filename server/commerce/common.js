"use strict";
const crypto = require("node:crypto");
const { initFirebaseAdmin } = require("../config/firebaseAdmin");
const { createdAtPage } = require("../core/firestorePagination");
const { recordMutationAudit } = require("../core/storeMutationAudit");
function error(code, statusCode = 400, details = {}) {
  return Object.assign(new Error(code), { code, statusCode, ...details });
}
function fail(code, status = 400, details = {}) {
  throw error(code, status, details);
}
function db() {
  const firebase = initFirebaseAdmin();
  if (!firebase.db) fail("STORE_STORAGE_UNAVAILABLE", 503);
  return firebase.db;
}
function text(value, max = 160, { required = false } = {}) {
  if (
    typeof value !== "string" ||
    value.length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  )
    fail("COMMERCE_INPUT_INVALID");
  const clean = value.trim();
  if (required && !clean) fail("COMMERCE_INPUT_REQUIRED");
  return clean;
}
function id(value, max = 128) {
  const clean = text(value, max, { required: true });
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(clean)) fail("COMMERCE_ID_INVALID");
  return clean;
}
function uid(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 128 ||
    value !== value.trim() ||
    /[\/\\<>\u0000-\u001f\u007f]/.test(value) ||
    [".", ".."].includes(value)
  )
    fail("COMMERCE_ID_INVALID");
  return value;
}
function integer(value, min = 0, max = 100000000) {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    fail("COMMERCE_VALUE_INVALID");
  return value;
}
function flag(value) {
  if (typeof value !== "boolean") fail("COMMERCE_VALUE_INVALID");
  return value;
}
function choice(value, values) {
  if (!values.includes(value)) fail("COMMERCE_VALUE_INVALID");
  return value;
}
function object(value, keys) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.keys(value).some((k) => !keys.includes(k))
  )
    fail("COMMERCE_FIELDS_INVALID");
  return value;
}
function array(value, limit = 100) {
  if (!Array.isArray(value) || value.length > limit)
    fail("COMMERCE_LIST_INVALID");
  return value;
}
function hash(...parts) {
  return crypto.createHash("sha256").update(parts.join("\0")).digest("hex");
}
function requireRevision(actual, expected) {
  integer(expected);
  if ((actual || 0) !== expected)
    fail("COMMERCE_REVISION_CONFLICT", 409, { currentRevision: actual || 0 });
}
async function activeUser(
  uid,
  { purchase = false, transaction = null, database = db() } = {},
) {
  module.exports.uid(uid);
  const ref = database.collection("users").doc(uid),
    snap = await (transaction ? transaction.get(ref) : ref.get());
  const row = snap.data() || {};
  if (
    row.storeAccountStatus === "suspended" ||
    (purchase && row.storeAccountStatus === "purchase_blocked")
  )
    fail("STORE_PURCHASE_BLOCKED", 403);
  return row;
}
async function orderForUser(
  uid,
  orderId,
  { transaction = null, database = db(), recipient = false } = {},
) {
  module.exports.uid(uid);
  id(orderId);
  const ref = database.collection("storeOrders").doc(orderId),
    snap = await (transaction ? transaction.get(ref) : ref.get());
  const row = snap.data();
  if (
    !snap.exists ||
    (row.uid !== uid && !(recipient && row.giftRecipientUid === uid))
  )
    fail("STORE_ORDER_NOT_FOUND", 404);
  return { ...row, id: snap.id };
}
async function page(
  collection,
  { uid = "", field = "uid", limit = 30, cursor = "" } = {},
) {
  const database = db();
  return createdAtPage({
    db: database,
    collection,
    filters: uid ? [[field, uid]] : [],
    limit: Math.min(100, Math.max(1, Number(limit) || 30)),
    cursor,
  });
}
function publicRows(result, pick = (x) => x) {
  return {
    items: result.docs.map((d) => pick({ ...d.data(), id: d.id })),
    nextCursor: result.nextCursor || "",
  };
}
function audit(tx, database, action, actor, changes) {
  recordMutationAudit(tx, database, action, actor, changes);
}
function notification(
  tx,
  database,
  uid,
  key,
  title,
  message,
  data = {},
  { site = true } = {},
) {
  const ref = database.collection("storeNotifications").doc(hash(uid, key));
  if (site)
    tx.set(
      ref,
      {
        id: ref.id,
        uid,
        type: "commerce",
        title,
        message,
        productId: data.productId || "",
        orderId: data.orderId || "",
        readAt: 0,
        createdAt: Date.now(),
        ...data,
      },
      { merge: true },
    );
  const emailType = key.split(":")[0];
  if (["stock", "price", "license"].includes(emailType))
    require("../email/service").enqueue(tx, database, {
      uid,
      type: emailType,
      key,
      data,
    });
}
module.exports = {
  error,
  fail,
  db,
  text,
  id,
  uid,
  integer,
  flag,
  choice,
  object,
  array,
  hash,
  requireRevision,
  activeUser,
  orderForUser,
  page,
  publicRows,
  audit,
  notification,
};
