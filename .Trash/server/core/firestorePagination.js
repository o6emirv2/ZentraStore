'use strict';

const FALLBACK_SCAN_LIMIT = 2_000;
const FALLBACK_CACHE_TTL_MS = 60_000;
const INDEX_RETRY_DELAY_MS = 90_000;
const MAX_FALLBACK_CACHE_ENTRIES = 100;
const fallbackCache = new Map();
const unavailableIndexes = new Map();

function pageError(code = 'STORE_PAGE_CURSOR_INVALID', statusCode = 400) {
  return Object.assign(new Error(code), { code, statusCode });
}

function indexMissing(error) {
  const code = String(error?.code || '').toLowerCase();
  return code === '9' || code === 'failed-precondition'
    || /(?:requires an index|index.*required)/i.test(String(error?.message || ''));
}

function filterCacheKey(collection, filters) {
  return JSON.stringify([String(collection), ...filters.map(([field, value]) => [String(field), value])]);
}

function trimFallbackCache() {
  const now = Date.now();
  for (const [key, entry] of fallbackCache) {
    if (entry.until <= now) fallbackCache.delete(key);
  }
  while (fallbackCache.size > MAX_FALLBACK_CACHE_ENTRIES) {
    fallbackCache.delete(fallbackCache.keys().next().value);
  }
  for (const [key, until] of unavailableIndexes) {
    if (until <= now) unavailableIndexes.delete(key);
  }
}

function invalidateCreatedAtPageCache(collection = '') {
  const requested = String(collection || '');
  for (const key of fallbackCache.keys()) {
    if (!requested || JSON.parse(key)[0] === requested) fallbackCache.delete(key);
  }
}

async function unindexedFilteredDocuments({ collectionRef, collection, filters, cacheKey }) {
  if (!filters.length) throw pageError('STORE_INDEX_REQUIRED', 503);
  const cached = fallbackCache.get(cacheKey);
  if (cached && cached.until > Date.now()) return cached.docs;

  const preferred = filters.find(([field]) => String(field) === 'uid') || filters[0];
  const query = collectionRef.where(String(preferred[0]), '==', preferred[1]);
  let snapshot;
  try {
    snapshot = await query.limit(FALLBACK_SCAN_LIMIT + 1).get();
  } catch (error) {
    if (indexMissing(error)) throw pageError('STORE_INDEX_REQUIRED', 503);
    throw error;
  }
  if (snapshot.docs.length > FALLBACK_SCAN_LIMIT) throw pageError('STORE_INDEX_REQUIRED', 503);

  const docs = snapshot.docs
    .filter((document) => {
      const row = document.data() || {};
      return Number.isFinite(Number(row.createdAt))
        && filters.every(([field, value]) => row[String(field)] === value);
    })
    .sort((left, right) => {
      const delta = Number(right.data()?.createdAt || 0) - Number(left.data()?.createdAt || 0);
      return delta || String(right.id || '').localeCompare(String(left.id || ''));
    });
  fallbackCache.set(cacheKey, { docs, until: Date.now() + FALLBACK_CACHE_TTL_MS, collection });
  trimFallbackCache();
  return docs;
}

async function createdAtPage({ db, collection = '', filters = [], limit = 30, cursor = '' } = {}) {
  if (!db || !collection) throw pageError('STORE_STORAGE_UNAVAILABLE', 503);
  const safeLimit = Math.max(1, Math.min(200, Math.trunc(Number(limit) || 30)));
  const collectionRef = db.collection(String(collection));
  const safeFilters = filters.map(([field, value]) => [String(field), value]);
  const cacheKey = filterCacheKey(collection, safeFilters);
  let query = collectionRef;
  for (const [field, value] of safeFilters) query = query.where(field, '==', value);
  query = query.orderBy('createdAt', 'desc');

  const safeCursor = String(cursor || '').trim();
  let anchor = null;
  if (safeCursor) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{3,159}$/.test(safeCursor)) throw pageError();
    anchor = await collectionRef.doc(safeCursor).get();
    const row = anchor.exists ? anchor.data() || {} : null;
    if (!row || !Number.isFinite(Number(row.createdAt))
      || safeFilters.some(([field, value]) => row[field] !== value)) throw pageError();
    query = query.startAfter(anchor);
  }

  let snapshot;
  if ((unavailableIndexes.get(cacheKey) || 0) <= Date.now()) {
    try {
      snapshot = await query.limit(safeLimit + 1).get();
      unavailableIndexes.delete(cacheKey);
    } catch (error) {
      if (!indexMissing(error)) throw error;
      unavailableIndexes.set(cacheKey, Date.now() + INDEX_RETRY_DELAY_MS);
    }
  }

  if (!snapshot) {
    const sorted = await unindexedFilteredDocuments({
      collectionRef,
      collection: String(collection),
      filters: safeFilters,
      cacheKey
    });
    const anchorIndex = safeCursor ? sorted.findIndex((document) => document.id === safeCursor) : -1;
    if (safeCursor && anchorIndex < 0) throw pageError();
    const offset = anchorIndex + 1;
    const docs = sorted.slice(offset, offset + safeLimit);
    const hasMore = offset + docs.length < sorted.length;
    return { docs, hasMore, nextCursor: hasMore ? String(docs[docs.length - 1]?.id || '') : '' };
  }
  const docs = snapshot.docs.slice(0, safeLimit);
  const hasMore = snapshot.docs.length > safeLimit;
  return { docs, hasMore, nextCursor: hasMore ? String(docs[docs.length - 1]?.id || '') : '' };
}

module.exports = { createdAtPage, invalidateCreatedAtPageCache };
