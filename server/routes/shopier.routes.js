'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { requireAuth, strictLimiter } = require('../core/security');
const { createShopierPayment, getShopierPayment } = require('../core/shopierService');
const { receiveShopierWebhook } = require('../core/shopierWebhooks');
const { wakeShopierWorker } = require('../core/shopierJobs');
const router = express.Router(), webhookRouter = express.Router();
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
router.post('/payments/shopier/create', requireAuth, strictLimiter, asyncRoute(async (req, res) => {
  const result = await createShopierPayment({ uid: req.user.uid, authUser: req.user, ...(req.body || {}) });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, ...result }); wakeShopierWorker();
}));
router.get('/payments/shopier/attempt', requireAuth, asyncRoute(async (req, res) => {
  const result = await getShopierPayment({ uid: req.user.uid, idempotencyKey: req.query.idempotencyKey });
  res.setHeader('Cache-Control', 'no-store'); res.json({ ok: true, ...result });
}));
router.get('/payments/shopier/orders/:id', requireAuth, asyncRoute(async (req, res) => {
  const result = await getShopierPayment({ uid: req.user.uid, orderId: req.params.id });
  res.setHeader('Cache-Control', 'no-store'); res.json({ ok: true, ...result });
}));
const webhookLimit = rateLimit({ windowMs: 60_000, max: 300, standardHeaders: true, legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ ok: false, error: 'TOO_MANY_REQUESTS' }) });
webhookRouter.post('/api/payments/shopier/webhook', webhookLimit, (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(String(req.headers['content-type'] || '')) || req.headers['content-encoding']) {
    return res.status(415).json({ ok: false, error: 'SHOPIER_WEBHOOK_CONTENT_TYPE' });
  }
  return next();
}, express.raw({ type: 'application/json', limit: '256kb', inflate: false }), asyncRoute(async (req, res) => {
  let timer;
  try {
    await Promise.race([receiveShopierWebhook(req.body, req.headers['shopier-signature'], req.headers['shopier-event']), new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('SHOPIER_WEBHOOK_STORAGE_TIMEOUT'), { code: 'SHOPIER_WEBHOOK_STORAGE_TIMEOUT', statusCode: 503 })), 3500);
    })]);
    res.status(200).json({ ok: true }); wakeShopierWorker();
  } finally { clearTimeout(timer); }
}));
module.exports = { router, webhookRouter };
