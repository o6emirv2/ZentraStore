export const CARD_STYLES = Object.freeze({
  classic: "Klasik",
  enhanced: "Gelişmiş",
  satin: "Saten",
  prism: "Prizma",
  signature: "İmza",
});
export const GALLERY_LIMIT = 20;

export function cardStyle(value) {
  return Object.hasOwn(CARD_STYLES, value) ? value : "classic";
}
export function galleryPath(value) {
  if (typeof value !== "string" || value.length > 300) return "";
  const path = value.trim().replace(/^public\//, "/public/");
  return /^\/public\/assets\/products\/(?:[\w-][\w.-]*\/)*[\w-][\w.-]*\.(?:jpe?g|png|webp|avif|gif)$/i.test(
    path,
  )
    ? path
    : "";
}
