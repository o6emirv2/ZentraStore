"use strict";
const C = require("./common");
const security = require("../core/security");
const { staffHasPermission } = require("../core/adminStoreService");
const account = require("./account"),
  catalog = require("./catalog"),
  support = require("./support");
const orders = require("./orders"),
  operations = require("./operations"),
  analytics = require("./analytics");
const base = "/store/commerce",
  admin = "/admin/store/commerce";
module.exports = function register(
  router,
  { adminChain, sensitiveAdminChain, noStore },
) {
  const send = (fn) => async (req, res) => {
    noStore(res);
    res.json({ ok: true, result: await fn(req, res) });
  };
  const customer = [security.requireAuth];
  const write = [...customer, security.strictLimiter];
  const paging = (req) => ({
    limit: req.query.limit,
    cursor: req.query.cursor,
  });
  const policy = (p) => [...adminChain, security.requireStorePermission(p)];
  const actor = (req) => ({
    ...req.user,
    financialPermission: staffHasPermission(
      req.adminPolicy,
      "store.wallet.write",
    ),
  });
  router.get(
    admin + "/email",
    ...policy("store.security.read"),
    send(() => require("../email/service").status()),
  );
  router.post(
    admin + "/email/test",
    ...sensitiveAdminChain("store.operations.write"),
    send((req) => {
      C.object(req.body, ["idempotencyKey"]);
      return require("../email/service").queueTest(
        req.user.uid,
        C.id(req.body.idempotencyKey, 100),
      );
    }),
  );
  const community = require("./community");
  const optionalIdentity = (req, res, next) =>
    req.headers.authorization !== undefined
      ? security.requireIdentity(req, res, next)
      : next();
  const communityOrigin = (req, res, next) =>
    require("../core/userSessionService").trustedOrigin(req)
      ? next()
      : res.status(403).json({ ok: false, error: "ORIGIN_NOT_ALLOWED" });
  const viewer = (req) => ({
    uid: req.user?.uid || "",
    visitorToken: req.headers["x-zentra-visitor"] || "",
  });
  router.post(
    base + "/community/visitor",
    communityOrigin,
    security.communityIdentityLimiter,
    send(() => community.issueVisitor()),
  );
  router.get(
    base + "/community/:id",
    optionalIdentity,
    send((req) =>
      community.read(req.params.id, {
        ...viewer(req),
        cursor: req.query.cursor || "",
      }),
    ),
  );
  router.put(
    base + "/community/:id/like",
    communityOrigin,
    security.strictLimiter,
    optionalIdentity,
    send((req) => community.like(req.params.id, viewer(req), req.body)),
  );
  router.get(
    base + "/community/:id/likes",
    security.communityReadLimiter,
    optionalIdentity,
    send(req => community.likers(req.params.id, { cursor: req.query.cursor || "" })),
  );
  router.get(
    base + "/products/:id/compatibility",
    send((req) => catalog.compatibility(req.params.id)),
  );
  router.get(
    base + "/products/:id",
    send((req) => catalog.publicProduct(req.params.id)),
  );
  router.get(
    base + "/knowledge",
    send(() => support.knowledge()),
  );
  router.post(
    base + "/events",
    security.strictLimiter,
    send((req) => analytics.record("", req.body)),
  );
  router.get(
    base + "/profile",
    ...customer,
    send((req) => account.get(req.user.uid)),
  );
  router.patch(
    base + "/profile",
    ...write,
    send((req) => account.update(req.user.uid, req.body)),
  );
  router.post(
    base + "/quote",
    ...write,
    send((req) => require("./quotes").prepare(req.user.uid, req.body)),
  );
  router.post(
    base + "/reservations",
    ...write,
    send((req) => require("./reservations").create(req.user.uid, req.body)),
  );
  router.post(
    base + "/reservations/:id/release",
    ...write,
    send((req) =>
      require("./reservations").release(req.user.uid, req.params.id),
    ),
  );
  router.get(
    base + "/watches",
    ...customer,
    send((req) => account.watches(req.user.uid)),
  );
  router.post(
    base + "/watch",
    ...write,
    send((req) => account.watch(req.user.uid, req.body)),
  );
  router.get(
    base + "/sessions",
    ...customer,
    send((req) => account.sessions(req.user.uid)),
  );
  router.post(
    base + "/sessions",
    ...write,
    send((req) => account.recordSession(req.user.uid, req.body, req)),
  );
  router.post(
    base + "/sessions/revoke",
    ...write,
    security.requireRecentUserAuth,
    send((req) => account.revokeSessions(req.user.uid)),
  );
  router.get(
    base + "/export",
    ...customer,
    security.strictLimiter,
    security.requireRecentUserAuth,
    send((req) => account.exportData(req.user.uid)),
  );
  router.get(
    base + "/data-requests",
    ...customer,
    send((req) =>
      C.page("storeDataRequests", { ...paging(req), uid: req.user.uid }).then(
        C.publicRows,
      ),
    ),
  );
  router.post(
    base + "/data-requests",
    ...write,
    security.requireRecentUserAuth,
    send((req) => account.dataRequest(req.user.uid, req.body)),
  );
  router.post(
    base + "/reviews",
    ...write,
    send((req) => catalog.review(req.user.uid, req.body)),
  );
  router.get(
    base + "/tickets",
    ...customer,
    send((req) => support.list(req.user.uid, paging(req))),
  );
  router.get(
    base + "/tickets/:id",
    ...customer,
    send((req) => support.get(req.user.uid, req.params.id)),
  );
  router.post(
    base + "/tickets",
    ...write,
    send((req) => support.create(req.user.uid, req.body)),
  );
  router.post(
    base + "/tickets/:id/reply",
    ...write,
    send((req) => support.reply(req.user.uid, req.params.id, req.body)),
  );
  router.post(
    base + "/tickets/:id/rating",
    ...write,
    send((req) => support.rate(req.user.uid, req.params.id, req.body)),
  );
  router.post(
    base + "/requests",
    ...write,
    send((req) => support.request(req.user.uid, req.body)),
  );
  router.get(
    base + "/requests",
    ...customer,
    send((req) =>
      C.page("storeCustomerRequests", {
        uid: req.user.uid,
        ...paging(req),
      }).then(C.publicRows),
    ),
  );
  router.get(
    base + "/loyalty",
    ...customer,
    send((req) => require("./loyalty").account(req.user.uid)),
  );
  router.post(
    base + "/loyalty/redeem",
    ...write,
    send((req) => require("./loyalty").redeem(req.user.uid, req.body)),
  );
  router.get(
    base + "/orders/:id",
    ...customer,
    send((req) => orders.experience(req.user.uid, req.params.id)),
  );
  router.post(
    base + "/orders/:id/acknowledge",
    ...write,
    send((req) => orders.acknowledge(req.user.uid, req.params.id)),
  );
  router.get(
    base + "/gifts",
    ...customer,
    send((req) => orders.gifts(req.user.uid, paging(req))),
  );
  router.post(
    base + "/recipient",
    ...write,
    send((req) => orders.recipient(req.user.uid, req.body)),
  );
  router.get(
    admin + "/settings",
    ...policy("store.security.read"),
    send(() => require("./settings").get()),
  );
  router.put(
    admin + "/settings",
    ...sensitiveAdminChain("store.operations.write"),
    send((req) => require("./settings").save(req.body, actor(req))),
  );
  router.get(
    admin + "/products/:id",
    ...policy("store.catalog.read"),
    send((req) =>
      catalog.details(req.params.id, {
        financial: actor(req).financialPermission,
      }),
    ),
  );
  router.get(
    admin + "/products/:id/versions",
    ...policy("store.catalog.read"),
    send((req) => catalog.versions(req.params.id)),
  );
  router.get(
    admin + "/products/:id/impact",
    ...policy("store.catalog.read"),
    send((req) => operations.impact(req.params.id)),
  );
  router.put(
    admin + "/products/:id/draft",
    ...sensitiveAdminChain("store.catalog.write"),
    send((req) => catalog.saveDraft(req.params.id, req.body, actor(req))),
  );
  router.post(
    admin + "/products/:id/publish",
    ...sensitiveAdminChain("store.catalog.write"),
    send((req) => catalog.publish(req.params.id, req.body, actor(req))),
  );
  router.post(
    admin + "/products/:id/restore",
    ...sensitiveAdminChain("store.catalog.write"),
    send((req) => catalog.restore(req.params.id, req.body, actor(req))),
  );
  router.post(
    admin + "/products/:id/images",
    ...sensitiveAdminChain("store.catalog.write"),
    send((req) => catalog.upload(req.params.id, req.body, actor(req))),
  );
  router.get(
    admin + "/reviews",
    ...policy("store.support.read"),
    send((req) => C.page("storeReviews", paging(req)).then(C.publicRows)),
  );
  router.post(
    admin + "/reviews/:id/moderate",
    ...sensitiveAdminChain("store.support.write"),
    send((req) => catalog.moderate(req.params.id, req.body, actor(req))),
  );
  router.get(
    admin + "/assignees",
    ...adminChain,
    send(async (req) => {
      const kind = C.choice(req.query.kind, ["ticket", "order"]),
        permission =
          kind === "order" ? "store.orders.write" : "store.support.write";
      if (!staffHasPermission(req.adminPolicy, permission))
        C.fail("ADMIN_PERMISSION_REQUIRED", 403);
      return (await require("../core/adminStoreService").listStaff())
        .filter(
          (x) =>
            x.active &&
            (x.permissions.includes("*") || x.permissions.includes(permission)),
        )
        .map((x) => ({ uid: x.uid, label: x.email, role: x.role }));
    }),
  );
  router.get(
    admin + "/tickets",
    ...policy("store.support.read"),
    send((req) =>
      C.page("storeSupportTickets", paging(req)).then(C.publicRows),
    ),
  );
  router.get(
    admin + "/tickets/:id",
    ...policy("store.support.read"),
    send((req) => support.get(req.user.uid, req.params.id, { admin: true })),
  );
  router.post(
    admin + "/tickets/:id/reply",
    ...sensitiveAdminChain("store.support.write"),
    send((req) =>
      support.reply(req.user.uid, req.params.id, req.body, {
        admin: true,
        actor: actor(req),
      }),
    ),
  );
  router.post(
    admin + "/tickets/:id/assign",
    ...sensitiveAdminChain("store.support.write"),
    send((req) =>
      support.assign("ticket", req.params.id, req.body, actor(req)),
    ),
  );
  router.post(
    admin + "/orders/:id/assign",
    ...sensitiveAdminChain("store.orders.write"),
    send((req) => support.assign("order", req.params.id, req.body, actor(req))),
  );
  router.get(
    admin + "/orders/:id",
    ...policy("store.orders.read"),
    send(async (req) => {
      const row = (
        await C.db().collection("storeOrders").doc(C.id(req.params.id)).get()
      ).data();
      if (!row) C.fail("STORE_ORDER_NOT_FOUND", 404);
      return {
        experience:
          (
            await C.db()
              .collection("storeOrderExperience")
              .doc(req.params.id)
              .get()
          ).data() || {},
        costs: actor(req).financialPermission
          ? (
              await C.db()
                .collection("storeOrderCostSnapshots")
                .doc(req.params.id)
                .get()
            ).data() || null
          : null,
      };
    }),
  );
  router.put(
    admin + "/orders/:id/license",
    ...sensitiveAdminChain("store.orders.write"),
    send((req) => orders.license(req.params.id, req.body, actor(req))),
  );
  router.put(
    admin + "/orders/:id/costs",
    ...sensitiveAdminChain("store.wallet.write"),
    send((req) => analytics.costs(req.params.id, req.body, actor(req))),
  );
  router.get(
    admin + "/requests",
    ...policy("store.support.read"),
    send((req) =>
      C.page("storeCustomerRequests", paging(req)).then(C.publicRows),
    ),
  );
  router.post(
    admin + "/requests/:id/decision",
    ...sensitiveAdminChain("store.support.write"),
    send((req) => support.requestDecision(req.params.id, req.body, actor(req))),
  );
  router.get(
    admin + "/knowledge",
    ...policy("store.support.read"),
    send(() => support.knowledge({ admin: true })),
  );
  router.put(
    admin + "/knowledge",
    ...sensitiveAdminChain("store.support.write"),
    send((req) => support.saveKnowledge(req.body, actor(req))),
  );
  router.get(
    admin + "/reports",
    ...policy("store.analytics.read"),
    send((req) =>
      analytics.report({ financial: actor(req).financialPermission }),
    ),
  );
  router.get(
    admin + "/alerts",
    ...policy("store.security.read"),
    send(() => analytics.alerts()),
  );
  router.post(
    admin + "/alerts/:id/acknowledge",
    ...sensitiveAdminChain("store.operations.write"),
    send((req) => analytics.acknowledge(req.params.id, actor(req))),
  );
  router.post(
    admin + "/diagnostic",
    ...sensitiveAdminChain("store.operations.write"),
    send((req) => operations.diagnostic(req.body, actor(req))),
  );
  router.get(
    admin + "/csv",
    ...policy("store.catalog.read"),
    send(async () => ({ csv: await operations.exportCatalog() })),
  );
  router.get(
    admin + "/bulk",
    ...policy("store.catalog.read"),
    send((req) =>
      C.page("storeBulkCatalogJobs", paging(req)).then(C.publicRows),
    ),
  );
  router.post(
    admin + "/bulk/preview",
    ...sensitiveAdminChain("store.catalog.write"),
    send((req) => operations.preview(req.body, actor(req))),
  );
  router.get(
    admin + "/bulk/:id",
    ...policy("store.catalog.read"),
    send((req) => operations.getJob(req.params.id)),
  );
  router.post(
    admin + "/bulk/:id/approve",
    ...sensitiveAdminChain("store.catalog.write"),
    send((req) => operations.approve(req.params.id, actor(req))),
  );
  router.post(
    admin + "/bulk/:id/execute",
    ...sensitiveAdminChain("store.catalog.write"),
    send((req) => operations.execute(req.params.id, req.body, actor(req))),
  );
  router.get(
    admin + "/backups",
    ...policy("store.backups.write"),
    send(() => require("./backups").list()),
  );
  router.post(
    admin + "/backups",
    ...sensitiveAdminChain("store.backups.write"),
    send((req) => require("./backups").create(req.body, actor(req))),
  );
  router.post(
    admin + "/backups/:id/refresh",
    ...sensitiveAdminChain("store.backups.write"),
    send((req) => require("./backups").refresh(req.params.id)),
  );
  router.post(
    admin + "/backups/:id/restore",
    ...sensitiveAdminChain("store.backups.write"),
    send((req) =>
      require("./backups").restore(req.params.id, req.body, actor(req)),
    ),
  );
  router.post(
    admin + "/backups/:id/verify",
    ...sensitiveAdminChain("store.backups.write"),
    send((req) => require("./backups").verify(req.params.id, actor(req))),
  );
  router.get(
    admin + "/data-requests",
    ...policy("store.privacy.write"),
    send((req) => C.page("storeDataRequests", paging(req)).then(C.publicRows)),
  );
  router.post(
    admin + "/data-requests/:id/decision",
    ...sensitiveAdminChain("store.privacy.write"),
    send((req) => account.dataDecision(req.params.id, req.body, actor(req))),
  );
};
