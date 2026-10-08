'use strict';

const { version: packageVersion } = require('../../package.json');

const DEFAULT_SERVICE_ORIGIN = 'https://emirhan-siye.onrender.com';

function integer(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function list(value = '') {
  return String(value).split(',').map((item) => item.trim()).filter(Boolean);
}

function normalizeOrigin(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    return `${url.protocol}//${url.host}`;
  } catch (_) {
    return '';
  }
}

function unique(values = []) {
  return [...new Set(values.map(normalizeOrigin).filter(Boolean))];
}

function parseObject(value = '') {
  const raw = String(value || '').trim();
  if (!raw || isPlaceholder(raw)) return null;
  const candidates = [raw];
  try { candidates.push(Buffer.from(raw, 'base64').toString('utf8')); } catch (_) {}
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch (_) {}
  }
  return null;
}

function isPlaceholder(value = '') {
  const raw = String(value || '').trim();
  return !raw
    || /^<[^>]+>$/.test(raw)
    || /replace|example|change[_-]?me|your[_-]?|buraya|degistir|değiştir|mevcut_|yeni_|secret_buraya/i.test(raw);
}

function value(first = '', second = '', fallback = '') {
  return String(first || second || fallback || '').trim();
}

function strongSecret(secret = '') {
  const raw = String(secret || '').trim();
  if (raw.length < 64 || isPlaceholder(raw)) return false;
  const characters = new Map();
  for (const character of raw) characters.set(character, (characters.get(character) || 0) + 1);
  const entropy = [...characters.values()].reduce((total, count) => {
    const probability = count / raw.length;
    return total - probability * Math.log2(probability);
  }, 0);
  return characters.size >= 10 && entropy >= 3;
}

function keyId(value = '', fallback = 'vault-2026-v1') {
  const normalized = String(value || fallback || '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{1,63}$/.test(normalized) ? normalized : fallback;
}

function secretMap(value = '') {
  const parsed = parseObject(value) || {};
  const output = {};
  for (const [rawKey, rawSecret] of Object.entries(parsed)) {
    const id = keyId(rawKey, '');
    const secret = String(rawSecret || '').trim();
    if (id && strongSecret(secret)) output[id] = secret;
  }
  return output;
}

const serviceOrigin = normalizeOrigin(process.env.PUBLIC_BACKEND_ORIGIN || process.env.RENDER_EXTERNAL_URL || DEFAULT_SERVICE_ORIGIN);
const publicBaseUrl = normalizeOrigin(process.env.PUBLIC_BASE_URL || serviceOrigin);
const canonicalOrigin = normalizeOrigin(process.env.CANONICAL_ORIGIN || publicBaseUrl);
const publicApiBase = normalizeOrigin(process.env.PUBLIC_API_BASE || serviceOrigin);
const allowedOrigins = unique([
  serviceOrigin,
  publicBaseUrl,
  canonicalOrigin,
  publicApiBase,
  ...list(process.env.ALLOWED_ORIGINS)
]);

const structuredFirebaseConfig = parseObject(
  process.env.PUBLIC_FIREBASE_CONFIG ||
  process.env.FIREBASE_WEB_CONFIG ||
  process.env.FIREBASE_CONFIG
) || {};

const firebasePublicConfig = Object.freeze({
  apiKey: value(process.env.PUBLIC_FIREBASE_API_KEY, process.env.FIREBASE_WEB_API_KEY, structuredFirebaseConfig.apiKey),
  authDomain: value(process.env.PUBLIC_FIREBASE_AUTH_DOMAIN, process.env.FIREBASE_AUTH_DOMAIN, structuredFirebaseConfig.authDomain),
  projectId: value(process.env.PUBLIC_FIREBASE_PROJECT_ID, process.env.FIREBASE_PROJECT_ID, structuredFirebaseConfig.projectId),
  storageBucket: value(process.env.PUBLIC_FIREBASE_STORAGE_BUCKET, process.env.FIREBASE_STORAGE_BUCKET, structuredFirebaseConfig.storageBucket),
  messagingSenderId: value(process.env.PUBLIC_FIREBASE_MESSAGING_SENDER_ID, process.env.FIREBASE_MESSAGING_SENDER_ID, structuredFirebaseConfig.messagingSenderId),
  appId: value(process.env.PUBLIC_FIREBASE_APP_ID, process.env.FIREBASE_APP_ID, structuredFirebaseConfig.appId),
  measurementId: value(process.env.PUBLIC_FIREBASE_MEASUREMENT_ID, process.env.FIREBASE_MEASUREMENT_ID, structuredFirebaseConfig.measurementId)
});

const appCheckMode = ['off', 'monitor', 'enforce'].includes(String(process.env.APP_CHECK_MODE || '').trim().toLowerCase())
  ? String(process.env.APP_CHECK_MODE).trim().toLowerCase()
  : (process.env.NODE_ENV === 'development' ? 'monitor' : 'enforce');
const adminTotpMode = ['off', 'optional', 'required'].includes(String(process.env.ADMIN_TOTP_MODE || '').trim().toLowerCase())
  ? String(process.env.ADMIN_TOTP_MODE).trim().toLowerCase()
  : (process.env.NODE_ENV === 'development' ? 'optional' : 'required');
const adminTotpSecret = String(process.env.ADMIN_TOTP_SECRET_BASE32 || '').replace(/[\s=-]/g, '').toUpperCase();

const serviceAccount = value(
  process.env.FIREBASE_KEY,
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_SERVICE_ACCOUNT_JSON
);

const env = {
  nodeEnv: process.env.NODE_ENV || 'production',
  logLevel: process.env.LOG_LEVEL || 'info',
  serviceOrigin,
  publicBaseUrl,
  canonicalOrigin,
  publicApiBase,
  allowedOrigins,
  firebase: {
    projectId: value(process.env.FIREBASE_PROJECT_ID, firebasePublicConfig.projectId),
    storageBucket: value(process.env.FIREBASE_STORAGE_BUCKET, firebasePublicConfig.storageBucket),
    serviceAccount,
    publicConfig: firebasePublicConfig,
    appCheckSiteKey: value(process.env.PUBLIC_FIREBASE_APP_CHECK_SITE_KEY),
    appCheckMode,
    publicConfigSource: process.env.PUBLIC_FIREBASE_API_KEY ? 'environment' : (structuredFirebaseConfig.apiKey ? 'structured-environment' : 'missing')
  },
  adminEmails: list(process.env.ADMIN_EMAILS).map((email) => email.toLowerCase()),
  adminUids: list(process.env.ADMIN_UIDS),
  security: {
    adminMinimumScore: integer(process.env.ADMIN_SECURITY_MIN_SCORE, 90, 86, 100),
    adminSessionTtlMinutes: integer(process.env.ADMIN_SESSION_TTL_MINUTES, 120, 15, 720),
    strictCsp: process.env.SECURITY_CSP_STRICT !== '0',
    rateLimitStore: process.env.RATE_LIMIT_STORE === 'memory' ? 'memory' : 'firestore',
    sensitiveActionRecentAuthSeconds: integer(process.env.SENSITIVE_ACTION_RECENT_AUTH_SECONDS, 180, 60, 600),
    adminTotp: Object.freeze({
      mode: adminTotpMode,
      secret: adminTotpSecret,
      configured: /^[A-Z2-7]{26,128}$/.test(adminTotpSecret)
    })
  },
  storeKeys: (() => {
    const encryptionSecret = value(process.env.STORE_KEY_ENCRYPTION_SECRET);
    const fingerprintSecret = value(process.env.STORE_KEY_FINGERPRINT_SECRET);
    const activeKeyId = keyId(process.env.STORE_KEY_ACTIVE_KEY_ID, 'vault-2026-v1');
    const decryptionSecrets = secretMap(process.env.STORE_KEY_DECRYPTION_KEYS_JSON);
    const encryptionReady = strongSecret(encryptionSecret);
    const fingerprintReady = strongSecret(fingerprintSecret);
    const distinct = encryptionSecret !== fingerprintSecret;
    if (encryptionReady) {
      decryptionSecrets[activeKeyId] = encryptionSecret;
      if (activeKeyId !== 'legacy-v1' && !decryptionSecrets['legacy-v1']) decryptionSecrets['legacy-v1'] = encryptionSecret;
    }
    return {
      encryptionSecret,
      fingerprintSecret,
      activeKeyId,
      decryptionSecrets: Object.freeze({ ...decryptionSecrets }),
      encryptionReady,
      fingerprintReady,
      distinct,
      configured: encryptionReady && fingerprintReady && distinct
    };
  })()
};

function publicRuntimeConfig() {
  return {
    apiBase: env.publicApiBase,
    canonicalOrigin: env.canonicalOrigin,
    publicBaseUrl: env.publicBaseUrl,
    firebase: { ...env.firebase.publicConfig },
    appCheck: {
      siteKey: env.firebase.appCheckSiteKey,
      mode: env.firebase.appCheckMode
    },
    firebaseConfigSource: env.firebase.publicConfigSource,
    brand: 'SHELBY STORE',
    version: integer(String(packageVersion || '').split('.')[0], 1, 1, 10_000),
    minimumPasswordLength: 8
  };
}

function validServiceAccount(raw = '') {
  const account = parseObject(raw);
  if (!account || account.type !== 'service_account') return false;
  const projectId = String(account.project_id || '').trim();
  const clientEmail = String(account.client_email || '').trim();
  const privateKey = String(account.private_key || '').replace(/\\n/g, '\n').trim();
  return !!projectId
    && !isPlaceholder(projectId)
    && /^\S+@\S+\.iam\.gserviceaccount\.com$/i.test(clientEmail)
    && privateKey.includes('-----BEGIN PRIVATE KEY-----')
    && privateKey.includes('-----END PRIVATE KEY-----')
    && !isPlaceholder(privateKey);
}

function configurationReport() {
  const missing = [];
  const warnings = [];
  const serviceAccountObject = parseObject(env.firebase.serviceAccount);
  const serviceAccountReady = validServiceAccount(env.firebase.serviceAccount);
  if (!serviceAccountReady) missing.push('FIREBASE_KEY');
  if (serviceAccountReady && env.firebase.projectId && serviceAccountObject.project_id !== env.firebase.projectId) {
    missing.push('FIREBASE_PROJECT_ID_MISMATCH');
  }
  if (!env.firebase.publicConfig.apiKey || isPlaceholder(env.firebase.publicConfig.apiKey)) missing.push('PUBLIC_FIREBASE_API_KEY');
  if (!env.firebase.publicConfig.authDomain || isPlaceholder(env.firebase.publicConfig.authDomain)) missing.push('PUBLIC_FIREBASE_AUTH_DOMAIN');
  if (!env.firebase.publicConfig.projectId || isPlaceholder(env.firebase.publicConfig.projectId)) missing.push('PUBLIC_FIREBASE_PROJECT_ID');
  if (env.firebase.projectId && env.firebase.publicConfig.projectId && env.firebase.projectId !== env.firebase.publicConfig.projectId) {
    missing.push('PUBLIC_FIREBASE_PROJECT_ID_MISMATCH');
  }
  if (!env.firebase.publicConfig.appId || isPlaceholder(env.firebase.publicConfig.appId)) missing.push('PUBLIC_FIREBASE_APP_ID');
  if (!env.storeKeys.encryptionReady) missing.push('STORE_KEY_ENCRYPTION_SECRET');
  if (!env.storeKeys.fingerprintReady) missing.push('STORE_KEY_FINGERPRINT_SECRET');
  if (env.storeKeys.encryptionReady && env.storeKeys.fingerprintReady && !env.storeKeys.distinct) missing.push('STORE_KEY_SECRETS_MUST_DIFFER');
  if (env.adminEmails.length !== 1 || env.adminEmails.some(isPlaceholder)) missing.push('ADMIN_EMAILS');
  if (env.adminUids.length !== 1 || env.adminUids.some(isPlaceholder)) missing.push('ADMIN_UIDS');
  const requiredHex = (name) => /^[0-9a-f]{64}$/i.test(String(process.env[name] || '').trim()) && !isPlaceholder(process.env[name]);
  if (!requiredHex('ADMIN_GATE_FOUR_SALT_HEX')) missing.push('ADMIN_GATE_FOUR_SALT_HEX');
  if (!requiredHex('ADMIN_GATE_FOUR_HASH_HEX')) missing.push('ADMIN_GATE_FOUR_HASH_HEX');
  if (!requiredHex('ADMIN_GATE_FIVE_SALT_HEX')) missing.push('ADMIN_GATE_FIVE_SALT_HEX');
  if (!requiredHex('ADMIN_GATE_FIVE_HASH_HEX')) missing.push('ADMIN_GATE_FIVE_HASH_HEX');
  const signingSecret = String(process.env.ADMIN_GATE_SIGNING_SECRET || '').trim();
  if (signingSecret.length < 64 || isPlaceholder(signingSecret)) missing.push('ADMIN_GATE_SIGNING_SECRET');
  if (!env.firebase.appCheckSiteKey || isPlaceholder(env.firebase.appCheckSiteKey)) {
    (env.firebase.appCheckMode === 'enforce' ? missing : warnings).push('PUBLIC_FIREBASE_APP_CHECK_SITE_KEY');
  }
  if (env.security.adminTotp.mode === 'required' && !env.security.adminTotp.configured) missing.push('ADMIN_TOTP_SECRET_BASE32');
  if (env.firebase.appCheckMode !== 'enforce') warnings.push('APP_CHECK_NOT_ENFORCED');
  if (env.security.rateLimitStore !== 'firestore') warnings.push('RATE_LIMIT_NOT_DISTRIBUTED');
  if (env.security.adminTotp.mode !== 'required') warnings.push('ADMIN_TOTP_NOT_REQUIRED');
  return {
    ready: missing.length === 0,
    missing,
    warnings,
    nodeEnv: env.nodeEnv,
    serviceOrigin: env.serviceOrigin,
    publicBaseUrl: env.publicBaseUrl,
    publicApiBase: env.publicApiBase,
    allowedOrigins: [...env.allowedOrigins],
    firebasePublicReady: !!(env.firebase.publicConfig.apiKey && env.firebase.publicConfig.authDomain && env.firebase.publicConfig.projectId && env.firebase.publicConfig.appId),
    appCheckMode: env.firebase.appCheckMode,
    appCheckConfigured: !!env.firebase.appCheckSiteKey,
    rateLimitStore: env.security.rateLimitStore,
    adminTotpRequired: env.security.adminTotp.mode === 'required',
    adminTotpConfigured: env.security.adminTotp.configured,
    keyVaultReady: env.storeKeys.configured,
    keyVaultActiveKeyId: env.storeKeys.activeKeyId,
    keyVaultDecryptKeyCount: Object.keys(env.storeKeys.decryptionSecrets || {}).length,
    serviceAccountReady
  };
}

env.normalizeOrigin = normalizeOrigin;
env.publicRuntimeConfig = publicRuntimeConfig;
env.configurationReport = configurationReport;
env.isPlaceholder = isPlaceholder;
env.strongSecret = strongSecret;
module.exports = Object.freeze(env);
