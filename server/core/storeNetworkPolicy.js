'use strict';
const fs = require('node:fs/promises');
const maxmind = require('maxmind');
const ipaddr = require('ipaddr.js');
const env = require('../config/env');
let cache = null, opening = null;
const fail = (code) => { throw Object.assign(new Error(code), { code, statusCode: 503, storeSecurityError: true }); };
function trustedProxySetting() {
  if (env.nodeEnv !== 'production') return false;
  const values = String(process.env.STORE_TRUSTED_PROXY_CIDRS || '').split(',').map(x => x.trim()).filter(Boolean);
  if (!values.length || values.length > 32) return false;
  try {
    for (const value of values) {
      const [address, prefix] = value.includes('/') ? ipaddr.parseCIDR(value) : [ipaddr.parse(value), null];
      if (prefix === 0 || address.range() === 'unspecified') return false;
    }
    return values;
  } catch (_) { return false; }
}
function normalizeIp(value) {
  try {
    if (typeof value !== 'string' || value.includes('%') || value.length > 80) throw new Error();
    let ip = ipaddr.parse(value);
    if (ip.kind() === 'ipv6' && ip.isIPv4MappedAddress()) ip = ip.toIPv4Address();
    if (ip.range() !== 'unicast' && !(env.nodeEnv !== 'production' && ip.range() === 'loopback')) throw new Error();
    return ip.toString();
  } catch (_) { fail('SECURITY_IP_UNAVAILABLE'); }
}
function maxAgeMs() {
  const hours = Number(process.env.STORE_NETWORK_DB_MAX_AGE_HOURS || 72);
  if (!Number.isSafeInteger(hours) || hours < 1 || hours > 168) fail('SECURITY_NETWORK_CONFIG_INVALID');
  return hours * 3600000;
}
function checkMetadata(reader) {
  const builtAt = Number(reader.metadata?.buildEpoch);
  if (!['GeoIP2-Anonymous-IP', 'GeoIP-Anonymous-Plus'].includes(reader.metadata?.databaseType)) fail('SECURITY_NETWORK_DB_INVALID');
  if (!Number.isFinite(builtAt) || builtAt > Date.now() + 300000 || Date.now() - builtAt > maxAgeMs()) fail('SECURITY_NETWORK_DB_STALE');
  return { builtAt, databaseType: reader.metadata.databaseType, maxAgeHours: maxAgeMs() / 3600000 };
}
async function loadReader() {
  const filename = String(process.env.STORE_ANONYMOUS_IP_DB_PATH || '').trim();
  if (!filename || !filename.startsWith('/')) fail('SECURITY_NETWORK_UNCONFIGURED');
  if (cache?.filename === filename && cache.checkedAt > Date.now() - 5000) { checkMetadata(cache.reader); return cache.reader; }
  if (opening) return opening;
  opening = (async () => {
    try {
      const stat = await fs.stat(filename);
      if (!stat.isFile() || stat.size < 128 || stat.size > 512 * 1024 * 1024) fail('SECURITY_NETWORK_DB_INVALID');
      const stamp = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
      const reader = cache?.filename === filename && cache.stamp === stamp ? cache.reader : await maxmind.open(filename);
      checkMetadata(reader); cache = { filename, reader, stamp, checkedAt: Date.now() }; return reader;
    } catch (error) {
      cache = null;
      if (error.storeSecurityError) throw error;
      fail('SECURITY_NETWORK_UNAVAILABLE');
    } finally { opening = null; }
  })();
  return opening;
}
async function networkReadiness() {
  try {
    if (env.nodeEnv === 'production' && !trustedProxySetting()) fail('SECURITY_PROXY_UNCONFIGURED');
    return { ready: true, ...checkMetadata(await loadReader()), policy: 'strict', blocksHosting: true };
  } catch (error) { return { ready: false, reason: error.code || 'SECURITY_NETWORK_UNAVAILABLE', policy: 'strict', blocksHosting: true }; }
}
async function checkNetwork(value) {
  if (env.nodeEnv === 'production' && !trustedProxySetting()) fail('SECURITY_PROXY_UNCONFIGURED');
  const ip = normalizeIp(value), reader = await loadReader();
  let record;
  try { record = reader.get(ip); } catch (_) { fail('SECURITY_NETWORK_UNAVAILABLE'); }
  // Anonymous-IP datasets are sparse: a valid lookup with no record means "not listed", never "guaranteed residential".
  if (record != null && (typeof record !== 'object' || Array.isArray(record))) fail('SECURITY_NETWORK_DB_INVALID');
  const flags = ['is_anonymous', 'is_anonymous_vpn', 'is_hosting_provider', 'is_public_proxy', 'is_residential_proxy', 'is_tor_exit_node'];
  if (record && flags.some(flag => record[flag] !== undefined && typeof record[flag] !== 'boolean')) fail('SECURITY_NETWORK_DB_INVALID');
  return { ip, blocked: !!record && flags.some(flag => record[flag] === true),
    categories: record ? flags.filter(flag => record[flag] === true) : [], checkedAt: Date.now(), ...checkMetadata(reader) };
}
module.exports = { normalizeIp, trustedProxySetting, networkReadiness, checkNetwork };
