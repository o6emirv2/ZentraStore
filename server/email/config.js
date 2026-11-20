"use strict";
const env = require("../config/env");
const crypto = require("node:crypto");
const { purposeKey } = require("../core/adminAccessService");
const OPTIONAL = Object.freeze({
  stock: "emailStockNotifications",
  price: "emailPriceNotifications",
  license: "emailLicenseReminders",
  coupon: "emailCouponNotifications",
});
const SERVICE = Object.freeze({
  order: "emailOrderNotifications",
  wallet: "emailWalletNotifications",
});
const RECOVERY_FROM = "ZENTRA STORE <bildirim@zentrastore.com.tr>";
function validEmail(value) {
  return (
    typeof value === "string" &&
    value.length <= 254 &&
    /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(
      value,
    )
  );
}
function configuration() {
  const apiKey = String(process.env.RESEND_API_KEY || "").trim();
  const from = String(
    process.env.RESEND_FROM || "ZENTRA STORE <bildirim@zentrastore.com.tr>",
  ).trim();
  const match = /^([^<>\r\n]{1,80}) <([^<>\r\n]+)>$/.exec(from);
  const domain = String(
    process.env.RESEND_SENDING_DOMAIN || "zentrastore.com.tr",
  )
    .trim()
    .toLowerCase();
  const replyTo = String(process.env.RESEND_REPLY_TO || "").trim();
  const webhookSecret = String(process.env.RESEND_WEBHOOK_SECRET || "").trim();
  const origin = env.canonicalOrigin || env.publicBaseUrl;
  const backend = env.serviceOrigin || env.publicApiBase || origin;
  const apiConfigured = /^re_[A-Za-z0-9_-]{16,200}$/.test(apiKey);
  const configured =
    apiConfigured &&
    !!match &&
    validEmail(match[2]) &&
    match[2].split("@")[1].toLowerCase() === domain &&
    (!replyTo || validEmail(replyTo));
  return {
    enabled:
      process.env.EMAIL_NOTIFICATIONS_ENABLED === undefined ||
      process.env.EMAIL_NOTIFICATIONS_ENABLED === "true",
    configured,
    apiConfigured,
    apiKey,
    from,
    replyTo,
    domain,
    origin,
    backend,
    webhookSecret,
    webhookConfigured: /^whsec_[A-Za-z0-9+/=_-]{20,200}$/.test(webhookSecret),
  };
}
function recoveryConfiguration() {
  const c = configuration();
  let originReady = false;
  try {
    const origin = new URL(c.origin);
    originReady = origin.protocol === "https:" ||
      (env.nodeEnv === "development" && origin.protocol === "http:" &&
        ["127.0.0.1", "localhost"].includes(origin.hostname));
  } catch {}
  return {
    ...c,
    from: RECOVERY_FROM,
    domain: "zentrastore.com.tr",
    enabled: true,
    configured: c.apiConfigured && originReady && (!c.replyTo || validEmail(c.replyTo)),
  };
}
function failure(code, statusCode = 400) {
  return Object.assign(new Error(code), { code, statusCode });
}
function addressHash(email) {
  return crypto
    .createHmac("sha256", purposeKey("email-recipient-v1"))
    .update(String(email).toLowerCase())
    .digest("hex");
}
function unsubscribeToken(uid, category, now = Date.now()) {
  if (!OPTIONAL[category]) return "";
  const iv = crypto.randomBytes(12),
    cipher = crypto.createCipheriv(
      "aes-256-gcm",
      purposeKey("email-unsubscribe-v1"),
      iv,
    );
  const bytes = Buffer.concat([
    cipher.update(
      JSON.stringify({ uid, category, expiresAt: now + 180 * 86400000 }),
    ),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString("base64url");
}
function readUnsubscribe(token, now = Date.now()) {
  try {
    if (
      typeof token !== "string" ||
      token.length > 800 ||
      !/^[A-Za-z0-9_-]+$/.test(token)
    )
      throw Error();
    const bytes = Buffer.from(token, "base64url");
    if (bytes.length < 30 || bytes.toString("base64url") !== token)
      throw Error();
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      purposeKey("email-unsubscribe-v1"),
      bytes.subarray(0, 12),
    );
    decipher.setAuthTag(bytes.subarray(12, 28));
    const row = JSON.parse(
      Buffer.concat([
        decipher.update(bytes.subarray(28)),
        decipher.final(),
      ]).toString(),
    );
    if (
      !OPTIONAL[row.category] ||
      typeof row.uid !== "string" ||
      !row.uid ||
      row.uid.length > 128 ||
      /[\\/\u0000-\u001f]/.test(row.uid) ||
      !Number.isSafeInteger(row.expiresAt) ||
      row.expiresAt <= now
    )
      throw Error();
    return row;
  } catch {
    throw failure("EMAIL_UNSUBSCRIBE_INVALID", 400);
  }
}
function permitted(category, profile = {}) {
  const key = OPTIONAL[category] || SERVICE[category];
  if (OPTIONAL[category]) return profile.preferences?.[key] === true;
  if (SERVICE[category]) return profile.preferences?.[key] !== false;
  return category === "security" || category === "test";
}
module.exports = {
  configuration,
  recoveryConfiguration,
  RECOVERY_FROM,
  validEmail,
  failure,
  addressHash,
  OPTIONAL,
  SERVICE,
  permitted,
  unsubscribeToken,
  readUnsubscribe,
};
