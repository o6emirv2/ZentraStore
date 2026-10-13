'use strict';

const path = require('node:path');
const root = path.resolve(__dirname, '../..');

function safeCode(value, fallback = 'SERVER_ERROR') {
  const code = String(value || '').replace(/[^A-Za-z0-9_.:/-]/g, '').slice(0, 100);
  return code || fallback;
}

function errorDetails(error) {
  if (!error || typeof error !== 'object') return {};
  const frames = String(error.stack || '').split('\n').slice(1, 9)
    .map((line) => line.match(/([^\s()]+\.(?:c?js|mjs)):(\d+):(\d+)/))
    .filter(Boolean)
    .map((match) => `${match[1].startsWith(root) ? path.relative(root, match[1]) : path.basename(match[1])}:${match[2]}:${match[3]}`);
  return {
    name: safeCode(error.name, 'Error'),
    ...(frames.length ? { frames } : {}),
    ...(error.cause?.code ? { causeCode: safeCode(error.cause.code) } : {})
  };
}

function logError(error, context = {}) {
  const row = {
    timestamp: new Date().toISOString(),
    level: 'error',
    service: 'zentra-store',
    code: safeCode(context.code || error?.code),
    ...errorDetails(error)
  };
  for (const name of ['event', 'requestId', 'method', 'route', 'source', 'providerCode']) {
    if (context[name]) row[name] = safeCode(context[name], 'unknown');
  }
  for (const name of ['status', 'line', 'column']) {
    if (Number.isSafeInteger(context[name])) row[name] = context[name];
  }
  if (Array.isArray(context.missing)) row.missing = context.missing.map((value) => safeCode(value));
  process.stderr.write(`${JSON.stringify(row)}\n`);
}

function requestErrorObserver(req, res, next) {
  const json = res.json;
  res.json = function observedJson(body) {
    if (body?.ok === false || body?.error) {
      res.locals.errorCode = safeCode(body.code || body.error, 'REQUEST_REJECTED');
      if (body && typeof body === 'object' && !body.requestId) body.requestId = req.requestId;
    }
    return json.call(this, body);
  };
  let finished = false;
  res.once('finish', () => {
    finished = true;
    if (res.statusCode < 400 && !res.locals.errorCode) return;
    logError(res.locals.requestError, {
      event: 'http.error',
      code: res.locals.errorCode || `HTTP_${res.statusCode}`,
      method: req.method,
      route: req.route?.path ? `${req.baseUrl || ''}${req.route.path}` : '[unmatched]',
      status: res.statusCode,
      requestId: req.requestId
    });
  });
  res.once('close', () => {
    if (!finished && !res.writableFinished) logError(null, {
      event: 'http.aborted', code: 'RESPONSE_ABORTED', method: req.method, requestId: req.requestId
    });
  });
  next();
}

module.exports = { logError, safeCode, requestErrorObserver };
