"use strict";
const C = require("./common");
const contracts = [
  ["POST", /^\/api\/store\/commerce\/community\/visitor$/, []],
  [
    "PUT",
    /^\/api\/store\/commerce\/community\/[^/]+\/like$/,
    ["liked", "mutationId", "expectedRevision"],
  ],
  ["POST", /^\/api\/admin\/store\/commerce\/email\/test$/, ["idempotencyKey"]],
  [
    "PATCH",
    /^\/api\/store\/commerce\/profile$/,
    ["expectedRevision", "cart", "favorites", "preferences"],
  ],
  [
    "POST",
    /^\/api\/store\/commerce\/quote$/,
    ["items", "paymentMethod", "promotionCode", "giftRecipientUid"],
  ],
  ["POST", /^\/api\/store\/commerce\/reservations$/, ["quoteToken"]],
  ["POST", /^\/api\/store\/commerce\/reservations\/[^/]+\/release$/, []],
  ["POST", /^\/api\/store\/commerce\/watch$/, ["productId", "stock", "price"]],
  ["POST", /^\/api\/store\/commerce\/sessions$/, ["deviceId", "label"]],
  ["POST", /^\/api\/store\/commerce\/sessions\/revoke$/, []],
  [
    "POST",
    /^\/api\/store\/commerce\/data-requests$/,
    ["kind", "message", "idempotencyKey"],
  ],
  [
    "POST",
    /^\/api\/store\/commerce\/reviews$/,
    ["orderId", "productId", "rating", "title", "message"],
  ],
  [
    "POST",
    /^\/api\/store\/commerce\/tickets$/,
    ["orderId", "subject", "message", "idempotencyKey"],
  ],
  [
    "POST",
    /^\/api\/store\/commerce\/tickets\/[^/]+\/reply$/,
    ["expectedRevision", "message"],
  ],
  [
    "POST",
    /^\/api\/store\/commerce\/tickets\/[^/]+\/rating$/,
    ["rating", "message"],
  ],
  [
    "POST",
    /^\/api\/store\/commerce\/requests$/,
    ["kind", "orderId", "subject", "message", "idempotencyKey"],
  ],
  ["POST", /^\/api\/store\/commerce\/loyalty\/redeem$/, ["idempotencyKey"]],
  ["POST", /^\/api\/store\/commerce\/orders\/[^/]+\/acknowledge$/, []],
  ["POST", /^\/api\/store\/commerce\/recipient$/, ["username"]],
  [
    "POST",
    /^\/api\/store\/commerce\/events$/,
    ["productId", "event", "eventId"],
  ],
  [
    "PUT",
    /^\/api\/admin\/store\/commerce\/settings$/,
    ["expectedRevision", "maintenance", "loyalty", "secondApproval"],
  ],
  [
    "PUT",
    /^\/api\/admin\/store\/commerce\/knowledge$/,
    ["expectedRevision", "articles", "templates"],
  ],
  [
    "PUT",
    /^\/api\/admin\/store\/commerce\/products\/[^/]+\/draft$/,
    ["expectedRevision", "content"],
  ],
  [
    "POST",
    /^\/api\/admin\/store\/commerce\/products\/[^/]+\/publish$/,
    ["expectedRevision"],
  ],
  [
    "POST",
    /^\/api\/admin\/store\/commerce\/products\/[^/]+\/restore$/,
    ["expectedRevision", "versionId"],
  ],
  [
    "POST",
    /^\/api\/admin\/store\/commerce\/products\/[^/]+\/images$/,
    ["imageUpload"],
  ],
  [
    "POST",
    /^\/api\/admin\/store\/commerce\/reviews\/[^/]+\/moderate$/,
    ["status", "reason"],
  ],
  [
    "POST",
    /^\/api\/admin\/store\/commerce\/tickets\/[^/]+\/reply$/,
    ["expectedRevision", "message", "status"],
  ],
  [
    "POST",
    /^\/api\/admin\/store\/commerce\/(?:tickets|orders)\/[^/]+\/assign$/,
    ["assigneeUid"],
  ],
  [
    "POST",
    /^\/api\/admin\/store\/commerce\/requests\/[^/]+\/decision$/,
    ["status", "reply"],
  ],
  [
    "PUT",
    /^\/api\/admin\/store\/commerce\/orders\/[^/]+\/license$/,
    ["startsAt", "expiresAt", "source"],
  ],
  [
    "PUT",
    /^\/api\/admin\/store\/commerce\/orders\/[^/]+\/costs$/,
    ["costKurus", "feesKurus", "source", "expectedRevision"],
  ],
  [
    "POST",
    /^\/api\/admin\/store\/commerce\/bulk\/preview$/,
    ["updates", "csv"],
  ],
  ["POST", /^\/api\/admin\/store\/commerce\/bulk\/[^/]+\/approve$/, []],
  [
    "POST",
    /^\/api\/admin\/store\/commerce\/bulk\/[^/]+\/execute$/,
    ["confirmation"],
  ],
  ["POST", /^\/api\/admin\/store\/commerce\/alerts\/[^/]+\/acknowledge$/, []],
  ["POST", /^\/api\/admin\/store\/commerce\/diagnostic$/, ["kind"]],
  ["POST", /^\/api\/admin\/store\/commerce\/backups$/, ["idempotencyKey"]],
  [
    "POST",
    /^\/api\/admin\/store\/commerce\/backups\/[^/]+\/(?:refresh|verify)$/,
    [],
  ],
  [
    "POST",
    /^\/api\/admin\/store\/commerce\/backups\/[^/]+\/restore$/,
    ["confirmation"],
  ],
  [
    "POST",
    /^\/api\/admin\/store\/commerce\/data-requests\/[^/]+\/decision$/,
    ["status", "reply"],
  ],
];
function validate(method, path, body) {
  if (
    !/^\/api\/(?:admin\/)?store\/commerce(?:\/|$)/.test(path) ||
    ["GET", "HEAD", "OPTIONS"].includes(method)
  )
    return null;
  const contract = contracts.find(
    ([verb, pattern]) => verb === method && pattern.test(path),
  );
  if (!contract) return false;
  try {
    C.object(body ?? {}, contract[2]);
    return true;
  } catch {
    return false;
  }
}
module.exports = { contracts, validate };
