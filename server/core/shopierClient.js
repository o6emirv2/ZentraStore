'use strict';

// REST v1 PAT only. There is no invented checkout/session endpoint or legacy form signature.
const { requireShopierConfig } = require('../config/shopier');
const MAX_BODY = 1_048_576;
function shopierError(code, statusCode = 503, extra = {}) { return Object.assign(new Error(code), { code, statusCode, ...extra }); }
function definitiveCreationRejection(error) {
  return error?.uncertain !== true && [400, 401, 402, 403, 404, 405, 410, 413, 414, 415, 422, 429].includes(error?.providerStatus);
}
function providerId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) throw shopierError('SHOPIER_RESPONSE_INVALID', 502);
  return value;
}
function decimalKurus(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,7})(?:\.[0-9]{1,2})?$/.test(value)) throw shopierError('SHOPIER_AMOUNT_INVALID', 409);
  const [whole, fraction = ''] = value.split('.');
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(amount) || amount > 100_000_000) throw shopierError('SHOPIER_AMOUNT_INVALID', 409);
  return amount;
}
function money(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 100_000_000) throw shopierError('SHOPIER_AMOUNT_INVALID', 409);
  return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, '0')}`;
}
function paymentUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && ['shopier.com', 'www.shopier.com'].includes(url.hostname)
      && !url.port && !url.username && !url.password && !url.hash && url.pathname !== '/' && url.href.length <= 2048) return url.href;
  } catch (_) {}
  throw shopierError('SHOPIER_PAYMENT_URL_INVALID', 502);
}
function createShopierClient({ config = requireShopierConfig(), transport = global.fetch } = {}) {
  async function request(method, path, body) {
    if (!/^\/(?:products|orders|refunds|webhooks)(?:\/[A-Za-z0-9_-]{1,100})?(?:\?[A-Za-z0-9_%=&.+:-]+)?$/.test(path)) throw shopierError('SHOPIER_REQUEST_INVALID', 500);
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(shopierError('SHOPIER_TIMEOUT', 504, { uncertain: method === 'POST' })); }, config.timeoutMs); });
    try {
      return await Promise.race([timeout, (async () => {
        const response = await transport(config.apiBaseUrl + path, { method, redirect: 'error', signal: controller.signal,
          headers: { accept: 'application/json', authorization: `Bearer ${config.pat}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        if (!response.ok) {
          const retryAfter = Math.min(3600, Math.max(1, Number(response.headers.get('retry-after')) || 30));
          // Provider bodies may contain personal data or credentials. Never pass them to logs/clients.
          await response.body?.cancel?.();
          const code = response.status === 429 ? 'SHOPIER_RATE_LIMITED' : [401, 403].includes(response.status) ? 'SHOPIER_AUTH_FAILED'
            : method === 'POST' && path === '/products' && [400, 422].includes(response.status) ? 'SHOPIER_REQUEST_REJECTED' : 'SHOPIER_API_ERROR';
          throw shopierError(code, 503, { providerStatus: response.status, retryAfter,
            uncertain: method === 'POST' && (response.status >= 500 || [408, 409].includes(response.status)) });
        }
        const contentType = response.headers.get('content-type') || '';
        if (!/^application\/json\b/i.test(contentType)) throw shopierError('SHOPIER_RESPONSE_INVALID', 502, { uncertain: method === 'POST' });
        let length = 0; const parts = [];
        for await (const part of response.body) {
          length += part.length;
          if (length > MAX_BODY) { controller.abort(); throw shopierError('SHOPIER_RESPONSE_INVALID', 502, { uncertain: method === 'POST' }); }
          parts.push(Buffer.from(part));
        }
        try { return JSON.parse(Buffer.concat(parts).toString('utf8')); }
        catch (_) { throw shopierError('SHOPIER_RESPONSE_INVALID', 502, { uncertain: method === 'POST' }); }
      })()]);
    } catch (error) {
      if (error?.code?.startsWith('SHOPIER_')) throw error;
      throw shopierError(controller.signal.aborted ? 'SHOPIER_TIMEOUT' : 'SHOPIER_CONNECTION_FAILED', 503, { uncertain: method === 'POST' });
    } finally { clearTimeout(timer); }
  }
  const list = async (path, query) => {
    const result = await request('GET', `${path}?${new URLSearchParams(query)}`);
    if (!Array.isArray(result) || result.length > 50) throw shopierError('SHOPIER_RESPONSE_INVALID', 502);
    return result;
  };
  return {
    createProduct: (body) => request('POST', '/products', body),
    getProduct: (id) => request('GET', `/products/${providerId(id)}`),
    updateProduct: (id, body) => request('PUT', `/products/${providerId(id)}`, body),
    listProducts: (query) => list('/products', query),
    getOrder: (id) => request('GET', `/orders/${providerId(id)}`),
    listOrders: (query) => list('/orders', query),
    getRefund: (id) => request('GET', `/refunds/${providerId(id)}`),
    listWebhooks: () => request('GET', '/webhooks'),
    createWebhook: (body) => request('POST', '/webhooks', body)
  };
}
module.exports = { definitiveCreationRejection, createShopierClient, shopierError, providerId, decimalKurus, money, paymentUrl };
