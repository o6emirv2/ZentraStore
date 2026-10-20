'use strict';

const env = require('./env');
const API_BASE = 'https://api.shopier.com/v1';
const WEBHOOK_PATH = '/api/payments/shopier/webhook';

function secret(value) {
  return typeof value === 'string' && value.length >= 16 && value.length <= 4096
    && !/[\s<>]/.test(value) && !/replace|placeholder|yeni_|gizli_|buraya|change.?me/i.test(value);
}
function httpsUrl(value, origin, path) {
  try {
    const url = new URL(value);
    const secure = url.protocol === 'https:' || (env.nodeEnv !== 'production' && url.protocol === 'http:' && url.hostname === '127.0.0.1');
    return secure && !url.username && !url.password && !url.search && !url.hash
      && url.origin === origin && url.pathname === path ? url.href : '';
  } catch (_) { return ''; }
}
function getShopierConfig(source = process.env) {
  const enabled = source.SHOPIER_ENABLED === 'true';
  const blockers = [];
  if (source.SHOPIER_ENABLED && !['true', 'false'].includes(source.SHOPIER_ENABLED)) blockers.push('SHOPIER_ENABLED');
  const apiBaseUrl = source.SHOPIER_API_BASE_URL || API_BASE;
  if (apiBaseUrl !== API_BASE) blockers.push('SHOPIER_API_BASE_URL');
  const pat = source.SHOPIER_PAT || '', webhookToken = source.SHOPIER_WEBHOOK_TOKEN || '';
  const refundWebhookToken = source.SHOPIER_REFUND_WEBHOOK_TOKEN || '';
  if (!secret(pat)) blockers.push('SHOPIER_PAT');
  if (!secret(webhookToken) || webhookToken === pat) blockers.push('SHOPIER_WEBHOOK_TOKEN');
  if (!secret(refundWebhookToken) || refundWebhookToken === pat || refundWebhookToken === webhookToken) blockers.push('SHOPIER_REFUND_WEBHOOK_TOKEN');
  const publicBaseUrl = source.WEQ_PUBLIC_BASE_URL || env.publicBaseUrl;
  let publicOrigin = '';
  try {
    const url = new URL(publicBaseUrl);
    const secure = url.protocol === 'https:' || (env.nodeEnv !== 'production' && url.protocol === 'http:' && url.hostname === '127.0.0.1');
    if (secure && url.origin === env.publicBaseUrl && url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password) publicOrigin = url.origin;
  } catch (_) {}
  if (!publicOrigin) blockers.push('WEQ_PUBLIC_BASE_URL');
  const webhookUrl = httpsUrl(source.SHOPIER_WEBHOOK_URL || '', env.serviceOrigin, WEBHOOK_PATH);
  if (!webhookUrl) blockers.push('SHOPIER_WEBHOOK_URL');
  const successUrl = httpsUrl(source.SHOPIER_SUCCESS_URL || `${publicOrigin}/odeme/sonuc`, publicOrigin, '/odeme/sonuc');
  const cancelUrl = httpsUrl(source.SHOPIER_CANCEL_URL || `${publicOrigin}/odeme/iptal`, publicOrigin, '/odeme/iptal');
  if (!successUrl) blockers.push('SHOPIER_SUCCESS_URL');
  if (!cancelUrl) blockers.push('SHOPIER_CANCEL_URL');
  const timeoutMs = Number(source.SHOPIER_HTTP_TIMEOUT_MS || 15000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 20000) blockers.push('SHOPIER_HTTP_TIMEOUT_MS');
  return { enabled, configured: blockers.length === 0, blockers, pat, webhookToken, refundWebhookToken,
    apiBaseUrl, publicBaseUrl: publicOrigin, webhookUrl, successUrl, cancelUrl, timeoutMs };
}
function shopierReadiness() {
  const { enabled, configured, blockers, refundWebhookToken } = getShopierConfig();
  return { enabled, configured, available: enabled && configured, refundNotifications: !!refundWebhookToken,
    blockers, mode: 'pat-product-link' };
}
function requireShopierConfig({ creating = false } = {}) {
  const config = getShopierConfig();
  if (creating && !config.enabled) throw Object.assign(new Error('SHOPIER_DISABLED'), { code: 'SHOPIER_DISABLED', statusCode: 503 });
  if (!config.configured) throw Object.assign(new Error('SHOPIER_CONFIGURATION_INVALID'), { code: 'SHOPIER_CONFIGURATION_INVALID', statusCode: 503 });
  return config;
}
module.exports = { API_BASE, WEBHOOK_PATH, getShopierConfig, shopierReadiness, requireShopierConfig };
