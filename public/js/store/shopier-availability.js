export const SHOPIER_TOPUP_LIMITS = Object.freeze({ minKurus: 10000, maxKurus: 1000000 });
export function normalizeShopierAvailability(source = {}) {
  const value = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
  const status = ['ready', 'disabled', 'maintenance', 'unavailable'].includes(value.status) ? value.status
    : value.status !== undefined ? 'unavailable' : value.available === true || value.topupAvailable === true ? 'ready' : 'disabled';
  return Object.freeze({ status, available: status === 'ready' && value.available === true,
    topupAvailable: status === 'ready' && value.topupAvailable === true, topupLimits: SHOPIER_TOPUP_LIMITS });
}
export function shopierUnavailableMessage(availability, { checking = false, topup = false } = {}) {
  if (checking) return 'Shopier ödeme durumu kontrol ediliyor…';
  const status = normalizeShopierAvailability(availability).status;
  if (status === 'unavailable') return 'Ödeme bağlantısı doğrulanamadı. Bağlantınızı kontrol edip durumu yenileyin.';
  if (status === 'maintenance') return 'Mağaza bakımda. Ödeme durumunu daha sonra yenileyebilirsiniz.';
  return topup ? 'Shopier ile bakiye yükleme şu anda kapalı.' : 'Kartla ödeme şu anda kapalı. Diğer sipariş yöntemlerini kullanabilirsiniz.';
}
export function createShopierAvailabilityRefresh({ load, onUpdate, onLoading = () => {}, now = Date.now, ttlMs = 15000 }) {
  let pending = null, checkedAt = null;
  return function refresh({ force = false } = {}) {
    if (pending) return pending;
    if (!force && checkedAt !== null && now() - checkedAt < ttlMs) return Promise.resolve(null);
    onLoading(true);
    pending = Promise.resolve().then(load).then(catalog => {
      if (!catalog || catalog.stale) throw new Error('CATALOG_UNAVAILABLE');
      const availability = normalizeShopierAvailability(catalog.payments?.shopier);
      onUpdate(availability, catalog); checkedAt = now(); return availability;
    }).catch(() => {
      const availability = normalizeShopierAvailability({ status: 'unavailable' });
      onUpdate(availability); checkedAt = null; return availability;
    }).finally(() => { pending = null; onLoading(false); });
    return pending;
  };
}
