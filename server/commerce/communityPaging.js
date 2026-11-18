"use strict";
const crypto = require("node:crypto");
const { purposeKey } = require("../core/adminAccessService");
const fail = () => { throw Object.assign(new Error("COMMUNITY_CURSOR_INVALID"), { code: "COMMUNITY_CURSOR_INVALID", statusCode: 400 }); };
const key = () => crypto.createHash("sha256").update(purposeKey("community-likers-cursor-v1")).digest();

function sealCursor(productId, id) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.from(JSON.stringify({ productId, id, expiresAt: Date.now() + 3600000 }));
  return Buffer.concat([iv, cipher.update(data), cipher.final(), cipher.getAuthTag()]).toString("base64url");
}

function openCursor(productId, cursor) {
  if (typeof cursor !== "string" || cursor.length > 700 || !/^[A-Za-z0-9_-]+$/.test(cursor)) fail();
  try {
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.length < 30) fail();
    const decipher = crypto.createDecipheriv("aes-256-gcm", key(), bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(-16));
    const value = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString());
    if (value.productId !== productId || !/^[a-f0-9]{64}$/.test(value.id) ||
        !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now() || value.expiresAt > Date.now() + 3600000) fail();
    return value.id;
  } catch { fail(); }
}
module.exports = { sealCursor, openCursor };
