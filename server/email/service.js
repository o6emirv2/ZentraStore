"use strict";
const crypto = require("node:crypto");
const { initFirebaseAdmin } = require("../config/firebaseAdmin");
const { createWorker } = require("../core/workerScheduler");
const { logError } = require("../core/errorLogger");
const K = require("./config"),
  templates = require("./templates");
const FINAL = 8640000000000000,
  RETRY_WINDOW = 23 * 3600000;
const id = (...parts) =>
  crypto.createHash("sha256").update(parts.join("\0")).digest("hex");
function enqueue(
  tx,
  database,
  { uid, type, key, data = {}, now = Date.now() },
) {
  const config = K.configuration(),
    category = templates.TYPES[type];
  if (!config.enabled || !config.configured) return "";
  if (
    !category ||
    typeof uid !== "string" ||
    !uid ||
    uid.length > 128 ||
    /[\\/\u0000-\u001f]/.test(uid) ||
    typeof key !== "string" ||
    !key ||
    key.length > 240
  )
    throw K.failure("EMAIL_EVENT_INVALID");
  const eventId = id(uid, type, key);
  tx.create(database.collection("storeEmailOutbox").doc(eventId), {
    id: eventId,
    uid,
    type,
    category,
    data,
    state: "queued",
    availableAt: now,
    createdAt: now,
    updatedAt: now,
    attempts: 0,
    providerId: "",
    failureCode: "",
  });
  return eventId;
}
function orderEvent(tx, db, order, { created = false, previous = {} } = {}) {
  const complete =
    order.status === "delivered" &&
    order.delivery?.status === "delivered" &&
    Number(order.approvedAt) > 0;
  if (created || (complete && !Number(previous.delivery?.deliveredAt))) {
    const noteId = id(order.uid, complete ? "delivered" : "created", order.id);
    tx.create(db.collection("storeNotifications").doc(noteId), {
      id: noteId,
      uid: order.uid,
      type: "order",
      templateType:complete ? "paid_delivered" : "order_created",
      orderId: order.id,
      title: complete ? "Siparişin teslim edildi" : "Siparişin oluşturuldu",
      message: complete
        ? "Ödeme ve teslimat kaydı doğrulandı. Teslimatını sipariş detayında açabilirsin."
        : "Sipariş kaydın oluşturuldu. Güncel ödeme ve teslimat durumunu siparişinde takip et.",
      createdAt: Date.now(),
      readAt: 0,
    });
    enqueue(tx, db, {
      uid: order.uid,
      type: complete ? "paid_delivered" : "order_created",
      key: order.id,
      data: { orderId: order.id },
    });
    if (
      complete &&
      order.giftRecipientUid &&
      order.giftRecipientUid !== order.uid
    )
      enqueue(tx, db, {
        uid: order.giftRecipientUid,
        type: "gift_received",
        key: order.id,
        data: { orderId: order.id },
      });
  }
}
async function factsFor(job, db) {
  const data = job.data || {};
  if (
    ["order_created", "paid_delivered", "gift_received", "license"].includes(
      job.type,
    )
  ) {
    const order = (
      await db.collection("storeOrders").doc(data.orderId).get()
    ).data();
    const recipient = job.type === "gift_received" || job.type === "license";
    if (
      !order ||
      (recipient
        ? (order.giftRecipientUid || order.uid) !== job.uid
        : order.uid !== job.uid)
    )
      return null;
    if (job.type === "order_created") {
      const labels = {
        awaiting_payment: "Ödeme bekleniyor",
        payment_review: "Ödeme kontrol ediliyor",
        paid: "Ödeme onaylandı",
        processing: "Hazırlanıyor",
        delivery_pending: "Teslimat bekleniyor",
        delivered: "Teslim edildi",
        cancelled: "İptal edildi",
        refunded: "İade edildi",
        payment_rejected: "Ödeme reddedildi",
      };
      return {
        order,
        statusLabel: labels[order.status] || "Hesabından kontrol et",
      };
    }
    if (
      order.status !== "delivered" ||
      order.delivery?.status !== "delivered" ||
      !Number.isSafeInteger(order.approvedAt) ||
      order.approvedAt <= 0 ||
      !Number.isSafeInteger(order.delivery?.deliveredAt) ||
      order.delivery.deliveredAt <= 0 ||
      !Number.isSafeInteger(order.totalKurus) ||
      order.totalKurus <= 0 ||
      !Array.isArray(order.items) ||
      !order.items.length ||
      order.items.some(
        (x) => !Number.isSafeInteger(x.quantity) || x.quantity < 1,
      )
    )
      return null;
    if (job.type === "license") {
      const experience = (
        await db.collection("storeOrderExperience").doc(data.orderId).get()
      ).data();
      return experience?.license?.source &&
        experience.license.expiresAt === data.expiresAt &&
        data.expiresAt > Date.now()
        ? { expiresAt: data.expiresAt }
        : null;
    }
    if (order.paymentMethod === "wallet") {
      const ledger = (
        await db
          .collection("storeWalletLedger")
          .doc("purchase_" + data.orderId)
          .get()
      ).data();
      if (
        !ledger ||
        ledger.uid !== order.uid ||
        ledger.type !== "DEBIT" ||
        ledger.amountKurus !== -order.totalKurus
      )
        return null;
    } else if (order.paymentMethod === "telegram") {
      if (
        !order.manualPayment?.reference ||
        !Number(order.manualPayment?.verifiedAt)
      )
        return null;
    } else return null;
    if (
      (order.delivery.itemCount || 0) <
      (order.items || []).reduce((n, x) => n + x.quantity, 0)
    )
      return null;
    return { order };
  }
  if (job.type === "wallet_credit") {
    const row = (
      await db.collection("storeWalletLedger").doc(data.transactionId).get()
    ).data();
    return row?.uid === job.uid &&
      row.type === "CREDIT" &&
      Number.isSafeInteger(row.amountKurus) &&
      row.amountKurus > 0 &&
      Number.isSafeInteger(row.balanceAfterKurus)
      ? row
      : null;
  }
  if (job.type === "coupon_assigned" || job.type === "promo_added") {
    const row = (
      await db.collection("storePromotions").doc(data.code).get()
    ).data();
    return row?.active === true &&
      (job.type === "promo_added" ? row.type === "balance" && row.announce === true :
        ["fixed","percent"].includes(row.type) && (row.customerUids?.includes(job.uid) || (row.visibleInWallet && !row.customerUids?.length))) &&
      (!row.usageLimit || row.usedCount < row.usageLimit) && (!row.startsAt || row.startsAt <= Date.now()) &&
      (!row.endsAt || row.endsAt > Date.now())
      ? { coupon: row }
      : null;
  }
  if (job.type === "password_changed") {
    const operation = (
      await db.collection("storePasswordOperations").doc(data.operationId).get()
    ).data();
    return operation?.uid === job.uid && operation.state === "completed"
      ? { reset: operation.source === "email-recovery" }
      : null;
  }
  if (["username_changed", "new_device", "test"].includes(job.type)) return {};
  if (["restock","stock","price"].includes(job.type)) {
    const catalog = await require("../core/storeService").publicCatalog();
    if (catalog.stockVerified === false)
      throw K.failure("EMAIL_SOURCE_UNAVAILABLE", 503);
    const product = catalog.products.find((p) => p.id === data.productId);
    if (!product) return null;
    if (job.type !== "price") {
      const stock = data.planKey ? product.plans.find(p => p.key === data.planKey)?.stock : product.stock;
      return stock?.available > 0 ? { product } : null;
    }
    const plan = product.plans.find((p) => p.key === data.planKey);
    return plan && plan.priceKurus <= data.priceKurus
      ? { product, plan, oldPriceKurus: data.oldPriceKurus || 0 }
      : null;
  }
  return null;
}
async function eligible(uid, category) {
  const { db, auth } = initFirebaseAdmin();
  if (!db || !auth) throw K.failure("EMAIL_STORAGE_UNAVAILABLE", 503);
  const user = await auth.getUser(uid);
  if (user.disabled || user.emailVerified !== true || !K.validEmail(user.email))
    return null;
  const [profile, account] = await Promise.all([
    db.collection("storeCommerceProfiles").doc(uid).get(),
    db.collection("users").doc(uid).get(),
  ]);
  if (
    account.data()?.storeAccountStatus === "suspended" ||
    !K.permitted(category, profile.data())
  )
    return null;
  return { email: user.email.toLowerCase(), hash: K.addressHash(user.email) };
}
async function skip(db, ref, code) {
  return db.runTransaction(async (tx) => {
    const row = (await tx.get(ref)).data();
    if (
      row &&
      ["queued", "retry", "sending"].includes(row.state) &&
      row.availableAt <= Date.now()
    )
      tx.update(ref, {
        state: "skipped",
        failureCode: code,
        availableAt: FINAL,
        updatedAt: Date.now(),
        payload: null,
      });
  });
}
async function processMessage(db, ref, { fetcher = global.fetch } = {}) {
  const config = K.configuration();
  if (!config.enabled || !config.configured) return;
  const current = (await ref.get()).data();
  if (
    !current ||
    current.availableAt > Date.now() ||
    !["queued", "retry", "sending"].includes(current.state)
  )
    return;
  let recipient;
  try {
    recipient = await eligible(current.uid, current.category);
  } catch (error) {
    if (error.code === "auth/user-not-found")
      return skip(db, ref, "EMAIL_ACCOUNT_UNAVAILABLE");
    throw error;
  }
  if (!recipient) return skip(db, ref, "EMAIL_PREFERENCE_OR_IDENTITY_BLOCKED");
  if (current.recipientHash && current.recipientHash !== recipient.hash)
    return skip(db, ref, "EMAIL_RECIPIENT_CHANGED");
  const facts = await factsFor(current, db);
  const overrides = (await require("./editor").read(db)).templates;
  const template = current.type === "password_changed" && facts?.reset ? overrides.password_reset_completed || overrides.password_changed : overrides[current.type];
  if (!facts) return skip(db, ref, "EMAIL_SOURCE_NO_LONGER_VALID");
  const lease = crypto.randomUUID();
  const entry = await db.runTransaction(async (tx) => {
    const row = (await tx.get(ref)).data();
    if (
      !row ||
      row.availableAt > Date.now() ||
      !["queued", "retry", "sending"].includes(row.state)
    )
      return null;
    const [suppression, profile] = await Promise.all([
      tx.get(db.collection("storeEmailSuppressions").doc(recipient.hash)),
      tx.get(db.collection("storeCommerceProfiles").doc(row.uid)),
    ]);
    if (
      suppression.data()?.blocked === true ||
      !K.permitted(row.category, profile.data())
    ) {
      tx.update(ref, {
        state: "skipped",
        failureCode: "EMAIL_SUPPRESSED_OR_UNSUBSCRIBED",
        availableAt: FINAL,
        updatedAt: Date.now(),
        payload: null,
      });
      return null;
    }
    const now = Date.now();
    if (
      (row.firstAttemptAt && now - row.firstAttemptAt >= RETRY_WINDOW) ||
      row.attempts >= 8
    ) {
      tx.update(ref, {
        state: "needs_review",
        failureCode: "EMAIL_RETRY_WINDOW_EXHAUSTED",
        availableAt: FINAL,
        updatedAt: now,
        payload: null,
      });
      return null;
    }
    const next = {
      ...row,
      payload: row.payload || templates.render(row, facts, recipient.email, template),
      recipientHash: recipient.hash,
      recipientLabel: recipient.email.replace(/^(.).*(@.*)$/, "$1***$2"),
      firstAttemptAt: row.firstAttemptAt || now,
      lease,
      state: "sending",
      availableAt: now + 60000,
      attempts: row.attempts + 1,
      updatedAt: now,
    };
    tx.update(ref, next);
    return next;
  });
  if (!entry) return;
  let patch;
  try {
    const response = await fetcher("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "zentra/" + entry.id,
      },
      body: JSON.stringify(entry.payload),
      signal: AbortSignal.timeout(10000),
      redirect: "error",
    });
    const payload = await response.json().catch(() => null);
    if (
      response.ok &&
      typeof payload?.id === "string" &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
        payload.id,
      )
    )
      patch = {
        state: "accepted",
        providerId: payload.id,
        acceptedAt: Date.now(),
        failureCode: "",
        availableAt: FINAL,
        payload: null,
      };
    else if (
      response.status === 429 ||
      response.status >= 500 ||
      response.status === 409
    )
      patch = {
        state: "retry",
        failureCode:
          response.status === 429
            ? "EMAIL_PROVIDER_RATE_LIMIT"
            : "EMAIL_PROVIDER_RETRY",
        availableAt:
          Date.now() +
          Math.min(
            3600000,
            Math.max(
              30000 * 2 ** (entry.attempts - 1),
              Math.min(
                3600,
                Number(response.headers?.get("retry-after")) || 0,
              ) * 1000,
            ),
          ),
      };
    else if (response.ok)
      patch = {
        state: "retry",
        failureCode: "EMAIL_PROVIDER_REPLY_UNVERIFIED",
        availableAt: Date.now() + 60000,
      };
    else
      patch = {
        state: "failed",
        failureCode: "EMAIL_PROVIDER_REJECTED_" + response.status,
        availableAt: FINAL,
        payload: null,
      };
  } catch {
    patch = {
      state: "retry",
      failureCode: "EMAIL_PROVIDER_REPLY_UNVERIFIED",
      availableAt: Date.now() + 60000,
    };
  }
  await db.runTransaction(async (tx) => {
    const row = (await tx.get(ref)).data();
    if (row?.lease !== lease || row.state !== "sending") return;
    const event = patch.providerId
      ? (
          await tx.get(
            db.collection("storeEmailProviderState").doc(patch.providerId),
          )
        ).data()
      : null;
    const effective = event ? { ...patch, ...providerPatch(event) } : patch;
    tx.update(ref, { ...effective, lease: "", updatedAt: Date.now() });
    if (patch.providerId) {
      tx.set(db.collection("storeEmailProviderMap").doc(patch.providerId), {
        jobId: entry.id,
        recipientHash: entry.recipientHash,
      });
      if (event?.blocked)
        tx.set(
          db.collection("storeEmailSuppressions").doc(entry.recipientHash),
          { blocked: true, reason: event.type, updatedAt: Date.now() },
        );
    }
  });
  return { id: entry.id, state: patch.state };
}
const PROVIDER = Object.freeze({
  "email.sent": [1, "accepted"],
  "email.delivery_delayed": [2, "delayed"],
  "email.delivered": [3, "delivered"],
  "email.failed": [4, "failed"],
  "email.bounced": [5, "bounced"],
  "email.suppressed": [5, "suppressed"],
  "email.complained": [6, "complained"],
});
function providerPatch(event) {
  return {
    state: PROVIDER[event.type][1],
    providerEventAt: event.at,
    availableAt: FINAL,
    failureCode: ["email.sent", "email.delivered"].includes(event.type)
      ? ""
      : "EMAIL_PROVIDER_" + event.type.slice(6).toUpperCase(),
    ...(event.type === "email.delivered" ? { deliveredAt: event.at } : {}),
  };
}
async function providerEvent(payload, messageId) {
  const { db } = initFirebaseAdmin(),
    providerId = payload.data?.email_id;
  if (!db) throw K.failure("EMAIL_STORAGE_UNAVAILABLE", 503);
  if (!PROVIDER[payload.type]) return { ignored: true };
  if (typeof providerId !== "string" || !/^[a-f0-9-]{36}$/i.test(providerId))
    throw K.failure("EMAIL_WEBHOOK_INVALID");
  const at = Date.parse(payload.created_at);
  if (!Number.isFinite(at)) throw K.failure("EMAIL_WEBHOOK_INVALID");
  const receipt = db.collection("storeEmailWebhookReceipts").doc(id(messageId)),
    ref = db.collection("storeEmailProviderState").doc(providerId);
  return db.runTransaction(async (tx) => {
    const [prior, existing, mapping] = await Promise.all([
      tx.get(receipt),
      tx.get(ref),
      tx.get(db.collection("storeEmailProviderMap").doc(providerId)),
    ]);
    if (prior.exists) return { replay: true };
    const map = mapping.data(),
      jobRef = map?.jobId
        ? db
            .collection(
              map.collection === "storeAccountRecoveryRequests"
                ? "storeAccountRecoveryRequests"
                : "storeEmailOutbox",
            )
            .doc(map.jobId)
        : null;
    const job = jobRef ? (await tx.get(jobRef)).data() : null;
    const old = existing.data(),
      rank = PROVIDER[payload.type][0];
    const accepted =
      !old || rank > old.rank || (rank === old.rank && at >= old.at);
    const event = {
      type: payload.type,
      rank,
      at,
      blocked:
        ["email.bounced", "email.complained", "email.suppressed"].includes(
          payload.type,
        ) || old?.blocked === true,
    };
    tx.create(receipt, {
      providerId,
      type: payload.type,
      at,
      createdAt: Date.now(),
    });
    if (accepted) {
      tx.set(ref, event);
      if (job && job.providerId === providerId)
        tx.update(jobRef, {
          ...providerPatch(event),
          updatedAt: Date.now(),
          lease: "",
        });
    }
    if (event.blocked && map?.recipientHash)
      tx.set(db.collection("storeEmailSuppressions").doc(map.recipientHash), {
        blocked: true,
        reason: payload.type,
        updatedAt: Date.now(),
      });
    return { recorded: true };
  });
}
async function unsubscribe(token) {
  const { uid, category } = K.readUnsubscribe(token),
    { db } = initFirebaseAdmin();
  if (!db) throw K.failure("EMAIL_STORAGE_UNAVAILABLE", 503);
  await db.runTransaction(async (tx) => {
    const ref = db.collection("storeCommerceProfiles").doc(uid),
      old = (await tx.get(ref)).data() || {};
    tx.set(ref, {
      ...old,
      uid,
      revision: (old.revision || 0) + 1,
      preferences: { ...old.preferences, [K.OPTIONAL[category]]: false },
      updatedAt: Date.now(),
    });
  });
  return { unsubscribed: true, category };
}
async function status() {
  const { db } = initFirebaseAdmin(),
    c = K.configuration();
  if (!db) throw K.failure("EMAIL_STORAGE_UNAVAILABLE", 503);
  const rows = await db
    .collection("storeEmailOutbox")
    .orderBy("createdAt", "desc")
    .limit(50)
    .get();
  const recovery = await db
    .collection("storeAccountRecoveryRequests")
    .orderBy("createdAt", "desc")
    .limit(50)
    .get();
  return {
    enabled: c.enabled,
    configured: c.configured,
    recovery: {
      configured: K.recoveryConfiguration().configured,
      from: K.RECOVERY_FROM,
      origin: K.recoveryConfiguration().origin,
      worker: require("../core/accountRecoveryService").worker.status(),
    },
    webhookConfigured: c.webhookConfigured,
    from: c.from,
    sampleLimit: 50,
    items: [...rows.docs, ...recovery.docs]
      .sort((a, b) => (b.data().createdAt || 0) - (a.data().createdAt || 0))
      .slice(0, 50)
      .map((doc) => {
        const r = doc.data();
        return {
          id: doc.id,
          type: r.type || "recovery_" + r.kind,
          state: r.state,
          recipient: r.recipientLabel || "Doğrulama bekleniyor",
          providerId: r.providerId || "",
          createdAt: r.createdAt,
          acceptedAt: r.acceptedAt || 0,
          deliveredAt: r.deliveredAt || 0,
          attempts: r.attempts,
          failureCode: r.failureCode || "",
        };
      }),
  };
}
async function queueTest(uid, key) {
  const { db } = initFirebaseAdmin(),
    config = K.configuration();
  if (!config.enabled || !config.configured)
    throw K.failure("EMAIL_NOT_CONFIGURED", 503);
  if (!(await eligible(uid, "test")))
    throw K.failure("EMAIL_VERIFIED_ADDRESS_REQUIRED", 409);
  const eventId = id(uid, "test", key),
    ref = db.collection("storeEmailOutbox").doc(eventId);
  await db.runTransaction(async (tx) => {
    if ((await tx.get(ref)).exists) return;
    enqueue(tx, db, { uid, type: "test", key });
    require("../core/storeMutationAudit").recordMutationAudit(
      tx,
      db,
      "store.email.test",
      { uid },
      { emailEventId: eventId },
    );
  });
  worker.wake();
  return { queued: true, id: eventId };
}
async function run() {
  const c = K.configuration(),
    { db } = initFirebaseAdmin();
  if (!c.enabled || !c.configured || !db) return 0;
  const rows = await db
    .collection("storeEmailOutbox")
    .where("availableAt", "<=", Date.now())
    .orderBy("availableAt", "asc")
    .limit(5)
    .get();
  for (const doc of rows.docs) await processMessage(db, doc.ref);
  return rows.size;
}
const worker = createWorker({
  run,
  idleMs: 60000,
  activeMs: 3000,
  onError: (error) =>
    logError(null, {
      event: "email.worker",
      code: /^EMAIL_[A-Z_]+$/.test(error.code || "")
        ? error.code
        : "EMAIL_WORKER_UNAVAILABLE",
    }),
});
module.exports = {
  providerPatch,
  enqueue,
  orderEvent,
  processMessage,
  factsFor,
  providerEvent,
  unsubscribe,
  status,
  queueTest,
  run,
  PROVIDER,
  FINAL,
  start: () => worker.start(),
  stop: () => worker.stop(),
};
