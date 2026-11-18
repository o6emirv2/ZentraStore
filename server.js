"use strict";

const path = require("path");
const {
  startRestockWorker,
  stopRestockWorker,
} = require("./server/core/storeRestockJobs");
const express = require("express");
const compression = require("compression");
const helmet = require("helmet");
const cors = require("cors");
const env = require("./server/config/env");
const { corsOptions } = require("./server/config/cors");
const { initFirebaseAdmin } = require("./server/config/firebaseAdmin");
const {
  connectionReadiness,
  sensitiveConfigurationGuard,
} = require("./server/core/runtimeHealth");
const {
  apiBodyContract,
  apiClientGuard,
} = require("./server/core/apiContracts");
const {
  publicLimiter,
  apiLimiter,
  adminAuthLimiter,
  appCheckGuard,
} = require("./server/core/security");
const {
  requestEnvelopeGuard,
  apiRequestGuard,
  bodySafetyGuard,
  configureHttpServer,
} = require("./server/core/requestSecurity");
const {
  trustedOrigin,
  sessionCookieHeader,
} = require("./server/core/userSessionService");
const {
  adminAccessCookie,
  clearAdminGateFactorCookie,
} = require("./server/core/adminAccessService");
const { isAdminSessionActive } = require("./server/core/adminSessionRegistry");
const { consumeAdminHandoff } = require("./server/core/adminHandoffService");
const { resolveStaffPolicy } = require("./server/core/adminStoreService");
const { writeAdminAudit } = require("./server/core/adminReauthService");
const { logError, requestErrorObserver } = require("./server/core/errorLogger");
const authRouter = require("./server/routes/auth.routes");
const identityRouter = require("./server/routes/identity.routes");
const emailVerificationRouter = require("./server/routes/email-verification.routes");
const adminAuthRouter = require("./server/routes/admin-auth.routes");
const storeRouter = require("./server/routes/store.routes");
const {
  startMaintenanceWorker,
  stopMaintenanceWorker,
} = require("./server/core/orderMaintenanceService");

const app = express();
const root = __dirname;
const port = Math.max(1, Number(process.env.PORT || 10000) || 10000);
const host = "0.0.0.0";

const ADMIN_ENTRY_BLOCK_COOKIE =
  env.nodeEnv === "production"
    ? "__Host-zentra_admin_block"
    : "zentra_admin_block";
function clearAdminBlockCookie() {
  const secure = env.nodeEnv === "production" ? "; Secure" : "";
  return `${ADMIN_ENTRY_BLOCK_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Priority=High${secure}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

function escapeHtml(value = "") {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character],
  );
}

function adminHandoffPage({ success = false, message = '', code = '' } = {}) {
  const destination = success ? '/admin/' : `${env.canonicalOrigin || env.publicBaseUrl}/admin/index.html`;
  const safeMessage = escapeHtml(message || (success
    ? 'Güvenli yönetici oturumu doğrulandı. Yönetim merkezi açılıyor.'
    : 'Güvenli yönetici geçişi tamamlanamadı. Lütfen son doğrulama adımını yeniden deneyin.'));
  const safeCode = escapeHtml(code);
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8" />\n`
    + `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />\n`
    + `<meta name="color-scheme" content="dark" />\n`
    + `<meta name="theme-color" content="#070B16" />\n`
    + `<meta name="robots" content="noindex, nofollow, noarchive" />\n`
    + (success ? '<meta http-equiv="refresh" content="0;url=/admin/" />\n' : '')
    + '<title>ZENTRA STORE | Güvenli Yönetici Oturumu</title>\n'
    + '<link rel="stylesheet" href="/public/css/admin-handoff.css?v=109" /><link rel="stylesheet" href="/public/css/interaction-guard.css?v=109" /><link rel="stylesheet" href="/public/css/app-system.css?v=109" /><link rel="stylesheet" href="/public/css/interface.css?v=109" /></head><body>'
    + '<main class="gate"><div class="brand"><img src="/public/assets/images/zentra-mark.webp?v=brand-v67" alt="" /><span><b>ZENTRA STORE</b><small>GÜVENLİ YÖNETİCİ GEÇİŞİ</small></span></div>'
    + `<span class="status ${success ? 'is-success' : 'is-error'}" aria-hidden="true">${success ? '✓' : '!'}</span><span class="eyebrow">${success ? 'OTURUM DOĞRULANDI' : 'ERİŞİM DENETİMİ'}</span>`
    + `<h1>${success ? 'Yönetim merkezi açılıyor' : 'Güvenli geçiş tamamlanamadı'}</h1>`
    + `<p>${safeMessage}</p><a href="${escapeHtml(destination)}">${success ? 'Yönetim paneline devam et' : 'Yönetici girişine dön'} <span aria-hidden="true">→</span></a>`
    + (safeCode ? `<small>İşlem kodu: ${safeCode}</small>` : '')
    + '</main><script type="module" src="/public/js/ui/interaction-guard-entry.js?v=109"></script></body></html>';
}

app.disable("x-powered-by");
app.set("trust proxy", env.nodeEnv === "production" ? 1 : false);
app.set("query parser", "simple");
app.set("etag", false);
app.set("json escape", true);
initFirebaseAdmin();

function contentSecurityPolicy() {
  const domain = String(
    env.firebase.publicConfig.authDomain || "",
  ).toLowerCase();
  const authOrigin =
    /^[a-z0-9.-]+$/.test(domain) &&
    (domain.endsWith(".firebaseapp.com") ||
      domain.endsWith(".web.app") ||
      env.allowedOrigins.includes(`https://${domain}`))
      ? `https://${domain}`
      : "";
  const connect = [
    "'self'",
    env.serviceOrigin,
    env.publicApiBase,
    env.publicBaseUrl,
    "https://www.gstatic.com",
    "https://identitytoolkit.googleapis.com",
    "https://securetoken.googleapis.com",
    "https://www.googleapis.com",
    "https://www.google.com",
    "https://www.recaptcha.net",
    "https://firebaseappcheck.googleapis.com",
    "https://firebaseinstallations.googleapis.com",
    "https://recaptchaenterprise.googleapis.com",
  ].filter(Boolean);
  return {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "base-uri": ["'self'"],
      "object-src": ["'none'"],
      "frame-ancestors": ["'none'"],
      "form-action": ["'self'"],
      "script-src": [
        "'self'",
        "https://www.gstatic.com/firebasejs/12.17.1/",
        "https://www.gstatic.com/recaptcha/",
        "https://www.google.com/recaptcha/",
        "https://www.recaptcha.net/recaptcha/",
      ],
      "script-src-attr": ["'none'"],
      "style-src": ["'self'"],
      "style-src-attr": ["'unsafe-inline'"],
      "img-src": [
        "'self'",
        "data:",
        "blob:",
        "https://encrypted-tbn0.gstatic.com",
        "https://firebasestorage.googleapis.com",
      ],
      "font-src": ["'self'"],
      "connect-src": [...new Set(connect)],
      "media-src": ["'self'"],
      "worker-src": ["'self'", "blob:"],
      "frame-src": [
        "'self'",
        "https://www.google.com/recaptcha/",
        "https://www.recaptcha.net/recaptcha/",
        ...(authOrigin ? [authOrigin] : []),
      ],
      "manifest-src": ["'self'"],
    },
  };
}

app.use(
  helmet({
    contentSecurityPolicy: env.security.strictCsp
      ? contentSecurityPolicy()
      : false,
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: "no-referrer" },
    frameguard: { action: "deny" },
    hsts:
      env.nodeEnv === "production"
        ? { maxAge: 31_536_000, includeSubDomains: true, preload: true }
        : false,
  }),
);
app.use(
  compression({
    filter(req, res) {
      const pathname = String(req.path || "");
      if (pathname.startsWith("/api") && pathname !== "/api/store/catalog")
        return false;
      if (pathname === "/admin/session/handoff") return false;
      return compression.filter(req, res);
    },
  }),
);
app.use(requestErrorObserver);
app.use(requestEnvelopeGuard);

app.use(publicLimiter);

app.post(
  "/admin/session/handoff",
  adminAuthLimiter,
  express.urlencoded({
    extended: false,
    limit: "2kb",
    parameterLimit: 2,
    inflate: false,
  }),
  bodySafetyGuard,
  async (req, res) => {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
    try {
      const sourceOrigin = env.normalizeOrigin(req.headers.origin || "");
      const contentType = String(req.headers["content-type"] || "");
      if (
        !trustedOrigin(req) ||
        !sourceOrigin ||
        !/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(contentType)
      ) {
        throw Object.assign(new Error("ADMIN_HANDOFF_ORIGIN_INVALID"), {
          code: "ADMIN_HANDOFF_ORIGIN_INVALID",
          statusCode: 403,
        });
      }
      if (
        Object.keys(req.body || {}).length !== 1 ||
        typeof req.body?.handoffCode !== "string"
      ) {
        throw Object.assign(new Error("ADMIN_HANDOFF_INVALID"), {
          code: "ADMIN_HANDOFF_INVALID",
          statusCode: 401,
        });
      }
      const handoff = await consumeAdminHandoff({
        code: req.body.handoffCode,
        sourceOrigin,
      });
      const { auth } = initFirebaseAdmin();
      if (!auth)
        throw Object.assign(new Error("AUTH_UNAVAILABLE"), {
          code: "AUTH_UNAVAILABLE",
          statusCode: 503,
        });
      const decoded = await auth.verifySessionCookie(
        handoff.sessionCookie,
        true,
      );
      const uid = String(decoded?.uid || decoded?.sub || "").trim();
      const email = String(decoded?.email || "")
        .trim()
        .toLowerCase();
      const account = await auth.getUser(uid);
      if (account?.emailVerified !== true)
        throw Object.assign(new Error("ADMIN_VERIFIED_EMAIL_REQUIRED"), {
          code: "ADMIN_VERIFIED_EMAIL_REQUIRED",
          statusCode: 403,
        });
      const policy = await resolveStaffPolicy(uid, email);
      if (
        uid !== handoff.uid ||
        email !== handoff.email ||
        account?.disabled === true ||
        String(account?.email || "")
          .trim()
          .toLowerCase() !== email ||
        !policy ||
        !(await isAdminSessionActive({
          uid,
          email,
          session: handoff.gateSession,
        }))
      ) {
        throw Object.assign(new Error("ADMIN_GATE_ACCESS_INVALID"), {
          code: "ADMIN_GATE_ACCESS_INVALID",
          statusCode: 401,
        });
      }
      req.user = { ...decoded, uid, email };
      req.adminPolicy = policy;
      await writeAdminAudit(req, "admin.gate.handoff.complete", {
        sourceOrigin,
        transport: "single-use-first-party-post",
        accessMode: "httpOnly-cookie",
      });
      res.setHeader("Set-Cookie", [
        sessionCookieHeader(handoff.sessionCookie, false),
        adminAccessCookie(handoff.accessToken),
        clearAdminGateFactorCookie(),
        clearAdminBlockCookie(),
      ]);
      return res
        .status(200)
        .type("html")
        .send(adminHandoffPage({ success: true }));
    } catch (error) {
      const status = Math.max(
        400,
        Math.min(503, Number(error?.statusCode || error?.status || 401) || 401),
      );
      const code = String(error?.code || "ADMIN_HANDOFF_INVALID")
        .replace(/[^A-Z0-9_]/gi, "")
        .slice(0, 80);
      const messages = {
        ADMIN_HANDOFF_EXPIRED:
          "Güvenli geçişin kısa süresi doldu. Yönetici girişindeki son adımı yeniden deneyin.",
        ADMIN_HANDOFF_REPLAY:
          "Bu güvenli geçiş daha önce kullanıldı. Yönetici girişinden yeni bir geçiş başlatın.",
        ADMIN_HANDOFF_ORIGIN_INVALID:
          "Bu alan adından yönetici geçişine güvenlik nedeniyle izin verilmedi.",
        ADMIN_GATE_ACCESS_INVALID:
          "Yönetici hesabı veya erişim oturumu artık geçerli değil.",
        ADMIN_AUDIT_FAILED: "Zorunlu yönetici güvenlik kaydı oluşturulamadı.",
        ADMIN_AUDIT_UNAVAILABLE:
          "Zorunlu yönetici güvenlik kaydı şu anda kullanılamıyor.",
      };
      res.locals.errorCode = code;
      res.locals.requestError = error;
      return res
        .status(status)
        .type("html")
        .send(
          adminHandoffPage({
            message:
              messages[code] ||
              "Güvenli yönetici geçişi doğrulanamadı. Lütfen yönetici girişinden yeniden deneyin.",
            code,
          }),
        );
    }
  },
);

require("./server/email/routes").register(app, express);
app.use("/api", cors(corsOptions));
app.options("/api/*", cors(corsOptions));
app.use("/api", apiLimiter);
app.use("/api", apiRequestGuard);
app.use("/api", appCheckGuard);
app.use(
  "/api/admin/store/products/bulk",
  express.json({ limit: "1mb", strict: true, inflate: false }),
);
app.post(
  "/api/admin/store/products",
  express.json({ limit: "2mb", strict: true, inflate: false }),
);
app.patch(
  "/api/admin/store/products/:productId",
  express.json({ limit: "2mb", strict: true, inflate: false }),
);
app.post(
  "/api/admin/store/commerce/products/:id/images",
  express.json({ limit: "2mb", strict: true, inflate: false }),
);
app.use("/api", express.json({ limit: "256kb", strict: true, inflate: false }));
app.use("/api", bodySafetyGuard);
app.use("/api", apiClientGuard);
app.use("/api", apiBodyContract);
app.use("/api", sensitiveConfigurationGuard);

app.get("/healthz", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    ok: true,
    release: require("./server/core/releaseIdentity").releaseIdentity(),
  });
});
const readinessResponse = async (_req, res, next) => {
  try {
    const status = await connectionReadiness();
    res.setHeader("Cache-Control", "no-store");
    const release = require("./server/core/releaseIdentity").releaseIdentity(),
      commerce = status.ready
        ? await require("./server/commerce/readiness").readiness()
        : { ready: false },
      ready =
        status.ready &&
        commerce.ready &&
        (process.env.NODE_ENV !== "production" || release.buildVerified);
    res.status(ready ? 200 : 503).json({ ok: ready, release });
  } catch (error) {
    next(error);
  }
};
app.get("/readyz", readinessResponse);
app.get("/api/healthz", readinessResponse);

app.use("/api", authRouter);
app.use("/api", identityRouter);
app.use("/api", emailVerificationRouter);
app.use("/api", adminAuthRouter);
app.use("/api", storeRouter);

const staticOptions = {
  etag: true,
  maxAge: env.nodeEnv === "production" ? "1h" : 0,
  immutable: false,
  dotfiles: "ignore",
  fallthrough: false,
};

function cacheVersionedAsset(req, res, next) {
  if (
    env.nodeEnv === "production" &&
    /^[A-Za-z0-9._-]{1,48}$/.test(String(req.query?.v || ""))
  ) {
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  }
  next();
}

function sendVersionedFile(req, res, filename) {
  if (
    env.nodeEnv === "production" &&
    /^[A-Za-z0-9._-]{1,48}$/.test(String(req.query?.v || ""))
  ) {
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  } else {
    res.setHeader(
      "Cache-Control",
      env.nodeEnv === "production"
        ? "public, max-age=3600, must-revalidate"
        : "no-cache",
    );
  }
  return res.sendFile(filename);
}

app.use(
  "/public",
  cacheVersionedAsset,
  express.static(path.join(root, "public"), staticOptions),
);
app.get(
  ["/admin", "/admin/", "/admin/index.html", "/admin/admin.html"],
  (req, res, next) => {
    if (env.nodeEnv !== "production") return next();
    const canonical = env.canonicalOrigin || env.publicBaseUrl;
    const canonicalHost = canonical && new URL(canonical).host.toLowerCase();
    const currentHost = String(req.headers.host || "").toLowerCase();
    if (
      canonicalHost &&
      (currentHost !== canonicalHost ||
        (req.path === "/admin/admin.html" && req.query.view !== "v90") ||
        req.path === "/admin")
    ) {
      res.setHeader("Cache-Control", "no-store, max-age=0");
      return res.redirect(
        302,
        `${canonical}${req.path === "/admin/index.html" ? "/admin/index.html" : "/admin/"}`,
      );
    }
    next();
  },
);
app.get("/admin", (req, res, next) =>
  req.path === "/admin" ? res.redirect(302, "/admin/") : next(),
);
app.get(["/admin/", "/admin/index.html"], (_req, res) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  return res.sendFile(path.join(root, "admin", "index.html"));
});
app.get("/admin/admin.html", (req, res) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  return req.query.view === "v90" ? res.sendFile(path.join(root, "admin", "admin.html")) : res.redirect(302, "/admin/");
});
app.get(["/admin/session/handoff", "/admin/session/handoff/"], (_req, res) =>
  res.redirect(302, "/admin/"),
);
const adminAssetAllowlist = new Set([
  "admin-audit.js",
  "notification-templates.js",
  "product-appearance.js",
  "admin-auth.js",
  "admin-browser-session.js",
  "admin-core.js",
  "admin-dashboard.css",
  "admin-dashboard.js",
  "admin-dialogs.js",
  "admin-entry.js",
  "admin-gate.css",
  "admin-gate.js",
  "admin-legacy-entry.js",
  "admin-links.js",
  "admin-maintenance.js",
  "admin-operations.css",
  "admin-security.js",
  "commerce.js",
  "inventory-model.mjs",
  "inventory-view.mjs",
  "layout.mjs",
  "metrics.mjs",
  "portal.js",
  "product-editor.mjs",
  "product-image-upload.js",
  "product-model.mjs",
  "product-policy.mjs",
  "product-view.mjs",
  "promo-codes.js",
  "supplier-view.mjs",
  "wallet-model.mjs",
  "wallet-view.mjs",
  "wallet.js",
  "workspace.js",
  "zentra-admin.css"
]);
app.get("/admin/:asset", (req, res, next) => {
  const asset = String(req.params.asset || "");
  if (!adminAssetAllowlist.has(asset)) return next();
  return sendVersionedFile(req, res, path.join(root, "admin", asset));
});
app.get("/store-pages.html", (req, res) => { res.setHeader("Cache-Control", "no-store"); res.sendFile(path.join(root, "store-pages.html")); });
app.get(["/style.css", "/script.js"], (req, res) => sendVersionedFile(req, res, path.join(root, req.path.slice(1))));
app.get(["/", "/index.html"], (req, res, next) => {
  if (Object.hasOwn(req.query, "devam")) return next();
  res.setHeader("Cache-Control", "no-cache, max-age=0, must-revalidate");
  return res.sendFile(path.join(root, "index.html"));
});
app.get(["/favicon.ico", "/apple-touch-icon.png"], (req, res) => {
  const filename = req.path.includes("apple")
    ? "apple-touch-icon.png"
    : "favicon.ico";
  res.sendFile(path.join(root, "public", "assets", "images", filename), {
    maxAge: staticOptions.maxAge,
  });
});
app.get("/sw.js", (_req, res) => {
  res.setHeader("Service-Worker-Allowed", "/");
  res.setHeader("Cache-Control", "no-cache");
  res.type("application/javascript").sendFile(path.join(root, "sw.js"));
});
app.get(["/offline.html", "/unavailable.html", "/sifre-yenile.html"], (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.sendFile(path.join(root, req.path.slice(1)));
});
app.get(
  [
    "/",
    "/index.html",
    "/magaza",
    "/kategori/:category",
    "/urun/:productId",
    "/sepet",
    "/hesabim",
    "/siparisler",
    "/favoriler",
    "/destek",
    "/kuponlar",
    "/promosyonlar",
    "/bildirimler",
  ],
  require("./server/core/storefrontSeo").servePage,
);
app.get("/robots.txt", require("./server/core/storefrontSeo").robots);
app.get("/sitemap.xml", require("./server/core/storefrontSeo").sitemap);

app.use("/api", (_req, res) =>
  res.status(404).json({ ok: false, error: "API_ROUTE_NOT_FOUND" }),
);
app.use((_req, res) => {
  return require("./server/core/storefrontPages").sendMissing(res);
});

app.use((error, req, res, _next) => {
  const parserCode =
    error?.type === "entity.parse.failed"
      ? "INVALID_JSON"
      : error?.type === "entity.too.large"
        ? "REQUEST_BODY_TOO_LARGE"
        : "";
  const parserStatus =
    parserCode === "INVALID_JSON"
      ? 400
      : parserCode === "REQUEST_BODY_TOO_LARGE"
        ? 413
        : 0;
  const status =
    parserStatus ||
    Math.max(
      400,
      Math.min(599, Number(error?.statusCode || error?.status || 500) || 500),
    );
  const code = String(
    parserCode ||
      error?.code ||
      (status >= 500 ? "SERVER_ERROR" : "REQUEST_REJECTED"),
  )
    .replace(/[^A-Z0-9_:-]/gi, "")
    .slice(0, 80);
  const publicMessages = {
    INVALID_JSON:
      "Gönderilen bilgiler okunamadı. Lütfen alanları kontrol edip tekrar deneyin.",
    REQUEST_BODY_TOO_LARGE:
      "Gönderilen bilgi boyutu izin verilen sınırı aşıyor.",
  };
  res.locals.errorCode = code;
  res.locals.requestError = error;
  if (res.headersSent) return _next(error);
  const message =
    publicMessages[code] ||
    (code === "COMMERCE_MAINTENANCE" ? error.publicMessage : "");
  if (status >= 500 || [401, 403, 429].includes(status))
    require("./server/commerce/analytics").alert(
      code,
      String(req.route?.path || req.path || "").slice(0, 200),
      status,
    );
  if (
    status >= 500 &&
    ["GET", "HEAD"].includes(req.method) &&
    !/^\/api(?:\/|$)/.test(req.path) &&
    /text\/html/i.test(req.get("accept") || "")
  )
    return require("./server/core/storefrontPages").sendUnavailable(
      res,
      status,
    );
  return res.status(status).json({
    ok: false,
    error: code,
    code,
    ...(message ? { message } : {}),
    requestId: req.requestId,
  });
});

let server = null;

function startServer() {
  if (server) return server;
  for (const eventName of ["uncaughtException", "unhandledRejection"]) {
    process.once(eventName, (cause) => {
      logError(cause, { event: eventName, code: "PROCESS_FATAL" });
      process.exitCode = 1;
      if (server) shutdown(eventName);
      else process.exit(1);
    });
  }
  server = configureHttpServer(
    app.listen(port, host, () => {
      const report = env.configurationReport();
      if (!report.ready)
        logError(null, {
          event: "configuration",
          code: "CONFIGURATION_INCOMPLETE",
          missing: report.missing,
        });
    }),
  );

  require("./server/core/firestoreIndexService").start();
  require("./server/commerce/worker").start();
  startRestockWorker();
  startMaintenanceWorker();
  require("./server/core/telegramNotifications").start();
  require("./server/email/service").start();
  require("./server/email/announcements").worker.start();
  require("./server/core/productDeletion").worker.start();
  require("./server/core/accountRecoveryService").worker.start();
  require("./server/core/emailVerificationService").worker.start();
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
  return server;
}

function shutdown(signal) {
  require("./server/core/firestoreIndexService").stop();
  require("./server/commerce/worker").stop();
  stopRestockWorker();
  stopMaintenanceWorker();
  require("./server/core/telegramNotifications").stop();
  require("./server/email/service").stop();
  require("./server/email/announcements").worker.stop();
  require("./server/core/productDeletion").worker.stop();
  require("./server/core/accountRecoveryService").worker.stop();
  require("./server/core/emailVerificationService").worker.stop();
  if (!server) return;
  server.close(() => process.exit(process.exitCode || 0));
  server.closeIdleConnections?.();
  setTimeout(() => {
    server.closeAllConnections?.();
    process.exit(1);
  }, 10_000).unref();
}

if (require.main === module) startServer();

module.exports = {
  app,
  startServer,
  get server() {
    return server;
  },
};
