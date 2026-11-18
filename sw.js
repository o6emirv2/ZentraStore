"use strict";
const VERSION = "zentra-public-v110";
const OFFLINE = "/offline.html";
const UNAVAILABLE = "/unavailable.html";
const PRECACHE = [
  OFFLINE,
  UNAVAILABLE,
  "/public/assets/images/apple-touch-icon.png",
  "/public/assets/images/zentra-mark.webp",
  "/public/assets/images/logo.png",
  "/public/css/recovery.css?v=109",
  "/public/css/design-tokens.css?v=109",
  "/public/css/device.css?v=109",
  "/public/css/ambient.css?v=109",
  "/public/js/app/recovery.mjs?v=109",
  "/public/js/app/routes.mjs?v=109",
  "/public/js/app/ambient.mjs?v=109",
  "/public/js/app/device.mjs?v=109",
];
async function cachedPage(path, status = 503) {
  const cached = await caches.open(VERSION).then((cache) => cache.match(path));
  if (!cached) return null;
  return new Response(cached.body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
      "Referrer-Policy": "no-referrer",
    },
  });
}
async function navigate(request) {
  let response;
  try {
    response = await fetch(request);
  } catch {
    return (await cachedPage(OFFLINE)) || Response.error();
  }
  if (response.status >= 500)
    return (await cachedPage(UNAVAILABLE, response.status)) || response;
  return response;
}
function publicAsset(url) {
  return (
    url.origin === self.location.origin &&
    /^\/public\/(?:assets|css|js)\/[A-Za-z0-9_./-]+\.(?:css|js|mjs|png|jpe?g|webp|svg|ico|woff2)$/.test(
      url.pathname,
    ) &&
    !url.pathname.split("/").includes("..")
  );
}
self.addEventListener("install", (event) =>
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(PRECACHE))),
);
self.addEventListener("activate", (event) =>
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys())
        if (key.startsWith("zentra-public-") && key !== VERSION)
          await caches.delete(key);
      await self.clients.claim();
    })(),
  ),
);
self.addEventListener("message", (event) => {
  if (event.data?.type === "APPLY_UPDATE") self.skipWaiting();
});
self.addEventListener("fetch", (event) => {
  const request = event.request,
    url = new URL(request.url);
  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/admin/") ||
    request.headers.has("authorization")
  )
    return;
  if (request.mode === "navigate") {
    event.respondWith(navigate(request));
    return;
  }
  if (!publicAsset(url)) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(VERSION),
        cached = await cache.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (
        response.ok &&
        response.type === "basic" &&
        !response.redirected &&
        !/no-store|private/i.test(response.headers.get("cache-control") || "")
      ) {
        await cache.put(request, response.clone());
        const keys = await cache.keys();
        if (keys.length > 100)
          for (const key of keys.slice(0, keys.length - 100))
            if (!PRECACHE.includes(new URL(key.url).pathname))
              await cache.delete(key);
      }
      return response;
    })(),
  );
});
