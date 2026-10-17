'use strict';

const env = require('../config/env');
const { initFirebaseAdmin } = require('../config/firebaseAdmin');
let cached = null, pending = null, probe = null;

async function connectionReadiness() {
  const now = Date.now();
  if (cached && now - cached.at < 15_000) return cached.value;
  if (pending) return pending;
  pending = (async () => {
    const configuration = env.configurationReport();
    const { db, auth, enabled } = initFirebaseAdmin();
    const configurationReady = configuration.capabilities?.identity ?? configuration.ready;
    if (!configurationReady || !enabled || !db || !auth) return { ready: false, configurationReady, storageReady: false, identityReady: false };
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ ready: false, configurationReady: true, storageReady: false, identityReady: false, timedOut: true }), 3000); timer.unref?.(); });
    try {
      const checks = probe || (probe = Promise.allSettled([
        Promise.resolve().then(() => db.collection('storeSecurityHealth').doc('readiness').get()),
        Promise.resolve().then(() => auth.getUser(env.adminUids[0] || '_zentra_readiness_probe_v1'))
      ]).then(([storage, identity]) => {
        const storageReady = storage.status === 'fulfilled';
        const user = identity.status === 'fulfilled' ? identity.value : null;
        const identityReady = !!user && user.disabled !== true && user.emailVerified === true
          && String(user.email || '').toLowerCase() === env.adminEmails[0];
        const providerReady = identity.status === 'fulfilled' || identity.reason?.code === 'auth/user-not-found';
        const connection = configuration.capabilities ? providerReady : identityReady;
        return { ready: storageReady && connection, configurationReady: true, storageReady, identityReady: connection,
          adminIdentityReady: identityReady, services: configuration.capabilities || {} };
      }).finally(() => { probe = null; }));
      return await Promise.race([checks, timeout]);
    } finally { clearTimeout(timer); }
  })().then((value) => { cached = { at: Date.now(), value }; return value; }).finally(() => { pending = null; });
  return pending;
}

function sensitiveConfigurationGuard(req, res, next) {
  const path = String(req.originalUrl || '').split('?')[0];
  const sensitive = !['GET', 'HEAD', 'OPTIONS'].includes(req.method)
    && /^\/api\/(?:admin\/(?:store\/|action-proof$)|store\/(?:orders$|balance-codes\/redeem$)|payments\/shopier\/create$)/.test(path);
  const configuration = env.configurationReport();
  const target = path === '/api/admin/action-proof' ? String(req.body?.path || '') : path;
  const admin = path.startsWith('/api/admin/');
  const vault = target.startsWith('/api/admin/store/inventory/') || target === '/api/store/orders' || target === '/api/payments/shopier/create' || /\/shopier\//.test(target);
  const ready = configuration.capabilities
    ? (admin ? configuration.capabilities.admin : configuration.capabilities.identity) && (!vault || configuration.capabilities.vault)
    : configuration.ready;
  if (env.nodeEnv === 'production' && sensitive && !ready) {
    return res.status(503).json({ ok: false, error: 'SERVICE_NOT_READY', message: 'Mağazanın güvenli işlem bağlantısı henüz hazır değil. İşlem uygulanmadı.', requestId: req.requestId });
  }
  return next();
}

module.exports = { connectionReadiness, sensitiveConfigurationGuard };
