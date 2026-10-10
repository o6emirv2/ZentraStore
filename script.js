import { installErrorReporter } from './public/js/ui/error-reporter.js?v=zentra-ui-v71';
import { bootStorefront } from '/public/js/store/storefront.js?v=zentra-ui-v71';
import { installInteractionGuard } from '/public/js/ui/interaction-guard.js?v=zentra-ui-v71';

window.__ZENTRA_RUNTIME__ = window.__ZENTRA_RUNTIME__ || { apiBase: '' };
installInteractionGuard();

function showStorefrontFailure() {
  document.documentElement.dataset.storefrontStatus = 'error';
  const loading = document.getElementById('catalogLoading');
  if (!loading) return;
  loading.hidden = false;
  loading.innerHTML = '<i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i><strong>Mağaza şu anda başlatılamadı</strong><span>Bağlantını kontrol edip sayfayı yenileyerek tekrar dene.</span>';
}

bootStorefront().catch(showStorefrontFailure);

installErrorReporter();
