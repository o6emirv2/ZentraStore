'use strict';

const env = require('./env');

function isOriginAllowed(origin = '') {
  const normalized = env.normalizeOrigin(origin);
  return !!normalized && env.allowedOrigins.includes(normalized);
}

function corsOptions(req, callback) {
  const origin = String(req.header('Origin') || '').trim();
  const allowed = !origin || isOriginAllowed(origin);
  callback(null, {
    origin: allowed,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type', 'Authorization', 'X-Request-Id', 'X-Idempotency-Key',
      'X-Shelby-Store-Client', 'X-Admin-Reauth', 'X-Firebase-AppCheck'
    ],
    exposedHeaders: ['X-Request-Id'],
    maxAge: 86400
  });
}

module.exports = { corsOptions, isOriginAllowed };
