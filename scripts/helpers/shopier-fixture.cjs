'use strict';
const crypto = require('node:crypto');
function shopierFixture() {
  const original = global.fetch, products = new Map(), orders = new Map(), refunds = new Map(), calls = [];
  let nextError = null, sequence = 1000;
  const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  global.fetch = async (address, options = {}) => {
    const url = new URL(address);
    if (url.origin !== 'https://api.shopier.com') return original(address, options);
    const method = options.method || 'GET', path = url.pathname.replace('/v1', '');
    calls.push({ method, path, query: Object.fromEntries(url.searchParams), body: options.body ? JSON.parse(options.body) : null });
    if (nextError) { const action = nextError; nextError = null; return action(address, options); }
    if (path === '/products' && method === 'POST') {
      const body = JSON.parse(options.body), id = String(++sequence), product = { id, ...body, url: `https://www.shopier.com/${id}` };
      products.set(id, product); return response(product);
    }
    if (/^\/products\//.test(path)) {
      const id = path.split('/')[2], product = products.get(id);
      if (!product) return response({}, 404);
      if (method === 'PUT') Object.assign(product, JSON.parse(options.body));
      return response(product);
    }
    if (path === '/products') return response([...products.values()].slice((Number(url.searchParams.get('page') || 1) - 1) * 50, Number(url.searchParams.get('page') || 1) * 50));
    if (path === '/orders') return response([...orders.values()].filter((row) => row.lineItems.some((line) => line.productId === url.searchParams.get('productId'))));
    if (path.startsWith('/orders/')) return orders.has(path.split('/')[2]) ? response(orders.get(path.split('/')[2])) : response({}, 404);
    if (path.startsWith('/refunds/')) return refunds.has(path.split('/')[2]) ? response(refunds.get(path.split('/')[2])) : response({}, 404);
    throw new Error('Unexpected mocked Shopier request: ' + method + ' ' + path);
  };
  function paid(productId, extra = {}) {
    const product = products.get(productId), id = String(++sequence);
    const row = { id, status: 'unfulfilled', paymentStatus: 'paid', currency: 'TRY', paymentMethod: 'creditCard',
      shippingInfo: { email: 'member@zentra.invalid' },
      totals: { total: product.priceData.price, subtotal: product.priceData.price, shipping: '0.00', discount: '0.00' },
      lineItems: [{ productId, title: product.title, type: 'digital', quantity: 1, price: product.priceData.price, total: product.priceData.price, selection: [], options: [] }], refunds: [], ...extra };
    orders.set(id, row); product.stockQuantity = 0; return row;
  }
  function signed(event, data, { token = event.startsWith('refund.') ? process.env.SHOPIER_REFUND_WEBHOOK_TOKEN : process.env.SHOPIER_WEBHOOK_TOKEN, encoding = 'hex', space = 0 } = {}) {
    const raw = JSON.stringify(data, null, space);
    return { raw, signature: crypto.createHmac('sha256', token).update(raw).digest(encoding) };
  }
  return { products, orders, refunds, calls, paid, signed, response,
    failNext: (action) => { nextError = action; }, close: () => { global.fetch = original; } };
}
module.exports = { shopierFixture };
