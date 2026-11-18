"use strict";
const { createRouter } = require("../core/asyncRouter");
const {
  requireIdentity,
  strictLimiter,
  emailVerificationSendLimiter,
} = require("../core/security");
const { trustedOrigin } = require("../core/userSessionService");
const service = require("../core/emailVerificationService");
const router = createRouter();
router.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});
const origin = (req, res, next) =>
  trustedOrigin(req)
    ? next()
    : res.status(403).json({ ok: false, error: "ORIGIN_NOT_ALLOWED" });
router.get("/auth/email-verification", requireIdentity, async (req, res) => {
  res.json({ ok: true, ...(await service.status(req.user)) });
});
router.post(
  "/auth/email-verification/start",
  origin,
  emailVerificationSendLimiter,
  requireIdentity,
  async (req, res) => {
    res.json({
      ok: true,
      ...(await service.start(req.user, req.body?.profile)),
    });
  },
);
router.post(
  "/auth/email-verification/resend",
  origin,
  emailVerificationSendLimiter,
  requireIdentity,
  async (req, res) => {
    res.json({
      ok: true,
      ...(await service.start(req.user, undefined, {
        resendId: req.body?.challengeId || "",
      })),
    });
  },
);
router.post(
  "/auth/email-verification/verify",
  origin,
  strictLimiter,
  requireIdentity,
  async (req, res) => {
    res.json({
      ok: true,
      ...(await service.verify(
        req.user,
        req.body?.challengeId || "",
        req.body?.code || "",
      )),
    });
  },
);
router.post(
  "/auth/email-verification/complete",
  origin,
  strictLimiter,
  requireIdentity,
  async (req, res) => {
    res.json({
      ok: true,
      ...(await service.complete(req.user, req.body?.challengeId || "")),
    });
  },
);
module.exports = router;
