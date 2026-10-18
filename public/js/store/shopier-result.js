import { initStoreAuth, getStoreAuthSnapshot } from './auth.js?v=zentra-ui-v81r1';
import { storeApi, friendlyStoreError } from './api.js?v=zentra-ui-v81r1';
import { verifiedShopierUrl } from './shopier-checkout.js?v=zentra-ui-v81r1';

const $ = (id) => document.getElementById(id);
const orderId = new URLSearchParams(location.search).get('order') || '';
let busy = false;
function message(title, text, tone = '') {
  $('paymentStateTitle').textContent = title; $('paymentStateText').textContent = text;
  document.querySelector('.payment-status').dataset.tone = tone;
  document.querySelector('.payment-status__icon').textContent = tone === 'success' ? '✓' : tone === 'error' ? '!' : '…';
}
async function refresh() {
  if (busy) return;
  busy = true; $('refreshPayment').disabled = true; $('refreshPayment').setAttribute('aria-busy', 'true');
  $('continuePayment').hidden = true; $('continuePayment').removeAttribute('href');
  try {
    await initStoreAuth();
    if (!getStoreAuthSnapshot().user) {
      message('Hesabınıza giriş yapın', 'Sipariş yalnızca satın almayı başlattığınız hesapla görüntülenebilir. Siparişlerime git bağlantısından giriş yapıp bu sayfayı yeniden açın.'); return;
    }
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(orderId)) {
      message('Sipariş seçin', 'Siparişlerim ekranında kontrol etmek istediğiniz Shopier siparişini açın.'); return;
    }
    const { order, paymentUrl } = await storeApi(`/api/payments/shopier/orders/${encodeURIComponent(orderId)}`);
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
    if (topup && order.paymentState === 'paid') message(order.walletTopup?.settledAt ? 'Bakiye yüklemeniz tamamlandı' : 'Ödemeniz doğrulandı', order.walletTopup?.settledAt ? 'Tutar hesabınıza işlendi. Hesabım bölümünden güncel bakiyenizi görebilir ve ürün satın alımınızı ayrıca tamamlayabilirsiniz.' : 'Bakiye kaydı kontrol bekliyor. Yeniden ödeme yapmadan işlem durumunu kontrol edin veya destek alın.', order.walletTopup?.settledAt ? 'success' : '');
    else if (order.paymentState === 'paid') message(order.status === 'delivered' ? 'Ödemeniz ve teslimatınız hazır' : 'Ödemeniz doğrulandı', order.status === 'delivered'
      ? 'Dijital teslimat bilgilerinizi Siparişlerim / Teslimatlarım ekranından güvenle açabilirsiniz.' : 'Teslimatınız hazırlanıyor. Kontrol gerekiyorsa siparişiniz yönetim panelinde görünür.', 'success');
    else if (order.paymentState === 'refunded') message('İade doğrulandı', 'İade durumu Shopier kaydıyla eşleştirildi. Bankanıza yansıma süresi için ödeme sağlayıcısını kontrol edin.');
    else if (order.paymentState === 'cancelled') message('Sipariş kapatıldı', 'Bu ödeme bağlantısı kullanıma kapatıldı. Önceden başlattığınız bir tahsilat varsa mağaza desteğiyle sipariş numaranızı paylaşın.');
    else if (order.paymentState === 'failed') message('Ödeme bağlantısı oluşturulamadı', 'Bu sipariş için tahsilat başlatılmadı. Mağazadan yeniden sipariş verebilirsiniz.', 'error');
    else message('Ödeme sonucu bekleniyor', order.shopier?.linkClosedAt ? 'Ödeme bağlantısı kapatıldı. Son ödeme kontrolü ve rezervasyon işlemi sürüyor.' : 'Henüz doğrulanmış bir ödeme alınmadı. Ödeme yaptıysanız yeniden ödeme yapmadan durumu kontrol edin.');
    if (paymentUrl) { $('continuePayment').href = verifiedShopierUrl(paymentUrl); $('continuePayment').hidden = false; }
  } catch (error) { message('Sipariş kontrol edilemedi', friendlyStoreError(error), 'error'); }
  finally { busy = false; $('refreshPayment').disabled = false; $('refreshPayment').removeAttribute('aria-busy'); }
}
$('refreshPayment').addEventListener('click', () => void refresh());
void refresh();
