'use strict';

const admin = require('firebase-admin');
const env = require('./env');

function parseServiceAccount(raw = '') {
  const value = String(raw || '').trim();
  if (!value || env.isPlaceholder(value)) return null;
  const normalize = (parsed) => {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (typeof parsed.private_key === 'string') parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
    const projectId = String(parsed.project_id || '').trim();
    const clientEmail = String(parsed.client_email || '').trim();
    const privateKey = String(parsed.private_key || '').trim();
    if (parsed.type !== 'service_account'
      || !projectId
      || env.isPlaceholder(projectId)
      || (env.firebase.projectId && projectId !== env.firebase.projectId)
      || !/^\S+@\S+\.iam\.gserviceaccount\.com$/i.test(clientEmail)
      || !privateKey.includes('-----BEGIN PRIVATE KEY-----')
      || !privateKey.includes('-----END PRIVATE KEY-----')
      || env.isPlaceholder(privateKey)) return null;
    return parsed;
  };
  try { return normalize(JSON.parse(value)); } catch (_) {}
  try { return normalize(JSON.parse(Buffer.from(value, 'base64').toString('utf8'))); } catch (_) {}
  return null;
}

let initialized = null;

function initFirebaseAdmin() {
  if (initialized) return initialized;
  const serviceAccount = parseServiceAccount(env.firebase.serviceAccount);
  if (!serviceAccount) {
    initialized = { admin, app: null, db: null, auth: null, appCheck: null, enabled: false };
    console.warn('[shelby-store] Firebase Admin yapılandırması bulunamadı.');
    return initialized;
  }
  try {
    const app = admin.apps.length ? admin.app() : admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: env.firebase.projectId || serviceAccount.project_id,
      storageBucket: env.firebase.storageBucket || undefined
    });
    initialized = {
      admin,
      app,
      db: admin.firestore(app),
      auth: admin.auth(app),
      appCheck: admin.appCheck(app),
      enabled: true
    };
    console.info('[shelby-store] Firebase Admin hazır.');
  } catch (_) {
    initialized = { admin, app: null, db: null, auth: null, appCheck: null, enabled: false };
    console.error('[shelby-store] Güvenli veri hizmeti başlatılamadı. Yapılandırmayı kontrol edin.');
  }
  return initialized;
}

module.exports = { initFirebaseAdmin };
