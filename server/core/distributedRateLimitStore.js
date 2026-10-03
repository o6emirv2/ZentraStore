'use strict';

const crypto = require('crypto');
const { initFirebaseAdmin } = require('../config/firebaseAdmin');

class FirestoreRateLimitStore {
  constructor(namespace) {
    this.namespace = String(namespace || 'default').replace(/[^a-z0-9-]/gi, '-').slice(0, 40);
    this.localKeys = false;
    this.windowMs = 60_000;
  }

  init(options) {
    this.windowMs = Math.max(1_000, Math.trunc(Number(options?.windowMs) || 60_000));
  }

  reference(key) {
    const { db } = initFirebaseAdmin();
    if (!db) throw Object.assign(new Error('RATE_LIMIT_STORE_UNAVAILABLE'), { code: 'RATE_LIMIT_STORE_UNAVAILABLE', statusCode: 503 });
    const id = crypto.createHash('sha256').update(`${this.namespace}\u0000${String(key || '')}`).digest('hex');
    return db.collection('storeSecurityRateLimits').doc(id);
  }

  async increment(key) {
    const { db } = initFirebaseAdmin();
    const reference = this.reference(key);
    return db.runTransaction(async (transaction) => {
      const now = Date.now();
      const snapshot = await transaction.get(reference);
      const existing = snapshot.exists ? (snapshot.data() || {}) : {};
      const currentReset = Math.max(0, Number(existing.resetAt || 0));
      const resetAt = currentReset > now ? currentReset : now + this.windowMs;
      const totalHits = currentReset > now ? Math.max(0, Number(existing.hits || 0)) + 1 : 1;
      transaction.set(reference, {
        namespace: this.namespace,
        hits: totalHits,
        resetAt,
        expiresAt: new Date(resetAt + this.windowMs),
        updatedAt: now
      }, { merge: false });
      return { totalHits, resetTime: new Date(resetAt) };
    });
  }

  async decrement(key) {
    const { db, admin } = initFirebaseAdmin();
    const reference = this.reference(key);
    if (!admin) return;
    await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists || Number(snapshot.data()?.resetAt || 0) <= Date.now()) return;
      transaction.update(reference, { hits: Math.max(0, Number(snapshot.data()?.hits || 0) - 1) });
    });
  }

  async resetKey(key) {
    await this.reference(key).delete();
  }
}

module.exports = { FirestoreRateLimitStore };
