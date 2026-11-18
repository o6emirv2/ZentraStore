"use strict";
const C = require("./common"),
  settings = require("./settings");
const {
  getEffectiveCatalog,
  updateProductsBulk,
} = require("../core/storeCatalogService");
function csvParse(source) {
  C.text(source, 200000);
  source = source.replace(/^\uFEFF/, "");
  const rows = [];
  let row = [],
    cell = "",
    quoted = false,
    afterQuote = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '"') {
      if (quoted && source[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (quoted) {
        quoted = false;
        afterQuote = true;
      } else if (cell || afterQuote) C.fail("COMMERCE_CSV_INVALID");
      else quoted = true;
    } else if (!quoted && (ch === "," || ch === "\n" || ch === "\r")) {
      row.push(cell);
      cell = "";
      afterQuote = false;
      if (ch !== ",") {
        if (ch === "\r" && source[i + 1] === "\n") i++;
        if (row.some((x) => x.trim())) rows.push(row);
        row = [];
      }
    } else if (afterQuote) {
      if (!/[ \t]/.test(ch)) C.fail("COMMERCE_CSV_INVALID");
    } else cell += ch;
    if (rows.length > 101) C.fail("COMMERCE_CSV_LIMIT");
  }
  if (quoted) C.fail("COMMERCE_CSV_INVALID");
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  if (rows.length > 101) C.fail("COMMERCE_CSV_LIMIT");
  if (!rows.length) C.fail("COMMERCE_CSV_INVALID");
  const headers = rows.shift().map((x) => x.replace(/^\uFEFF/, "").trim());
  if (
    headers.length !== new Set(headers).size ||
    headers.some(
      (x) =>
        ![
          "productId",
          "planKey",
          "priceKurus",
          "active",
          "categoryKey",
        ].includes(x),
    ) ||
    !headers.includes("productId")
  )
    C.fail("COMMERCE_CSV_HEADER_INVALID");
  return rows.map((r, i) => {
    if (r.length !== headers.length)
      C.fail("COMMERCE_CSV_ROW_INVALID", 400, { row: i + 2 });
    return Object.fromEntries(headers.map((h, j) => [h, r[j].trim()]));
  });
}
function csvCell(value) {
  let s = String(value ?? "");
  if (/^[=+@\-\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}
async function exportCatalog() {
  const catalog = await getEffectiveCatalog({
    includeInactive: true,
    fresh: true,
  });
  const rows = [
    ["productId", "planKey", "priceKurus", "active", "categoryKey"],
  ];
  for (const p of catalog.products)
    for (const plan of p.plans)
      rows.push([
        p.id,
        plan.key,
        plan.priceKurus,
        p.active !== false,
        p.categoryKey,
      ]);
  return "\uFEFF" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}
function makeUpdates(rows) {
  const updates = new Map();
  for (const row of rows) {
    const productId = C.id(row.productId, 80),
      item = updates.get(productId) || { productId, settings: {} };
    if (row.priceKurus !== undefined && row.priceKurus !== "") {
      const planKey = C.id(row.planKey, 40);
      const n = Number(row.priceKurus);
      C.integer(n, 1, 100000000);
      if (Object.hasOwn(item.settings.plans || {}, planKey))
        C.fail("COMMERCE_CSV_DUPLICATE_ROW");
      item.settings.plans = {
        ...item.settings.plans,
        [planKey]: { priceKurus: n },
      };
    }
    if (row.active !== undefined && row.active !== "") {
      if (!["true", "false"].includes(row.active))
        C.fail("COMMERCE_CSV_BOOLEAN_INVALID");
      if (
        item.settings.active !== undefined &&
        item.settings.active !== (row.active === "true")
      )
        C.fail("COMMERCE_CSV_CONFLICT");
      item.settings.active = row.active === "true";
    }
    if (row.categoryKey) {
      if (
        item.settings.categoryKey &&
        item.settings.categoryKey !== row.categoryKey
      )
        C.fail("COMMERCE_CSV_CONFLICT");
      item.settings.categoryKey = C.text(row.categoryKey, 60);
    }
    updates.set(productId, item);
  }
  return [...updates.values()];
}
function snapshot(catalog, updates) {
  return updates.map((u) => {
    const p = catalog.products.find((p) => p.id === u.productId);
    if (!p) C.fail("STORE_PRODUCT_NOT_FOUND", 404);
    return {
      productId: p.id,
      name: p.name,
      active: p.active !== false,
      categoryKey: p.categoryKey,
      plans: p.plans.map((x) => ({ key: x.key, priceKurus: x.priceKurus })),
    };
  });
}
async function preview(input, actor) {
  C.object(input, ["updates", "csv"]);
  if ((input.csv === undefined) === (input.updates === undefined))
    C.fail("COMMERCE_BULK_INPUT_INVALID");
  const updates =
    input.csv !== undefined
      ? makeUpdates(csvParse(input.csv))
      : C.array(input.updates, 100);
  if (
    !updates.length ||
    new Set(updates.map((x) => x.productId)).size !== updates.length
  )
    C.fail("COMMERCE_BULK_INPUT_INVALID");
  for (const u of updates) {
    C.object(u, ["productId", "settings"]);
    C.id(u.productId, 80);
    if (!u.settings || !Object.keys(u.settings).length)
      C.fail("COMMERCE_BULK_INPUT_INVALID");
    for (const plan of Object.values(u.settings?.plans || {}))
      C.object(plan, ["priceKurus"]);
    if (
      !require("../core/apiContracts").validateApiBody(
        "PATCH",
        "/api/admin/store/products/" + u.productId,
        u.settings,
      )
    )
      C.fail("COMMERCE_BULK_INPUT_INVALID");
    if (
      Object.keys(u.settings).some(
        (k) => !["active", "categoryKey", "plans"].includes(k),
      )
    )
      C.fail("COMMERCE_BULK_FIELD_NOT_SUPPORTED");
  }
  const catalog = await getEffectiveCatalog({
      includeInactive: true,
      fresh: true,
    }),
    before = snapshot(catalog, updates),
    config = await settings.get(),
    database = C.db(),
    ref = database.collection("storeBulkCatalogJobs").doc(),
    now = Date.now();
  for (const u of updates)
    for (const key of Object.keys(u.settings.plans || {}))
      if (
        !before
          .find((x) => x.productId === u.productId)
          .plans.some((x) => x.key === key)
      )
        C.fail("STORE_PLAN_NOT_FOUND", 404);
  const row = {
    id: ref.id,
    uid: actor.uid,
    updates,
    before,
    beforeHash: C.hash(JSON.stringify(before)),
    state: "preview",
    approvalRequired: config.secondApproval,
    approvedBy: "",
    expiresAt: now + 30 * 60000,
    createdAt: now,
    updatedAt: now,
  };
  await database.runTransaction(async (tx) => {
    tx.create(ref, row);
    C.audit(tx, database, "commerce.bulk.preview", actor, {
      jobId: ref.id,
      count: updates.length,
    });
  });
  return row;
}
async function getJob(jobId) {
  const snap = await C.db()
    .collection("storeBulkCatalogJobs")
    .doc(C.id(jobId))
    .get();
  if (!snap.exists) C.fail("COMMERCE_BULK_NOT_FOUND", 404);
  return { ...snap.data(), id: snap.id };
}
async function approve(jobId, actor) {
  const database = C.db(),
    ref = database.collection("storeBulkCatalogJobs").doc(C.id(jobId));
  return database.runTransaction(async (tx) => {
    const snap = await tx.get(ref),
      row = snap.data();
    if (!row || row.expiresAt < Date.now() || row.state !== "preview")
      C.fail("COMMERCE_BULK_NOT_READY", 409);
    if (row.uid === actor.uid) C.fail("COMMERCE_SECOND_APPROVER_REQUIRED", 403);
    tx.update(ref, { approvedBy: actor.uid, approvedAt: Date.now() });
    C.audit(tx, database, "commerce.bulk.approve", actor, {
      jobId,
      initiator: row.uid,
    });
    return { approved: true, jobId };
  });
}
async function execute(jobId, input, actor) {
  C.object(input, ["confirmation"]);
  if (input.confirmation !== "UYGULA") C.fail("COMMERCE_CONFIRMATION_REQUIRED");
  const database = C.db(),
    ref = database.collection("storeBulkCatalogJobs").doc(C.id(jobId)),
    row = await getJob(jobId),
    config = await settings.get({ fresh: true });
  if (row.state === "completed")
    return { jobId, state: "completed", count: row.updates.length };
  if (row.uid !== actor.uid) C.fail("COMMERCE_JOB_OWNER_REQUIRED", 403);
  if (row.expiresAt < Date.now()) C.fail("COMMERCE_BULK_EXPIRED", 409);
  if (
    (row.approvalRequired || config.secondApproval) &&
    (!row.approvedBy || row.approvedBy === actor.uid)
  )
    C.fail("COMMERCE_SECOND_APPROVER_REQUIRED", 403);
  const catalog = await getEffectiveCatalog({
    includeInactive: true,
    fresh: true,
  });
  if (C.hash(JSON.stringify(snapshot(catalog, row.updates))) !== row.beforeHash)
    C.fail("COMMERCE_BULK_STALE", 409);
  const result = await updateProductsBulk(
    row.updates,
    { ...actor, commerceApprovedJobId: jobId },
    {
      commerceJob: {
        id: jobId,
        uid: actor.uid,
        beforeHash: row.beforeHash,
        approvedBy: row.approvedBy,
        approvalRequired: row.approvalRequired || config.secondApproval,
      },
    },
  );
  return {
    jobId,
    state: "completed",
    count: row.updates.length,
    products: result,
  };
}
async function impact(productId) {
  C.id(productId, 80);
  const database = C.db(),
    [orders, reservations, reviews, tickets, meta] = await Promise.all([
      database
        .collection("storeOrders")
        .orderBy("createdAt", "desc")
        .limit(1000)
        .get(),
      database
        .collection("storeReservations")
        .where("state", "==", "active")
        .limit(200)
        .get(),
      database
        .collection("storeReviews")
        .where("productId", "==", productId)
        .limit(500)
        .get(),
      database.collection("storeSupportTickets").limit(500).get(),
      database.collection("storeProductDetails").doc(productId).get(),
    ]);
  const relatedOrders = orders.docs.filter((d) =>
      (d.data().items || []).some((i) => i.productId === productId),
    ),
    ids = new Set(relatedOrders.map((d) => d.id));
  return {
    productId,
    orders: relatedOrders.length,
    activeReservations: reservations.docs.filter((d) =>
      (d.data().items || []).some((i) => i.productId === productId),
    ).length,
    reviews: reviews.size,
    supportTickets: tickets.docs.filter((d) => ids.has(d.data().orderId))
      .length,
    hasContent: meta.exists,
    canHardDelete: false,
    recommendedAction: "archive",
    scope: {
      ordersLimit: 1000,
      ticketLimit: 500,
      mayBeTruncated: orders.size === 1000 || tickets.size === 500,
    },
  };
}
async function diagnostic(input, actor) {
  C.object(input, ["kind"]);
  const kind = C.choice(input.kind, ["database", "telegram"]);
  const now = Date.now();
  if (kind === "database") {
    await C.db().collection("storeCommerceSettings").doc("main").get();
    return { kind, verified: true, checkedAt: now, operation: "read" };
  }
  const token = String(process.env.TELEGRAM_BOT_TOKEN || ""),
    chat = String(process.env.TELEGRAM_ADMIN_CHAT_ID || "");
  if (!token || !chat || !/^-?[0-9]{1,20}$/.test(chat))
    C.fail("TELEGRAM_NOT_CONFIGURED", 503);
  let response;
  try {
    response = await fetch(
      "https://api.telegram.org/bot" + token + "/sendMessage",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chat,
          text: "Zentra Store bağlantı testi · " + new Date(now).toISOString(),
          disable_notification: true,
        }),
        signal: AbortSignal.timeout(10000),
      },
    );
  } catch {
    C.fail("COMMERCE_DIAGNOSTIC_RESULT_UNKNOWN", 503);
  }
  const payload = await response.json();
  if (
    !response.ok ||
    payload.ok !== true ||
    !Number.isSafeInteger(payload.result?.message_id)
  )
    C.fail("COMMERCE_DIAGNOSTIC_FAILED", 502);
  await C.db().runTransaction(async (tx) => {
    C.audit(tx, C.db(), "commerce.diagnostic.telegram", actor, {
      messageId: payload.result.message_id,
      checkedAt: now,
    });
  });
  return {
    kind,
    verified: true,
    messageId: payload.result.message_id,
    checkedAt: now,
  };
}
module.exports = {
  csvParse,
  csvCell,
  makeUpdates,
  exportCatalog,
  snapshot,
  preview,
  getJob,
  approve,
  execute,
  impact,
  diagnostic,
};
