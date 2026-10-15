'use strict';
const crypto = require('node:crypto');
const env = require('../config/env');
const { initFirebaseAdmin } = require('../config/firebaseAdmin');
const { verifyDevice } = require('./storeDeviceService');
const { checkNetwork, normalizeIp, networkReadiness } = require('./storeNetworkPolicy');
const { securityBlocked, registrationComplete } = require('./storeAccountPolicy');
const fail = (code, statusCode = 403) => { throw Object.assign(new Error(code), { code, statusCode, storeSecurityError: true }); };
const EXEMPT_ADMIN_EMAIL = 'o6emirv2@gmail.com';
function storage() { const value = initFirebaseAdmin(); if (!value.db || !value.auth) fail('STORE_STORAGE_UNAVAILABLE', 503); return value; }
async function isSecurityExemptAdmin(req) {
  if (req.storeSecurityExempt !== undefined) return req.storeSecurityExempt;
  const uid = req.user?.uid;
  if (!uid || env.adminUids.length !== 1 || env.adminEmails.length !== 1 || env.adminUids[0] !== uid
    || env.adminEmails[0] !== EXEMPT_ADMIN_EMAIL) return (req.storeSecurityExempt = false);
  const { auth } = storage();
  const identity = req.storeAuthIdentity || await auth.getUser(uid);
  return (req.storeSecurityExempt = identity.uid === uid && identity.emailVerified === true && identity.disabled !== true
    && String(identity.email || '').toLowerCase() === EXEMPT_ADMIN_EMAIL);
}
async function enforceIdentityAccess(req) {
  const uid = req.user?.uid;
  if (!uid) fail('AUTH_REQUIRED', 401);
  const { db } = storage(), doc = await db.collection('users').doc(uid).get(), profile = doc.data() || {};
  if (securityBlocked(profile)) fail('SECURITY_ACCOUNT_BLOCKED');
  return { profile, exempt: await isSecurityExemptAdmin(req) };
}
async function registrationContext(req) {
  if (await isSecurityExemptAdmin(req)) return { exempt: true, uid: req.user.uid };
  return checkedContext(req);
}
function digest(value) {
  const secret = String(process.env.STORE_SECURITY_HASH_SECRET || process.env.STORE_KEY_FINGERPRINT_SECRET || '');
  if (secret.length < 48) fail('SECURITY_HASH_UNCONFIGURED', 503);
  return crypto.createHmac('sha256', crypto.hkdfSync('sha256', secret, 'zentra-account-guard-v1', 'network-identifiers', 32)).update(value).digest('hex');
}
function maskedIp(ip) { return ip.includes(':') ? `${ip.split(':').slice(0, 2).join(':')}:…` : `${ip.split('.').slice(0, 2).join('.')}.x.x`; }
async function accountProtectionReadiness() {
  const network = await networkReadiness();
  if (!network.ready) return network;
  try { digest('readiness'); return network; }
  catch (error) { return { ...network, ready: false, reason: error.code || 'SECURITY_HASH_UNCONFIGURED' }; }
}
async function securityEvent(req, code, extra = {}) {
  const { db } = storage(), uid = String(req.user?.uid || '');
  const context = req.storeSecurityContext;
  let ipHash = context?.ipHash || '', mask = context?.ipMask || '';
  try { if (!ipHash) { const ip = normalizeIp(req.ip); ipHash = digest(ip); mask = maskedIp(ip); } } catch (_) {}
  const deviceId = req.storeDevice?.deviceId || '';
  const id = digest(JSON.stringify([uid, code, ipHash, deviceId, Math.floor(Date.now() / 60000)]));
  await db.runTransaction(async tx => {
    const ref = db.collection('storeSecurityEvents').doc(id), existing = await tx.get(ref), now = Date.now();
    tx.set(ref, { uid, code, ipHash, ipMask: mask, deviceId, ...extra,
      path: String(req.originalUrl || '').split('?')[0].slice(0, 160), createdAt: existing.data()?.createdAt || now,
      updatedAt: now, hits: (existing.data()?.hits || 0) + 1 }, { merge: true });
  });
}
async function requestSecurityContext(req) {
  if (req.storeSecurityContext) return req.storeSecurityContext;
  if (env.nodeEnv === 'production' && (!Array.isArray(req.ips) || !req.ips.length)) fail('SECURITY_PROXY_UNCONFIGURED', 503);
  const device = await verifyDevice(req), network = await checkNetwork(req.ip);
  req.storeSecurityContext = { deviceId: device.deviceId, ipHash: digest(network.ip), ipMask: maskedIp(network.ip),
    networkCheckedAt: network.checkedAt, categories: network.categories, agentHash: digest(String(req.headers?.['user-agent'] || '').slice(0, 500)) };
  if (network.blocked) fail('SECURITY_NETWORK_BLOCKED');
  const { db } = storage(), ip = await db.collection('storeRegistrationIps').doc(req.storeSecurityContext.ipHash).get();
  if (ip.data()?.blocked === true) fail('SECURITY_IP_BLOCKED');
  return req.storeSecurityContext;
}
async function auditSecurityFailure(req, error) {
  if (!error.storeSecurityError) throw error;
  await securityEvent(req, error.code);
  throw error;
}
async function checkedContext(req) {
  try { return await requestSecurityContext(req); } catch (error) { return auditSecurityFailure(req, error); }
}
let epochDb = null, epochPromise = null;
async function enforcementEpoch() {
  const { db } = storage();
  if (epochDb === db && epochPromise) return epochPromise;
  epochDb = db;
  epochPromise = db.runTransaction(async tx => {
    const ref = db.collection('storeSecuritySettings').doc('activation'), doc = await tx.get(ref);
    if (doc.exists) {
      const value = doc.data()?.enabledAt;
      if (!Number.isSafeInteger(value) || value < 1 || value > Date.now() + 30000) fail('SECURITY_NETWORK_CONFIG_INVALID', 503);
      return value;
    }
    const enabledAt = Date.now(); tx.create(ref, { enabledAt }); return enabledAt;
  }).catch(error => { epochPromise = null; throw error; });
  return epochPromise;
}
async function legacyIdentity(uid, current) {
  if (current.profileInitializationPending === true || !current.username) return false;
  const { auth } = storage();
  const user = await auth.getUser(uid), createdAt = Date.parse(user.metadata?.creationTime || '');
  return Number.isFinite(createdAt) && createdAt < await enforcementEpoch();
}
async function readRegistrationSecurity({ tx, db, uid, current, context, legacy = false }) {
  if (securityBlocked(current)) fail('SECURITY_ACCOUNT_BLOCKED');
  if (current.storeRegistrationSecurity && !registrationComplete(current)) fail('SECURITY_NETWORK_CONFIG_INVALID', 503);
  if (registrationComplete(current)) return { existing: true, patch: {} };
  if (context.exempt === true && context.uid === uid) return { exempt: true, patch: {
    storeRegistrationSecurity: { kind: 'admin_exemption', admittedAt: Date.now(), historicalRegistrationKnown: false },
    storeSecurity: { ...(current.storeSecurity || {}), state: current.storeSecurity?.state || 'active' }
  } };
  const ipRef = db.collection('storeRegistrationIps').doc(context.ipHash), deviceRef = db.collection('storeDevices').doc(context.deviceId);
  const [ipDoc, deviceDoc] = await Promise.all([tx.get(ipRef), tx.get(deviceRef)]);
  const ip = ipDoc.data() || {}, device = deviceDoc.data() || {};
  if (!deviceDoc.exists) fail('SECURITY_DEVICE_REQUIRED');
  if (ip.blocked === true || device.blocked === true) fail(ip.blocked ? 'SECURITY_IP_BLOCKED' : 'SECURITY_DEVICE_BLOCKED');
  const sharedIp = !!ip.ownerUid && ip.ownerUid !== uid, sharedDevice = !!device.ownerUid && device.ownerUid !== uid;
  if (!legacy && (sharedIp || sharedDevice)) fail(sharedIp ? 'SECURITY_IP_ACCOUNT_EXISTS' : 'SECURITY_DEVICE_ACCOUNT_EXISTS');
  const now = Date.now();
  return { ipRef, deviceRef, ip, device, sharedIp, sharedDevice, patch: {
    storeRegistrationSecurity: { kind: legacy ? 'legacy_observation' : 'registration', admittedAt: now,
      ipHash: context.ipHash, ipMask: context.ipMask, deviceId: context.deviceId,
      sharedIp, sharedDevice, historicalRegistrationKnown: !legacy },
    storeSecurity: { ...(current.storeSecurity || {}), state: current.storeSecurity?.state || 'active' }
  } };
}
function applyRegistrationSecurity({ tx, db, uid, claim }) {
  if (claim.existing) return {};
  const now = Date.now();
  if (!claim.exempt && !claim.ip.ownerUid) tx.set(claim.ipRef, { ownerUid: uid, blocked: false, createdAt: claim.ip.createdAt || now, source: claim.patch.storeRegistrationSecurity.kind }, { merge: true });
  if (!claim.exempt && !claim.device.ownerUid) tx.set(claim.deviceRef, { ownerUid: uid, boundAt: now }, { merge: true });
  tx.create(db.collection('audit').doc(), { uid, type: 'store-security-admission', ...claim.patch.storeRegistrationSecurity, at: now });
  return claim.patch;
}
async function enforceCustomerAccess(req, { pendingAllowed = false } = {}) {
  const { db } = storage(), uid = req.user?.uid;
  if (!uid) fail('AUTH_REQUIRED', 401);
  try {
    if (await isSecurityExemptAdmin(req)) {
      await db.runTransaction(async tx => {
        const ref = db.collection('users').doc(uid), doc = await tx.get(ref), current = doc.data() || {};
        if (securityBlocked(current)) fail('SECURITY_ACCOUNT_BLOCKED');
        if (!registrationComplete(current)) {
          const claim = await readRegistrationSecurity({ tx, db, uid, current, context: { exempt: true, uid } });
          tx.set(ref, applyRegistrationSecurity({ tx, db, uid, claim }), { merge: true });
        }
      });
      return (req.storeSecurityContext = { exempt: true, uid });
    }
    const context = await requestSecurityContext(req), ref = db.collection('users').doc(uid), snapshot = await ref.get(), profile = snapshot.data() || {};
    if (securityBlocked(profile)) fail('SECURITY_ACCOUNT_BLOCKED');
    if (!registrationComplete(profile)) {
      const legacy = await legacyIdentity(uid, profile);
      if (!legacy) {
        if (pendingAllowed) return context;
        fail('SECURITY_REGISTRATION_REQUIRED');
      }
      await db.runTransaction(async tx => {
        const current = await tx.get(ref), data = current.data() || {};
        const claim = await readRegistrationSecurity({ tx, db, uid, current: data, context, legacy: true });
        const patch = applyRegistrationSecurity({ tx, db, uid, claim });
        if (!claim.existing) tx.set(ref, patch, { merge: true });
      });
    }
    const prior = profile.storeSecurityObserved;
    const deviceDoc = req.storeDevice.data;
    if (deviceDoc.ownerUid && deviceDoc.ownerUid !== uid) await securityEvent(req, 'OBSERVED_SHARED_DEVICE', { relatedUid: deviceDoc.ownerUid });
    if (!prior || prior.deviceId !== context.deviceId || prior.ipHash !== context.ipHash || prior.at < Date.now() - 300000) {
      await ref.set({ storeSecurityObserved: { deviceId: context.deviceId, ipHash: context.ipHash, ipMask: context.ipMask, agentHash: context.agentHash, at: Date.now() } }, { merge: true });
    }
    return context;
  } catch (error) { return auditSecurityFailure(req, error); }
}
async function customerRouteGuard(req) {
  const path = String(req.originalUrl || '').split('?')[0];
  if (!path.startsWith('/api/store/')) return;
  if (['/api/store/catalog', '/api/store/affiliate/resolve', '/api/store/security/device'].includes(path)) return;
  if (path === '/api/store/account' && req.method === 'GET') {
    await enforceIdentityAccess(req);
    if (!req.headers?.['x-zentra-device-proof'] && !await isSecurityExemptAdmin(req)) {
      req.storeAccountReadOnly = true; req.storeAccountLimitedReason = 'SECURITY_DEVICE_REQUIRED'; return;
    }
    try { return await enforceCustomerAccess(req, { pendingAllowed: true }); }
    catch (error) {
      if (error.storeSecurityError && error.statusCode === 503) {
        req.storeAccountReadOnly = true; req.storeAccountLimitedReason = error.code; return;
      }
      throw error;
    }
  }
  return enforceCustomerAccess(req, { pendingAllowed: path === '/api/store/account' });
}
module.exports = { EXEMPT_ADMIN_EMAIL, isSecurityExemptAdmin, enforceIdentityAccess, registrationContext, accountProtectionReadiness, enforcementEpoch, digest, checkedContext, securityEvent, requestSecurityContext, auditSecurityFailure, legacyIdentity,
  readRegistrationSecurity, applyRegistrationSecurity, enforceCustomerAccess, customerRouteGuard, fail };
