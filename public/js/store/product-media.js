const PRODUCT_ASSET_ROOT = '/public/assets/products';
const MEDIA_VERSION = 'zentra-v67';
const EMPTY_MEDIA = Object.freeze([]);

export const PRODUCT_MEDIA_SOURCE_PATTERN = /^\/public\/assets\/products\/(?:[A-Za-z0-9._-]+\.(?:jpeg|jpg|png|webp|svg)|gallery\/[a-z0-9-]+\/game-\d{2}\.jpeg)(?:\?v=zentra-v67)?$/i;

function versionedMediaPath(path) {
  return `${path}?v=${MEDIA_VERSION}`;
}

function numberedGameMedia(key, label, count) {
  return Array.from({ length: count }, (_, index) => Object.freeze({
    src: versionedMediaPath(`${PRODUCT_ASSET_ROOT}/gallery/${key}/game-${String(index + 1).padStart(2, '0')}.jpeg`),
    alt: `${label} oyun görseli ${index + 1}`,
    kind: 'game'
  }));
}

function mediaGroup({ key, label, productIds, gameCount = 0, imagePath = `${key}.jpeg` }) {
  const logo = Object.freeze({
    src: versionedMediaPath(`${PRODUCT_ASSET_ROOT}/${imagePath}`),
    alt: `${label} yazılı ürün görseli`,
    kind: 'logo'
  });
  return Object.freeze({
    key,
    label,
    productIds: Object.freeze([...productIds]),
    images: Object.freeze([logo, ...numberedGameMedia(key, label, gameCount)])
  });
}

export const PRODUCT_MEDIA_GROUPS = Object.freeze([
  mediaGroup({ key: 'kingmod', label: 'KİNGMOD', productIds: ['kingmod', 'ios-kingmod'], gameCount: 9 }),
  mediaGroup({ key: 'star', label: 'STAR', productIds: ['ios-star'], gameCount: 9 }),
  mediaGroup({ key: 'oasis', label: 'OASİS', productIds: ['ios-oasis'], gameCount: 4 }),
  mediaGroup({ key: 'contra-hax', label: 'CONTRAHAX', productIds: ['contra-hax', 'contra-hax-ios'], gameCount: 7 }),
  mediaGroup({ key: 'zolo', label: 'ZOLO', productIds: ['zolo'], gameCount: 5 }),
  mediaGroup({ key: 'moon', label: 'MOON', productIds: ['moon'], gameCount: 6 }),
  mediaGroup({ key: 'dolphin', label: 'DelphinİOS', productIds: ['ios-dolphin'], gameCount: 5 }),
  mediaGroup({ key: 'titan', label: 'TİTAN', productIds: ['titan'] }),
  mediaGroup({ key: 'ultima-oxide', label: 'ULTİMA OXİDE', productIds: ['ios-ultima-oxide'] }),
  mediaGroup({ key: 'h-kernel', label: 'H-KERNEL', productIds: ['h-kernel'], imagePath: 'h-kernel.PNG' })
]);

const PRODUCT_MEDIA_BY_ID = new Map(
  PRODUCT_MEDIA_GROUPS.flatMap((group) => group.productIds.map((productId) => [productId, group.images]))
);

export const SHOWCASE_MEDIA = Object.freeze(PRODUCT_MEDIA_GROUPS.map((group) => Object.freeze({
  ...group.images[0], groupKey: group.key, groupLabel: group.label, groupIndex: 0, groupTotal: group.images.length
})));

export function getProductMedia(product = {}) {
  const configured = PRODUCT_MEDIA_BY_ID.get(String(product?.id || '').trim());
  if (configured) return configured;
  const fallback = String(product?.image || '').trim();
  if (!PRODUCT_MEDIA_SOURCE_PATTERN.test(fallback)) return EMPTY_MEDIA;
  return Object.freeze([Object.freeze({
    src: fallback,
    alt: `${String(product?.name || 'Ürün').trim() || 'Ürün'} yazılı ürün görseli`,
    kind: 'logo'
  })]);
}
