"use strict";
const C = require("./common");
const { initFirebaseAdmin } = require("../config/firebaseAdmin");
const env = require("../config/env");
function configuration() {
  const bucket = String(process.env.FIRESTORE_BACKUP_BUCKET || ""),
    target = String(process.env.FIRESTORE_RESTORE_TEST_PROJECT || "");
  const sourceProject =
    env.firebase.projectId || initFirebaseAdmin().app?.options?.projectId || "";
  return {
    configured: /^[a-z0-9][a-z0-9._-]{2,220}$/.test(bucket),
    bucket,
    sourceProject:
      env.firebase.projectId ||
      initFirebaseAdmin().app?.options?.projectId ||
      "",
    targetProject: target,
    restoreConfigured:
      /^[a-z][a-z0-9-]{4,29}$/.test(target) && target !== sourceProject,
    consistentSnapshot: process.env.FIRESTORE_BACKUP_PITR === "true",
  };
}
async function provider(path, body) {
  if (
    !/^projects\/[a-z0-9-]+\/databases\/\(default\)(?::(?:exportDocuments|importDocuments)|\/operations\/[A-Za-z0-9_-]+)$/.test(
      path,
    )
  )
    C.fail("COMMERCE_BACKUP_PATH_INVALID");
  const credential = initFirebaseAdmin().app?.options?.credential;
  if (!credential?.getAccessToken)
    C.fail("COMMERCE_BACKUP_AUTH_UNAVAILABLE", 503);
  const token = await credential.getAccessToken();
  let response;
  try {
    response = await fetch("https://firestore.googleapis.com/v1/" + path, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: "Bearer " + token.access_token,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    C.fail("COMMERCE_BACKUP_RESULT_UNKNOWN", 503);
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    C.fail("COMMERCE_BACKUP_RESULT_UNKNOWN", 503);
  }
  if (!response.ok)
    C.fail("COMMERCE_BACKUP_PROVIDER_REJECTED", 502, {
      providerCode: payload.error?.status || "UNKNOWN",
    });
  return payload;
}
async function create(input, actor) {
  C.object(input, ["idempotencyKey"]);
  const key = C.id(input.idempotencyKey, 100),
    config = configuration();
  if (!config.configured) C.fail("COMMERCE_BACKUP_NOT_CONFIGURED", 503);
  const database = C.db(),
    ref = database.collection("storeBackups").doc(C.hash(actor.uid, key)),
    prefix = "gs://" + config.bucket + "/zentra/" + ref.id;
  let send = false;
  await database.runTransaction(async (tx) => {
    const old = await tx.get(ref);
    if (old.exists) return;
    tx.create(ref, {
      uid: actor.uid,
      state: "submitting",
      prefix,
      sourceProject: config.sourceProject,
      consistentSnapshot: config.consistentSnapshot,
      createdAt: Date.now(),
      operation: "",
      restore: null,
    });
    send = true;
  });
  if (!send) return get(ref.id);
  let submittedOperation = "";
  try {
    const body = { outputUriPrefix: prefix, collectionIds: [] };
    if (config.consistentSnapshot)
      body.snapshotTime = new Date(
        Math.floor((Date.now() - 60000) / 60000) * 60000,
      ).toISOString();
    const result = await provider(
      "projects/" +
        config.sourceProject +
        "/databases/(default):exportDocuments",
      body,
    );
    if (!result.name) C.fail("COMMERCE_BACKUP_RESULT_UNKNOWN", 503);
    submittedOperation = result.name;
    await ref.update({
      operation: result.name,
      state: "pending",
      updatedAt: Date.now(),
    });
    return get(ref.id);
  } catch (e) {
    const unknown =
      !!submittedOperation || e.code === "COMMERCE_BACKUP_RESULT_UNKNOWN";
    await ref
      .update({
        state: unknown ? "unknown" : "failed",
        ...(submittedOperation ? { operation: submittedOperation } : {}),
        error: unknown
          ? "COMMERCE_BACKUP_RESULT_UNKNOWN"
          : e.code || "PROVIDER_ERROR",
        updatedAt: Date.now(),
      })
      .catch(() => {});
    if (unknown) C.fail("COMMERCE_BACKUP_RESULT_UNKNOWN", 503);
    throw e;
  }
}
async function get(backupId) {
  const ref = C.db().collection("storeBackups").doc(C.id(backupId)),
    snap = await ref.get();
  if (!snap.exists) C.fail("COMMERCE_BACKUP_NOT_FOUND", 404);
  return { id: ref.id, ...snap.data() };
}
async function refresh(backupId) {
  const row = await get(backupId),
    ref = C.db().collection("storeBackups").doc(backupId);
  if (!row.operation) return row;
  const result = await provider(row.operation);
  const state = result.error ? "failed" : result.done ? "completed" : "pending";
  const update = {
    state,
    checkedAt: Date.now(),
    documentCount:
      Number(result.metadata?.progressDocuments?.workCompleted) || null,
    bytes: Number(result.metadata?.progressBytes?.workCompleted) || null,
    error: result.error?.code ? String(result.error.code) : "",
  };
  if (row.restore?.operation) {
    const restore = await provider(row.restore.operation);
    update.restore = {
      ...row.restore,
      state: restore.error ? "failed" : restore.done ? "completed" : "pending",
      providerConfirmed: restore.done === true && !restore.error,
      recordChecksumsVerified: row.restore.recordChecksumsVerified === true,
      checkedAt: Date.now(),
      error: restore.error?.code ? String(restore.error.code) : "",
    };
  }
  await ref.update(update);
  return { ...row, ...update };
}
async function restore(backupId, input, actor) {
  C.object(input, ["confirmation"]);
  const config = configuration();
  if (!config.restoreConfigured)
    C.fail("COMMERCE_RESTORE_TEST_PROJECT_REQUIRED", 503);
  if (input.confirmation !== "TEST ORTAMINA GERI YUKLE")
    C.fail("COMMERCE_CONFIRMATION_REQUIRED");
  const row = await refresh(backupId);
  if (row.sourceProject === config.targetProject)
    C.fail("COMMERCE_PRODUCTION_RESTORE_FORBIDDEN", 403);
  if (row.state !== "completed") C.fail("COMMERCE_BACKUP_NOT_COMPLETED", 409);
  if (row.restore) return row;
  const ref = C.db().collection("storeBackups").doc(backupId);
  let claimed = false;
  await C.db().runTransaction(async (tx) => {
    const fresh = await tx.get(ref);
    if (fresh.data().restore) return;
    tx.update(ref, {
      restore: {
        state: "submitting",
        targetProject: config.targetProject,
        requestedBy: actor.uid,
        createdAt: Date.now(),
      },
    });
    claimed = true;
  });
  if (!claimed) return get(backupId);
  try {
    const result = await provider(
      "projects/" +
        config.targetProject +
        "/databases/(default):importDocuments",
      { inputUriPrefix: row.prefix },
    );
    if (!result.name) C.fail("COMMERCE_BACKUP_RESULT_UNKNOWN", 503);
    await ref.update({
      restore: {
        state: "pending",
        targetProject: config.targetProject,
        operation: result.name,
        requestedBy: actor.uid,
        createdAt: Date.now(),
        recordChecksumsVerified: false,
      },
    });
    return get(backupId);
  } catch (e) {
    await ref.update({
      restore: {
        state: "unknown",
        targetProject: config.targetProject,
        error: e.code || "UNKNOWN",
        requestedBy: actor.uid,
        createdAt: Date.now(),
      },
    });
    throw e;
  }
}
async function list() {
  return {
    configuration: configuration(),
    ...C.publicRows(await C.page("storeBackups", { limit: 30 })),
  };
}
module.exports = {
  configuration,
  provider,
  create,
  get,
  refresh,
  restore,
  list,
};
const CRITICAL_COLLECTIONS = Object.freeze([
  "users",
  "adminUsers",
  "audit",
  "storeOrders",
  "storeDeliveries",
  "storeInventory",
  "storeInventorySummary",
  "storeInventoryFingerprints",
  "storeInventoryEvents",
  "storeWalletLedger",
  "storeOrderIdempotency",
  "storePromotions",
  "storePromotionCustomerUsage",
  "storefrontSettings",
  "storeProductDetails",
  "storeProductSlugs",
  "storeContentVersions",
  "storePriceHistory",
  "storeReviews",
  "storeCommerceProfiles",
  "storeProductWatches",
  "storeSupportTickets",
  "storeCustomerRequests",
  "storeDataRequests",
  "storeOrderExperience",
  "storeOrderTimeline",
  "storeOrderCostSnapshots",
  "storeLoyaltyAccounts",
  "storeLoyaltyOrderLedger",
  "storeLoyaltyRedemptions",
  "storeKnowledge",
  "storeCommerceSettings",
]);
async function verify(backupId, actor) {
  const row = await refresh(backupId),
    config = configuration();
  if (
    !row.restore?.providerConfirmed ||
    row.restore.targetProject !== config.targetProject ||
    !config.restoreConfigured
  )
    C.fail("COMMERCE_RESTORE_NOT_COMPLETED", 409);
  const { admin, app, db } = initFirebaseAdmin(),
    name = "zentra-restore-check-" + config.targetProject;
  if (!db || !app?.options?.credential || !admin.initializeApp)
    C.fail("COMMERCE_BACKUP_AUTH_UNAVAILABLE", 503);
  const testApp =
    admin.apps.find((a) => a.name === name) ||
    admin.initializeApp(
      { credential: app.options.credential, projectId: config.targetProject },
      name,
    );
  const result =
    await require("../core/restoreVerification").recordRestoreVerification({
      source: db,
      restored: admin.firestore(testApp),
      sourceProject: config.sourceProject,
      restoreProject: config.targetProject,
      collections: [...CRITICAL_COLLECTIONS],
    });
  await C.db()
    .collection("storeBackups")
    .doc(backupId)
    .update({
      restore: {
        ...row.restore,
        recordChecksumsVerified: true,
        verifiedAt: result.verifiedAt,
        documents: result.documents,
        verifiedCollections: [...CRITICAL_COLLECTIONS],
      },
    });
  return { ...result, collections: [...CRITICAL_COLLECTIONS] };
}
module.exports.verify = verify;
module.exports.CRITICAL_COLLECTIONS = CRITICAL_COLLECTIONS;
