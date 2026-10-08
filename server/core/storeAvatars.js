'use strict';

const AVATAR_IDS = Object.freeze(Array.from({ length: 25 }, (_, index) => String(index + 1)));
function validateAvatarUrl(value = '') {
  const raw = String(value || '').trim();
  if (!/^\/public\/assets\/avatars\/avatar-(?:0[1-9]|1[0-9]|2[0-5])\.svg$/.test(raw)) throw new Error('STORE_AVATAR_URL_INVALID');
  return raw;
}
const AVATAR_CATALOG = Object.freeze(AVATAR_IDS.map((id) => Object.freeze({
  id, label: `ZENTRA Profil ${id.padStart(2, '0')}`,
  image: validateAvatarUrl(`/public/assets/avatars/avatar-${id.padStart(2, '0')}.svg`)
})));
const AVATAR_BY_ID = new Map(AVATAR_CATALOG.map((avatar) => [avatar.id, avatar]));
function getAvatarById(value = '') { return AVATAR_BY_ID.get(String(value || '').trim()) || null; }
function publicAvatarCatalog() { return AVATAR_CATALOG.map((avatar) => ({ ...avatar })); }
module.exports = { AVATAR_IDS, getAvatarById, publicAvatarCatalog, validateAvatarUrl };
