'use strict';

(() => {
  const seen = new Set();
  let sent = 0;
  function report(error, context = 'browser') {
    if (sent >= 20 || !navigator.onLine) return;
    const value = String(error?.code || 'CLIENT_RUNTIME_ERROR');
    const code = /^[A-Z][A-Z0-9_:/.-]{0,79}$/i.test(value) ? value : 'CLIENT_RUNTIME_ERROR';
    const key = `${context}:${code}`;
    if (seen.has(key)) return;
    seen.add(key); sent += 1;
    const payload = JSON.stringify({ code, context, page: location.pathname.startsWith('/admin') ? 'admin' : 'store', requestId: /^[A-Za-z0-9_-]{1,100}$/.test(error?.requestId || '') ? error.requestId : '' });
    fetch('/api/public/client-errors', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, credentials: 'same-origin', keepalive: true }).catch(() => {});
  }
  window.ZENTRA_REPORT_ERROR = report;
  window.addEventListener('error', (event) => {
    if (event.error) report(event.error);
    else if (event.target?.tagName === 'SCRIPT' || event.target?.tagName === 'LINK') report({ code: 'CLIENT_ASSET_LOAD_FAILED' }, 'asset');
  }, true);
  window.addEventListener('unhandledrejection', (event) => report(event.reason));
})();
