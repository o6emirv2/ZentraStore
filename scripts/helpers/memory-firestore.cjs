'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

// Transaction fixture: serial commits, discarded writes on failure, and enforced read-before-write ordering.
function memoryFirestore(initial = []) {
  const records = new Map(initial), stats = { reads: 0, queries: 0, commits: 0, writes: 0 };
  let tail = Promise.resolve(), failCommit = false, queryHook = null;
  const snapshot = (ref) => { const exists = records.has(ref.path), value = structuredClone(records.get(ref.path)); return { id: ref.id, ref, exists, data: () => structuredClone(value) }; };
  function reference(path) {
    return { path, id: path.split('/').at(-1), collection: (name) => collection(`${path}/${name}`),
      get: async () => { stats.reads++; return snapshot(reference(path)); },
      set: async (data, options) => apply([{ kind: options?.merge ? 'merge' : 'set', ref: reference(path), data }]),
      update: async (data) => apply([{ kind: 'update', ref: reference(path), data }]),
      delete: async () => records.delete(path) };
  }
  function collection(path, filters = [], orders = [], take = Infinity, cursor = null) {
    const query = { path, query: true, doc: (id = crypto.randomUUID()) => reference(`${path}/${id}`),
      where: (field, op, value) => collection(path, [...filters, [field, op, value]], orders, take, cursor),
      orderBy: (field, direction = 'asc') => collection(path, filters, [...orders, [field, direction]], take, cursor),
      limit: (count) => collection(path, filters, orders, count, cursor),
      select: () => query, startAfter: (after) => collection(path, filters, orders, take, after),
      add: async data => { const ref = reference(`${path}/${crypto.randomUUID()}`); await ref.set(data); return ref; },
      count: () => ({ get: async () => { const result = await query.get(); return { data: () => ({ count: result.size }) }; } }),
      get: async () => {
        stats.queries++; if (queryHook) await queryHook(path);
        let rows = [...records].filter(([key, row]) => key.startsWith(path + '/') && !key.slice(path.length + 1).includes('/')
          && filters.every(([field, op, value]) => {
            const actual = field === '__name__' ? key.split('/').at(-1) : row[field];
            return op === '==' ? actual === value : op === 'in' ? value.includes(actual)
              : op === '<=' ? actual <= value : op === '>=' ? actual >= value : op === '>' ? actual > value : actual < value;
          }));
        const compare = (a, b) => {
          for (const [field, direction] of orders) {
            const left = field === '__name__' ? a[0].split('/').at(-1) : a[1][field];
            const right = field === '__name__' ? b[0].split('/').at(-1) : b[1][field];
            if (left !== right) return (left < right ? -1 : 1) * (direction === 'desc' ? -1 : 1);
          }
          return a[0].localeCompare(b[0]);
        };
        rows.sort(compare);
        if (cursor) {
          const id = typeof cursor === 'string' ? cursor : cursor.id;
          rows = rows.filter(([key]) => key.split('/').at(-1) > id);
        }
        const docs = rows.slice(0, take).map(([key]) => snapshot(reference(key))); stats.reads += docs.length;
        return { docs, empty: !docs.length, size: docs.length };
      } };
    return query;
  }
  function apply(staged) {
    const updated = new Map(records);
    for (const { kind, ref, data } of staged) {
      if (kind === 'delete') { updated.delete(ref.path); continue; }
      if (kind === 'create') assert(!updated.has(ref.path), 'create cannot overwrite');
      if (kind === 'update') assert(updated.has(ref.path), 'update needs an existing record');
      const before = updated.get(ref.path) || {}, row = { ...(kind === 'merge' || kind === 'update' ? before : {}), ...structuredClone(data) };
      for (const [key, value] of Object.entries(row)) if (value?.increment !== undefined) row[key] = (before[key] || 0) + value.increment;
      updated.set(ref.path, row);
    }
    if (failCommit) throw Object.assign(new Error('controlled commit failure'), { code: 'CONTROLLED_COMMIT_FAILURE' });
    records.clear(); updated.forEach((value, key) => records.set(key, value)); stats.writes += staged.length; stats.commits++;
  }
  const db = { collection, doc: reference, records, stats,
    getAll: async (...refs) => Promise.all(refs.map((ref) => ref.get())),
    setFailure: (value) => { failCommit = value; }, setQueryHook: (hook) => { queryHook = hook; },
    runTransaction: (callback) => {
      const job = tail.then(async () => {
        const staged = []; let writing = false;
        const read = (target) => { assert(!writing, 'all transaction reads precede writes'); return target.get(); };
        const tx = { get: read, getAll: (...refs) => Promise.all(refs.map(read)) };
        for (const kind of ['set', 'create', 'update', 'delete']) tx[kind] = (ref, data, options) => {
          writing = true; staged.push({ kind: kind === 'set' && options?.merge ? 'merge' : kind, ref, data });
        };
        const result = await callback(tx); apply(staged); return result;
      });
      tail = job.catch(() => {}); return job;
    }, batch: () => {
      const staged = [], batch = { commit: async () => apply(staged) };
      for (const kind of ['set', 'create', 'update', 'delete']) batch[kind] = (ref, data, options) => {
        staged.push({ kind: kind === 'set' && options?.merge ? 'merge' : kind, ref, data }); return batch;
      };
      return batch;
    } };
  return db;
}
function mockModule(name, exports) {
  const filename = require.resolve(name); require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
const admin = { firestore: { FieldPath: { documentId: () => '__name__' }, FieldValue: { increment: (value) => ({ increment: value }) } } };
module.exports = { memoryFirestore, mockModule, admin };
