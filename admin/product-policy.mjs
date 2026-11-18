export function isProductSettingsUpdate(method, path) {
  return method === "PATCH" && /^\/api\/admin\/store\/products\/[a-z][a-z0-9-]{1,79}$/.test(path);
}
