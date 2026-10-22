import { SHOPIER_TOPUP_LIMITS } from './shopier-availability.js?v=zentra-ui-v84r1';
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
  const kinds = ['purchase', 'wallet_topup'];
  const legacyKey = (uid) => `zentra-shopier-attempt-v1:${uid}`;
  const key = (uid, kind) => `zentra-shopier-attempt-v2:${uid}:${kind}`;
  const read = (name) => {
    try { return JSON.parse(storage.getItem(name) || 'null'); } catch (_) { return null; }
  };
  function valid(value, uid, kind) {
    return value?.uid === uid && (value.kind || 'purchase') === kind
      && /^[A-Za-z0-9_.:-]{12,160}$/.test(value.body?.idempotencyKey || '')
      && (kind === 'wallet_topup' ? Number.isSafeInteger(value.body.amountKurus) : Array.isArray(value.body.items));
  }
  function pending(uid, kind = 'purchase') {
    if (!uid) return null;
    if (!kinds.includes(kind)) throw new TypeError('Unknown payment purpose');
    const current = read(key(uid, kind));
    if (valid(current, uid, kind)) return current;
    const legacy = read(legacyKey(uid));
    if (!valid(legacy, uid, kind)) return null;
    const migrated = { ...legacy, kind };
    try {
      storage.setItem(key(uid, kind), JSON.stringify(migrated));
      storage.removeItem(legacyKey(uid));
    } catch (_) { /* Recover the original key even when migration storage is unavailable. */ }
    return migrated;
  }
  function forget(uid, kind = 'purchase') {
    try {
      storage.removeItem(key(uid, kind));
      if (valid(read(legacyKey(uid)), uid, kind)) storage.removeItem(legacyKey(uid));
    } catch (_) {}
  }
  function resultFor(result, attempt) {
    if (result.order && (result.order.orderType || 'purchase') !== attempt.kind) {
      throw Object.assign(new Error('İşlem türü doğrulanamadı. İşlem geçmişinden kontrol edin.'), { code: 'SHOPIER_ATTEMPT_KIND_MISMATCH' });
    }
    if (['paid', 'refunded', 'failed', 'cancelled'].includes(result.order?.paymentState)) forget(attempt.uid, attempt.kind);
    return { ...result, attemptedItems: attempt.body.items || [], purpose: attempt.kind };
  }
  async function check(uid, kind = 'purchase') {
    const attempt = pending(uid, kind);
    if (!attempt) return null;
    const result = await request(`/api/payments/shopier/attempt?idempotencyKey=${encodeURIComponent(attempt.body.idempotencyKey)}`);
    if (result.found) return resultFor(result, attempt);
    return { found: false, attemptedItems: attempt.body.items || [] };
  }
  async function begin(uid, body, kind = 'purchase') {
    let attempt = pending(uid, kind);
    if (attempt) {
      const result = await check(uid, kind);
      if (result?.found) return result;
    } else {
      attempt = { uid, kind, body: { ...body, idempotencyKey: `${kind}:${createId()}` } };
      try { storage.setItem(key(uid, kind), JSON.stringify(attempt)); }
      catch (_) { throw Object.assign(new Error('Tarayıcı işlem kaydını saklayamadı. Sekmeyi açık tutup tarayıcı depolama iznini kontrol edin.'), { code: 'SHOPIER_ATTEMPT_STORAGE_REQUIRED' }); }
    }
    // An explicit retry always sends the same persisted body and key; no automatic financial POST retry.
    const result = await request(attempt.kind === 'wallet_topup' ? '/api/payments/shopier/topups' : '/api/payments/shopier/create', { method: 'POST', body: attempt.body, timeoutMs: 30_000 });
    return resultFor(result, attempt);
  }
  const start = (uid, items, promotionCode = '') => begin(uid, { items, ...(promotionCode ? { promotionCode } : {}) });
  const startTopup = (uid, amountKurus) => begin(uid, { amountKurus }, 'wallet_topup');
  return { pending, start, startTopup, check, forget, pendingKinds: (uid) => kinds.filter(kind => pending(uid, kind)) };
}
