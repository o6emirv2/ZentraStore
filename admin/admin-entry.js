import { adminFetch } from './admin-core.js?v=zentra-ui-v89r1';
let mounting = null;
function css(href) {
  if ([...document.querySelectorAll('link[rel=stylesheet]')].some(link => link.href === new URL(href, location.href).href)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = href;
    const failure = () => { clearTimeout(timer); link.remove(); reject(new Error('Yönetim görünümü yüklenemedi. Yeniden deneyin.')); };
    const timer = setTimeout(failure, 10_000);
    link.onload = () => { clearTimeout(timer); resolve(); }; link.onerror = failure;
    document.head.append(link);
  });
}
async function mountDashboard() {
  if (mounting) return mounting;
  mounting = (async () => {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15_000);
    let response, html;
    try {
      response = await fetch('/admin/admin.html?view=v89', { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal });
      if (!response.ok || !String(response.headers.get('content-type')).includes('text/html')) throw new Error('Yönetim dosyaları eksik. Güncel admin klasörünü mağaza alanına birlikte yükleyin.');
      html = await response.text();
    } finally { clearTimeout(timer); }
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    if (parsed.querySelector('meta[name=zentra-admin-release]')?.content !== '89' || !parsed.querySelector('#adminLoader') || !parsed.querySelector('#promoCodeForm') || !parsed.querySelector('#productCreateForm')) throw new Error('Yönetim görünümü sürümü eşleşmiyor. Güncel admin klasörünü birlikte yayınlayın.');
    const styles = [...parsed.querySelectorAll('link[rel=stylesheet]')].map(link => new URL(link.getAttribute('href'), location.origin + '/admin/').href);
    await Promise.all(styles.map(css));
    for (const href of styles) {
      const link = [...document.querySelectorAll('link[rel=stylesheet]')].find(node => node.href === href);
      if (link) document.head.append(link);
    }
    parsed.querySelectorAll('script').forEach(node => node.remove());
    document.getElementById('adminGateRoot')?.remove();
    window.dispatchEvent(new CustomEvent('zentra:admin-mounted'));
    document.querySelector('link[href*="admin-gate.css"]')?.remove();
    document.body.append(...[...parsed.body.childNodes].map(node => document.importNode(node, true)));
    history.replaceState(history.state, '', '/admin/' + (/^#panel\/[a-z]+$/.test(location.hash) ? location.hash : ''));
    await import('./admin-dashboard.js?v=zentra-ui-v89r1');
  })();
  try { await mounting; } catch (error) { mounting = null; throw error; }
}
function showMountError(error) {
  const section = document.querySelector('.gate-step[data-step="6"]');
  if (!section) {
    const loader = document.querySelector('#adminLoader');
    if (loader) {
      loader.classList.add('has-entry-error');
      const title = loader.querySelector('strong'); if (title) title.textContent = 'Yönetim görünümü yüklenemedi';
      const description = loader.querySelector('small'); if (description) description.textContent = 'Güncel yönetim dosyaları yüklenemedi. Bağlantıyı kontrol edip yeniden deneyin.';
      if (!loader.querySelector('button')) { const button = document.createElement('button'); button.type = 'button'; button.className = 'primary-action'; button.textContent = 'Yeniden Dene'; button.addEventListener('click', () => location.reload()); loader.querySelector('div').append(button); }
    }
    return;
  }
  document.querySelectorAll('.gate-step').forEach(node => { node.hidden = node !== section; node.inert = node !== section; });
  section.querySelector('h2').textContent = 'Yönetim görünümü yüklenemedi';
  section.querySelector('p').textContent = error?.message || 'Bağlantınızı kontrol edip yeniden deneyin.';
  section.querySelector('.loader-line')?.remove();
  if (!section.querySelector('button')) {
    const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'primary-btn'; retry.textContent = 'Yeniden Dene';
    retry.addEventListener('click', () => { void mountDashboard().catch(showMountError); }); section.append(retry);
  }
}
window.addEventListener('zentra:admin-unlocked', () => { void mountDashboard().catch(showMountError); });
if (location.pathname === '/admin/index.html') history.replaceState(history.state, '', '/admin/' + location.hash);
let authenticated = false;
try {
  await window.ZENTRA_ADMIN_AUTH.init();
  authenticated = (await adminFetch('/api/auth/admin/gate/status'))?.authenticated === true;
} catch (_) {}
if (authenticated) await mountDashboard().catch(showMountError);
else await import('./admin-gate.js?v=zentra-ui-v89r1');
