'use strict';

const crypto = require('node:crypto');
const { initFirebaseAdmin } = require('../config/firebaseAdmin');
const { requireShopierConfig } = require('../config/shopier');
const { shopierError } = require('./shopierClient');
const { hash, queueJob } = require('./shopierService');

function authenticateWebhook(raw, signature, config = requireShopierConfig()) {
  if (!Buffer.isBuffer(raw) || raw.length < 2 || raw.length > 256 * 1024 || typeof signature !== 'string' || signature.length > 128) throw shopierError('SHOPIER_SIGNATURE_INVALID', 401);
  // The signed bytes are used verbatim, before parsing or any body-safety transformations.
  // Official Node recipe: HMAC-SHA256, hexadecimal Shopier-Signature.
  const supplied = /^[a-f0-9]{64}$/.test(signature) ? Buffer.from(signature, 'hex') : Buffer.alloc(0);
  let tokenKind = '';
  for (const [kind, token] of [['order', config.webhookToken], ['refund', config.refundWebhookToken]]) {
    if (!token) continue;
    const expected = crypto.createHmac('sha256', token).update(raw).digest();
    const valid = supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
    if (valid) tokenKind = kind;
  }
  if (!tokenKind) throw shopierError('SHOPIER_SIGNATURE_INVALID', 401);
  return tokenKind;
}
function notification(raw, tokenKind, event) {
  let payload;
  try { payload = JSON.parse(raw.toString('utf8')); } catch (_) { throw shopierError('SHOPIER_WEBHOOK_INVALID', 400); }
  // Official webhook body is the resource itself (data.id), NOT an invented { event, data } envelope.
  // Shopier-Event is a header. Subscription-specific signing keys bind each accepted event type.
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof event !== 'string') throw shopierError('SHOPIER_WEBHOOK_INVALID', 400);
  if ((tokenKind === 'order' && event !== 'order.created') || (tokenKind === 'refund' && event !== 'refund.updated')) throw shopierError('SHOPIER_WEBHOOK_EVENT_INVALID', 400);
  if (typeof payload.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(payload.id)) throw shopierError('SHOPIER_WEBHOOK_INVALID', 400);
  return { event, resourceId: payload.id };
}
async function receiveShopierWebhook(raw, signature, eventHeader) {
  const tokenKind = authenticateWebhook(raw, signature), event = notification(raw, tokenKind, eventHeader);
  const { db } = initFirebaseAdmin();
  if (!db) throw shopierError('STORE_STORAGE_UNAVAILABLE');
  const id = hash(raw), ref = db.collection('shopierWebhookReceipts').doc(id);
  await db.runTransaction(async (tx) => {
    const previous = await tx.get(ref);
    if (previous.exists) return;
    // Retain the digest, event and opaque IDs only; never persist the customer's raw webhook body.
    tx.create(ref, { id, ...event, receivedAt: Date.now(), tokenKind });
    queueJob(tx, db, { id: `event_${id}`, kind: event.event, resourceId: event.resourceId });
  });
  return { accepted: true };
}
module.exports = { authenticateWebhook, notification, receiveShopierWebhook };
