"use strict";
const C = require("./common");
function ticketView(row) {
  const { adminNotes: _n, ...result } = row;
  return result;
}
async function create(uid, input) {
  C.object(input, ["orderId", "subject", "message", "idempotencyKey"]);
  const database = C.db(),
    orderId = C.id(input.orderId),
    key = C.id(input.idempotencyKey, 100),
    subject = C.text(input.subject, 120, { required: true }),
    message = C.text(input.message, 4000, { required: true }),
    ref = database.collection("storeSupportTickets").doc(C.hash(uid, key));
  return database.runTransaction(async (tx) => {
    await C.activeUser(uid, { transaction: tx, database });
    const order = await C.orderForUser(uid, orderId, {
        transaction: tx,
        database,
        recipient: true,
      }),
      old = await tx.get(ref);
    if (old.exists) {
      if (
        old.data().orderId !== orderId ||
        old.data().subject !== subject ||
        old.data().messages?.[0]?.message !== message
      )
        C.fail("COMMERCE_IDEMPOTENCY_CONFLICT", 409);
      return ticketView({ ...old.data(), id: ref.id });
    }
    const now = Date.now(),
      row = {
        uid,
        orderId,
        orderNumber: order.orderNumber || orderId,
        subject,
        status: "open",
        assigneeUid: "",
        revision: 1,
        createdAt: now,
        updatedAt: now,
        messages: [
          {
            id: C.hash(uid, key, "first"),
            senderUid: uid,
            role: "customer",
            message,
            createdAt: now,
          },
        ],
      };
    tx.create(ref, row);
    return ticketView({ ...row, id: ref.id });
  });
}
async function list(uid, query = {}) {
  await C.activeUser(uid);
  return C.publicRows(
    await C.page("storeSupportTickets", { uid, ...query }),
    ticketView,
  );
}
async function get(uid, ticketId, { admin = false } = {}) {
  const row = (
    await C.db().collection("storeSupportTickets").doc(C.id(ticketId)).get()
  ).data();
  if (!row || (!admin && row.uid !== uid))
    C.fail("COMMERCE_TICKET_NOT_FOUND", 404);
  return ticketView({ ...row, id: ticketId });
}
async function reply(uid, ticketId, input, { admin = false, actor = {} } = {}) {
  C.object(input, ["expectedRevision", "message", "status"]);
  const message = C.text(input.message, 4000, { required: true }),
    database = C.db(),
    ref = database.collection("storeSupportTickets").doc(C.id(ticketId));
  return database.runTransaction(async (tx) => {
    if (!admin) await C.activeUser(uid, { transaction: tx, database });
    const snap = await tx.get(ref),
      row = snap.data();
    if (!row || (!admin && row.uid !== uid))
      C.fail("COMMERCE_TICKET_NOT_FOUND", 404);
    C.requireRevision(row.revision, input.expectedRevision);
    if (row.messages.length >= 100)
      C.fail("COMMERCE_TICKET_MESSAGE_LIMIT", 409);
    const status = admin
      ? C.choice(input.status || "answered", ["answered", "resolved", "open"])
      : "open";
    const now = Date.now(),
      next = {
        ...row,
        status,
        revision: row.revision + 1,
        updatedAt: now,
        messages: [
          ...row.messages,
          {
            id: require("node:crypto").randomUUID(),
            senderUid: uid,
            role: admin ? "staff" : "customer",
            message,
            createdAt: now,
          },
        ],
      };
    tx.set(ref, next);
    if (admin) {
      C.notification(
        tx,
        database,
        row.uid,
        "support:" + ticketId + ":" + next.revision,
        "Destek talebin yanıtlandı",
        row.subject,
        { ticketId },
      );
      C.audit(tx, database, "commerce.support.reply", actor, {
        ticketId,
        status,
      });
    }
    return ticketView({ ...next, id: ticketId });
  });
}
async function rate(uid, ticketId, input) {
  C.object(input, ["rating", "message"]);
  const rating = C.integer(input.rating, 1, 5),
    message = C.text(input.message || "", 1000),
    database = C.db(),
    ref = database.collection("storeSupportTickets").doc(C.id(ticketId));
  return database.runTransaction(async (tx) => {
    const snap = await tx.get(ref),
      row = snap.data();
    if (!row || row.uid !== uid) C.fail("COMMERCE_TICKET_NOT_FOUND", 404);
    if (row.status !== "resolved") C.fail("COMMERCE_TICKET_NOT_RESOLVED", 409);
    if (row.satisfaction) C.fail("COMMERCE_SATISFACTION_EXISTS", 409);
    const satisfaction = { rating, message, createdAt: Date.now() };
    tx.update(ref, { satisfaction });
    return satisfaction;
  });
}
async function request(uid, input) {
  C.object(input, ["kind", "orderId", "subject", "message", "idempotencyKey"]);
  const kind = C.choice(input.kind, ["product", "refund", "cancellation"]),
    subject = C.text(input.subject, 120, { required: true }),
    message = C.text(input.message, 3000, { required: true }),
    database = C.db(),
    key = C.id(input.idempotencyKey, 100),
    ref = database.collection("storeCustomerRequests").doc(C.hash(uid, key));
  return database.runTransaction(async (tx) => {
    await C.activeUser(uid, { transaction: tx, database });
    if (kind !== "product")
      await C.orderForUser(uid, C.id(input.orderId), {
        transaction: tx,
        database,
      });
    const before = await tx.get(ref);
    if (before.exists) {
      const row = before.data();
      if (
        row.kind !== kind ||
        row.orderId !== (input.orderId || "") ||
        row.subject !== subject ||
        row.message !== message
      )
        C.fail("COMMERCE_IDEMPOTENCY_CONFLICT", 409);
      return { ...row, id: ref.id };
    }
    const now = Date.now(),
      row = {
        uid,
        kind,
        orderId: input.orderId || "",
        subject,
        message,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      };
    tx.create(ref, row);
    return { ...row, id: ref.id };
  });
}
async function requestDecision(requestId, input, actor) {
  C.object(input, ["status", "reply"]);
  const status = C.choice(input.status, [
      "reviewing",
      "accepted",
      "rejected",
      "resolved",
    ]),
    reply = C.text(input.reply, 3000, { required: true }),
    database = C.db(),
    ref = database.collection("storeCustomerRequests").doc(C.id(requestId));
  return database.runTransaction(async (tx) => {
    const old = await tx.get(ref),
      row = old.data();
    if (!row) C.fail("COMMERCE_REQUEST_NOT_FOUND", 404);
    if (row.kind === "refund" && status === "resolved") {
      const order = await tx.get(
        database.collection("storeOrders").doc(row.orderId),
      );
      if (order.data()?.status !== "refunded")
        C.fail("COMMERCE_REFUND_NOT_VERIFIED", 409);
    }
    if (row.kind === "cancellation" && status === "resolved") {
      const order = await tx.get(
        database.collection("storeOrders").doc(row.orderId),
      );
      if (order.data()?.status !== "cancelled")
        C.fail("COMMERCE_CANCELLATION_NOT_VERIFIED", 409);
    }
    tx.update(ref, {
      status,
      reply,
      updatedAt: Date.now(),
      updatedBy: actor.uid,
    });
    C.notification(
      tx,
      database,
      row.uid,
      "request:" + requestId + ":" + status,
      "Talebin güncellendi",
      reply,
    );
    C.audit(tx, database, "commerce.request.update", actor, {
      requestId,
      status,
    });
    return { id: requestId, status, reply };
  });
}
async function assign(kind, targetId, input, actor) {
  C.object(input, ["assigneeUid"]);
  C.choice(kind, ["ticket", "order"]);
  const assigneeUid = C.uid(input.assigneeUid),
    database = C.db();
  const ref = database
    .collection(
      kind === "ticket" ? "storeSupportTickets" : "storeOrderExperience",
    )
    .doc(C.id(targetId));
  const identity = await require("../config/firebaseAdmin")
    .initFirebaseAdmin()
    .auth.getUser(assigneeUid);
  if (identity.disabled || !identity.emailVerified)
    C.fail("COMMERCE_ASSIGNEE_INVALID", 403);
  return database.runTransaction(async (tx) => {
    const policy =
      await require("../core/adminStoreService").resolveStaffPolicy(
        assigneeUid,
        identity.email,
      );
    const needed =
      kind === "order" ? "store.orders.write" : "store.support.write";
    if (
      !policy?.active ||
      !policy.permissions.some((p) => p === "*" || p === needed)
    )
      C.fail("COMMERCE_ASSIGNEE_INVALID", 403);
    if (!policy.systemOwner) {
      const staff = await tx.get(
        database.collection("adminUsers").doc(assigneeUid),
      );
      const live = staff.data();
      if (
        !live ||
        live.active === false ||
        live.disabled === true ||
        live.revoked === true ||
        live.role !== policy.role ||
        (live.policyVersion || 0) !== policy.policyVersion
      )
        C.fail("COMMERCE_ASSIGNEE_INVALID", 403);
    }
    const old = await tx.get(ref);
    if (kind === "ticket" && !old.exists)
      C.fail("COMMERCE_TICKET_NOT_FOUND", 404);
    if (kind === "order") {
      const order = await tx.get(
        database.collection("storeOrders").doc(targetId),
      );
      if (!order.exists) C.fail("STORE_ORDER_NOT_FOUND", 404);
    }
    tx.set(
      ref,
      {
        ...(old.data() || {}),
        assigneeUid,
        assignedAt: Date.now(),
        assignedBy: actor.uid,
        updatedAt: Date.now(),
      },
      { merge: true },
    );
    C.audit(tx, database, "commerce.work.assign", actor, {
      kind,
      targetId,
      assigneeUid,
    });
    return { kind, targetId, assigneeUid };
  });
}
async function knowledge({ admin = false } = {}) {
  const snap = await C.db().collection("storeKnowledge").doc("main").get(),
    row = snap.data() || {};
  return {
    revision: row.revision || 0,
    articles: (row.articles || []).filter((x) => admin || x.published === true),
    templates: admin ? row.templates || [] : [],
  };
}
async function saveKnowledge(input, actor) {
  C.object(input, ["expectedRevision", "articles", "templates"]);
  const articles = C.array(input.articles, 50).map((x) => {
      C.object(x, ["id", "title", "body", "published"]);
      return {
        id: C.id(x.id, 60),
        title: C.text(x.title, 120, { required: true }),
        body: C.text(x.body, 12000, { required: true }),
        published: C.flag(x.published),
      };
    }),
    templates = C.array(input.templates, 30).map((x) => {
      C.object(x, ["id", "title", "body"]);
      return {
        id: C.id(x.id, 60),
        title: C.text(x.title, 120, { required: true }),
        body: C.text(x.body, 4000, { required: true }),
      };
    });
  if (new Set(articles.map((x) => x.id)).size !== articles.length)
    C.fail("COMMERCE_DUPLICATE_ID");
  const database = C.db(),
    ref = database.collection("storeKnowledge").doc("main");
  return database.runTransaction(async (tx) => {
    const old = await tx.get(ref);
    C.requireRevision(old.data()?.revision, input.expectedRevision);
    const next = {
      revision: (old.data()?.revision || 0) + 1,
      articles,
      templates,
      updatedAt: Date.now(),
    };
    tx.set(ref, next);
    C.audit(tx, database, "commerce.knowledge.update", actor, {
      revision: next.revision,
    });
    return next;
  });
}
module.exports = {
  create,
  list,
  get,
  reply,
  rate,
  request,
  requestDecision,
  assign,
  knowledge,
  saveKnowledge,
};
