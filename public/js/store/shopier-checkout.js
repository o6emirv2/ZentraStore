import { SHOPIER_TOPUP_LIMITS } from './shopier-availability.js?v=zentra-ui-v83r1';
export function verifiedShopierUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !['shopier.com', 'www.shopier.com'].includes(url.hostname)
    || url.port || url.username || url.password || url.hash || url.pathname === '/' || url.href.length > 2048) throw Object.assign(new Error('Ödeme bağlantısı doğrulanamadı.'), { code: 'SHOPIER_PAYMENT_URL_INVALID' });
  return url.href;
}

export function parseTopupAmount(value, { minKurus = SHOPIER_TOPUP_LIMITS.minKurus, maxKurus = SHOPIER_TOPUP_LIMITS.maxKurus } = {}) {
  const raw = String(value || '').trim();
  if (!/^\d{1,5}(?:[.,]\d{1,2})?$/.test(raw)) throw Object.assign(new Error('Yüklenecek tutarı TL olarak girin.'), { code: 'SHOPIER_TOPUP_AMOUNT_INVALID' });
  const [whole, fraction = ''] = raw.replace(',', '.').split('.');
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(amount) || amount < minKurus || amount > maxKurus) throw Object.assign(new Error('Yükleme tutarı izin verilen aralıkta değil.'), { code: 'SHOPIER_TOPUP_AMOUNT_INVALID' });
  return amount;
}

export function createShopierCheckout({ request, storage, createId }) {
  const key = (uid) => `zentra-shopier-attempt-v1:${uid}`;
  function pending(uid) {
    if (!uid) return null;
    try {
      const value = JSON.parse(storage.getItem(key(uid)) || 'null');
      return value?.uid === uid && typeof value.body?.idempotencyKey === 'string'
        && (value.kind === 'wallet_topup' ? Number.isSafeInteger(value.body.amountKurus) : Array.isArray(value.body.items)) ? value : null;
    } catch (_) { return null; }
  }
  function forget(uid) { try { storage.removeItem(key(uid)); } catch (_) {} }
  async function check(uid) {
    const attempt = pending(uid);
    if (!attempt) return null;
    const result = await request(`/api/payments/shopier/attempt?idempotencyKey=${encodeURIComponent(attempt.body.idempotencyKey)}`);
    if (result.found) {
      if (['paid', 'refunded', 'failed', 'cancelled'].includes(result.order?.paymentState)) forget(uid);
      return { ...result, attemptedItems: attempt.body.items || [] };
    }
    return { found: false, attemptedItems: attempt.body.items || [] };
  }
  async function begin(uid, body, kind = 'purchase') {
    let attempt = pending(uid);
    if (attempt) {
      const result = await check(uid);
      if (result?.found) return result;
    } else {
      attempt = { uid, kind, body: { ...body, idempotencyKey: createId() } };
      try { storage.setItem(key(uid), JSON.stringify(attempt)); }
      catch (_) { throw Object.assign(new Error('Tarayıcı işlem kaydını saklayamadı. Sekmeyi açık tutup tarayıcı depolama iznini kontrol edin.'), { code: 'SHOPIER_ATTEMPT_STORAGE_REQUIRED' }); }
    }
    // An explicit retry always sends the same persisted body and key; no automatic financial POST retry.
    const result = await request(attempt.kind === 'wallet_topup' ? '/api/payments/shopier/topups' : '/api/payments/shopier/create', { method: 'POST', body: attempt.body, timeoutMs: 30_000 });
    if (['paid', 'refunded', 'failed', 'cancelled'].includes(result.order?.paymentState)) forget(uid);
    return { ...result, attemptedItems: attempt.body.items || [] };
  }
  const start = (uid, items, promotionCode = '') => begin(uid, { items, ...(promotionCode ? { promotionCode } : {}) });
  const startTopup = (uid, amountKurus) => begin(uid, { amountKurus }, 'wallet_topup');
  return { pending, start, startTopup, check, forget };
}
