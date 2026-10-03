const MAX_QUICK_LINKS = 16;
const LINK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,59}$/;
const HIDDEN_TEXT_PATTERN = /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2069<>]/g;

const LINK_PLATFORM_META = Object.freeze({
  telegram: Object.freeze({
    label: 'Telegram', icon: 'fa-telegram', family: 'fa-brands',
    hosts: Object.freeze(['t.me', 'www.t.me']), canonicalHost: 't.me',
    path: /^\/(?:\+[A-Za-z0-9_-]{10,128}|[A-Za-z][A-Za-z0-9_]{4,31})\/?$/
  }),
  tiktok: Object.freeze({
    label: 'TikTok', icon: 'fa-tiktok', family: 'fa-brands',
    hosts: Object.freeze(['tiktok.com', 'www.tiktok.com']), canonicalHost: 'www.tiktok.com',
    path: /^\/@[A-Za-z0-9._]{2,24}\/?$/
  }),
  whatsapp: Object.freeze({
    label: 'WhatsApp', icon: 'fa-whatsapp', family: 'fa-brands',
    hosts: Object.freeze(['wa.me']), canonicalHost: 'wa.me',
    path: /^\/[1-9][0-9]{7,14}\/?$/
  })
});

function linkError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function label(value = '', max = 80) {
  return String(value ?? '').replace(HIDDEN_TEXT_PATTERN, '').trim().slice(0, max);
}

function normalizeQuickLinkUrl(platform = '', value = '') {
  const definition = LINK_PLATFORM_META[String(platform || '').trim().toLowerCase()];
  if (!definition) throw linkError('STORE_LINK_PLATFORM_INVALID');
  const raw = String(value || '').trim();
  if (!raw || raw.length > 500 || /[\u0000-\u0020\u007f<>"'\\]/.test(raw)) {
    throw linkError('STORE_LINK_URL_INVALID');
  }

  let parsed;
  try {
    parsed = new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch (_) {
    throw linkError('STORE_LINK_URL_INVALID');
  }

  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash
    || !definition.hosts.includes(parsed.hostname.toLowerCase()) || !definition.path.test(parsed.pathname)) {
    throw linkError('STORE_LINK_URL_INVALID');
  }

  return `https://${definition.canonicalHost}${parsed.pathname.replace(/\/$/, '')}`;
}

function validateQuickLink(source = {}) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw linkError('STORE_LINK_INVALID');
  const id = label(source.id, 60).toLowerCase();
  const platform = label(source.platform, 20).toLowerCase();
  const title = label(source.title, 48);
  const description = label(source.description, 80);
  if (!LINK_ID_PATTERN.test(id)) throw linkError('STORE_LINK_ID_INVALID');
  if (!LINK_PLATFORM_META[platform]) throw linkError('STORE_LINK_PLATFORM_INVALID');
  if (!title || !description) throw linkError('STORE_LINK_LABEL_REQUIRED');
  return { id, platform, title, description, url: normalizeQuickLinkUrl(platform, source.url), enabled: source.enabled !== false };
}

function normalizeQuickLinks(source = []) {
  if (!Array.isArray(source)) return Object.freeze([]);
  const ids = new Set();
  const urls = new Set();
  const output = [];
  for (const entry of source.slice(0, MAX_QUICK_LINKS)) {
    try {
      const item = validateQuickLink(entry);
      const key = item.url.toLowerCase();
      if (ids.has(item.id) || urls.has(key)) continue;
      ids.add(item.id);
      urls.add(key);
      output.push(Object.freeze(item));
    } catch (_) {}
  }
  return Object.freeze(output);
}

function quickLinkTone(item = {}) {
  if (item.platform !== 'telegram') return item.platform;
  if (item.id.includes('support')) return 'support';
  if (item.id.includes('free')) return 'free';
  return 'telegram';
}

function renderQuickLinks(host, source = []) {
  if (!host) return [];
  const links = normalizeQuickLinks(source).filter((item) => item.enabled);
  const signature = JSON.stringify(links.map(({ id, platform, title, description, url }) => [id, platform, title, description, url]));
  if (host.dataset.quickLinksSignature === signature) return links;
  const fragment = document.createDocumentFragment();

  for (const item of links) {
    const platform = LINK_PLATFORM_META[item.platform];
    const anchor = document.createElement('a');
    anchor.className = `showcase-social showcase-social--${quickLinkTone(item)}`;
    anchor.href = item.url;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.referrerPolicy = 'no-referrer';
    anchor.dataset.quickLinkId = item.id;
    anchor.setAttribute('aria-label', `${item.title} · ${item.description} · Yeni sekmede aç`);
    if (item.id === 'official-telegram') anchor.dataset.telegramChannel = '';

    const iconHost = document.createElement('span');
    iconHost.className = 'showcase-social__icon';
    iconHost.setAttribute('aria-hidden', 'true');
    const icon = document.createElement('i');
    icon.className = `${platform.family} ${platform.icon}`;
    iconHost.append(icon);

    const copy = document.createElement('span');
    copy.className = 'showcase-social__copy';
    const title = document.createElement('strong');
    title.textContent = item.title;
    const description = document.createElement('small');
    description.textContent = item.description;
    copy.append(title, description);

    const arrow = document.createElement('i');
    arrow.className = 'fa-solid fa-arrow-up-right-from-square showcase-social__arrow';
    arrow.setAttribute('aria-hidden', 'true');
    anchor.append(iconHost, copy, arrow);
    fragment.append(anchor);
  }

  host.replaceChildren(fragment);
  host.dataset.quickLinksSignature = signature;
  host.hidden = links.length === 0;
  const section = host.closest('[data-quick-links-section]');
  if (section) section.hidden = links.length === 0;
  return links;
}

export {
  LINK_PLATFORM_META,
  MAX_QUICK_LINKS,
  normalizeQuickLinks,
  renderQuickLinks,
  validateQuickLink
};
