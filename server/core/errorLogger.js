'use strict';

const crypto = require('node:crypto');

function identifier(value, fallback = '') {
  const source = String(value || '');
  return /^[A-Za-z0-9_.:/-]{1,100}$/.test(source) ? source : fallback;
}

function frames(error) {
  return String(error?.stack || '').split('\n').slice(1, 9).map((line) => {
    const match = line.match(/(?:\(|\s)([^\s()]+\.c?js):(\d+):(\d+)\)?$/);
    if (!match) return '';
    return `${match[1].split(/[\\/]/).at(-1)}:${match[2]}:${match[3]}`;
  }).filter(Boolean);
}

function logError(code, { error, requestId, method, route, status, durationMs, fields = {} } = {}) {
  const record = {
    level: 'error', time: new Date().toISOString(),
    code: identifier(code, 'INTERNAL_ERROR'),
    ...(requestId ? { requestId: identifier(requestId) } : {}),
    ...(method ? { method: identifier(method) } : {}),
    ...(route ? { route: identifier(route, 'unmatched') } : {}),
    ...(status ? { status: Number(status) } : {}),
    ...(durationMs !== undefined ? { durationMs: Math.max(0, Math.round(durationMs)) } : {}),
    ...(error ? { causeCode: identifier(error.code, 'UNKNOWN'), frames: frames(error) } : {}),
    ...fields
  };
  // Never log request bodies, URL queries, tokens, identity details or secret values.
  process.stderr.write(JSON.stringify(record) + '\n');
  return record;
}

function logDependencyError(code, error) {
  logError(code, { error });
}

function observeErrors(req, res, next) {
  const started = performance.now();
  req.requestId = `req_${crypto.randomUUID()}`;
  res.setHeader('X-Request-Id', req.requestId);
  const sendJson = res.json;
  res.json = function (payload) {
    if (res.statusCode >= 400 && payload && typeof payload === 'object') {
      res.locals.errorCode = identifier(payload.code || payload.error, `HTTP_${res.statusCode}`);
      payload = { ...payload, requestId: req.requestId };
    }
    return sendJson.call(this, payload);
  };
  res.once('finish', () => {
    if (res.statusCode < 400) return;
    const route = typeof req.route?.path === 'string' ? `${req.baseUrl || ''}${req.route.path}` : 'unmatched';
    logError(res.locals.errorCode || `HTTP_${res.statusCode}`, {
      requestId: req.requestId, method: req.method, route,
      status: res.statusCode, durationMs: performance.now() - started,
      error: res.locals.failure
    });
  });
  res.once('close', () => {
    if (!res.writableFinished) logError('HTTP_CONNECTION_CLOSED', { requestId: req.requestId, method: req.method });
  });
  next();
}

module.exports = { logError, logDependencyError, observeErrors, identifier };
