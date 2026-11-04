'use strict';
const http = require('node:http'), path = require('node:path'), { spawn } = require('node:child_process');
async function main() {
  const reservation = http.createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, ['server.js'], { cwd: path.resolve(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PUBLIC_BASE_URL: 'https://smoke.zentra.invalid', CANONICAL_ORIGIN: 'https://smoke.zentra.invalid', PUBLIC_API_BASE: 'https://smoke.zentra.invalid', PUBLIC_BACKEND_ORIGIN: 'https://smoke.zentra.invalid', SHOPIER_ENABLED: 'false', PORT: String(port), NODE_ENV: 'production', FIREBASE_KEY: '', PUBLIC_FIREBASE_CONFIG: '', ADMIN_GATE_SIGNING_SECRET: '',
      ADMIN_EMAILS: '', ADMIN_UIDS: '', STORE_KEY_ENCRYPTION_SECRET: '', STORE_KEY_FINGERPRINT_SECRET: '' } });
  let output = '', exited = false;
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  child.once('exit', () => { exited = true; });
  const request = route => new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: route, headers: { host: 'smoke.zentra.invalid' } }, response => { const status = response.statusCode; response.resume(); response.on('end', () => resolve({ status, ok: status === 200 })); });
    req.setTimeout(1000, () => req.destroy(new Error('SMOKE_REQUEST_TIMEOUT'))); req.on('error', reject);
  });
  try {
    let response;
    for (let index = 0; index < 80; index++) {
      if (exited) throw new Error('SERVER_EXITED_BEFORE_HEALTH');
      try { response = await request('/healthz'); if (response.ok) break; } catch (_) {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!response?.ok) { console.error(output.slice(-4000)); throw new Error('SERVER_START_TIMEOUT'); }
    const ready = await request('/readyz');
    if (ready.status !== 503) throw new Error('MISSING_CONFIGURATION_MUST_NOT_BE_READY');
    if (/-----BEGIN PRIVATE KEY-----|Bearer\s+\S{20}/.test(output)) throw new Error('SENSITIVE_STARTUP_LOG');
    console.log(JSON.stringify({ result: 'PASS', health: response.status, missingConfigurationReadiness: ready.status, financialMutations: 0 }));
  } finally {
    if (!exited) { child.kill('SIGTERM'); await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]); }
    if (!exited) child.kill('SIGKILL');
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
