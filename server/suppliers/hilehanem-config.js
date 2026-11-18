"use strict";

const KEYS = Object.freeze({
  baseUrl: "HILEHANEM_API_BASE_URL",
  apiKey: "HILEHANEM_API_KEY",
});

function validBaseUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password &&
      !url.search && !url.hash && !url.port &&
      (url.hostname === "hilehanem.com" || url.hostname.endsWith(".hilehanem.com")) &&
      !/[\\\x00-\x20\x7f]/.test(value);
  } catch {
    return false;
  }
}

function fromEnvironment(source = process.env) {
  const baseUrl = String(source[KEYS.baseUrl] || "").trim();
  const apiKey = String(source[KEYS.apiKey] || "").trim();
  const missing = Object.values(KEYS).filter((name) => !String(source[name] || "").trim());
  const invalid = [];
  if (baseUrl && !validBaseUrl(baseUrl)) invalid.push(KEYS.baseUrl);
  if (apiKey && !/^hh_[A-Za-z0-9_-]{16,256}$/.test(apiKey)) invalid.push(KEYS.apiKey);
  const config = {
    mode: "native_api",
    configured: missing.length === 0 && invalid.length === 0,
    missing: Object.freeze(missing),
    invalid: Object.freeze(invalid),
  };
  Object.defineProperties(config, { baseUrl: { value: baseUrl }, apiKey: { value: apiKey } });
  return Object.freeze(config);
}

module.exports = { KEYS, fromEnvironment, validBaseUrl };
