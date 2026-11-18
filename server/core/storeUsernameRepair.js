'use strict';
const { usernameKeys, usernameRegistryId, validateUsername } = require('./storeUsername');

async function repairUsernameIndexes({ db, admin, apply = false, pageSize = 100, maxPages = 20, cursor = '' }) {
  if (!db || !admin?.firestore?.FieldPath || typeof apply !== 'boolean' || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 200
    || !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 1000 || typeof cursor !== 'string' || cursor.length > 128 || /[/\u0000-\u001f]/.test(cursor)) {
    throw Object.assign(new Error('USERNAME_REPAIR_OPTIONS_INVALID'), { code: 'USERNAME_REPAIR_OPTIONS_INVALID' });
  }
  const report = { mode: apply ? 'apply' : 'dry-run', visited: 0, updated: 0, registryCreated: 0, conflicts: [], skipped: [], nextCursor: cursor, complete: false };
  for (let page = 0; page < maxPages; page++) {
    let query = db.collection('users').orderBy(admin.firestore.FieldPath.documentId()).select('username', 'usernameLower').limit(pageSize);
    if (report.nextCursor) query = query.startAfter(report.nextCursor);
    const snapshot = await query.get();
    for (const document of snapshot.docs) {
      report.visited++;
      let name;
      try { name = validateUsername(document.data()?.username); }
      catch (_) { report.skipped.push({ uid: document.id, reason: 'USERNAME_INVALID' }); continue; }
      const inspect = async tx => {
        const ref = db.collection('users').doc(document.id);
        const current = await (tx ? tx.get(ref) : ref.get());
        if (!current.exists || current.data()?.username !== document.data()?.username) return { skipped: true };
        const keys = usernameKeys(name), entries = keys.map(key => ({ key, ref: db.collection('usernameRegistry').doc(usernameRegistryId(key)) }));
        const registries = await Promise.all(entries.map(entry => tx ? tx.get(entry.ref) : entry.ref.get()));
        const conflict = registries.some(row => row.exists && row.data()?.uid !== document.id);
        const missing = entries.filter((_, index) => !registries[index].exists);
        const changed = current.data().usernameLower !== keys[0];
        if (tx && changed) tx.set(ref, { usernameLower: keys[0] }, { merge: true });
        if (tx && !conflict) for (const entry of missing) tx.create(entry.ref, { uid: document.id, username: current.data().username, usernameLower: entry.key, updatedAt: Date.now() });
        return { changed, created: conflict ? 0 : missing.length, conflict };
      };
      const result = apply ? await db.runTransaction(inspect) : await inspect(null);
      if (result.skipped) report.skipped.push({ uid: document.id, reason: 'PROFILE_CHANGED' });
      if (result.changed) report.updated++;
      report.registryCreated += result.created || 0;
      if (result.conflict) report.conflicts.push({ uid: document.id, reason: 'REGISTRY_OWNER_CONFLICT' });
    }
    if (snapshot.docs.length) report.nextCursor = snapshot.docs.at(-1).id;
    if (snapshot.size < pageSize) { report.complete = true; report.nextCursor = ''; break; }
  }
  return report;
}
module.exports = { repairUsernameIndexes };
