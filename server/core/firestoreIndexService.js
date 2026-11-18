"use strict";
const { initFirebaseAdmin } = require("../config/firebaseAdmin");
const { createWorker } = require("./workerScheduler");
const definitions = require("../../firestore.indexes.json").indexes;
const fail = (code, details = {}) =>
  Object.assign(new Error(code), { code, statusCode: 503, ...details });
const PROVIDER_CODES = new Set([
  "INVALID_ARGUMENT",
  "FAILED_PRECONDITION",
  "UNAUTHENTICATED",
  "PERMISSION_DENIED",
  "NOT_FOUND",
  "RESOURCE_EXHAUSTED",
  "UNAVAILABLE",
  "DEADLINE_EXCEEDED",
  "INTERNAL",
  "UNIMPLEMENTED",
]);
function providerFailure(status, body, operation) {
  const raw = body?.error?.status;
  const providerCode = PROVIDER_CODES.has(raw) ? raw : `HTTP_${status}`;
  const details = Array.isArray(body?.error?.details) ? body.error.details : [];
  const disabled = details.some(
    (item) =>
      item?.["@type"] === "type.googleapis.com/google.rpc.ErrorInfo" &&
      item.reason === "SERVICE_DISABLED",
  );
  const fieldNames = new Map([
    ["page_size", "pageSize"],
    ["pageSize", "pageSize"],
    ["page_token", "pageToken"],
    ["pageToken", "pageToken"],
    ["parent", "parent"],
    ["filter", "filter"],
    ["index", "index"],
  ]);
  const providerFields = [
    ...new Set(
      details.flatMap((item) =>
        item?.["@type"] === "type.googleapis.com/google.rpc.BadRequest" &&
        Array.isArray(item.fieldViolations)
          ? item.fieldViolations
              .map((value) => fieldNames.get(value?.field))
              .filter(Boolean)
          : [],
      ),
    ),
  ];
  let code = "FIRESTORE_INDEX_PROVIDER_UNAVAILABLE";
  if (status === 401) code = "FIRESTORE_INDEX_CREDENTIAL_REJECTED";
  else if (status === 403)
    code = disabled
      ? "FIRESTORE_INDEX_API_DISABLED"
      : "FIRESTORE_INDEX_PERMISSION_REQUIRED";
  else if (status === 404) code = "FIRESTORE_INDEX_DATABASE_NOT_FOUND";
  else if (status === 429 || providerCode === "RESOURCE_EXHAUSTED")
    code = "FIRESTORE_INDEX_QUOTA_EXHAUSTED";
  else if (status === 400) code = "FIRESTORE_INDEX_REQUEST_REJECTED";
  return fail(code, {
    providerStatus: status,
    providerCode,
    indexOperation: operation,
    ...(providerFields.length ? { providerFields } : {}),
  });
}
function signature(index) {
  if (
    !["COLLECTION", "COLLECTION_GROUP"].includes(index?.queryScope) ||
    !Array.isArray(index.fields) ||
    index.fields.length < 2 ||
    (index.apiScope &&
      !["ANY_API", "FIRESTORE_NATIVE_API"].includes(index.apiScope))
  )
    return null;
  if (index.fields.some((field) => !field || typeof field !== "object"))
    return null;
  const fields = index.fields.map((field) => ({
    fieldPath: field.fieldPath,
    ...(field.order
      ? { order: field.order }
      : { arrayConfig: field.arrayConfig }),
  }));
  if (
    fields.some(
      (field) =>
        typeof field.fieldPath !== "string" ||
        !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(field.fieldPath) ||
        !(field.order
          ? ["ASCENDING", "DESCENDING"].includes(field.order)
          : field.arrayConfig === "CONTAINS"),
    )
  )
    return null;
  if (!fields.some((field) => field.fieldPath === "__name__"))
    fields.push({
      fieldPath: "__name__",
      order: fields.at(-1).order || "ASCENDING",
    });
  return JSON.stringify([index.queryScope, fields]);
}
async function reconcile({
  apply = false,
  fetchImpl = global.fetch,
  firebase = initFirebaseAdmin(),
} = {}) {
  const project = firebase.app?.options?.projectId,
    credential = firebase.app?.options?.credential;
  if (
    !firebase.db ||
    typeof project !== "string" ||
    !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(project) ||
    !credential?.getAccessToken
  )
    throw fail("FIRESTORE_INDEX_CONFIGURATION_REQUIRED");
  const groups = new Map();
  for (const index of definitions) {
    if (!/^store[A-Za-z0-9]+$/.test(index.collectionGroup) || !signature(index))
      throw fail("FIRESTORE_INDEX_DEFINITION_INVALID");
    if (!groups.has(index.collectionGroup))
      groups.set(index.collectionGroup, []);
    groups.get(index.collectionGroup).push(index);
  }
  let token;
  try {
    token = await credential.getAccessToken();
  } catch {
    throw fail("FIRESTORE_INDEX_CREDENTIAL_UNAVAILABLE");
  }
  if (!token?.access_token || /[\r\n]/.test(token.access_token))
    throw fail("FIRESTORE_INDEX_CREDENTIAL_UNAVAILABLE");
  async function request(url, body) {
    const operation = body ? "index-create" : "index-list";
    let response;
    try {
      response = await fetchImpl(url, {
        method: body ? "POST" : "GET",
        headers: {
          authorization: "Bearer " + token.access_token,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
    } catch (error) {
      const network = new Set([
        "ETIMEDOUT",
        "ECONNRESET",
        "ENOTFOUND",
        "UND_ERR_CONNECT_TIMEOUT",
        "ABORT_ERR",
      ]);
      const raw = error.cause?.code || error.code;
      throw fail("FIRESTORE_INDEX_PROVIDER_UNAVAILABLE", {
        indexOperation: operation,
        providerCode: network.has(raw) ? raw : "NETWORK_ERROR",
      });
    }
    if (response.status === 409 && body) return { alreadyExists: true };
    const data = await response.json().catch(() => null);
    if (!response.ok) throw providerFailure(response.status, data, operation);
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw fail("FIRESTORE_INDEX_RESPONSE_INVALID");
    return data;
  }
  const parent = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/collectionGroups`;
  const byGroup = new Map(),
    visitedTokens = new Set();
  let pageToken = "",
    pages = 0;
  do {
    if (++pages > 20 || visitedTokens.has(pageToken))
      throw fail("FIRESTORE_INDEX_LIST_LIMIT");
    visitedTokens.add(pageToken);
    const suffix = pageToken ? "?" + new URLSearchParams({ pageToken }) : "";
    const page = await request(`${parent}/-/indexes${suffix}`);
    if (
      (page.indexes !== undefined && !Array.isArray(page.indexes)) ||
      (page.nextPageToken !== undefined &&
        (typeof page.nextPageToken !== "string" ||
          page.nextPageToken.length > 4096))
    )
      throw fail("FIRESTORE_INDEX_RESPONSE_INVALID");
    for (const index of page.indexes || []) {
      const prefix = `projects/${project}/databases/(default)/collectionGroups/`;
      if (typeof index?.name !== "string" || !index.name.startsWith(prefix))
        continue;
      const [group, kind, id, extra] = index.name
        .slice(prefix.length)
        .split("/");
      if (
        !groups.has(group) ||
        kind !== "indexes" ||
        !id ||
        extra !== undefined
      )
        continue;
      if (!byGroup.has(group)) byGroup.set(group, []);
      byGroup.get(group).push(index);
    }
    pageToken = page.nextPageToken || "";
  } while (pageToken);
  const rows = [];
  let createdCount = 0;
  for (const [group, wanted] of groups) {
    const existing = byGroup.get(group) || [];
    const endpoint = `${parent}/${group}/indexes`;
    for (const index of wanted) {
      const matches = existing.filter(
        (item) => signature(item) === signature(index),
      );
      const found =
        matches.find((item) => item.state === "READY") || matches[0];
      let state = found?.state || "MISSING";
      if (!found && apply && createdCount < 6) {
        const created = await request(endpoint, {
          queryScope: index.queryScope,
          fields: index.fields,
        });
        if (
          !created.alreadyExists &&
          (created.error ||
            typeof created.name !== "string" ||
            !created.name.startsWith(
              `projects/${project}/databases/(default)/operations/`,
            ))
        )
          throw fail("FIRESTORE_INDEX_CREATE_UNVERIFIED");
        state = "CREATING";
        createdCount++;
      }
      rows.push({
        collectionGroup: group,
        fields: index.fields.map((f) => f.fieldPath),
        state,
      });
    }
  }
  return {
    ready: rows.every((row) => row.state === "READY"),
    total: rows.length,
    readyCount: rows.filter((row) => row.state === "READY").length,
    createdCount,
    missingCount: rows.filter((row) => row.state === "MISSING").length,
    pendingCount: rows.filter((row) => row.state === "CREATING").length,
    repairCount: rows.filter((row) => row.state === "NEEDS_REPAIR").length,
    indexes: rows,
  };
}
let startedAt = 0;
const worker = createWorker({
  idleMs: 120000,
  run: async () => {
    if (Date.now() - startedAt > 86400000) {
      worker.stop();
      throw fail("FIRESTORE_INDEX_VERIFICATION_DEADLINE");
    }
    const result = await reconcile({ apply: true });
    if (result.repairCount) throw fail("FIRESTORE_INDEX_REPAIR_REQUIRED");
    if (result.ready) {
      require("../commerce/readiness").reset();
      require("../commerce/worker").wake();
      process.stdout.write(
        JSON.stringify({
          event: "firestore.indexes",
          state: "READY",
          count: result.total,
        }) + "\n",
      );
      worker.stop();
    }
    return 0;
  },
  onError: (error) => {
    require("./errorLogger").logError(error, {
      event: "firestore.indexes",
      status: error.providerStatus,
      providerCode: error.providerCode,
      source: error.indexOperation,
      fields: error.providerFields,
    });
    if (
      [
        "FIRESTORE_INDEX_PERMISSION_REQUIRED",
        "FIRESTORE_INDEX_CONFIGURATION_REQUIRED",
        "FIRESTORE_INDEX_CREDENTIAL_REJECTED",
        "FIRESTORE_INDEX_CREDENTIAL_UNAVAILABLE",
        "FIRESTORE_INDEX_API_DISABLED",
        "FIRESTORE_INDEX_DATABASE_NOT_FOUND",
        "FIRESTORE_INDEX_REQUEST_REJECTED",
        "FIRESTORE_INDEX_REPAIR_REQUIRED",
      ].includes(error.code)
    )
      worker.stop();
  },
});
module.exports = {
  reconcile,
  signature,
  start() {
    if (process.env.FIRESTORE_AUTO_CREATE_INDEXES === "true") {
      startedAt = Date.now();
      worker.start();
    }
  },
  stop: worker.stop,
  status: worker.status,
};
