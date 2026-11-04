'use strict';
const fs = require('node:fs'), path = require('node:path'), { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'), checkedAt = Date.now();
function run(label, command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: 240000, maxBuffer: 12 * 1024 * 1024 });
  if (result.status !== 0) { process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || ''); }
  console.log(`${label}: ${result.status === 0 ? 'PASS' : 'FAIL'}`);
  return { exitCode: result.status ?? 1, stdout: result.stdout || '', stderr: result.stderr || '' };
}
const source = run('Source and viewport', process.execPath, ['scripts/verify-source.cjs']);
const modules = run('Module links', process.execPath, ['--experimental-vm-modules', 'scripts/verify-module-graph.cjs']);
const catalog = run('Catalog', process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'check:catalog']);
const files = fs.readdirSync(path.join(root, 'scripts')).filter(name => name.endsWith('-regression.cjs')).sort().map(name => 'scripts/' + name);
const tests = run('Regression', process.execPath, ['--test', '--test-reporter=tap', ...files]);
const number = key => Number(new RegExp(`^# ${key} (\\d+)`, 'm').exec(tests.stdout)?.[1] || 0);
const regression = { exitCode: tests.exitCode, passed: number('pass'), failed: number('fail'), total: number('tests'), skipped: number('skipped') };
if (!regression.total || regression.failed) regression.exitCode = 1;
const audit = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['audit', '--omit=dev', '--json'], { cwd: root, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
let dependencies = { verified: false, checkedAt: Date.now(), vulnerabilities: null, reason: 'AUDIT_UNAVAILABLE' };
try {
  const report = JSON.parse(audit.stdout);
  if (!report.error && report.metadata?.vulnerabilities && Number.isSafeInteger(report.metadata.vulnerabilities.total)) {
    const counts = report.metadata.vulnerabilities;
    dependencies = { verified: true, checkedAt: Date.now(), vulnerabilities: counts.total, moderate: counts.moderate, high: counts.high, critical: counts.critical };
  }
} catch (_) {}
const evidence = { version: 1, checkedAt, sourceDigest: require('../server/core/securityAssessment').sourceDigest(root),
  source: { exitCode: source.exitCode }, modules: { exitCode: modules.exitCode }, catalog: { exitCode: catalog.exitCode }, regression, dependencies };
fs.writeFileSync(path.join(root, 'validation-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(evidence));
process.exitCode = source.exitCode || modules.exitCode || catalog.exitCode || regression.exitCode || (dependencies.verified && (dependencies.moderate + dependencies.high + dependencies.critical > 0) ? 1 : 0);
