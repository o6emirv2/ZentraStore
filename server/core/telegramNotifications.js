"use strict";
const { initFirebaseAdmin } = require("../config/firebaseAdmin");
const { createWorker } = require("./workerScheduler");
const { logError } = require("./errorLogger");
const FINAL = 8640000000000000;
function configuration() {
  const token = String(process.env.TELEGRAM_BOT_TOKEN || ""),
    chat = String(process.env.TELEGRAM_ADMIN_CHAT_ID || "");
  return {
    enabled: process.env.TELEGRAM_NOTIFICATIONS_ENABLED === "true",
    configured:
      /^[0-9]{5,16}:[A-Za-z0-9_-]{20,}$/.test(token) &&
      /^-?[0-9]{5,20}$/.test(chat),
    token,
    chat,
  };
}
function enqueue(tx, db, order) {
  const c = configuration();
  if (!c.enabled || !c.configured) return;
  tx.create(db.collection("storeTelegramOutbox").doc("order_" + order.id), {
    orderId: order.id,
    orderNumber: order.orderNumber,
    paymentMethod: order.paymentMethod,
    totalKurus: order.totalKurus,
    state: "queued",
    availableAt: Date.now(),
    createdAt: Date.now(),
    attempts: 0,
  });
}
async function processMessage(db, ref, { fetcher = fetch } = {}) {
  const config = configuration();
  if (!config.enabled || !config.configured) return;
  const entry = await db.runTransaction(async (tx) => {
    const row = (await tx.get(ref)).data();
    if (!row || row.state !== "queued" || row.availableAt > Date.now())
      return null;
    tx.update(ref, {
      state: "sending",
      attempts: (row.attempts || 0) + 1,
      startedAt: Date.now(),
      availableAt: FINAL,
    });
    return row;
  });
  if (!entry) return;
  // A lost provider response is uncertain. Never automatically resend a message
  // that Telegram may already have accepted; an operator can review the outbox.
  let patch;
  try {
    const amount = (entry.totalKurus / 100).toLocaleString("tr-TR", {
      style: "currency",
      currency: "TRY",
    });
    const response = await fetcher(
      `https://api.telegram.org/bot${config.token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: config.chat,
          text: `ZENTRA STORE\nYeni sipariş: ${entry.orderNumber}\nKanal: ${entry.paymentMethod === "telegram" ? "Telegram" : "Bakiye"}\nTutar: ${amount}\nÖdeme ve teslimat durumunu yönetim merkezinden doğrulayın.`,
          protect_content: true,
          link_preview_options: { is_disabled: true },
        }),
        signal: AbortSignal.timeout(10000),
        redirect: "error",
      },
    );
    const payload = await response.json();
    if (
      response.ok &&
      payload.ok === true &&
      Number.isSafeInteger(payload.result?.message_id)
    )
      patch = {
        state: "sent",
        providerMessageId: payload.result.message_id,
        sentAt: Date.now(),
        availableAt: FINAL,
      };
    else if (
      response.status === 429 &&
      payload.ok === false &&
      Number(entry.attempts || 0) < 4
    ) {
      const delay = Math.min(
        3600,
        Math.max(30, Number(payload.parameters?.retry_after) || 60),
      );
      patch = {
        state: "queued",
        availableAt: Date.now() + delay * 1000,
        failureCode: "TELEGRAM_RATE_LIMIT",
      };
    } else
      patch = {
        state: "failed",
        failureCode: "TELEGRAM_PROVIDER_REJECTED",
        availableAt: FINAL,
      };
  } catch {
    patch = {
      state: "uncertain",
      failureCode: "TELEGRAM_DELIVERY_UNVERIFIED",
      availableAt: FINAL,
    };
  }
  await ref.update(patch);
}
async function drain() {
  const c = configuration(),
    { db } = initFirebaseAdmin();
  if (!c.enabled || !c.configured || !db) return 0;
  const jobs = await db
    .collection("storeTelegramOutbox")
    .where("availableAt", "<=", Date.now())
    .orderBy("availableAt")
    .limit(2)
    .get();
  for (const doc of jobs.docs) await processMessage(db, doc.ref);
  return jobs.size;
}
const worker = createWorker({
  run: drain,
  onError: (error) =>
    logError(null, {
      event: "telegram.worker",
      code: String(error.code || "TELEGRAM_WORKER_FAILED"),
    }),
});
function start() {
  const c = configuration();
  if (c.enabled && c.configured) worker.start();
}
function status() {
  const c = configuration();
  return {
    enabled: c.enabled,
    configured: c.configured,
    deliveryVerified: false,
  };
}
module.exports = {
  enqueue,
  processMessage,
  start,
  stop: () => worker.stop(),
  wake: () => worker.wake(),
  status,
};
