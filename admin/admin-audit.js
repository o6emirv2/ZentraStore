import { escapeHtml } from './admin-core.js?v=zentra-ui-v90r1';

const ACTIONS = { 'store-order-update': 'Sipariş Durumu Değiştirildi', 'store.order.update': 'Sipariş Durumu Değiştirildi',
  'store-order-cancelled-by-customer': 'Müşteri Siparişi İptal Etti',
  'store.links.update': 'Bağlantılar Güncellendi', 'store-links-update': 'Bağlantılar Güncellendi' };
export function renderAuditCards(host, rows, { formatDate, describe = value => value ? JSON.stringify(value) : '—' }) {
  const line = (label, value) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value || '—')}</dd></div>`;
  host.innerHTML = rows.length ? rows.map(row => `<article class="audit-record"><header><span class="audit-record__icon"><i class="fa-solid ${row.source === 'admin' ? 'fa-user-shield' : 'fa-store'}" aria-hidden="true"></i></span><div><h3>${escapeHtml(ACTIONS[row.action] || row.action || 'Kayıt')}</h3><time>${escapeHtml(formatDate(row.createdAt))}</time></div><b>${row.source === 'admin' ? 'Yönetim' : 'Mağaza'}</b></header><dl>${line('Yönetici / İşlemi yapan', row.actor?.email || row.actor?.uid || 'Sistem')}${line('Rol', row.actor?.role || (row.actor?.uid === 'system' ? 'Sistem' : 'Yetkili hesap'))}${line('Eski Durum', describe(row.before))}${line('Yeni Durum', describe(row.after))}${line('İşlem Sonucu', row.result || 'Kaydedildi')}${line('İşlem Kimliği', row.requestId || row.eventId || row.id)}${row.summary ? line('Açıklama', row.summary) : ''}${row.orderId ? line('Sipariş Referansı', row.orderId) : ''}</dl><footer>${row.deletable ? 'Saklama süresi bitmiş operasyon kaydı' : 'Korunan / saklama süresi devam eden kayıt'}</footer></article>`).join('') : '<p class="operation-empty">Eşleşen denetim kaydı yok.</p>';
}
