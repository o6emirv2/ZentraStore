export const ENTRY_PARAMETER = "devam";
const base = "https://zentra.invalid";
const pages = Object.freeze({
  "/": "home",
  "/index.html": "home",
  "/magaza": "catalog",
  "/sepet": "cart",
  "/hesabim": "account",
  "/siparisler": "orders",
  "/favoriler": "favorites",
  "/destek": "support",
  "/bildirimler": "notifications",
  "/kuponlar": "coupons",
});

export function safeStorePath(value = "") {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\x00-\x20\x7f]/.test(value)
  )
    return "";
  const rawPath = value.split(/[?#]/, 1)[0];
  const pathname = rawPath.replace(/\/$/, "") || "/";
  if (
    !Object.hasOwn(pages, pathname) &&
    !/^\/(?:kategori|urun)\/[a-z0-9][a-z0-9-]{0,79}$/.test(pathname)
  )
    return "";
  try {
    const url = new URL(value, base);
    if (url.origin !== base || url.hash) return "";
    if (url.searchParams.has(ENTRY_PARAMETER))
      url.searchParams.delete(ENTRY_PARAMETER);
    return (pathname === "/index.html" ? "/" : pathname) + url.search;
  } catch {
    return "";
  }
}

export function storeRoute(pathname = "/", search = "") {
  const path = safeStorePath(pathname);
  const parts = path.split("/");
  const query = new URLSearchParams(search);
  return {
    name:
      (path === "/" && query.has(ENTRY_PARAMETER) ? "notFound" : pages[path]) ||
      (path.startsWith("/urun/")
        ? "product"
        : path.startsWith("/kategori/")
          ? "category"
          : "notFound"),
    id: parts[2] || "",
    query,
  };
}

export function storeEntryPath(target) {
  const path = safeStorePath(target);
  if (!path) throw new TypeError("STORE_DESTINATION_INVALID");
  return path === "/"
    ? "/"
    : "/?" + new URLSearchParams({ [ENTRY_PARAMETER]: path });
}

export function storeEntryUrl(origin, target) {
  const url = new URL(origin);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password)
    throw new TypeError("STORE_ORIGIN_INVALID");
  return new URL(storeEntryPath(target), url.origin).href;
}

export function entryDestination(href) {
  try {
    const url = new URL(href);
    if (!["/", "/index.html"].includes(url.pathname)) return "";
    const values = url.searchParams.getAll(ENTRY_PARAMETER);
    return values.length === 1 ? safeStorePath(values[0]) : "";
  } catch {
    return "";
  }
}

export function restoreStoreEntry(view) {
  const target = entryDestination(view?.location?.href);
  if (target) view.history.replaceState(null, "", target);
  return target;
}

export function recoveryDestination(href) {
  try {
    const url = new URL(href);
    if (["/", "/index.html"].includes(url.pathname)) return "";
    const path = safeStorePath(url.pathname + url.search);
    return path ? storeEntryPath(path) : "";
  } catch {
    return "";
  }
}
