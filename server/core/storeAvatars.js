'use strict';

const AVATAR_HOST = 'encrypted-tbn0.gstatic.com';

const RAW_AVATARS = Object.freeze([
  ['1', 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcTpdvzOYRo2M-O1_24P_g9TPOSuA8VpdxeapQYLWWwItA&s=10'],
  ['2', 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcRCKuVURZnQ-dg-nX-Ka_VVgKst3PmfzQ3TLz2O4VTvNg&s=10'],
  ['3', 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcTiCrZquXFHvFSVqoCGt5c3qyscuhXu2er5ItyGHrw1aA&s=10'],
  ['4', 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcQsSmxwqOmED5C4OKwwyYQBztoiQ6CQ7S0HFevoq7fYTg&s=10'],
  ['5', 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcSmL0I6y11vTWB3C8xvaE7rgV1rvZS5EG5xH4fmhmgg8A&s=10'],
  ['6', 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcQoQ6GOp6drr37OUWdCRWoujIDBL8v55illcHSYpSWabQ&s=10'],
  ['7', 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcSWaHBm5OOEy9WqLWE57DCp-bvSdcCZ1996jLAGKWYepw&s=10'],
  ['8', 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcSly9tdjIhYzf1rDm4pAOYO-ly3CiA7PU6FnDTxwmQd8g&s=10'],
  ['9', 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcQjOi2pKNchmCe3XExNbStft4goZ79bOdZBkssm48bHzA&s=10'],
  ['10', 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcSav6cSxQjRHwjftSQUyabGflQi2U5DcEIvp42Ej1SCzA&s=10'],
  ['11', 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcT9i6JSwcm5H6i2wUY-KMOWDC8WnSa5Uunw4lIypuJjbw&s=10'],
  ['12', 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcQbJQQbxo2uNc79auiZkYpmJBsDnKaexBO-PT8YsRY4aA&s=10'],
  ['13', 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcQG76rZe2shoHXpJWh-pYy3-38X8g93Lkfj1rv-MY_KPA&s=10'],
  ['14', 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcR99-VZmupktPesBm5TxsGRfuERAreRG0B81XU4JWnBSg&s=10'],
  ['15', 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcTzTtnini5t0FpE3evP-mhYD8zRspqzAWX26xtFKS3quA&s=10'],
  ['16', 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcQB4007AmUYzqTgKXh26BY1RRqvv97FGX6zbw5L2ZIgag&s=10'],
  ['17', 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcTJ8i1-BCNXCNg3nq_jvwe0usf6DG9K2v2S6L8TW1SykQ&s=10'],
  ['18', 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcQ5m0l25GpHPYjcx5vS0F58X1MxALk_VDHZbqitPdSiAQ&s=10'],
  ['19', 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcSzmum5OWNUZvhJjLkf5Fogj60PLR5__UCz_14lzugvdQ&s=10'],
  ['20', 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcQc5qyBFwUTw5ZAgMGZ7H2dIAWHA9yl5mfWRQ0BfCCb4Q&s=10'],
  ['21', 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcR7To-Q4sobEEGWBHNUIADM-rDKSt_E55qoeoUEukAlkw&s=10'],
  ['22', 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcSduIlY_kKAqaFSU7zFSXMTfXy3vSfEJjpjfUuFa5o5DQ&s=10'],
  ['23', 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcTeep_9jtZL4pzQSWWKsyGWr4IIfnqnkH0juUVMyI65sA&s=10'],
  ['24', 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcSEcR7KT5v9P8idp24QcHi9MbyS3NCSv2Bw4J8KM5Efnw&s=10'],
  ['25', 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcSAWHXeDG-Pa29BfRpA2bC12bsoubWrS0wUhlSKdMdVSg&s=10']
]);

function validateAvatarUrl(value = '') {
  const raw = String(value || '').trim();
  let parsed;
  try { parsed = new URL(raw); } catch (_) { throw new Error('STORE_AVATAR_URL_INVALID'); }
  if (parsed.protocol !== 'https:' || parsed.hostname !== AVATAR_HOST || parsed.pathname !== '/images') {
    throw new Error('STORE_AVATAR_URL_INVALID');
  }
  if (!/^tbn:ANd9Gc/i.test(parsed.searchParams.get('q') || '') || parsed.searchParams.get('s') !== '10') {
    throw new Error('STORE_AVATAR_URL_INVALID');
  }
  return raw;
}

const AVATAR_CATALOG = Object.freeze(RAW_AVATARS.map(([id, image], index) => Object.freeze({
  id,
  label: `SHELBY Profil ${String(index + 1).padStart(2, '0')}`,
  image: validateAvatarUrl(image)
})));
const AVATAR_IDS = Object.freeze(AVATAR_CATALOG.map((item) => item.id));
const AVATAR_BY_ID = new Map(AVATAR_CATALOG.map((item) => [item.id, item]));

function getAvatarById(value = '') {
  return AVATAR_BY_ID.get(String(value || '').trim()) || null;
}

function publicAvatarCatalog() {
  return AVATAR_CATALOG.map((item) => ({ id: item.id, label: item.label, image: item.image }));
}

module.exports = {
  AVATAR_HOST,
  AVATAR_IDS,
  getAvatarById,
  publicAvatarCatalog,
  validateAvatarUrl
};
