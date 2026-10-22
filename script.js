import { installErrorReporter } from './public/js/ui/error-reporter.js?v=zentra-ui-v84r1';
import { bootStorefront } from '/public/js/store/storefront.js?v=zentra-ui-v84r1';
import { installInteractionGuard } from '/public/js/ui/interaction-guard.js?v=zentra-ui-v84r1';

window.__ZENTRA_RUNTIME__ = window.__ZENTRA_RUNTIME__ || { apiBase: '' };
installInteractionGuard();

function showStorefrontFailure() {
  document.documentElement.dataset.storefrontStatus = 'error';
  const loading = document.getElementById('catalogLoading');
  if (!loading) return;
  loading.hidden = false;
  loading.innerHTML = '<i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i><strong>Mağaza şu anda yüklenemedi</strong><span>Bağlantınızı kontrol edip sayfayı yenileyerek tekrar deneyin.</span>';
}

bootStorefront().catch(showStorefrontFailure);

installErrorReporter();
