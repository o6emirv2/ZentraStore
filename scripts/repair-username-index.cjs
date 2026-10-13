'use strict';
const { initFirebaseAdmin } = require('../server/config/firebaseAdmin');
const { repairUsernameIndexes } = require('../server/core/storeUsernameRepair');
async function main() {
  const args = process.argv.slice(2), options = { apply: false };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--apply') options.apply = true;
    else if (['--cursor', '--page-size', '--max-pages'].includes(flag) && args[index + 1] !== undefined) {
      const value = args[++index]; options[flag === '--cursor' ? 'cursor' : flag === '--page-size' ? 'pageSize' : 'maxPages'] = flag === '--cursor' ? value : Number(value);
    } else throw Object.assign(new Error('OPTIONS_INVALID'), { code: 'USERNAME_REPAIR_OPTIONS_INVALID' });
  }
  const { db, admin } = initFirebaseAdmin();
  const result = await repairUsernameIndexes({ db, admin, ...options }); process.stdout.write(JSON.stringify(result) + '\n');
}
main().catch(error => { process.stderr.write(String(error.code || 'USERNAME_REPAIR_FAILED') + '\n'); process.exitCode = 1; });
