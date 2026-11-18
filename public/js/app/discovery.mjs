export const PRODUCT_CATEGORIES = Object.freeze([
  { id: "", label: "Tüm Ürünler", href: "/magaza", icon: "grid" },
  { id: "pubg-ios", label: "Pubg Mobile (iOS)", href: "/kategori/pubg-ios", icon: "game" },
  { id: "pubg-android", label: "Pubg Mobile (Android)", href: "/kategori/pubg-android", icon: "game" },
  { id: "oxide-ios", label: "Oxide (iOS)", href: "/kategori/oxide-ios", icon: "flame" },
  { id: "oxide-android", label: "Oxide (Android)", href: "/kategori/oxide-android", icon: "flame" },
  { id: "gbox-iphone", label: "GBOX (iPhone)", href: "/kategori/gbox-iphone", icon: "box" },
  { id: "gbox-ipad", label: "GBOX (iPad)", href: "/kategori/gbox-ipad", icon: "box" },
].map(Object.freeze));

export const STORE_NAVIGATION = Object.freeze([
  ...PRODUCT_CATEGORIES,
  { id: "featured", label: "Öne Çıkan Ürünler", href: "/magaza?featured=1", icon: "sparkles" },
  { id: "account", label: "Hesabım", href: "/hesabim", icon: "user" },
  { id: "promotion", label: "Promosyon Kodu", href: "/promosyonlar", icon: "gift" },
  { id: "discount", label: "İndirim Kodu", href: "/kuponlar", icon: "ticket" },
  { id: "orders", label: "Siparişlerim", href: "/siparisler", icon: "receipt" },
  { id: "cart", label: "Sepetim", href: "/sepet", icon: "bag" },
  { id: "support", label: "DESTEK KANALLARI", href: "/destek", icon: "support" },
].map(Object.freeze));

export const HOME_CATEGORIES = Object.freeze(PRODUCT_CATEGORIES.slice(1, 5).map(category => Object.freeze({
  ...category,
  game: category.id.startsWith("pubg-") ? "PUBG MOBILE" : "OXIDE",
  platform: category.id.endsWith("-ios") ? "iOS" : "ANDROID",
  image: category.id.startsWith("pubg-")
    ? "/public/assets/categories/pubg-mobile.jpeg"
    : "/public/assets/categories/oxide-flame.jpeg",
})));

export const HOME_CHANNELS = Object.freeze([
  { id: "official-telegram", title: "TELEGRAM KANALIMIZ", description: "Duyurular ve mağaza haberleri", icon: "telegram", tone: "" },
  { id: "guarantee-telegram", title: "GÜVENCE KANALIMIZ", description: "Topluluk paylaşımlarını incele", icon: "shield", tone: "" },
  { id: "chat-telegram", title: "SOHBET GRUBUMUZ", description: "Zentra topluluğuna katıl", icon: "comment", tone: "gold" },
  { id: "free-telegram", title: "ÜCRETSİZ İÇERİK KANALIMIZ", description: "Yeni içerikleri keşfet", icon: "gift", tone: "blue" },
].map(Object.freeze));

export function channelDestination(links, id) {
  const link = (Array.isArray(links) ? links : []).find(item => item.id === id);
  if (!link || link.enabled === false || link.showOnHome === false) return "";
  return /^https:\/\/t\.me\/(?:\+[A-Za-z0-9_-]{10,128}|[A-Za-z][A-Za-z0-9_]{4,31})\/?$/.test(link.url || "") ? link.url : "";
}

export function activeDiscovery(route) {
  if (route.name === "category") return route.id === "gbox-ios" ? "gbox" : route.id;
  if (route.name === "catalog" && route.query.get("featured") === "1") return "featured";
  if (["catalog", "home"].includes(route.name)) return "";
  if (route.name === "promotions") return "promotion";
  if (route.name === "coupons") return "discount";
  return { account: "account", orders: "orders", cart: "cart", support: "support" }[route.name] || null;
}
