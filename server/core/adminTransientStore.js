'use strict';

const crypto = require('node:crypto');
const env = require('../config/env');

class ExpiringStore {
  constructor(limit) { this.limit = limit; this.rows = new Map(); }
  prune(now = Date.now()) {
    for (const [key, row] of this.rows) if (row.expiresAt <= now) this.rows.delete(key);
  }
  get(key) {
    const row = this.rows.get(key);
    if (!row) return null;
    if (row.expiresAt <= Date.now()) { this.rows.delete(key); return null; }
    return structuredClone(row.value);
  }
  set(key, value, expiresAt) {
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw Object.assign(new Error('ADMIN_TRANSIENT_EXPIRY_INVALID'), { code: 'ADMIN_TRANSIENT_EXPIRY_INVALID', statusCode: 503 });
    if (!this.rows.has(key) && this.rows.size >= this.limit) this.prune();
    // Replay records must never be evicted while their proofs are still valid.
    if (!this.rows.has(key) && this.rows.size >= this.limit) throw Object.assign(new Error('ADMIN_TRANSIENT_CAPACITY'), { code: 'ADMIN_TRANSIENT_CAPACITY', statusCode: 503 });
    this.rows.set(key, { value: structuredClone(value), expiresAt });
  }
  claim(key, value, expiresAt) {
    if (this.get(key)) return false;
    this.set(key, value, expiresAt);
    return true;
  }
  delete(key) { this.rows.delete(key); }
  values() { this.prune(); return [...this.rows.values()].map(row => structuredClone(row.value)); }
}

const memory = env.security.adminTransientStore === 'memory';
const bootId = crypto.randomBytes(32).toString('hex');
const sessions = new ExpiringStore(3000);
const nonces = new ExpiringStore(30000);
const actions = new ExpiringStore(10000);
const audits = new Map();
function rememberAudit(row) {
  audits.set(row.id, structuredClone(row));
  while (audits.size > 1000) audits.delete(audits.keys().next().value);
}
function recentAudits() {
  const cutoff = Date.now() - 24 * 60 * 60_000;
  for (const [key, row] of audits) if (row.createdAt < cutoff) audits.delete(key);
  return [...audits.values()].map(row => structuredClone(row));
}

const cleanup = setInterval(() => { sessions.prune(); nonces.prune(); actions.prune(); recentAudits(); }, 60_000);
cleanup.unref();

module.exports = { ExpiringStore, memory, bootId, sessions, nonces, actions, rememberAudit, recentAudits };
