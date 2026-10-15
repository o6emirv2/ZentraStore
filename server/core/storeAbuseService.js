'use strict';
const crypto = require('node:crypto');
const env = require('../config/env');
const { initFirebaseAdmin } = require('../config/firebaseAdmin');
const { createdAtPage, invalidateCreatedAtPageCache } = require('./firestorePagination');
const { securityBlocked } = require('./storeAccountPolicy');
const fail = (code, statusCode = 400) => { throw Object.assign(new Error(code), { code, statusCode }); };
function storage() { const f = initFirebaseAdmin(); if (!f.db || !f.auth) fail('STORE_STORAGE_UNAVAILABLE', 503); return f; }
function safeUid(uid) { if (typeof uid !== 'string' || !uid || uid.length > 128 || /[\\/<>\u0000-\u001f]/.test(uid)) fail('STORE_TARGET_UID_REQUIRED'); return uid; }
async function listSecurityEvents(cursor = '') {
  const { db } = storage();
  const page = await createdAtPage({ db, collection: 'storeSecurityEvents', limit: 30, cursor });
  const enabledAt = await require('./storeAccountSecurity').enforcementEpoch();
  return { readiness: { ...await require('./storeAccountSecurity').accountProtectionReadiness(), enabledAt }, events: page.docs.map(doc => ({ id: doc.id, ...doc.data() })), nextCursor: page.nextCursor, hasMore: page.hasMore };
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
  return { networkExempt: await require('./storeAccountSecurity').isSecurityExemptAdmin({ user: { uid } }), relatedAccounts: [...related.values()], relatedLimited: groups.some(group => group.size >= 20), uid, username: profile.username || '', state: securityBlocked(profile) ? 'blocked' : 'active',
    revision: Number(profile.storeSecurity?.revision || 0), reason: profile.storeSecurity?.reason || '',
    revocationPending: profile.storeSecurity?.revocationPending === true, restorationPending: profile.storeSecurity?.restorationPending === true, registration, observed,
    identifiers: { deviceId: deviceId || '', ipHash: ipHash || '', deviceBlocked: device?.data()?.blocked === true, ipBlocked: ip?.data()?.blocked === true,
      deviceOwner: device?.data()?.ownerUid || '', ipOwner: ip?.data()?.ownerUid || '' },
    referral: profile.storeAffiliate || null, balanceKurus: profile.storeBalanceKurus || 0,
    events: events.docs.map(x => ({ id: x.id, ...x.data() })),
    recentMoney: transfers.docs.map(x => { const r = x.data(); return { id: x.id, type: r.type, amountKurus: r.amountKurus, reason: r.reason, orderId: r.orderId || '', createdAt: r.createdAt }; }) };
}
async function ownedIdentifiers(tx, db, profile) {
  const ids = profile.storeRegistrationSecurity || profile.storeSecurityObserved || {};
  const refs = [ids.ipHash ? db.collection('storeRegistrationIps').doc(ids.ipHash) : null,
    ids.deviceId ? db.collection('storeDevices').doc(ids.deviceId) : null];
  const docs = await Promise.all(refs.map(ref => ref ? tx.get(ref) : null));
  return refs.map((ref, index) => [ref, docs[index]?.data()]);
}
function updateIdentifierBlocks(tx, identifiers, uid, blocked, reason, now) {
  for (const [ref, row] of identifiers) {
    if (!ref || !row || row.ownerUid !== uid) continue;
    if (blocked) tx.set(ref, { blocked: true, blockedForUid: uid, reason, updatedAt: now }, { merge: true });
    else if (row.blockedForUid === uid) tx.set(ref, { blocked: false, blockedForUid: '', reason: '', updatedAt: now }, { merge: true });
  }
}
async function moderateSecurityAccount(uid, input, actor) {
  safeUid(uid);
  if (!actor?.uid || !['suspend', 'restore', 'retry-revocation'].includes(input?.action) || typeof input.reason !== 'string'
    || input.reason.trim().length < 8 || input.reason.length > 300 || /[<>\u0000-\u001f]/.test(input.reason)
    || !Number.isSafeInteger(input.revision) || input.revision < 0) fail('SECURITY_MODERATION_INVALID');
  if (env.adminUids.includes(uid) || actor.uid === uid) fail('ADMIN_OWNER_IMMUTABLE', 403);
  const { db, auth } = storage(), ref = db.collection('users').doc(uid);
  const restoring = input.action === 'restore', operationId = crypto.randomUUID(), kind = restoring ? 'restore' : 'revoke';
  // Revocation never depends on the identity provider being available before the durable block.
  let restoreIdentity = null;
  if (restoring) {
    try { restoreIdentity = await auth.getUser(uid); }
    catch (_) { fail('AUTH_UNAVAILABLE', 503); }
  }
  let changed;
  await db.runTransaction(async tx => {
    const doc = await tx.get(ref); if (!doc.exists) fail('STORE_ACCOUNT_NOT_FOUND', 404);
    const profile = doc.data(), current = profile.storeSecurity || {}, now = Date.now();
    if ((current.revision || 0) !== input.revision) fail('SECURITY_MODERATION_CONFLICT', 409);
    if (current.providerOperation && (current.providerOperation.until > now || current.providerOperation.kind !== kind)) fail('SECURITY_MODERATION_BUSY', 409);
    if (restoring && restoreIdentity.disabled && current.authDisabledManaged !== true) fail('SECURITY_EXTERNAL_ACCOUNT_DISABLED', 409);
    if (input.action === 'retry-revocation' && !securityBlocked(profile)) fail('SECURITY_MODERATION_INVALID');
    const identifiers = await ownedIdentifiers(tx, db, profile);
    changed = { ...current, state: 'blocked', reason: input.reason.trim(), revision: (current.revision || 0) + 1,
      updatedAt: now, updatedBy: actor.uid, revocationPending: !restoring, restorationPending: restoring,
      authDisabledManaged: current.authDisabledManaged === true,
      providerOperation: { id: operationId, kind, until: now + 120000 } };
    tx.set(ref, { storeSecurity: changed, storeAccountStatus: 'suspended', storeUpdatedAt: now }, { merge: true });
    updateIdentifierBlocks(tx, identifiers, uid, true, input.reason.trim(), now);
    tx.create(db.collection('audit').doc(), { uid, actor: { uid: actor.uid }, type: 'store-security-moderation', action: input.action,
      reason: input.reason.trim(), before: current.state || 'active', after: 'blocked', phase: 'requested', at: now });
  });
  let finalState = 'blocked', revocationPending = !restoring, restorationPending = restoring;
  try {
    const identity = await auth.getUser(uid);
    if (restoring) {
      if (identity.disabled && changed.authDisabledManaged !== true) fail('SECURITY_EXTERNAL_ACCOUNT_DISABLED', 409);
      if (identity.disabled) await auth.updateUser(uid, { disabled: false });
    } else if (!identity.disabled) {
      changed.authDisabledManaged = true;
      await db.runTransaction(async tx => {
        const doc = await tx.get(ref), current = doc.data()?.storeSecurity;
        if (current?.providerOperation?.id !== operationId) fail('SECURITY_MODERATION_CONFLICT', 409);
        tx.set(ref, { storeSecurity: { ...current, authDisabledManaged: true } }, { merge: true });
      });
      await auth.updateUser(uid, { disabled: true });
    }
    await auth.revokeRefreshTokens(uid);
    const { revokeAdminSessionsForUser } = require('./adminSessionRegistry');
    await revokeAdminSessionsForUser(uid);
    await db.runTransaction(async tx => {
      const doc = await tx.get(ref), profile = doc.data() || {}, current = profile.storeSecurity;
      if (current?.revision !== changed.revision || current.providerOperation?.id !== operationId) fail('SECURITY_MODERATION_CONFLICT', 409);
      const identifiers = restoring ? await ownedIdentifiers(tx, db, profile) : [];
      const now = Date.now(), state = restoring ? 'active' : 'blocked';
      tx.set(ref, { storeSecurity: { ...current, state, revocationPending: false, restorationPending: false, providerOperation: null,
        authDisabledManaged: restoring ? false : changed.authDisabledManaged, updatedAt: now }, storeAccountStatus: restoring ? 'active' : 'suspended' }, { merge: true });
      if (restoring) updateIdentifierBlocks(tx, identifiers, uid, false, '', now);
      tx.create(db.collection('audit').doc(), { uid, actor: { uid: actor.uid }, type: 'store-security-provider-sync', action: input.action,
        revision: changed.revision, state, at: now });
    });
    finalState = restoring ? 'active' : 'blocked'; revocationPending = false; restorationPending = false;
  } catch (error) {
    if (error.code === 'SECURITY_MODERATION_CONFLICT') throw error;
    // Keep the account blocked until every restoration step is confirmed; release only our own operation lock.
    await db.runTransaction(async tx => {
      const doc = await tx.get(ref), current = doc.data()?.storeSecurity;
      if (current?.revision === changed.revision && current.providerOperation?.id === operationId) {
        tx.set(ref, { storeSecurity: { ...current, providerOperation: null, updatedAt: Date.now() } }, { merge: true });
      }
    });
  }
  invalidateCreatedAtPageCache('storeSecurityEvents');
  return { uid, state: finalState, revision: changed.revision, revocationPending, restorationPending };
}
module.exports = { listSecurityEvents, readAccountSecurity, moderateSecurityAccount };
