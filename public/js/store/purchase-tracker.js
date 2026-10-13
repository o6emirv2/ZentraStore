const STORAGE_KEY = 'zentra-pending-purchase-v1';

function validAttempt(value, uid) {
  return value && value.uid === uid && typeof value.body?.idempotencyKey === 'string'
    && value.body.idempotencyKey.length >= 12 && value.body.idempotencyKey.length <= 160
    && ['wallet', 'telegram'].includes(value.body.paymentMethod)
    && Array.isArray(value.body.items) && value.body.items.length > 0 && value.body.items.length <= 20
    && value.body.items.every((item) => typeof item.productId === 'string' && item.productId.length <= 80
      && typeof item.planKey === 'string' && item.planKey.length <= 40
      && Number.isSafeInteger(item.quantity) && item.quantity >= 1 && item.quantity <= 5);
}

export function createPurchaseTracker({ api, userId, storage } = {}) {
  if (!storage) {
    try { storage = window.sessionStorage; } catch (_) {}
  }
  let current = null;
  let checking = null;
  function pending() {
    const uid = String(userId() || '');
    if (!uid) return null;
    if (current && validAttempt(current, uid)) return current;
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (!raw || raw.length > 12_000) return null;
      const saved = JSON.parse(raw);
      if (validAttempt(saved, uid)) current = saved;
    } catch (_) {}
    return validAttempt(current, uid) ? current : null;
  }
  function start(body, options = {}) {
    const attempt = {
      uid: String(userId() || ''),
      body: { items: body.items.map(({ productId, planKey, quantity }) => ({ productId, planKey, quantity })),
        paymentMethod: body.paymentMethod, idempotencyKey: body.idempotencyKey,
        ...(body.promotionCode ? { promotionCode: body.promotionCode } : {}) },
      clearCart: options.clearCart === true,
      createdAt: Date.now()
    };
    if (!validAttempt(attempt, attempt.uid)) throw new Error('Invalid purchase attempt');
    current = attempt;
    try { storage.setItem(STORAGE_KEY, JSON.stringify(attempt)); } catch (_) {}
    return attempt;
  }
  function finish(attempt) {
    if (current?.body.idempotencyKey !== attempt?.body.idempotencyKey) return;
    current = null;
    try { storage.removeItem(STORAGE_KEY); } catch (_) {}
  }
  function clear() {
    current = null;
    try { storage.removeItem(STORAGE_KEY); } catch (_) {}
  }
  async function verify(attempt = pending()) {
    if (!attempt || attempt.uid !== String(userId() || '')) return null;
    if (checking) return checking;
    const operation = (async () => {
      for (let index = 0; index < 3; index++) {
        if (attempt.uid !== String(userId() || '')) return null;
        if (index) await new Promise((resolve) => setTimeout(resolve, index * 700));
        try {
          const payload = await api(`/api/store/order-attempt?key=${encodeURIComponent(attempt.body.idempotencyKey)}`, { timeoutMs: 6500 });
          if (attempt.uid !== String(userId() || '')) return null;
          if ((payload.found === true && payload.order) || payload.cancelled === true) return payload;
        } catch (error) {
          if ([401, 403].includes(error?.status)) throw error;
        }
      }
      return null;
    })();
    checking = operation;
    try { return await operation; }
    finally { if (checking === operation) checking = null; }
  }
  return Object.freeze({ pending, start, finish, clear, verify });
}
