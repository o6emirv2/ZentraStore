'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { memoryFirestore, admin } = require('./helpers/memory-firestore.cjs');
const { repairUsernameIndexes } = require('../server/core/storeUsernameRepair');
const { findUsernameProfiles } = require('../server/core/storeUsername');
test('legacy mixed-case repair defaults to dry run and preserves identity and financial fields', async () => {
  const db = memoryFirestore([['users/member', { username: 'EmirHan', storeBalanceKurus: 20000, orderId: 'keep-order' }]]);
  const before = structuredClone([...db.records]);
  const preview = await repairUsernameIndexes({ db, admin }); assert.equal(preview.updated, 1); assert.deepEqual([...db.records], before);
  await repairUsernameIndexes({ db, admin, apply: true });
  const row = db.records.get('users/member'); assert.equal(row.username, 'EmirHan'); assert.equal(row.storeBalanceKurus, 20000); assert.equal(row.orderId, 'keep-order');
  assert.deepEqual((await findUsernameProfiles(db, 'emirhan')).map(doc => doc.id), ['member']);
  const writes = db.stats.writes; await repairUsernameIndexes({ db, admin, apply: true }); assert.equal(db.stats.writes, writes);
});
test('duplicate legacy names remain ambiguous and registry ownership is never overwritten', async () => {
  const db = memoryFirestore([['users/first', { username: 'SameName' }], ['users/second', { username: 'SAMENAME' }]]);
  const result = await repairUsernameIndexes({ db, admin, apply: true }); assert.equal(result.conflicts.length, 1);
  assert.equal((await findUsernameProfiles(db, 'samename')).length, 2);
});
test('repair is bounded, resumable and keeps canonical Unicode lookup compatible', async () => {
  const db = memoryFirestore([['users/a', { username: 'ÜyelikA' }], ['users/b', { username: 'U\u0308yelikB' }]]);
  const first = await repairUsernameIndexes({ db, admin, apply: true, pageSize: 1, maxPages: 1 }); assert.equal(first.complete, false); assert.equal(first.visited, 1);
  const second = await repairUsernameIndexes({ db, admin, apply: true, cursor: first.nextCursor }); assert.equal(second.visited, 1);
  assert.deepEqual((await findUsernameProfiles(db, 'üyelikb')).map(doc => doc.id), ['b']);
});
test('a saturated legacy query cannot falsely claim that a partially loaded username is unique', async () => {
  const rows = Array.from({ length: 5 }, (_, index) => ['users/user' + index, { username: index < 4 ? 'Different' + index : 'EmirHan', usernameLower: 'emirhan' }]);
  const db = memoryFirestore(rows);
  await assert.rejects(findUsernameProfiles(db, 'emirhan'), { code: 'USERNAME_AMBIGUOUS' });
});
