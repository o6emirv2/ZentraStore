'use strict';

const BADGE_DEFINITIONS = Object.freeze([
  Object.freeze({ key: 'premium', label: 'PREMIUM', icon: 'fa-gem', tone: 'premium' }),
  Object.freeze({ key: 'cheat', label: 'HİLE', icon: 'fa-wand-magic-sparkles', tone: 'danger' }),
  Object.freeze({ key: 'rooted', label: 'ROOTLU', icon: 'fa-microchip', tone: 'root' }),
  Object.freeze({ key: 'new', label: 'YENİ', icon: 'fa-star', tone: 'new' }),
  Object.freeze({ key: 'bestseller', label: 'EN ÇOK SATILAN', icon: 'fa-crown', tone: 'bestseller' }),
  Object.freeze({ key: 'popular', label: 'ÇOK TERCİH EDİLEN', icon: 'fa-fire-flame-curved', tone: 'popular' }),
  Object.freeze({ key: 'discounted', label: 'İNDİRİMLİ', icon: 'fa-tags', tone: 'discounted' }),
  Object.freeze({ key: 'mod', label: 'MOD', icon: 'fa-puzzle-piece', tone: 'mod' }),
  Object.freeze({ key: 'guaranteed-login', label: 'KESİN GİRİŞ', icon: 'fa-circle-check', tone: 'verified' }),
  Object.freeze({ key: 'annual', label: 'YILLIK', icon: 'fa-calendar-check', tone: 'annual' }),
  Object.freeze({ key: 'verified', label: 'DOĞRULANMIŞ', icon: 'fa-shield-halved', tone: 'verified' })
]);

const BADGE_BY_KEY = new Map(BADGE_DEFINITIONS.map((badge) => [badge.key, badge]));
const BADGE_KEY_BY_LABEL = new Map(BADGE_DEFINITIONS.map((badge) => [badge.label.toLocaleUpperCase('tr-TR'), badge.key]));

function normalizeBadgeKey(value = '') {
  const key = String(value || '').trim().toLowerCase();
  return BADGE_BY_KEY.has(key) ? key : '';
}

function badgeKeyFromLegacyLabel(value = '') {
  const label = String(value || '').trim().toLocaleUpperCase('tr-TR');
  return BADGE_KEY_BY_LABEL.get(label) || '';
}

function resolveBadge({ badgeKey = '', badge = '' } = {}, fallback = {}) {
  const requestedKey = normalizeBadgeKey(badgeKey) || badgeKeyFromLegacyLabel(badge);
  const fallbackKey = normalizeBadgeKey(fallback.badgeKey) || badgeKeyFromLegacyLabel(fallback.badge) || 'premium';
  const selected = BADGE_BY_KEY.get(requestedKey) || BADGE_BY_KEY.get(fallbackKey) || BADGE_BY_KEY.get('premium');
  return { ...selected };
}

function badgeOptions() {
  return BADGE_DEFINITIONS.map((badge) => ({ ...badge }));
}

module.exports = {
  BADGE_DEFINITIONS,
  normalizeBadgeKey,
  badgeKeyFromLegacyLabel,
  resolveBadge,
  badgeOptions
};
