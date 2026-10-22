import { verifiedPaymentComplete, paymentNeedsRefresh, paymentReturnUrl } from './shopier-payment-state.js?v=zentra-ui-v84r1';
import { initStoreAuth, getStoreAuthSnapshot, subscribeStoreAuth } from './auth.js?v=zentra-ui-v84r1';
import { storeApi, friendlyStoreError } from './api.js?v=zentra-ui-v84r1';
import { verifiedShopierUrl } from './shopier-checkout.js?v=zentra-ui-v84r1';

const $ = (id) => document.getElementById(id);
const orderId = new URLSearchParams(location.search).get('order') || '';
let busy = false, refreshTimer = null, redirectTimer = null, polls = 0;
let displayUid = '';
function clearPaymentDetails() {
  displayUid = '';
  $('paymentFacts').hidden = true;
  $('paymentItems').replaceChildren();
  for (const id of ['paymentOrderNumber', 'paymentProviderId', 'paymentAmount', 'paymentStatus', 'paymentDelivery']) $(id).textContent = '—';
  $('continuePayment').hidden = true;
  $('continuePayment').removeAttribute('href');
  $('paymentAccountLink').hidden = true;
}
const openedAt = Date.now();
function scheduleRefresh() {
  if (refreshTimer || redirectTimer || Date.now() - openedAt > 5 * 60_000) return;
  refreshTimer = setTimeout(() => { refreshTimer = null; void refresh(); }, document.hidden ? 15000 : polls++ < 3 ? 3000 : polls < 12 ? 8000 : 15000);
}
function message(title, text, tone = '') {
  $('paymentStateTitle').textContent = title; $('paymentStateText').textContent = text;
  document.querySelector('.payment-status').dataset.tone = tone;
  document.querySelector('.payment-status__icon').textContent = tone === 'success' ? '✓' : tone === 'error' ? '!' : '…';
}
async function refresh() {
  if (busy || redirectTimer) return;
  clearTimeout(refreshTimer); refreshTimer = null;
  busy = true; $('refreshPayment').disabled = true; $('refreshPayment').setAttribute('aria-busy', 'true');
  $('continuePayment').hidden = true; $('continuePayment').removeAttribute('href');
  try {
    await initStoreAuth();
    if (!getStoreAuthSnapshot().user) {
      clearPaymentDetails();
      message('Hesabınıza giriş yapın', 'Sipariş yalnızca satın almayı başlattığınız hesapla görüntülenebilir. Siparişlerime git bağlantısından giriş yapıp bu sayfayı yeniden açın.'); return;
    }
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(orderId)) {
      message('Sipariş seçin', 'Siparişlerim ekranında kontrol etmek istediğiniz Shopier siparişini açın.'); return;
    }
    const identityUid = getStoreAuthSnapshot().user.uid;
    const { order, paymentUrl } = await storeApi(`/api/payments/shopier/orders/${encodeURIComponent(orderId)}`);
    if (getStoreAuthSnapshot().user?.uid !== identityUid) { clearPaymentDetails(); return; }
    displayUid = identityUid;
    const topup = order.orderType === 'wallet_topup';
    $('paymentFacts').hidden = false;
    $('paymentOrderNumber').textContent = order.orderNumber;
    $('paymentProviderId').textContent = order.shopier?.orderId || 'Henüz doğrulanmadı';
    $('paymentAmount').textContent = new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY' }).format(order.totalKurus / 100);
    const labels = { pending: 'Ödeme bekleniyor', paid: 'Ödeme doğrulandı', refunded: 'İade doğrulandı', failed: 'Bağlantı oluşturulamadı', cancelled: 'Sipariş kapatıldı' };
    $('paymentStatus').textContent = labels[order.paymentState] || 'Kontrol ediliyor';
    $('paymentDelivery').textContent = topup ? order.paymentState === 'refunded' ? 'Bakiye yükleme iadesi işlendi' : order.walletTopup?.settledAt ? 'Bakiye hesabınıza işlendi' : 'Bakiye yüklemek için ödeme doğrulaması bekleniyor' : order.status === 'delivered' ? 'Teslim edildi · hesabınızdan açabilirsiniz' : order.paymentState === 'paid' ? 'Hazırlanıyor / kontrol bekliyor' : 'Ödeme doğrulamasını bekliyor';
    if ($('paymentAccountLink')) $('paymentAccountLink').hidden = !topup;
    $('paymentItems').replaceChildren(...(topup ? [] : order.items || []).map((item) => {
      const li = document.createElement('li'); li.textContent = `${item.productName} · ${item.platform === 'ios' ? 'iOS' : 'Android'} · ${item.planLabel} · ${item.quantity} adet`; return li;
    }));
    if (topup) { const li = document.createElement('li'); li.textContent = `Mağaza bakiyesi yüklemesi · Ürün satın alımı ayrıca yapılır.${order.walletTopup?.debtSettledKurus ? ' Yüklemenin bir bölümü doğrulanmış iade bakiyesini kapatmak için kullanıldı.' : ''}`; $('paymentItems').append(li); }
    if (order.shopier?.state === 'paid_review') message('Ödemeniz kontrol bekliyor', 'Ödeme kaydı bulundu; bakiye veya teslimat için ek kontrol gerekiyor. Yeniden ödeme yapmadan işlem numaranızla destek alın.');
    else if (order.shopier?.refundPending || order.shopier?.refundStatus === 'pending') message('İade işlemi kontrol ediliyor', 'İade sonucu kesinleşene kadar bu işlemi yeniden ödemeyin. Güncel bakiye ve iade durumunu hesabınızdan takip edin.');
    else if (order.shopier?.refundStatus === 'partial') message('Kısmi iade doğrulandı', 'İade tutarı ödeme kaydıyla eşleştirildi. Güncel tutarları hesabınızdan kontrol edebilirsiniz.');
    else if (topup && order.paymentState === 'paid') message(order.walletTopup?.settledAt ? 'Bakiye yüklemeniz tamamlandı' : 'Ödemeniz doğrulandı', order.walletTopup?.settledAt ? 'Tutar hesabınıza işlendi. Hesabım bölümünden güncel bakiyenizi görebilir ve ürün satın alımınızı ayrıca tamamlayabilirsiniz.' : 'Bakiye kaydı kontrol bekliyor. Yeniden ödeme yapmadan işlem durumunu kontrol edin veya destek alın.', order.walletTopup?.settledAt ? 'success' : '');
    else if (order.paymentState === 'paid') message(order.status === 'delivered' ? 'Ödemeniz ve teslimatınız hazır' : 'Ödemeniz doğrulandı', order.status === 'delivered'
      ? 'Dijital teslimat bilgilerinizi Siparişlerim / Teslimatlarım ekranından güvenle açabilirsiniz.' : 'Teslimatınız hazırlanıyor. Kontrol gerekiyorsa siparişiniz yönetim panelinde görünür.', 'success');
    else if (order.paymentState === 'refunded') message('İade doğrulandı', 'İade durumu Shopier kaydıyla eşleştirildi. Bankanıza yansıma süresi için ödeme sağlayıcısını kontrol edin.');
    else if (order.paymentState === 'cancelled') message('Sipariş kapatıldı', 'Bu ödeme bağlantısı kullanıma kapatıldı. Önceden başlattığınız bir tahsilat varsa mağaza desteğiyle sipariş numaranızı paylaşın.');
    else if (order.paymentState === 'failed') message('Ödeme bağlantısı oluşturulamadı', 'Bu sipariş için tahsilat başlatılmadı. Mağazadan yeniden sipariş verebilirsiniz.', 'error');
    else message('Ödeme sonucu bekleniyor', order.shopier?.linkClosedAt ? 'Ödeme bağlantısı kapatıldı. Son ödeme kontrolü ve rezervasyon işlemi sürüyor.' : 'Henüz doğrulanmış bir ödeme alınmadı. Ödeme yaptıysanız yeniden ödeme yapmadan durumu kontrol edin.');
    if (paymentUrl) { $('continuePayment').href = verifiedShopierUrl(paymentUrl); $('continuePayment').hidden = false; }
    if (verifiedPaymentComplete(order)) {
      message('Ödeme alındı, yönlendiriliyorsunuz', topup ? 'Bakiye hesabınıza işlendi. ZENTRA STORE’a yönlendiriliyorsunuz.' : 'Ödemeniz doğrulandı. ZENTRA STORE’a yönlendiriliyorsunuz.', 'success');
      redirectTimer = setTimeout(() => {
        if (getStoreAuthSnapshot().user?.uid !== identityUid) { redirectTimer = null; return; }
        location.replace(paymentReturnUrl(window.__ZENTRA_RUNTIME__ || {}, location.origin));
      }, 2500);
    } else if (paymentNeedsRefresh(order)) scheduleRefresh();
  } catch (error) {
    if (['AUTH_REQUIRED', 'AUTH_SESSION_CHANGED', 'STORE_ORDER_NOT_FOUND'].includes(error.code)) clearPaymentDetails();
    message('İşlem kontrol edilemedi', friendlyStoreError(error), 'error');
    if (!['AUTH_REQUIRED', 'STORE_ORDER_NOT_FOUND'].includes(error.code)) scheduleRefresh();
  }
  finally { busy = false; $('refreshPayment').disabled = false; $('refreshPayment').removeAttribute('aria-busy'); }
}
$('refreshPayment').addEventListener('click', () => void refresh());
subscribeStoreAuth(snapshot => {
  if (displayUid && snapshot.user?.uid !== displayUid) {
    clearTimeout(refreshTimer); clearTimeout(redirectTimer); refreshTimer = null; redirectTimer = null;
    clearPaymentDetails();
    message('Hesabınıza giriş yapın', 'Bu işlemi görüntülemek için ödemeyi başlattığınız hesapla giriş yapın.');
  }
});
void refresh();

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { clearTimeout(refreshTimer); refreshTimer = null; scheduleRefresh(); }
  else if (!redirectTimer) void refresh();
});
window.addEventListener('pagehide', () => { clearTimeout(refreshTimer); clearTimeout(redirectTimer); refreshTimer = null; redirectTimer = null; });
window.addEventListener('pageshow', event => { if (event.persisted) void refresh(); });
