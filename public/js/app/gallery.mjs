const groups = Object.freeze([
  {
    folder: "kingmod",
    ids: ["kingmod", "android-kingmod", "ios-kingmod"],
    count: 9,
  },
  { folder: "star", ids: ["ios-star"], count: 9 },
  { folder: "oasis", ids: ["ios-oasis"], count: 4 },
  {
    folder: "contra-hax",
    ids: ["contra-hax", "android-contra-hax", "contra-hax-ios"],
    count: 7,
  },
  { folder: "zolo", ids: ["zolo", "android-zolo"], count: 5 },
  { folder: "moon", ids: ["moon", "android-moon"], count: 6 },
  { folder: "dolphin", ids: ["ios-dolphin"], count: 5 },
]);
function safeSource(source) {
  if (typeof source !== "string") return false;
  if (
    /^\/public\/assets\/[a-zA-Z0-9._/-]+$/.test(source) &&
    !source.split("/").includes("..")
  )
    return true;
  try {
    const url = new URL(source);
    return (
      url.protocol === "https:" &&
      url.hostname === "firebasestorage.googleapis.com" &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
export function productGallery(product = {}) {
  const group = groups.find((x) => x.ids.includes(product.id));
  const name = String(product.name || "Ürün");
  const items = [
    {
      src: safeSource(product.image)
        ? product.image
        : "/public/assets/images/zentra-mark.webp",
      alt: name + " ürün görseli",
    },
  ];
  if (Array.isArray(product.gallery) && product.gallery.length) {
    for (const image of product.gallery.slice(0, 12))
      if (safeSource(image.url))
        items.push({ src: image.url, alt: image.alt || name });
    return Object.freeze(items.map(Object.freeze));
  }
  if (group)
    for (let i = 1; i <= group.count; i++)
      items.push({
        src: `/public/assets/products/gallery/${group.folder}/game-${String(i).padStart(2, "0")}.jpeg`,
        alt: `${name} oyun görseli ${i}`,
      });
  return Object.freeze(items.map(Object.freeze));
}
export function galleryIndex(value, count) {
  if (!Number.isSafeInteger(count) || count < 1) return 0;
  const n = Number.isSafeInteger(value) ? value : 0;
  return ((n % count) + count) % count;
}
