export function escapeViewText(value = '') {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[character]));
}

export function viewIcon(name, family = 'fa-solid') {
  return `<i class="${escapeViewText(family)} ${escapeViewText(name)}" aria-hidden="true"></i>`;
}

export function safeExternalLink(value, fallback = 'https://t.me/ZENTRA_STORE') {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && ['t.me', 'www.t.me'].includes(url.hostname) ? url.href : fallback;
  } catch { return fallback; }
}
