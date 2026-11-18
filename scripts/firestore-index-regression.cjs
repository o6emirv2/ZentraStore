"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  http = require("node:http");
const service = require("../server/core/firestoreIndexService"),
  indexes = require("../firestore.indexes.json").indexes;
const project = "zentra-integration";
const firebase = {
  db: {},
  app: {
    options: {
      projectId: project,
      credential: {
        getAccessToken: async () => ({ access_token: "fixture-only-token" }),
      },
    },
  },
};
const reply = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const indexName = (group, id) =>
  `projects/${project}/databases/(default)/collectionGroups/${group}/indexes/${id}`;
function remote(index, state = "READY", id = "fixture-index") {
  return {
    ...index,
    name: indexName(index.collectionGroup, id),
    state,
    fields: [
      ...index.fields,
      ...(index.fields.at(-1).fieldPath === "__name__"
        ? []
        : [
            {
              fieldPath: "__name__",
              order: index.fields.at(-1).order || "ASCENDING",
            },
          ]),
    ],
  };
}
test("read-only check uses one database-wide list and cannot mutate data", async () => {
  let gets = 0;
  const result = await service.reconcile({
    firebase,
    fetchImpl: async (url, options) => {
      gets++;
      assert.equal(options.method, "GET");
      assert.equal(options.body, undefined);
      assert.equal(new URL(url).search, "");
      assert.equal(
        new URL(url).pathname,
        `/v1/projects/${project}/databases/(default)/collectionGroups/-/indexes`,
      );
      assert.equal(options.redirect, "error");
      return reply({});
    },
  });
  assert.equal(gets, 1);
  assert.equal(result.ready, false);
  assert.equal(result.total, indexes.length);
  assert.equal(result.missingCount, indexes.length);
  assert.equal(result.createdCount, 0);
});
test("creation is bounded to six declared indexes per pass and only actual READY completes the process", async () => {
  const writes = [],
    records = [];
  const fetchImpl = async (url, options) => {
    if (options.method === "GET") return reply({ indexes: records });
    assert.equal(options.method, "POST");
    const group = new URL(url).pathname.match(
        /collectionGroups\/([^/]+)\/indexes$/,
      )[1],
      body = JSON.parse(options.body);
    assert.ok(
      indexes.some(
        (i) =>
          i.collectionGroup === group &&
          service.signature(i) === service.signature(body),
      ),
    );
    writes.push([group, body]);
    records.push(
      remote(
        { ...body, collectionGroup: group },
        "CREATING",
        "index-" + records.length,
      ),
    );
    return reply({
      name: `projects/${project}/databases/(default)/operations/new-index`,
      done: false,
    });
  };
  const first = await service.reconcile({ firebase, fetchImpl, apply: true });
  assert.equal(writes.length, 6);
  assert.equal(first.createdCount, 6);
  assert.equal(first.missingCount, indexes.length - 6);
  assert.equal(first.ready, false);
  for (let pass = 1; pass < Math.ceil(indexes.length / 6); pass++)
    await service.reconcile({ firebase, fetchImpl, apply: true });
  assert.equal(writes.length, indexes.length);
  await service.reconcile({ firebase, fetchImpl, apply: true });
  assert.equal(writes.length, indexes.length);
  records.forEach((record) => (record.state = "READY"));
  const ready = await service.reconcile({ firebase, fetchImpl, apply: true });
  assert.equal(ready.ready, true);
  assert.equal(ready.readyCount, indexes.length);
  assert.equal(writes.length, indexes.length);
});
test("global pagination preserves group ownership and does not duplicate indexes", async () => {
  let calls = 0;
  const result = await service.reconcile({
    firebase,
    apply: true,
    fetchImpl: async (url, options) => {
      assert.equal(options.method, "GET");
      calls++;
      assert.equal(new URL(url).searchParams.has("pageSize"), false);
      if (!new URL(url).searchParams.has("pageToken"))
        return reply({
          indexes: indexes
            .slice(0, 8)
            .map((i, n) => remote(i, "READY", String(n))),
          nextPageToken: "second page",
        });
      assert.equal(new URL(url).searchParams.get("pageToken"), "second page");
      return reply({
        indexes: indexes.slice(8).map((i, n) => remote(i, "READY", String(n))),
      });
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.ready, true);
});
test("invalid request diagnostics expose only approved field names and no provider descriptions", async () => {
  await assert.rejects(
    service.reconcile({
      firebase,
      fetchImpl: async () =>
        reply(
          {
            error: {
              status: "INVALID_ARGUMENT",
              message: "private-provider-message",
              details: [
                {
                  "@type": "type.googleapis.com/google.rpc.BadRequest",
                  fieldViolations: [
                    {
                      field: "page_size",
                      description: "private-provider-description",
                    },
                    {
                      field: "private-customer-field",
                      description: "private-customer-description",
                    },
                  ],
                },
              ],
            },
          },
          400,
        ),
    }),
    (error) => {
      assert.equal(error.code, "FIRESTORE_INDEX_REQUEST_REJECTED");
      assert.deepEqual(error.providerFields, ["pageSize"]);
      assert(!JSON.stringify(error).includes("private-"));
      return true;
    },
  );
});
test("HTTP status and provider code identify permission, quota, invalid request and unavailable API separately", async () => {
  for (const [status, providerCode, code] of [
    [400, "INVALID_ARGUMENT", "FIRESTORE_INDEX_REQUEST_REJECTED"],
    [401, "UNAUTHENTICATED", "FIRESTORE_INDEX_CREDENTIAL_REJECTED"],
    [403, "PERMISSION_DENIED", "FIRESTORE_INDEX_PERMISSION_REQUIRED"],
    [404, "NOT_FOUND", "FIRESTORE_INDEX_DATABASE_NOT_FOUND"],
    [429, "RESOURCE_EXHAUSTED", "FIRESTORE_INDEX_QUOTA_EXHAUSTED"],
    [503, "UNAVAILABLE", "FIRESTORE_INDEX_PROVIDER_UNAVAILABLE"],
  ]) {
    await assert.rejects(
      service.reconcile({
        firebase,
        fetchImpl: async () =>
          reply(
            {
              error: {
                status: providerCode,
                message: "private-provider-message",
              },
            },
            status,
          ),
      }),
      (error) => {
        assert.equal(error.code, code);
        assert.equal(error.providerCode, providerCode);
        assert.equal(error.providerStatus, status);
        assert.equal(error.indexOperation, "index-list");
        assert.ok(!JSON.stringify(error).includes("private-provider-message"));
        return true;
      },
    );
  }
});
test("a disabled Firestore API is distinct from missing IAM permission", async () => {
  await assert.rejects(
    service.reconcile({
      firebase,
      fetchImpl: async () =>
        reply(
          {
            error: {
              status: "PERMISSION_DENIED",
              details: [
                {
                  "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                  reason: "SERVICE_DISABLED",
                  metadata: { secret: "must-not-log" },
                },
              ],
            },
          },
          403,
        ),
    }),
    (error) => {
      assert.equal(error.code, "FIRESTORE_INDEX_API_DISABLED");
      assert.ok(!JSON.stringify(error).includes("must-not-log"));
      return true;
    },
  );
});
test("create failures keep the operation type and cannot pretend the index was created", async () => {
  await assert.rejects(
    service.reconcile({
      firebase,
      apply: true,
      fetchImpl: async (_url, options) =>
        options.method === "GET"
          ? reply({})
          : reply({ error: { status: "PERMISSION_DENIED" } }, 403),
    }),
    {
      code: "FIRESTORE_INDEX_PERMISSION_REQUIRED",
      indexOperation: "index-create",
      providerStatus: 403,
    },
  );
  await assert.rejects(
    service.reconcile({
      firebase,
      apply: true,
      fetchImpl: async (_url, options) =>
        reply(options.method === "GET" ? {} : { name: "unrelated-operation" }),
    }),
    { code: "FIRESTORE_INDEX_CREATE_UNVERIFIED" },
  );
});
test("a concurrent create conflict waits for the next actual index listing", async () => {
  const result = await service.reconcile({
    firebase,
    apply: true,
    fetchImpl: async (_url, options) =>
      reply({}, options.method === "GET" ? 200 : 409),
  });
  assert.equal(result.ready, false);
  assert.equal(result.createdCount, 6);
  assert.equal(result.pendingCount, 6);
  assert.equal(result.missingCount, indexes.length - 6);
});
test("repair-needed indexes and unrelated indexes are never deleted or accepted for another collection", async () => {
  const result = await service.reconcile({
    firebase,
    apply: true,
    fetchImpl: async (_url, options) => {
      assert.equal(options.method, "GET");
      return reply({ indexes: indexes.map((i) => remote(i, "NEEDS_REPAIR")) });
    },
  });
  assert.equal(result.ready, false);
  assert.equal(result.repairCount, indexes.length);
  assert.equal(result.createdCount, 0);
  const original = remote(indexes[0]);
  const foreign = await service.reconcile({
    firebase,
    fetchImpl: async () =>
      reply({
        indexes: [
          { ...original, name: indexName("someOtherCollection", "foreign") },
          {
            ...original,
            name: original.name.replace(project, "foreign-project"),
          },
        ],
      }),
  });
  assert.equal(foreign.readyCount, 0);
  assert.equal(foreign.missingCount, indexes.length);
});
test("invalid configuration, malformed pages and cycling pagination fail without writes", async () => {
  await assert.rejects(
    service.reconcile({
      firebase: { db: {}, app: { options: { projectId: "../../foreign" } } },
      fetchImpl: async () => {
        throw Error("must not call");
      },
    }),
    { code: "FIRESTORE_INDEX_CONFIGURATION_REQUIRED" },
  );
  await assert.rejects(
    service.reconcile({
      firebase,
      fetchImpl: async () => reply({ indexes: {} }),
    }),
    { code: "FIRESTORE_INDEX_RESPONSE_INVALID" },
  );
  let calls = 0;
  await assert.rejects(
    service.reconcile({
      firebase,
      fetchImpl: async () => {
        calls++;
        return reply({ nextPageToken: "same-page" });
      },
    }),
    { code: "FIRESTORE_INDEX_LIST_LIMIT" },
  );
  assert.equal(calls, 2);
  assert.equal(
    service.signature({ queryScope: "COLLECTION", fields: [null, {}] }),
    null,
  );
});
test("network and credential failures never expose raw provider messages", async () => {
  await assert.rejects(
    service.reconcile({
      firebase,
      fetchImpl: async () => {
        throw Object.assign(new Error("private-value"), {
          cause: { code: "ETIMEDOUT" },
        });
      },
    }),
    {
      code: "FIRESTORE_INDEX_PROVIDER_UNAVAILABLE",
      providerCode: "ETIMEDOUT",
      indexOperation: "index-list",
    },
  );
  await assert.rejects(
    service.reconcile({
      firebase: {
        db: {},
        app: {
          options: {
            projectId: project,
            credential: {
              getAccessToken: async () => {
                throw Error("private-credential-error");
              },
            },
          },
        },
      },
    }),
    { code: "FIRESTORE_INDEX_CREDENTIAL_UNAVAILABLE" },
  );
});
test("real HTTP transport uses the Firebase CLI list request without forced pagination and preserves JSON creation", async () => {
  const records = [],
    calls = [],
    prefix = `/v1/projects/${project}/databases/(default)/collectionGroups/`;
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://fixture.invalid");
      calls.push([req.method, url.pathname]);
      assert.equal(req.headers.authorization, "Bearer fixture-only-token");
      res.setHeader("content-type", "application/json");
      if (req.method === "GET" && url.pathname === prefix + "-/indexes") {
        if (url.search) {
          res.statusCode = 400;
          return res.end(
            JSON.stringify({
              error: {
                status: "INVALID_ARGUMENT",
                details: [
                  {
                    "@type": "type.googleapis.com/google.rpc.BadRequest",
                    fieldViolations: [
                      {
                        field: "page_size",
                        description: "private-provider-description",
                      },
                    ],
                  },
                ],
              },
            }),
          );
        }
        return res.end(JSON.stringify({ indexes: records }));
      }
      const group =
        url.pathname.startsWith(prefix) &&
        url.pathname
          .slice(prefix.length)
          .match(/^([A-Za-z0-9]+)\/indexes$/)?.[1];
      if (req.method !== "POST" || !group) {
        res.statusCode = 404;
        return res.end(JSON.stringify({ error: { status: "NOT_FOUND" } }));
      }
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      assert.deepEqual(Object.keys(body).sort(), ["fields", "queryScope"]);
      assert.ok(
        indexes.some(
          (i) =>
            i.collectionGroup === group &&
            service.signature(i) === service.signature(body),
        ),
      );
      records.push(
        remote(
          { ...body, collectionGroup: group },
          "CREATING",
          String(records.length),
        ),
      );
      res.end(
        JSON.stringify({
          name: `projects/${project}/databases/(default)/operations/creation-${records.length}`,
          done: false,
        }),
      );
    } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: { status: "INVALID_ARGUMENT" } }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const fetchImpl = (target, options) => {
    const url = new URL(target);
    return fetch(
      `http://127.0.0.1:${server.address().port}${url.pathname}${url.search}`,
      options,
    );
  };
  try {
    for (let pass = 0; pass < Math.ceil(indexes.length / 6); pass++) {
      const result = await service.reconcile({
        firebase,
        fetchImpl,
        apply: true,
      });
      assert.equal(result.ready, false);
      assert.equal(result.createdCount, Math.min(6, indexes.length - pass * 6));
      records.forEach((i) => (i.state = "READY"));
    }
    const ready = await service.reconcile({ firebase, fetchImpl, apply: true });
    assert.equal(ready.ready, true);
    assert.equal(ready.readyCount, indexes.length);
    assert.equal(
      calls.filter((c) => c[0] === "GET").length,
      Math.ceil(indexes.length / 6) + 1,
    );
    assert.equal(calls.filter((c) => c[0] === "POST").length, indexes.length);
    assert.equal(records.length, indexes.length);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
