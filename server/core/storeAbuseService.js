'use strict';
const env = require('../config/env');
const { initFirebaseAdmin } = require('../config/firebaseAdmin');
const { createdAtPage, invalidateCreatedAtPageCache } = require('./firestorePagination');
const { networkReadiness } = require('./storeNetworkPolicy');
const { securityBlocked } = require('./storeAccountPolicy');
const fail = (code, statusCode = 400) => { throw Object.assign(new Error(code), { code, statusCode }); };
function storage() { const f = initFirebaseAdmin(); if (!f.db || !f.auth) fail('STORE_STORAGE_UNAVAILABLE', 503); return f; }
function safeUid(uid) { if (typeof uid !== 'string' || !uid || uid.length > 128 || /[\\/<>\u0000-\u001f]/.test(uid)) fail('STORE_TARGET_UID_REQUIRED'); return uid; }
async function listSecurityEvents(cursor = '') {
  const { db } = storage();
  const page = await createdAtPage({ db, collection: 'storeSecurityEvents', limit: 30, cursor });
  const enabledAt = await require('./storeAccountSecurity').enforcementEpoch();
  return { readiness: { ...await networkReadiness(), enabledAt }, events: page.docs.map(doc => ({ id: doc.id, ...doc.data() })), nextCursor: page.nextCursor, hasMore: page.hasMore };
}
async function readAccountSecurity(uid) {
  safeUid(uid); const { db } = storage(), doc = await db.collection('users').doc(uid).get();
  if (!doc.exists) fail('STORE_ACCOUNT_NOT_FOUND', 404);
  const profile = doc.data(), registration = profile.storeRegistrationSecurity || null, observed = profile.storeSecurityObserved || null;
  const deviceId = registration?.deviceId || observed?.deviceId, ipHash = registration?.ipHash || observed?.ipHash;
  const [device, ip, events, transfers] = await Promise.all([
    deviceId ? db.collection('storeDevices').doc(deviceId).get() : null,
    ipHash ? db.collection('storeRegistrationIps').doc(ipHash).get() : null,
    createdAtPage({ db, collection: 'storeSecurityEvents', filters: [['uid', uid]], limit: 20 }),
    createdAtPage({ db, collection: 'storeWalletLedger', filters: [['uid', uid]], limit: 20 })
  ]);
  const relations = [];
  for (const value of new Set([registration?.ipHash, observed?.ipHash].filter(Boolean))) {
    relations.push(['storeRegistrationSecurity.ipHash', value, 'registration-ip'], ['storeSecurityObserved.ipHash', value, 'observed-ip']);
  }
  for (const value of new Set([registration?.deviceId, observed?.deviceId].filter(Boolean))) {
    relations.push(['storeRegistrationSecurity.deviceId', value, 'registration-device'], ['storeSecurityObserved.deviceId', value, 'observed-device']);
  }
  const groups = await Promise.all(relations.map(([field, value]) => db.collection('users').where(field, '==', value).limit(20).get()));
  const related = new Map();
  groups.forEach((group, index) => group.docs.forEach(doc => {
    if (doc.id === uid) return;
    const row = doc.data(), previous = related.get(doc.id);
    related.set(doc.id, { uid: doc.id, username: row.username || '', state: securityBlocked(row) ? 'blocked' : 'active',
      matches: [...new Set([...(previous?.matches || []), relations[index][2]])] });
  }));
  return { relatedAccounts: [...related.values()], relatedLimited: groups.some(group => group.size >= 20), uid, username: profile.username || '', state: securityBlocked(profile) ? 'blocked' : 'active',
    revision: Number(profile.storeSecurity?.revision || 0), reason: profile.storeSecurity?.reason || '',
    revocationPending: profile.storeSecurity?.revocationPending === true, registration, observed,
    identifiers: { deviceId: deviceId || '', ipHash: ipHash || '', deviceBlocked: device?.data()?.blocked === true, ipBlocked: ip?.data()?.blocked === true,
      deviceOwner: device?.data()?.ownerUid || '', ipOwner: ip?.data()?.ownerUid || '' },
    referral: profile.storeAffiliate || null, balanceKurus: profile.storeBalanceKurus || 0,
    events: events.docs.map(x => ({ id: x.id, ...x.data() })),
    recentMoney: transfers.docs.map(x => { const r = x.data(); return { id: x.id, type: r.type, amountKurus: r.amountKurus, reason: r.reason, orderId: r.orderId || '', createdAt: r.createdAt }; }) };
}
async function moderateSecurityAccount(uid, input, actor) {
  safeUid(uid);
  if (!actor?.uid || !['suspend', 'restore', 'retry-revocation'].includes(input?.action) || typeof input.reason !== 'string'
    || input.reason.trim().length < 8 || input.reason.length > 300 || /[<>\u0000-\u001f]/.test(input.reason)
    || !Number.isSafeInteger(input.revision) || input.revision < 0) fail('SECURITY_MODERATION_INVALID');
  if (env.adminUids.includes(uid) || actor.uid === uid) fail('ADMIN_OWNER_IMMUTABLE', 403);
  const { db, auth } = storage(), ref = db.collection('users').doc(uid);
  const identity = await auth.getUser(uid);
  if (input.action === 'restore') {
    const prior = await ref.get();
    if ((prior.data()?.storeSecurity?.revision || 0) !== input.revision) fail('SECURITY_MODERATION_CONFLICT', 409);
    if (identity.disabled && prior.data()?.storeSecurity?.authDisabledManaged !== true) fail('SECURITY_EXTERNAL_ACCOUNT_DISABLED', 409);
    if (prior.data()?.storeSecurity?.authDisabledManaged === true && identity.disabled) await auth.updateUser(uid, { disabled: false });
  }
  let changed;
  await db.runTransaction(async tx => {
    const doc = await tx.get(ref); if (!doc.exists) fail('STORE_ACCOUNT_NOT_FOUND', 404);
    const profile = doc.data(), current = profile.storeSecurity || {}, now = Date.now();
    if ((current.revision || 0) !== input.revision) fail('SECURITY_MODERATION_CONFLICT', 409);
    if (input.action === 'retry-revocation' && !securityBlocked(profile)) fail('SECURITY_MODERATION_INVALID');
    const ids = profile.storeRegistrationSecurity || profile.storeSecurityObserved || {};
    const ipRef = ids.ipHash ? db.collection('storeRegistrationIps').doc(ids.ipHash) : null;
    const deviceRef = ids.deviceId ? db.collection('storeDevices').doc(ids.deviceId) : null;
    const [ip, device] = await Promise.all([ipRef ? tx.get(ipRef) : null, deviceRef ? tx.get(deviceRef) : null]);
    const blocked = input.action !== 'restore';
    changed = { ...current, state: blocked ? 'blocked' : 'active', reason: input.reason.trim(), revision: (current.revision || 0) + 1,
      updatedAt: now, updatedBy: actor.uid, revocationPending: blocked,
      authDisabledManaged: blocked ? (current.authDisabledManaged === true || identity.disabled !== true) : false };
    tx.set(ref, { storeSecurity: changed, storeAccountStatus: blocked ? 'suspended' : 'active', storeUpdatedAt: now }, { merge: true });
    for (const [idRef, row] of [[ipRef, ip?.data()], [deviceRef, device?.data()]]) {
      // A failed second account never acquires the first account's identifiers.
      if (!idRef || !row || row.ownerUid !== uid) continue;
      if (blocked) tx.set(idRef, { blocked: true, blockedForUid: uid, reason: input.reason.trim(), updatedAt: now }, { merge: true });
      else if (row.blockedForUid === uid) tx.set(idRef, { blocked: false, blockedForUid: '', reason: '', updatedAt: now }, { merge: true });
    }
    tx.create(db.collection('audit').doc(), { uid, actor: { uid: actor.uid }, type: 'store-security-moderation', action: input.action,
      reason: input.reason.trim(), before: current.state || 'active', after: changed.state, at: now });
  });
  let revocationPending = changed.revocationPending;
  if (input.action !== 'restore') {
    try {
      if (!identity.disabled) await auth.updateUser(uid, { disabled: true });
      await auth.revokeRefreshTokens(uid);
      const { revokeAdminSessionsForUser } = require('./adminSessionRegistry');
      await revokeAdminSessionsForUser(uid);
      await db.runTransaction(async tx => {
        const current = await tx.get(ref), latest = current.data()?.storeSecurity;
        if (latest?.revision === changed.revision) tx.set(ref, { storeSecurity: { ...latest, revocationPending: false } }, { merge: true });
      });
      revocationPending = false;
    } catch (_) { /* The durable server-side block stays effective if the identity provider is unavailable. */ }
  }
  invalidateCreatedAtPageCache('storeSecurityEvents');
  return { uid, state: changed.state, revision: changed.revision, revocationPending };
}
module.exports = { listSecurityEvents, readAccountSecurity, moderateSecurityAccount };
