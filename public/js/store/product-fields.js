export const PRODUCT_IMAGE_PATTERN = /^\/public\/assets\/(?:products|images)\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.(?:jpe?g|png|svg|webp|gif|avif|bmp|ico)(?:\?v=[A-Za-z0-9._-]{1,48})?$/i;

export function productImagePath(value = '') {
  const raw = String(value || '').trim();
  const local = raw.startsWith('public/') ? `/${raw}` : raw;
  if (PRODUCT_IMAGE_PATTERN.test(local)) return local;
  // Read compatibility for previously saved, server-validated Firebase images.
  if (/^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/[a-z0-9.-]+\/o\/store-product-images%2F[a-f0-9-]{36}\.(?:png|jpg|webp)\?alt=media&token=[a-f0-9-]{36}$/i.test(raw)) return raw;
  return '';
}

export function versionedProductImage(value, version = 'storefront-v70') {
  const source = productImagePath(value);
  if (!source || source.startsWith('https:')) return source;
  return `${source.split('?')[0]}?v=${version}`;
}

export function productFeatures(value = []) {
  const rows = typeof value === 'string' ? value.split(/\r?\n/) : Array.isArray(value) ? value : [];
  return [...new Set(rows.filter((row) => typeof row === 'string')
    .map((row) => row.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().replace(/^[✅✔☑•\s-]+/u, '').replace(/\s+/g, ' ').trim())
    .filter((row) => row && row.replace(/[🏆\s]/gu, '').toLocaleLowerCase('tr-TR') !== 'özellikler'))].slice(0, 40).map((row) => row.slice(0, 160));
}
