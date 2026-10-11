const MAX_REPORTS = 10;
let installed = false;

export function installErrorReporter() {
  if (installed) return;
  installed = true;
  let sent = 0;
  const seen = new Set();
  const report = (code, source = '', line = 0, column = 0) => {
    let pathname = '';
    try {
      const path = new URL(source, window.location.href).pathname;
      if (/^\/(?:public\/|admin\/|script\.js|style\.css)/.test(path)) pathname = path.slice(0, 160);
    } catch (_) {}
    const signature = `${code}:${pathname}:${line}:${column}`;
    if (seen.has(signature) || sent >= MAX_REPORTS) return;
    seen.add(signature);
    sent += 1;
    const base = window.__ZENTRA_RUNTIME__?.apiBase || window.ZENTRA_ADMIN_AUTH?.apiUrl?.('')
      || document.querySelector('meta[name="zentra-api-origin"]')?.content || '';
    fetch(`${String(base).replace(/\/$/, '')}/api/client-errors`, {
      method: 'POST', credentials: 'omit', keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, source: pathname, line: Number(line) || 0, column: Number(column) || 0 })
    }).catch(() => {});
  };
  window.addEventListener('error', (event) => {
    const asset = event.target;
    if (asset instanceof HTMLImageElement || asset instanceof HTMLScriptElement || asset instanceof HTMLLinkElement) {
      report('BROWSER_ASSET_FAILED', asset.src || asset.href || '');
    } else report('BROWSER_RUNTIME_ERROR', event.filename || '', event.lineno, event.colno);
  }, true);
  window.addEventListener('unhandledrejection', () => report('BROWSER_PROMISE_REJECTION'));
}
