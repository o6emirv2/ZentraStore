"use strict";
const crypto = require("node:crypto");
const env = require("../config/env");
const { purposeKey } = require("./adminAccessService");
const { initFirebaseAdmin } = require("../config/firebaseAdmin");
const { hash } = require("../commerce/common");
const { enqueue } = require("../email/service");
const key =
  env.nodeEnv === "production" ? "__Host-zentra_device" : "zentra_device";
const sign = (id) =>
  crypto
    .createHmac("sha256", purposeKey("customer-device-v1"))
    .update(id)
    .digest("hex");
function verified(value) {
  const parts = /^([a-f0-9]{32})\.([a-f0-9]{64})$/.exec(
    typeof value === "string" ? value : "",
  );
  return parts &&
    crypto.timingSafeEqual(
      Buffer.from(sign(parts[1]), "hex"),
      Buffer.from(parts[2], "hex"),
    )
    ? parts[1]
    : "";
}
function read(req) {
  const cookie = String(req.headers?.cookie || "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(key + "="));
  return (
    verified(cookie?.slice(key.length + 1)) || verified(req.body?.deviceMarker)
  );
}
async function observe(req, decoded) {
  const { db } = initFirebaseAdmin();
  if (!db)
    throw Object.assign(new Error("AUTH_UNAVAILABLE"), {
      code: "AUTH_UNAVAILABLE",
      statusCode: 503,
    });
  const uid = decoded.uid || decoded.sub;
  const device = read(req) || crypto.randomBytes(16).toString("hex");
  const id = hash(uid, device),
    ref = db.collection("storeCustomerSessions").doc(id);
  const ua = String(req.headers?.["user-agent"] || "");
  const label =
    (/iPhone/.test(ua)
      ? "iPhone"
      : /iPad/.test(ua)
        ? "iPad"
        : /Android/.test(ua)
          ? "Android"
          : /Windows/.test(ua)
            ? "Windows"
            : /Mac/.test(ua)
              ? "Mac"
              : /Linux/.test(ua)
                ? "Linux"
                : "Cihaz") +
    " · " +
    (/Edg\//.test(ua)
      ? "Edge"
      : /Firefox|FxiOS/.test(ua)
        ? "Firefox"
        : /Chrome|CriOS/.test(ua)
          ? "Chrome"
          : /Safari/.test(ua)
            ? "Safari"
            : "Tarayıcı");
  await db.runTransaction(async (tx) => {
    const previous = (await tx.get(ref)).data(),
      now = Date.now();
    if (
      previous?.revokedAt &&
      Number(decoded.auth_time || 0) * 1000 <= previous.revokedAt
    )
      throw Object.assign(new Error("AUTH_INVALID"), { code: "AUTH_INVALID" });
    tx.set(ref, {
      uid,
      deviceId: device,
      label,
      createdAt: previous?.createdAt || now,
      lastSeenAt: now,
      authTime: Number(decoded.auth_time || 0) * 1000,
      revokedAt: 0,
    });
    if (previous) return;
    tx.create(db.collection("storeNotifications").doc(hash(id, "new_device")), {
      uid,
      type: "new_device",
      label,
      title: "Yeni cihazdan giriş yapıldı",
      message:
        label +
        " ile hesabınıza giriş yapıldı. Oturumlarınızı inceleyebilirsiniz.",
      readAt: 0,
      createdAt: now,
    });
    enqueue(tx, db, { uid, type: "new_device", key: id, data: { label }, now });
  });
  const marker = device + "." + sign(device);
  return {
    marker,
    cookie:
      key +
      "=" +
      marker +
      "; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000" +
      (env.nodeEnv === "production" ? "; Secure" : ""),
  };
}
module.exports = { observe, read };
