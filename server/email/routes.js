"use strict";
const crypto = require("node:crypto");
const rateLimit = require("express-rate-limit");
const K = require("./config"),
  service = require("./service");
const { escape } = require("./templates");
const { storeEntryUrl } = require("../../public/js/app/routes.mjs");
function verifyWebhook(raw, headers, now = Date.now()) {
  const config = K.configuration();
  if (!config.webhookConfigured)
    throw K.failure("EMAIL_WEBHOOK_NOT_CONFIGURED", 503);
  const id = headers["svix-id"],
    timestamp = headers["svix-timestamp"],
    signatures = headers["svix-signature"];
  if (
    !Buffer.isBuffer(raw) ||
    raw.length > 65536 ||
    typeof id !== "string" ||
    !/^[A-Za-z0-9_-]{1,200}$/.test(id) ||
    typeof timestamp !== "string" ||
    !/^\d{10,12}$/.test(timestamp) ||
    Math.abs(now / 1000 - Number(timestamp)) > 300 ||
    typeof signatures !== "string" ||
    signatures.length > 2000
  )
    throw K.failure("EMAIL_WEBHOOK_SIGNATURE_INVALID", 401);
  const expected = crypto
    .createHmac("sha256", Buffer.from(config.webhookSecret.slice(6), "base64"))
    .update(id + "." + timestamp + ".")
    .update(raw)
    .digest();
  const valid = signatures.split(" ").some((part) => {
    const [version, value, ...extra] = part.split(",");
    if (
      version !== "v1" ||
      extra.length ||
      !value ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
    )
      return false;
    const received = Buffer.from(value, "base64");
    return (
      received.length === expected.length &&
      crypto.timingSafeEqual(received, expected)
    );
  });
  if (!valid) throw K.failure("EMAIL_WEBHOOK_SIGNATURE_INVALID", 401);
  let payload;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    throw K.failure("EMAIL_WEBHOOK_INVALID");
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    typeof payload.type !== "string"
  )
    throw K.failure("EMAIL_WEBHOOK_INVALID");
  return { payload, messageId: id };
}
function page(message, token = "") {
  const account = escape(
    storeEntryUrl(K.configuration().origin, "/hesabim?bolum=preferences"),
  );
  return `<!doctype html><html lang="tr" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=0.85, viewport-fit=cover" /><meta name="robots" content="noindex,nofollow"><meta name="color-scheme" content="dark"><title>Zentra Store · E-posta tercihleri</title><link rel="stylesheet" href="/public/css/recovery.css?v=109"></head><body><main class="recovery-preferences"><section class="recovery-card"><img src="/public/assets/images/logo.png" alt="ZENTRA STORE" width="64" height="64"><p class="recovery-kicker">BİLDİRİM MERKEZİ</p><h1>E-posta tercihleri</h1><p>${escape(message)}</p>${token ? `<form method="post" action="/email/unsubscribe?token=${encodeURIComponent(token)}"><button type="submit" class="recovery-button primary">Bu tür e-postaları kapat</button></form>` : `<a class="recovery-button primary" href="${account}">Bildirim tercihlerime git</a>`}</section></main></body></html>`;
}
function register(app, express) {
  const limiter = rateLimit({
    windowMs: 60000,
    max: 180,
    standardHeaders: true,
    legacyHeaders: false,
  });
  const noStore = (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    next();
  };
  app.post(
    "/api/webhooks/resend",
    limiter,
    noStore,
    express.raw({ type: "application/json", limit: "64kb", inflate: false }),
    async (req, res) => {
      try {
        const { payload, messageId } = verifyWebhook(req.body, req.headers);
        await service.providerEvent(payload, messageId);
        res.json({ ok: true });
      } catch (error) {
        res.status(error.statusCode || 503).json({
          ok: false,
          error: error.statusCode
            ? error.code
            : "EMAIL_WEBHOOK_STORAGE_UNAVAILABLE",
        });
      }
    },
  );
  app.get("/email/unsubscribe", limiter, noStore, (req, res) => {
    try {
      K.readUnsubscribe(req.query.token);
      res
        .type("html")
        .send(
          page(
            "Bu bildirim türünü e-posta üzerinden almayı durdurabilirsin. Diğer hesap işlemleri ve güvenlik iletileri etkilenmez.",
            req.query.token,
          ),
        );
    } catch {
      res
        .status(400)
        .type("html")
        .send(
          page(
            "Bağlantı geçersiz veya süresi dolmuş. Bildirim tercihlerini hesabından yönetebilirsin.",
          ),
        );
    }
  });
  app.post(
    "/email/unsubscribe",
    limiter,
    noStore,
    express.urlencoded({
      extended: false,
      limit: "1kb",
      parameterLimit: 2,
      inflate: false,
    }),
    async (req, res) => {
      try {
        await service.unsubscribe(req.query.token);
        res
          .type("html")
          .send(
            page(
              "Bu tür e-postalar kapatıldı. Tercihini hesabından yeniden değiştirebilirsin.",
            ),
          );
      } catch (error) {
        res
          .status(error.statusCode || 503)
          .type("html")
          .send(
            page(
              "Tercihin kaydedilemedi. Hesabındaki bildirim ayarlarından tekrar deneyebilirsin.",
            ),
          );
      }
    },
  );
}
module.exports = { register, verifyWebhook };
