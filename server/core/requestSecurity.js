'use strict';

const crypto = require('crypto');
const env = require('../config/env');

const API_BODY_LIMIT_BYTES = 256 * 1024;
const MAX_URI_LENGTH = 2048;
const MAX_QUERY_KEYS = 80;
const MAX_QUERY_VALUE_LENGTH = 4096;
const MAX_OBJECT_KEYS = 1000;
const MAX_ARRAY_ITEMS = 500;
const MAX_BODY_DEPTH = 10;
const MAX_BODY_STRING_LENGTH = 200_000;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']);
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function requestId() {
  return `req_${Date.now()}_${crypto.randomBytes(12).toString('hex')}`;
}

function response(res, status, error, req) {
  return res.status(status).json({ ok: false, error, requestId: req.requestId });
}

function parseContentLength(value) {
  if (value === undefined) return 0;
  const raw = String(value).trim();
  if (!/^\d{1,12}$/.test(raw)) return -1;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : -1;
}

function inspectQuery(query) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) return false;
  const entries = Object.entries(query);
  if (entries.length > MAX_QUERY_KEYS) return false;
  return entries.every(([key, value]) => {
    if (!key || key.length > 120 || FORBIDDEN_KEYS.has(key)) return false;
    if (typeof value === 'string') return value.length <= MAX_QUERY_VALUE_LENGTH;
    if (Array.isArray(value)) {
      return value.length <= 20 && value.every((item) => typeof item === 'string' && item.length <= MAX_QUERY_VALUE_LENGTH);
    }
    return value === undefined;
  });
}

function inspectBody(body) {
  let keys = 0;
  function inspect(value, depth = 0) {
    if (depth > MAX_BODY_DEPTH) return false;
    if (typeof value === 'string') return value.length <= MAX_BODY_STRING_LENGTH;
    if (typeof value === 'number') return Number.isFinite(value);
    if (value === null || typeof value === 'boolean' || value === undefined) return true;
    if (typeof value !== 'object') return false;
    if (Array.isArray(value)) {
      return value.length <= MAX_ARRAY_ITEMS && value.every((item) => inspect(item, depth + 1));
    }
    for (const [key, child] of Object.entries(value)) {
      keys += 1;
      if (keys > MAX_OBJECT_KEYS || FORBIDDEN_KEYS.has(key) || key.length > 160 || !inspect(child, depth + 1)) return false;
    }
    return true;
  }
  return inspect(body);
}

function allowedHosts() {
  const hosts = new Set();
  for (const origin of env.allowedOrigins || []) {
    try { hosts.add(new URL(origin).host.toLowerCase()); } catch (_) {}
  }
  return hosts;
}

const HOST_ALLOWLIST = allowedHosts();

function requestEnvelopeGuard(req, res, next) {
  req.requestId = requestId();
  res.setHeader('X-Request-Id', req.requestId);
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()');

  const method = String(req.method || '').toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    res.setHeader('Allow', [...ALLOWED_METHODS].join(', '));
    return response(res, 405, 'METHOD_NOT_ALLOWED', req);
  }

  if (String(req.originalUrl || req.url || '').length > MAX_URI_LENGTH) {
    return response(res, 414, 'REQUEST_URI_TOO_LONG', req);
  }

  const contentLength = parseContentLength(req.headers['content-length']);
  if (contentLength < 0) return response(res, 400, 'CONTENT_LENGTH_INVALID', req);
  if (contentLength > API_BODY_LIMIT_BYTES && String(req.path || '').startsWith('/api')) {
    return response(res, 413, 'REQUEST_BODY_TOO_LARGE', req);
  }

  if (req.headers['content-length'] !== undefined && req.headers['transfer-encoding'] !== undefined) {
    return response(res, 400, 'AMBIGUOUS_MESSAGE_LENGTH', req);
  }

  if (env.nodeEnv === 'production' && HOST_ALLOWLIST.size) {
    const host = String(req.headers.host || '').trim().toLowerCase();
    if (!host || !HOST_ALLOWLIST.has(host)) return response(res, 421, 'HOST_NOT_ALLOWED', req);
  }

  return next();
}

function apiRequestGuard(req, res, next) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.vary('Origin');

  if (!inspectQuery(req.query)) return response(res, 400, 'QUERY_UNSAFE', req);

  const method = String(req.method || '').toUpperCase();
  const mutating = !SAFE_METHODS.has(method);
  const origin = env.normalizeOrigin(req.headers.origin || '');
  if (mutating && env.nodeEnv === 'production' && (!origin || !env.allowedOrigins.includes(origin))) {
    return response(res, 403, 'ORIGIN_NOT_ALLOWED', req);
  }
  if (mutating && origin && !env.allowedOrigins.includes(origin)) {
    return response(res, 403, 'ORIGIN_NOT_ALLOWED', req);
  }

  const contentLength = parseContentLength(req.headers['content-length']);
  const hasBody = contentLength > 0 || req.headers['transfer-encoding'] !== undefined;
  if (mutating && hasBody && !/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) {
    return response(res, 415, 'CONTENT_TYPE_REQUIRED', req);
  }

  const contentEncoding = String(req.headers['content-encoding'] || 'identity').trim().toLowerCase();
  if (hasBody && contentEncoding !== 'identity') return response(res, 415, 'CONTENT_ENCODING_NOT_ALLOWED', req);
  return next();
}

function bodySafetyGuard(req, res, next) {
  if (!inspectBody(req.body)) return response(res, 400, 'REQUEST_BODY_UNSAFE', req);
  return next();
}

function configureHttpServer(server) {
  server.requestTimeout = 20_000;
  server.headersTimeout = 12_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 80;
  server.maxRequestsPerSocket = 100;
  server.setTimeout(45_000);
  server.on('clientError', (_error, socket) => {
    if (!socket || !socket.writable) return;
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  return server;
}

module.exports = {
  API_BODY_LIMIT_BYTES,
  MAX_URI_LENGTH,
  inspectBody,
  inspectQuery,
  requestEnvelopeGuard,
  apiRequestGuard,
  bodySafetyGuard,
  configureHttpServer
};
