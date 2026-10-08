'use strict';

const path = require('path');
const express = require('express');
const compression = require('compression');
const helmet = require('helmet');
const cors = require('cors');
const env = require('./server/config/env');
const { corsOptions } = require('./server/config/cors');
const { initFirebaseAdmin } = require('./server/config/firebaseAdmin');
const { publicLimiter, apiLimiter, adminAuthLimiter, appCheckGuard, isAdminPrincipal } = require('./server/core/security');
const { requestEnvelopeGuard, apiRequestGuard, bodySafetyGuard, configureHttpServer } = require('./server/core/requestSecurity');
const { trustedOrigin, verifyUserSession, sessionCookieHeader } = require('./server/core/userSessionService');
const {
  adminAccessCookie,
  clearAdminAccessCookie,
  clearAdminGateFactorCookie,
  getRequestAdminAccessToken,
  readAdminAccess
} = require('./server/core/adminAccessService');
const { isAdminSessionActive } = require('./server/core/adminSessionRegistry');
const { consumeAdminHandoff } = require('./server/core/adminHandoffService');
const { resolveStaffPolicy } = require('./server/core/adminStoreService');
const { writeAdminAudit } = require('./server/core/adminReauthService');
const { scheduleCatalogRetirementCleanup } = require('./server/core/storeCatalogCleanupService');
const authRouter = require('./server/routes/auth.routes');
const identityRouter = require('./server/routes/identity.routes');
const adminAuthRouter = require('./server/routes/admin-auth.routes');
const storeRouter = require('./server/routes/store.routes');

const app = express();
const root = __dirname;
const port = Math.max(1, Number(process.env.PORT || 10000) || 10000);
const host = '0.0.0.0';


const ADMIN_ENTRY_BLOCK_COOKIE = env.nodeEnv === 'production' ? '__Host-zentra_admin_block' : 'zentra_admin_block';
const ADMIN_ENTRY_BLOCK_SECONDS = 5 * 60;

function readCookie(req, name) {
  return String(req?.headers?.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1) || '';
}

function adminBlockCookie() {
  const secure = env.nodeEnv === 'production' ? '; Secure' : '';
  return `${ADMIN_ENTRY_BLOCK_COOKIE}=1; Path=/; HttpOnly; SameSite=Strict; Priority=High${secure}; Max-Age=${ADMIN_ENTRY_BLOCK_SECONDS}`;
}

function clearAdminBlockCookie() {
  const secure = env.nodeEnv === 'production' ? '; Secure' : '';
  return `${ADMIN_ENTRY_BLOCK_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Priority=High${secure}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function adminHandoffPage({ success = false, message = '', code = '' } = {}) {
  const destination = success ? '/admin/admin.html' : `${env.canonicalOrigin || env.publicBaseUrl}/admin/index.html`;
  const safeMessage = escapeHtml(message || (success
    ? 'Güvenli yönetici oturumu doğrulandı. Yönetim merkezi açılıyor.'
    : 'Güvenli yönetici geçişi tamamlanamadı. Lütfen son doğrulama adımını yeniden deneyin.'));
  const safeCode = escapeHtml(code);
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8" />\n`
    + `<meta name="viewport" content="width=device-width, initial-scale=0.85, minimum-scale=0.85, maximum-scale=5, user-scalable=yes, viewport-fit=cover" />\n`
    + `<meta name="color-scheme" content="dark" />\n`
    + `<meta name="theme-color" content="#070304" />\n`
    + `<meta name="robots" content="noindex, nofollow, noarchive" />\n`
    + (success ? '<meta http-equiv="refresh" content="0;url=/admin/admin.html" />\n' : '')
    + '<title>ZENTRA STORE | Güvenli Yönetici Oturumu</title>\n'
    + '<link rel="stylesheet" href="/public/css/admin-handoff.css?v=zentra-20261008-v1" /><link rel="stylesheet" href="/public/css/interaction-guard.css?v=zentra-20261008-v1" /></head><body>'
    + '<main class="gate"><div class="brand"><img src="/public/assets/images/zentra-mark.webp?v=brand-v67" alt="" /><span><b>ZENTRA STORE</b><small>GÜVENLİ YÖNETİCİ GEÇİŞİ</small></span></div>'
    + `<span class="status ${success ? 'is-success' : 'is-error'}" aria-hidden="true">${success ? '✓' : '!'}</span><span class="eyebrow">${success ? 'OTURUM DOĞRULANDI' : 'ERİŞİM DENETİMİ'}</span>`
    + `<h1>${success ? 'Yönetim merkezi açılıyor' : 'Güvenli geçiş tamamlanamadı'}</h1>`
    + `<p>${safeMessage}</p><a href="${escapeHtml(destination)}">${success ? 'Yönetim paneline devam et' : 'Yönetici girişine dön'} <span aria-hidden="true">→</span></a>`
    + (safeCode ? `<small>İşlem kodu: ${safeCode}</small>` : '')
    + '</main><script type="module" src="/public/js/ui/interaction-guard-entry.js?v=zentra-20261008-v1"></script></body></html>';
}

function redirectToStorefront(res, { block = false } = {}) {
  const cookies = [clearAdminAccessCookie()];
  if (block) cookies.push(adminBlockCookie());
  res.setHeader('Set-Cookie', cookies);
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  return res.redirect(302, `${env.canonicalOrigin || env.publicBaseUrl || '/'}${String(env.canonicalOrigin || env.publicBaseUrl || '').endsWith('/') ? '' : '/'}`);
}

async function requireActiveAdminEntry(req, res, next) {
  try {
    if (readCookie(req, ADMIN_ENTRY_BLOCK_COOKIE)) return redirectToStorefront(res);
    const session = await verifyUserSession(req, { checkRevoked: true });
    const uid = String(session?.uid || '').trim();
    const email = String(session?.email || '').trim().toLowerCase();
    if (!uid || !email || !(await isAdminPrincipal(uid, email))) return redirectToStorefront(res, { block: true });
    req.activeAdminIdentity = { uid, email };
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return await next();
  } catch (error) {
    return next(error);
  }
}

async function requireAdminDashboardEntry(req, res, next) {
  return requireActiveAdminEntry(req, res, async () => {
    const access = readAdminAccess(getRequestAdminAccessToken(req));
    const uid = String(access?.uid || '').trim();
    const email = String(access?.email || '').trim().toLowerCase();
    const activeUid = String(req.activeAdminIdentity?.uid || '').trim();
    const activeEmail = String(req.activeAdminIdentity?.email || '').trim().toLowerCase();
    if (!uid || !email || uid !== activeUid || email !== activeEmail
      || !(await isAdminSessionActive({ uid, email, session: access.gateSession }))) return res.redirect(302, '/admin/index.html');
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return next();
  });
}

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.set('query parser', 'simple');
app.set('etag', false);
app.set('json escape', true);
initFirebaseAdmin();

function contentSecurityPolicy() {
  const connect = [
    "'self'",
    env.serviceOrigin,
    env.publicApiBase,
    env.publicBaseUrl,
    'https://www.gstatic.com',
    'https://identitytoolkit.googleapis.com',
    'https://securetoken.googleapis.com',
    'https://www.googleapis.com',
    'https://www.google.com',
    'https://www.recaptcha.net',
    'https://*.googleapis.com'
  ].filter(Boolean);
  return {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      'base-uri': ["'self'"],
      'object-src': ["'none'"],
      'frame-ancestors': ["'none'"],
      'form-action': ["'self'"],
      'script-src': ["'self'", 'https://www.gstatic.com', 'https://www.google.com', 'https://www.recaptcha.net'],
      'script-src-attr': ["'none'"],
      'style-src': ["'self'", 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
      'style-src-attr': ["'unsafe-inline'"],
      'img-src': ["'self'", 'data:', 'blob:', 'https://encrypted-tbn0.gstatic.com', 'https://firebasestorage.googleapis.com'],
      'font-src': ["'self'", 'data:', 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com'],
      'connect-src': [...new Set(connect)],
      'media-src': ["'self'"],
      'worker-src': ["'self'", 'blob:'],
      'frame-src': ["'self'", 'https://www.google.com', 'https://www.recaptcha.net'],
      'manifest-src': ["'self'"]
    }
  };
}

app.use(helmet({
  contentSecurityPolicy: env.security.strictCsp ? contentSecurityPolicy() : false,
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  frameguard: { action: 'deny' },
  hsts: env.nodeEnv === 'production' ? { maxAge: 31_536_000, includeSubDomains: true, preload: true } : false
}));
app.use(compression({
  filter(req, res) {
    const pathname = String(req.path || '');
    if (pathname.startsWith('/api') && pathname !== '/api/store/catalog') return false;
    if (pathname === '/admin/session/handoff') return false;
    return compression.filter(req, res);
  }
}));
app.use(requestEnvelopeGuard);
// Render application logs contain failures only. Never log bodies, credentials, tokens or raw URLs.
app.use((req, res, next) => {
  res.once('finish', () => {
    if (res.statusCode < 400) return;
    const code = String(res.locals.errorCode || (res.statusCode >= 500 ? 'SERVER_ERROR' : 'HTTP_REJECTED'));
    console.error('[zentra-store:error]', JSON.stringify({
      status: res.statusCode,
      method: req.method,
      path: String(req.route?.path || req.path || '/').replace(/[\u0000-\u001F\u007F<>]/g, '').slice(0, 140),
      code: code.replace(/[^A-Z0-9_:-]/gi, '').slice(0, 80),
      requestId: req.requestId
    }));
  });
  next();
});

app.use(publicLimiter);

app.post('/admin/session/handoff', adminAuthLimiter, express.urlencoded({
  extended: false,
  limit: '2kb',
  parameterLimit: 2,
  inflate: false
}), bodySafetyGuard, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  try {
    const sourceOrigin = env.normalizeOrigin(req.headers.origin || '');
    const contentType = String(req.headers['content-type'] || '');
    if (!trustedOrigin(req) || !sourceOrigin || !/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(contentType)) {
      throw Object.assign(new Error('ADMIN_HANDOFF_ORIGIN_INVALID'), { code: 'ADMIN_HANDOFF_ORIGIN_INVALID', statusCode: 403 });
    }
    if (Object.keys(req.body || {}).length !== 1 || typeof req.body?.handoffCode !== 'string') {
      throw Object.assign(new Error('ADMIN_HANDOFF_INVALID'), { code: 'ADMIN_HANDOFF_INVALID', statusCode: 401 });
    }
    const handoff = await consumeAdminHandoff({ code: req.body.handoffCode, sourceOrigin });
    const { auth } = initFirebaseAdmin();
    if (!auth) throw Object.assign(new Error('AUTH_UNAVAILABLE'), { code: 'AUTH_UNAVAILABLE', statusCode: 503 });
    const decoded = await auth.verifySessionCookie(handoff.sessionCookie, true);
    const uid = String(decoded?.uid || decoded?.sub || '').trim();
    const email = String(decoded?.email || '').trim().toLowerCase();
    const account = await auth.getUser(uid);
    if (account?.emailVerified !== true) throw Object.assign(new Error('ADMIN_VERIFIED_EMAIL_REQUIRED'), { code: 'ADMIN_VERIFIED_EMAIL_REQUIRED', statusCode: 403 });
    const policy = await resolveStaffPolicy(uid, email);
    if (uid !== handoff.uid || email !== handoff.email || account?.disabled === true
      || String(account?.email || '').trim().toLowerCase() !== email || !policy
      || !(await isAdminSessionActive({ uid, email, session: handoff.gateSession }))) {
      throw Object.assign(new Error('ADMIN_GATE_ACCESS_INVALID'), { code: 'ADMIN_GATE_ACCESS_INVALID', statusCode: 401 });
    }
    req.user = { ...decoded, uid, email };
    req.adminPolicy = policy;
    await writeAdminAudit(req, 'admin.gate.handoff.complete', {
      sourceOrigin,
      transport: 'single-use-first-party-post',
      accessMode: 'httpOnly-cookie'
    });
    res.setHeader('Set-Cookie', [
      sessionCookieHeader(handoff.sessionCookie, false),
      adminAccessCookie(handoff.accessToken),
      clearAdminGateFactorCookie(),
      clearAdminBlockCookie()
    ]);
    return res.status(200).type('html').send(adminHandoffPage({ success: true }));
  } catch (error) {
    const status = Math.max(400, Math.min(503, Number(error?.statusCode || error?.status || 401) || 401));
    const code = String(error?.code || 'ADMIN_HANDOFF_INVALID').replace(/[^A-Z0-9_]/gi, '').slice(0, 80);
    const messages = {
      ADMIN_HANDOFF_EXPIRED: 'Güvenli geçişin kısa süresi doldu. Yönetici girişindeki son adımı yeniden deneyin.',
      ADMIN_HANDOFF_REPLAY: 'Bu güvenli geçiş daha önce kullanıldı. Yönetici girişinden yeni bir geçiş başlatın.',
      ADMIN_HANDOFF_ORIGIN_INVALID: 'Bu alan adından yönetici geçişine güvenlik nedeniyle izin verilmedi.',
      ADMIN_GATE_ACCESS_INVALID: 'Yönetici hesabı veya erişim oturumu artık geçerli değil.',
      ADMIN_AUDIT_FAILED: 'Zorunlu yönetici güvenlik kaydı oluşturulamadı.',
      ADMIN_AUDIT_UNAVAILABLE: 'Zorunlu yönetici güvenlik kaydı şu anda kullanılamıyor.'
    };
    return res.status(status).type('html').send(adminHandoffPage({
      message: messages[code] || 'Güvenli yönetici geçişi doğrulanamadı. Lütfen yönetici girişinden yeniden deneyin.',
      code
    }));
  }
});

app.use('/api', cors(corsOptions));
app.options('/api/*', cors(corsOptions));
app.use('/api', apiLimiter);
app.use('/api', apiRequestGuard);
app.use('/api', appCheckGuard);
app.use('/api/admin/store/products/image', express.json({ limit: '1200kb', strict: true, inflate: false }));
app.use('/api', express.json({ limit: '256kb', strict: true, inflate: false }));
app.use('/api', bodySafetyGuard);

app.get('/healthz', (_req, res) => {
  res.status(200).json({ ok: true });
});
app.get('/readyz', (_req, res) => {
  const firebase = initFirebaseAdmin();
  const configuration = env.configurationReport();
  const ready = firebase.enabled === true && configuration.ready === true;
  res.status(ready ? 200 : 503).json({ ok: ready });
});
app.get('/api/healthz', (_req, res) => {
  const firebase = initFirebaseAdmin();
  const configuration = env.configurationReport();
  const ready = firebase.enabled && configuration.ready;
  res.status(ready ? 200 : 503).json({ ok: ready });
});

app.use('/api', authRouter);
app.use('/api', identityRouter);
app.use('/api', adminAuthRouter);
app.use('/api', storeRouter);

const staticOptions = {
  etag: true,
  maxAge: env.nodeEnv === 'production' ? '1h' : 0,
  immutable: false,
  dotfiles: 'ignore',
  fallthrough: false
};

function cacheVersionedAsset(req, res, next) {
  if (env.nodeEnv === 'production' && /^[A-Za-z0-9._-]{1,48}$/.test(String(req.query?.v || ''))) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
  next();
}

function sendVersionedFile(req, res, filename) {
  if (env.nodeEnv === 'production' && /^[A-Za-z0-9._-]{1,48}$/.test(String(req.query?.v || ''))) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  } else {
    res.setHeader('Cache-Control', env.nodeEnv === 'production' ? 'public, max-age=3600, must-revalidate' : 'no-cache');
  }
  return res.sendFile(filename);
}

app.use('/public', cacheVersionedAsset, express.static(path.join(root, 'public'), staticOptions));
app.get(['/admin', '/admin/', '/admin/index.html'], requireActiveAdminEntry, (_req, res) => res.sendFile(path.join(root, 'admin', 'index.html')));
app.get('/admin/admin.html', requireAdminDashboardEntry, (_req, res) => res.sendFile(path.join(root, 'admin', 'admin.html')));
const adminAssetAllowlist = new Set([
  'admin-auth.js', 'admin-core.js', 'admin-dashboard.css', 'admin-dashboard.js',
  'admin-gate.css', 'admin-gate.js'
]);
app.get('/admin/:asset', (req, res, next) => {
  const asset = String(req.params.asset || '');
  if (!adminAssetAllowlist.has(asset)) return next();
  return sendVersionedFile(req, res, path.join(root, 'admin', asset));
});
app.get('/style.css', (req, res) => sendVersionedFile(req, res, path.join(root, 'style.css')));
app.get('/script.js', (req, res) => sendVersionedFile(req, res, path.join(root, 'script.js')));
app.get(['/favicon.ico', '/apple-touch-icon.png'], (req, res) => {
  const filename = req.path.includes('apple') ? 'apple-touch-icon.png' : 'favicon.ico';
  res.sendFile(path.join(root, 'public', 'assets', 'images', filename), { maxAge: staticOptions.maxAge });
});
app.get(['/', '/index.html'], (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, max-age=0, must-revalidate');
  return res.sendFile(path.join(root, 'index.html'));
});

app.use('/api', (_req, res) => res.status(404).json({ ok: false, error: 'API_ROUTE_NOT_FOUND' }));
app.use((_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, max-age=0, must-revalidate');
  return res.status(404).sendFile(path.join(root, 'index.html'));
});

app.use((error, req, res, _next) => {
  const parserCode = error?.type === 'entity.parse.failed'
    ? 'INVALID_JSON'
    : error?.type === 'entity.too.large'
      ? 'REQUEST_BODY_TOO_LARGE'
      : '';
  const parserStatus = parserCode === 'INVALID_JSON' ? 400 : parserCode === 'REQUEST_BODY_TOO_LARGE' ? 413 : 0;
  const status = parserStatus || Math.max(400, Math.min(599, Number(error?.statusCode || error?.status || 500) || 500));
  const code = String(parserCode || error?.code || (status >= 500 ? 'SERVER_ERROR' : 'REQUEST_REJECTED')).replace(/[^A-Z0-9_:-]/gi, '').slice(0, 80);
  const publicMessages = {
    INVALID_JSON: 'Gönderilen bilgiler okunamadı. Lütfen alanları kontrol edip tekrar deneyin.',
    REQUEST_BODY_TOO_LARGE: 'Gönderilen bilgi boyutu izin verilen sınırı aşıyor.'
  };
  res.locals.errorCode = code;
  const message = publicMessages[code];
  return res.status(status).json({ ok: false, error: code, code, ...(message ? { message } : {}), requestId: req.requestId });
});

let server = null;

function startServer() {
  if (server) return server;
  server = configureHttpServer(app.listen(port, host, () => {
    const report = env.configurationReport();
    if (!report.ready) console.error('[zentra-store:configuration]', JSON.stringify({ code: 'CONFIGURATION_INCOMPLETE', missing: report.missing }));
  }));

  setImmediate(() => {
    scheduleCatalogRetirementCleanup()
      .then((report) => {
        // Retired products are retained until an authorized catalog cleanup.
      })
      .catch(() => console.error('[zentra-store] Katalog bakım raporu okunamadı; otomatik silme yapılmadı.'));
  });
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
  return server;
}

function shutdown(signal) {
  if (!server) return;
  server.close(() => process.exit(0));
  server.closeIdleConnections?.();
  setTimeout(() => {
    server.closeAllConnections?.();
    process.exit(1);
  }, 10_000).unref();
}

if (require.main === module) startServer();

module.exports = { app, startServer, get server() { return server; } };
