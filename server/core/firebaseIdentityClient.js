'use strict';

const env = require('../config/env');
const CONFIGURATION_ERRORS = /API_KEY_(?:INVALID|HTTP_REFERRER_BLOCKED|SERVICE_BLOCKED)|PROJECT_NOT_FOUND|CONFIGURATION_NOT_FOUND|OPERATION_NOT_ALLOWED|SERVICE_DISABLED|API_KEY_NOT_VALID|PASSWORD_LOGIN_DISABLED|API KEY NOT VALID/;
function failure(code, statusCode = 503) { return Object.assign(new Error(code), { code, statusCode }); }

async function identityRequest(action, body) {
  if (!['signInWithPassword', 'sendOobCode'].includes(action)) throw failure('AUTH_UNAVAILABLE');
  if (env.configurationReport?.().capabilities?.identity === false) throw failure('AUTH_PROVIDER_CONFIGURATION_INVALID');
  const apiKey = String(env.firebase.identityApiKey || env.firebase.publicConfig.apiKey || '').trim();
  if (!apiKey) throw failure('AUTH_UNAVAILABLE');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:${action}?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body), signal: controller.signal, redirect: 'error'
    });
    const payload = await response.json().catch(() => null);
    const reasons = [payload?.error?.message, ...(Array.isArray(payload?.error?.details) ? payload.error.details.map(entry => entry.reason) : [])].join(' ').toUpperCase();
    if (!response.ok && CONFIGURATION_ERRORS.test(reasons)) throw failure('AUTH_PROVIDER_CONFIGURATION_INVALID');
    return { ok: response.ok, status: Number(response.status || (response.ok ? 200 : 400)), payload: payload || {} };
  } catch (error) {
    if (error.code === 'AUTH_PROVIDER_CONFIGURATION_INVALID') throw error;
    throw failure('AUTH_UNAVAILABLE');
  } finally { clearTimeout(timer); }
}

module.exports = { identityRequest };
