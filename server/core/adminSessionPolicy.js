'use strict';
const crypto = require('node:crypto');
const GATE_VERSION = 82;
function credentialRevision() {
  return crypto.createHash('sha256').update(JSON.stringify([
    'zentra-admin-six-stage-v82', ...['ADMIN_GATE_FOUR_SALT_HEX', 'ADMIN_GATE_FOUR_HASH_HEX',
      'ADMIN_GATE_FIVE_SALT_HEX', 'ADMIN_GATE_FIVE_HASH_HEX', 'ADMIN_TOTP_SECRET_BASE32']
      .map(key => String(process.env[key] || ''))
  ])).digest('hex');
}
async function currentSessionPolicy(uid, email) {
  const policy = await require('./adminStoreService').resolveStaffPolicy(uid, email);
  return policy ? { gateVersion: GATE_VERSION, policyVersion: Number(policy.policyVersion || 0), credentialRevision: credentialRevision() } : null;
}
async function sessionPolicyMatches(row) {
  if (!row || row.gateVersion !== GATE_VERSION || row.credentialRevision !== credentialRevision()) return false;
  const current = await currentSessionPolicy(row.uid, row.email);
  return !!current && row.policyVersion === current.policyVersion;
}
module.exports = { GATE_VERSION, credentialRevision, currentSessionPolicy, sessionPolicyMatches };
