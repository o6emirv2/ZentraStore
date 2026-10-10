import { PRODUCT_IMAGE_PATTERN, productImagePath, versionedProductImage } from './product-fields.js?v=zentra-ui-v71';
const PRODUCT_ASSET_ROOT = '/public/assets/products';
const MEDIA_VERSION = 'storefront-v68';
const EMPTY_MEDIA = Object.freeze([]);

export const PRODUCT_MEDIA_SOURCE_PATTERN = { test: (value) => PRODUCT_IMAGE_PATTERN.test(value) || Boolean(productImagePath(value)) };

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

function mediaGroup({ key, label, productIds, gameCount }) {
  const logo = Object.freeze({
    src: versionedMediaPath(`${PRODUCT_ASSET_ROOT}/${key}.jpeg`),
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
  mediaGroup({ key: 'kingmod', label: 'KİNGMOD', productIds: ['kingmod', 'android-kingmod', 'ios-kingmod'], gameCount: 9 }),
  mediaGroup({ key: 'star', label: 'STAR', productIds: ['ios-star'], gameCount: 9 }),
  mediaGroup({ key: 'oasis', label: 'OASİS', productIds: ['ios-oasis'], gameCount: 4 }),
  mediaGroup({ key: 'contra-hax', label: 'CONTRAHAX', productIds: ['contra-hax', 'android-contra-hax', 'contra-hax-ios'], gameCount: 7 }),
  mediaGroup({ key: 'zolo', label: 'ZOLO', productIds: ['zolo', 'android-zolo'], gameCount: 5 }),
  mediaGroup({ key: 'moon', label: 'MOON', productIds: ['moon', 'android-moon'], gameCount: 6 }),
  mediaGroup({ key: 'dolphin', label: 'DelphinİOS', productIds: ['ios-dolphin'], gameCount: 5 })
]);

const PRODUCT_MEDIA_BY_ID = new Map(
  PRODUCT_MEDIA_GROUPS.flatMap((group) => group.productIds.map((productId) => [productId, group.images]))
);

export const SHOWCASE_MEDIA = Object.freeze(PRODUCT_MEDIA_GROUPS.flatMap((group) => (
  group.images.map((image, groupIndex) => Object.freeze({
    ...image,
    groupKey: group.key,
    groupLabel: group.label,
    groupIndex,
    groupTotal: group.images.length
  }))
)));

export function getProductMedia(product = {}) {
  const configured = PRODUCT_MEDIA_BY_ID.get(String(product.id || '').trim()) || EMPTY_MEDIA;
  const source = versionedProductImage(product.image);
  if (!source) return configured;
  const primary = Object.freeze({ src: source, alt: `${String(product.name || 'Ürün')} ürün görseli`, kind: 'logo' });
  return Object.freeze([primary, ...configured.filter((item) => item.kind !== 'logo')]);
}
