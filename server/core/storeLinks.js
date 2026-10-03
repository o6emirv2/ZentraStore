'use strict';

const MAX_QUICK_LINKS = 16;
const CHANNEL_LINKS_REVISION = 69;
const QUICK_LINK_PLATFORMS = Object.freeze(['telegram', 'tiktok', 'whatsapp']);
const TIKTOK_OFFICIAL_URL = 'https://www.tiktok.com/@srfxkayra';
const TELEGRAM_SUPPORT_USERNAME = 'shelbyios';
const LINK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,59}$/;
const HIDDEN_TEXT_PATTERN = /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2069<>]/g;

const PLATFORM_RULES = Object.freeze({
  telegram: Object.freeze({
    hosts: Object.freeze(['t.me', 'www.t.me']),
    canonicalHost: 't.me',
    path: /^\/(?:\+[A-Za-z0-9_-]{10,128}|[A-Za-z][A-Za-z0-9_]{4,31})\/?$/
  }),
  tiktok: Object.freeze({
    hosts: Object.freeze(['tiktok.com', 'www.tiktok.com']),
    canonicalHost: 'www.tiktok.com',
    path: /^\/@[A-Za-z0-9._]{2,24}\/?$/
  }),
  whatsapp: Object.freeze({
    hosts: Object.freeze(['wa.me']),
    canonicalHost: 'wa.me',
    path: /^\/[1-9][0-9]{7,14}\/?$/
  })
});

const DEFAULT_QUICK_LINKS = Object.freeze([
  { id: 'official-telegram', platform: 'telegram', title: 'Telegram Kanalı', description: 'Resmî kanalımızı takip et', url: 'https://t.me/shelbystoreofficial', enabled: true },
  { id: 'chat-telegram', platform: 'telegram', title: 'Sohbet Kanalı', description: 'Sohbet grubumuza katıl', url: 'https://t.me/+1CNyDrYyBzcwMGY0', enabled: true },
  { id: 'free-telegram', platform: 'telegram', title: 'Ücretsiz İçerik', description: 'Ücretsiz içerikleri keşfet', url: 'https://t.me/shelbystorefree', enabled: true },
  { id: 'tiktok-official', platform: 'tiktok', title: 'TikTok', description: 'Videolarımızı izle', url: TIKTOK_OFFICIAL_URL, enabled: true },
  { id: 'whatsapp-support', platform: 'whatsapp', title: 'WhatsApp Destek', description: 'Destek ekibimize ulaş', url: 'https://wa.me/905339673730', enabled: true },
  { id: 'support-telegram', platform: 'telegram', title: 'Telegram Destek', description: 'Destek ekibimize güvenle ulaş', url: `https://t.me/${TELEGRAM_SUPPORT_USERNAME}`, enabled: true }
].map((link) => Object.freeze(link)));

function channelLinksMigration(source = {}) {
  const current = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
  if (Number(current.channelLinksRevision) >= CHANNEL_LINKS_REVISION) return null;
  const support = current.support && typeof current.support === 'object' && !Array.isArray(current.support) ? current.support : {};
  return {
    channelLinksRevision: CHANNEL_LINKS_REVISION,
    quickLinks: DEFAULT_QUICK_LINKS.map((link) => ({ ...link })),
    support: { ...support, telegramUsername: TELEGRAM_SUPPORT_USERNAME }
  };
}

function linkError(code, statusCode = 400) {
  return Object.assign(new Error(code), { code, statusCode });
}

function safeLabel(value = '', max = 80) {
  return String(value ?? '').replace(HIDDEN_TEXT_PATTERN, '').trim().slice(0, max);
}

function normalizeQuickLinkUrl(platform = '', value = '') {
  const rule = PLATFORM_RULES[String(platform || '').trim().toLowerCase()];
  if (!rule) throw linkError('STORE_LINK_PLATFORM_INVALID');

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
    || !rule.hosts.includes(parsed.hostname.toLowerCase()) || !rule.path.test(parsed.pathname)) {
    throw linkError('STORE_LINK_URL_INVALID');
  }

  return `https://${rule.canonicalHost}${parsed.pathname.replace(/\/$/, '')}`;
}

function normalizeQuickLink(source = {}) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw linkError('STORE_LINK_INVALID');
  }

  const id = safeLabel(source.id, 60).toLowerCase();
  const platform = safeLabel(source.platform, 20).toLowerCase();
  const title = safeLabel(source.title, 48);
  const description = safeLabel(source.description, 80);
  if (!LINK_ID_PATTERN.test(id)) throw linkError('STORE_LINK_ID_INVALID');
  if (!QUICK_LINK_PLATFORMS.includes(platform)) throw linkError('STORE_LINK_PLATFORM_INVALID');
  if (!title || !description) throw linkError('STORE_LINK_LABEL_REQUIRED');

  return {
    id,
    platform,
    title,
    description,
    url: normalizeQuickLinkUrl(platform, source.url),
    enabled: source.enabled !== false
  };
}

function normalizeQuickLinks(source, { defaultsWhenMissing = true } = {}) {
  if (source === undefined || source === null) {
    return defaultsWhenMissing ? DEFAULT_QUICK_LINKS.map((link) => ({ ...link })) : [];
  }
  if (!Array.isArray(source) || source.length > MAX_QUICK_LINKS) {
    throw linkError('STORE_LINK_LIST_INVALID');
  }

  const ids = new Set();
  const urls = new Set();
  const normalized = [];
  let tiktokAdded = false;
  for (const entry of source) {
    let link = normalizeQuickLink(entry);
    if (link.platform === 'tiktok') {
      if (tiktokAdded) continue;
      tiktokAdded = true;
      link = { ...link, id: 'tiktok-official', url: TIKTOK_OFFICIAL_URL };
    }
    if (ids.has(link.id) || urls.has(link.url.toLowerCase())) {
      throw linkError('STORE_LINK_DUPLICATE', 409);
    }
    ids.add(link.id);
    urls.add(link.url.toLowerCase());
    normalized.push(link);
  }
  return normalized;
}

module.exports = {
  CHANNEL_LINKS_REVISION,
  DEFAULT_QUICK_LINKS,
  MAX_QUICK_LINKS,
  TIKTOK_OFFICIAL_URL,
  QUICK_LINK_PLATFORMS,
  channelLinksMigration,
  normalizeQuickLink,
  normalizeQuickLinks,
  normalizeQuickLinkUrl
};
