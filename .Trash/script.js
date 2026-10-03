import { bootStorefront } from '/public/js/store/storefront.js?v=audit-20260908-v1';
import { installInteractionGuard } from '/public/js/ui/interaction-guard.js?v=audit-20260908-v1';

window.__SHELBY_RUNTIME__ = window.__SHELBY_RUNTIME__ || { apiBase: '' };
installInteractionGuard();

function showStorefrontFailure() {
  document.documentElement.dataset.storefrontStatus = 'error';
  const loading = document.getElementById('catalogLoading');
  if (!loading) return;
  loading.hidden = false;
  loading.innerHTML = '<i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i><strong>Mağaza şu anda başlatılamadı</strong><span>Bağlantını kontrol edip sayfayı yenileyerek tekrar dene.</span>';
}

bootStorefront().catch(showStorefrontFailure);
