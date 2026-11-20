import { entryDestination } from '/public/js/app/routes.mjs?v=109';
import { installErrorReporter } from './public/js/ui/error-reporter.js?v=109';
import { bootStorefront } from '/public/js/store/storefront.js?v=109';
import { installInteractionGuard } from '/public/js/ui/interaction-guard.js?v=109';

window.__ZENTRA_RUNTIME__ = window.__ZENTRA_RUNTIME__ || { apiBase: '' };
installInteractionGuard();

function showStorefrontFailure() {
  document.documentElement.dataset.storefrontStatus = 'error';
  const loading = document.getElementById('catalogLoading');
  if (!loading) return;
  loading.hidden = false;
  loading.innerHTML = '<i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i><strong>Mağaza şu anda yüklenemedi</strong><span>Bağlantınızı kontrol edip sayfayı yenileyerek tekrar deneyin.</span>';
}

const target = entryDestination(location.href);
if (target && target !== '/') {
  const entry = new URL('/store-pages.html', location.origin);
  entry.searchParams.set('devam', target);
  location.replace(entry.href);
} else {
  bootStorefront().catch(showStorefrontFailure);
}

installErrorReporter();
