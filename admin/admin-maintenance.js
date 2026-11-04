import { escapeHtml } from './admin-core.js?v=zentra-ui-v88r1';
import { openAdminDialog } from './admin-dialogs.js?v=zentra-ui-v88r1';

export const ORDER_BULK_ACTIONS = Object.freeze([
  ['cancel_telegram', 'Tüm Telegram Siparişlerini İptal Et'],
  ['cancel_shopier', 'Tüm Shopier Siparişlerini İptal Et'],
  ['cancel_delete_all', 'Tüm Telegram Ve Shopier Siparişlerini İptal Et Ve Kalıcı Olarak Tamamen Sil'],
  ['cancel_all', 'Tüm Telegram Ve Shopier Siparişlerini İptal Et'],
  ['delete_refunded', 'Tüm İade Edilen Siparişlerini Kalıcı Olarak Tamamen Sil (Her Yerden Sil)'],
  ['delete_cancelled', 'Tüm İptal Edilen Siparişlerini Kalıcı Olarak Tamamen Sil (Her Yerden Sil)']
]);
const REASONS = Object.freeze({
  ALREADY_FINAL: 'Zaten sonuçlanmış', DELIVERED_OR_PROTECTED: 'Teslim edilmiş veya korunan kayıt',
  EXTERNAL_PAYMENT_REVIEW_REQUIRED: 'Harici ödeme / iade doğrulaması gerekli', REFUND_NOT_VERIFIED: 'İade henüz doğrulanmadı',
  EXTERNAL_REFUND_NOT_VERIFIED: 'Harici iade referansı doğrulanmadı', PROTECTED_SECURITY_OR_FINANCIAL_RECORD: 'Korunan güvenlik / finans kaydı',
  UNKNOWN_RECORD_RETENTION_REQUIRED: 'Kayıt türünün saklama gereksinimi doğrulanmadı; korundu',
  RETENTION_PERIOD_ACTIVE: 'Saklama süresi devam ediyor', RETENTION_HOLD: 'Kayıt saklama altında', RESERVATION_ACTIVE: 'Aktif rezervasyon var',
  PROVIDER_REVIEW_PENDING: 'Sağlayıcı doğrulaması bekleniyor', STATE_CHANGED_AFTER_PREVIEW: 'Önizlemeden sonra değişti',
  PROVIDER_VERIFICATION_REQUIRED: 'Sağlayıcı sonucu bekleniyor; işlem tekrarlanmıyor', LINK_CLOSED_GRACE_PERIOD: 'Bağlantı kapatıldı; son kontrol bekleniyor',
  PROVIDER_MANUAL_REVIEW_REQUIRED: 'Sağlayıcı sonucu kesinleşmedi; otomatik deneme durduruldu, yönetici kontrolü gerekli',
  REFUND_PENDING: 'İade sağlayıcıda işleniyor', SHOPIER_TIMEOUT: 'Sağlayıcı zaman aşımı; yeniden sorgulanacak',
  CANCELLED: 'İptal edildi', REFUNDED: 'İade tamamlandı', DELETED: 'Silindi',
  DELETED_FINANCIAL_EVIDENCE_RETAINED: 'Sipariş kaldırıldı; zorunlu finans kayıtları korundu', ALREADY_REMOVED: 'Daha önce kaldırılmış',
  SHOPIER_REFUND_FAILED_REVIEW_REQUIRED: 'Sağlayıcı iadesi başarısız; otomatik yeni iade gönderilmez, yönetici incelemesi gerekli',
  SHOPIER_DELIVERED_REFUND_REVIEW_REQUIRED: 'Teslim edilen ürün için tekil iade incelemesi gerekli',
  WALLET_REFUND_NOT_VERIFIED: 'Bakiye iadesi doğrulanmadı', PROVIDER_CANCELLATION_NOT_VERIFIED: 'Sağlayıcı iptali kesinleşmedi'
});
const PHASE = { preparing: 'Kapsam hesaplanıyor', ready: 'Onay bekliyor', running: 'İşlem devam ediyor', completed: 'İşlem sonuçlandı', paused: 'İşlem duraklatıldı' };
export function createMaintenanceController({ host, scope = 'orders', request, authorize, canWrite, identity, toast, onChanged }) {
  let current = null, results = [], cursor = '', timer, stopped = false, busy = false, confirming = false;
  const controls = document.createElement('div'); controls.className = 'bulk-actions';
  const progress = document.createElement('section'); progress.className = 'maintenance-progress'; progress.hidden = true;
  progress.setAttribute('aria-label', 'Toplu işlem durumu');
  const actions = scope === 'audit' ? [['delete_audit', 'Tüm Denetimleri Kalıcı Olarak Tamamen Sil']] : ORDER_BULK_ACTIONS;
  controls.innerHTML = actions.map(([key, label]) => `<button type="button" class="secondary-action" data-bulk-operation="${key}">${escapeHtml(label)}</button>`).join('');
  host.append(controls, progress);
  const key = () => `zentra-maintenance:${identity()}:${scope}`;
  function remember(id) { try { localStorage.setItem(key(), id); } catch (_) {} }
  function render() {
    controls.querySelectorAll('button').forEach(button => { button.disabled = busy || !canWrite() || ['preparing', 'running'].includes(current?.state); });
    if (!current) return;
    progress.hidden = false;
    const wasOpen = progress.querySelector('details')?.open === true;
    const job = current;
    const channelNames = { telegram: 'Telegram', shopier: 'Shopier', wallet: 'Bakiye', audit: 'Mağaza denetimi', adminAudit: 'Yönetim denetimi' };
    const channels = Object.entries(job.channels || {}).map(([name, row]) => `<div><strong>${escapeHtml(channelNames[name] || name)}</strong><span>${row.succeeded || 0} başarılı · ${row.failed || 0} başarısız · ${row.skipped || 0} kapsam dışı</span></div>`).join('');
    progress.innerHTML = `<header><h3>${escapeHtml(PHASE[job.state] || job.state)}</h3><small>İşlem: …${escapeHtml(job.id.slice(-12))}</small></header><progress max="${Math.max(1, job.total)}" value="${job.completed || 0}">${job.completed || 0}/${job.total}</progress><p role="status" aria-live="polite">${job.total} hedef · ${job.completed || 0} sonuçlandı · ${job.succeeded || 0} başarılı · ${job.failed || 0} başarısız · ${job.skipped || 0} kapsam dışı</p><div class="maintenance-channels">${channels}</div>${job.state === 'running' ? '<p>Bekleyen sağlayıcı işlemleri kesinleşmeden başarılı sayılmaz. Sayfayı kapatsanız da sunucu kaldığı yerden devam eder.</p>' : ''}${job.error ? `<p role="alert">${escapeHtml(job.error)}</p>` : ''}${['ready', 'paused'].includes(job.state) ? '<button type="button" class="primary-action" data-review-job>Önizlemeyi Aç ve İncele</button>' : ''}<details><summary>Sipariş / kayıt sonuçları (${results.length} gösteriliyor)</summary><ul class="maintenance-results">${results.map(row => `<li><strong>${escapeHtml(row.reference)}</strong><span>${escapeHtml(REASONS[row.code || row.result] || row.code || row.result || ({ queued: 'Sırada', waiting: 'Doğrulama bekleniyor', skipped: 'Kapsam dışı', failed: 'Başarısız', succeeded: 'Doğrulandı' }[row.state]) || row.state)}</span></li>`).join('')}</ul>${cursor || results.length === 0 && job.total > 0 ? '<button type="button" class="secondary-action" data-more-results>Diğer sonuçları yükle</button>' : ''}</details>`;
    if (wasOpen) progress.querySelector('details')?.setAttribute('open', '');
    progress.querySelector('[data-review-job]')?.addEventListener('click', () => void confirm());
    progress.querySelector('[data-more-results]')?.addEventListener('click', async event => {
      event.currentTarget.disabled = true;
      try { const next = await request(`/api/admin/store/maintenance/${job.id}?cursor=${encodeURIComponent(cursor)}`); results.push(...next.results); cursor = next.nextCursor; render(); }
      catch (error) { toast('error', 'Sonuçlar okunamadı', error.message); event.currentTarget.disabled = false; }
    });
  }
  async function refresh(schedule = true) {
    clearTimeout(timer);
    if (!current || stopped) return;
    try {
      const response = await request(`/api/admin/store/maintenance/${current.id}?results=0`);
      const changed = current.completed !== response.job.completed || current.state !== response.job.state;
      current = response.job;
      if (changed && current.state === 'completed') { const detail = await request(`/api/admin/store/maintenance/${current.id}`); results = detail.results || []; cursor = detail.nextCursor || ''; }
      render();
      if (changed && current.state === 'completed') await onChanged?.();
    } catch (error) { toast('error', 'Toplu işlem durumu okunamadı', `${error.message} İşlem kimliği korunuyor; sayfayı yenileyerek yeniden kontrol edin.`); }
    if (schedule && ['preparing', 'running'].includes(current.state)) timer = setTimeout(() => refresh(), 2500);
  }
  async function confirm() {
    if (!current || !['ready', 'paused'].includes(current.state) || confirming) return;
    confirming = true;
    const job = current;
    try {
      const confirmed = await openAdminDialog({ title: 'Toplu Sipariş İşlemi',
        description: scope === 'audit' ? 'Yalnızca saklama süresi bitmiş ve korunmayan operasyon denetimleri silinir. Finans ve güvenlik kayıtları korunur.' : 'Seçilen işlem Telegram ve/veya Shopier siparişlerinizi etkileyecektir. Ücret alınmış uygun Shopier işlemleri iade sürecine girer.',
        confirmLabel: 'İşlemi Onayla', destructive: job.permanent,
        content: `<dl class="operation-summary"><div><dt>Toplam hedeflenen kayıt</dt><dd>${job.total}</dd></div><div><dt>İptal edilebilir</dt><dd>${job.cancellable}</dd></div><div><dt>İşlem dışında</dt><dd>${job.excluded}</dd></div><div><dt>Silme kapsamına alınabilecek</dt><dd>${job.deletable}</dd></div><div><dt>İade gerektiren Shopier kaydı</dt><dd>${job.refunds}</dd></div><div><dt>Geri alınabilirlik</dt><dd>${job.permanent ? 'Kalıcı silme geri alınamaz' : 'İptal / iade geri alınamaz'}</dd></div></dl><p class="operation-note">Kapsam, önizleme oluşturulduğu andaki kayıtlardır. Değişen ve doğrulanamayan kayıtlar işlenmez. Harici platform kayıtlarının silindiği iddia edilmez. Finansal kanıtlar ve tek kullanımlık işlem kayıtları korunur.</p>${job.permanent ? '<label class="operation-field"><span>İkinci doğrulama: KALICI SIL yazın</span><input name="confirmation" required autocomplete="off" pattern="KALICI SIL"/></label>' : ''}`,
        collect: form => ({ confirmation: job.permanent ? form.elements.confirmation.value.trim() : '' }) });
      if (!confirmed || !(await authorize())) return;
      const result = await request(`/api/admin/store/maintenance/${job.id}/${scope}/confirm`, { method: 'POST', body: confirmed, timeoutMs: 30_000 });
      current = result.job; results = result.results || []; cursor = result.nextCursor || ''; render(); await refresh();
    } catch (error) { toast('error', 'Toplu işlem başlatılamadı', error.message); await refresh(); }
    finally { confirming = false; }
  }
  controls.addEventListener('click', async event => {
    const operation = event.target.closest('[data-bulk-operation]')?.dataset.bulkOperation;
    if (!operation || busy || !canWrite()) return;
    busy = true; render();
    try {
      const result = await request('/api/admin/store/maintenance/preview', { method: 'POST', body: { operation, idempotencyKey: crypto.randomUUID() } });
      current = result.job; remember(current.id); render();
      await refresh(false);
      const reviewWhenReady = () => {
        if (stopped || !current) return;
        if (current.state === 'ready') void confirm();
        else if (current.state === 'preparing') timer = setTimeout(async () => { await refresh(false); reviewWhenReady(); }, 1500);
      };
      clearTimeout(timer); reviewWhenReady();
    } catch (error) { toast('error', 'Önizleme oluşturulamadı', error.message); }
    finally { busy = false; render(); }
  });
  async function resume() {
    if (!canWrite()) { render(); return; }
    let id = ''; try { id = localStorage.getItem(key()) || ''; } catch (_) {}
    if (/^[a-f0-9]{64}$/.test(id)) { current = { id }; await refresh(); } else render();
  }
  return { resume, stop() { stopped = true; clearTimeout(timer); } };
}
