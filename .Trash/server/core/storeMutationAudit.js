'use strict';

const { sanitizeAuditValue } = require('./adminReauthService');

// Add this record to the SAME transaction/batch as the business mutation.
// A secondary request log must never turn an already committed change into a failure.
function recordMutationAudit(writer, db, action, actor = {}, details = {}, context = {}) {
  const reference = db.collection('audit').doc();
  const now = Date.now();
  writer.create(reference, {
    id: reference.id,
    type: String(action).replace(/\./g, '-').slice(0, 100),
    action: String(action).slice(0, 100),
    actor: {
      uid: String(actor.uid || '').slice(0, 160),
      email: String(actor.email || '').toLowerCase().slice(0, 254),
      source: 'admin'
    },
    details: sanitizeAuditValue(details),
    requestId: String(context.requestId || '').slice(0, 180),
    at: now,
    createdAt: now
  });
}

module.exports = { recordMutationAudit };
