import { bootStorefront } from '/public/js/store/storefront.js?v=zentra-20261008-v2';

window.__ZENTRA_RUNTIME__ = window.__ZENTRA_RUNTIME__ || { apiBase: '' };

function showStorefrontFailure() {
  document.documentElement.dataset.storefrontStatus = 'error';
  const loading = document.getElementById('catalogLoading');
  if (!loading) return;
  loading.hidden = false;
  loading.innerHTML = '<i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i><strong>Mağaza şu anda başlatılamadı</strong><span>Bağlantını kontrol edip sayfayı yenileyerek tekrar dene.</span>';
}

bootStorefront().catch(showStorefrontFailure);
