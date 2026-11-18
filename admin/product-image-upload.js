export async function prepareProductImage(file) {
  if (!file) return null;
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif'].includes(file.type) || file.size > 15 * 1024 * 1024 || file.size < 1) {
    throw Object.assign(new Error('En fazla 15 MB boyutunda JPEG, PNG, WebP, AVIF veya GIF görseli seçin.'), { code: 'STORE_PRODUCT_IMAGE_UPLOAD_INVALID' });
  }
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = objectUrl;
    await image.decode();
    if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 50_000_000) throw new Error('IMAGE_DIMENSIONS');
    const scale = Math.min(1, 1600 / image.naturalWidth, 1600 / image.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('CANVAS_UNAVAILABLE');
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.86, 0.72, 0.58]) {
      const encoded = canvas.toDataURL('image/jpeg', quality);
      if (!encoded.startsWith('data:image/jpeg;base64,')) break;
      const data = encoded.slice('data:image/jpeg;base64,'.length);
      if (data.length <= Math.ceil(1024 * 1024 / 3) * 4) return { data };
    }
    throw new Error('IMAGE_TOO_LARGE');
  } catch (_) {
    throw Object.assign(new Error('Görsel hazırlanamadı. Daha küçük bir JPEG, PNG veya WebP dosyası seçin.'), { code: 'STORE_PRODUCT_IMAGE_UPLOAD_INVALID' });
  } finally { URL.revokeObjectURL(objectUrl); }
}
