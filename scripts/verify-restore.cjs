'use strict';
// Run only after an actual Firestore backup has been restored to a separate, isolated project.
async function main() {
  const { initFirebaseAdmin } = require('../server/config/firebaseAdmin'), { recordRestoreVerification } = require('../server/core/restoreVerification');
  const firebase = initFirebaseAdmin();
  if (!firebase.db || !firebase.app) throw Object.assign(new Error('SOURCE_DATABASE_UNAVAILABLE'), { code: 'SOURCE_DATABASE_UNAVAILABLE' });
  let account;
  try { account = JSON.parse(process.env.RESTORE_FIREBASE_KEY || ''); } catch (_) { throw Object.assign(new Error('RESTORE_CREDENTIAL_REQUIRED'), { code: 'RESTORE_CREDENTIAL_REQUIRED' }); }
  if (account.project_id !== process.env.RESTORE_PROJECT_ID || !account.project_id || account.project_id === firebase.app.options.projectId) throw Object.assign(new Error('ISOLATED_RESTORE_PROJECT_REQUIRED'), { code: 'ISOLATED_RESTORE_PROJECT_REQUIRED' });
  const admin = require('firebase-admin');
  const restored = admin.initializeApp({ credential: admin.credential.cert(account), projectId: account.project_id }, 'zentra-restore-verification');
  try {
    const result = await recordRestoreVerification({ source: firebase.db, restored: admin.firestore(restored), sourceProject: firebase.app.options.projectId, restoreProject: account.project_id });
    console.log(JSON.stringify(result));
  } finally { await restored.delete(); await firebase.app.delete(); }
}
main().catch(error => { console.error(String(error.code || '').replace(/[^A-Z0-9_]/g, '').slice(0, 100) || 'RESTORE_VERIFICATION_FAILED'); process.exitCode = 1; });
