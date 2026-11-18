"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, ".."),
  checkedAt = Date.now();
const { runTests } = require("./run-tests.cjs");
function run(label, args, timeout = 240000) {
  const r = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    timeout,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (r.status !== 0) {
    process.stdout.write(r.stdout || "");
    process.stderr.write(r.stderr || "");
  }
  console.log(`${label}: ${r.status === 0 ? "PASS" : "FAIL"}`);
  return { exitCode: r.status ?? 1, stdout: r.stdout || "" };
}
const source = run("Source / responsive viewport", [
  "scripts/verify-source.cjs",
]);
const modules = run("Module graph", [
  "--experimental-vm-modules",
  "scripts/verify-module-graph.cjs",
]);
const catalog = spawnSync(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["run", "check:catalog"],
  { cwd: root, encoding: "utf8" },
);
console.log(`Catalog: ${catalog.status === 0 ? "PASS" : "FAIL"}`);
if (catalog.status !== 0)
  process.stderr.write(catalog.stderr || catalog.stdout || "");
const files = fs
  .readdirSync(path.join(root, "scripts"))
  .filter((x) => x.endsWith("-regression.cjs"))
  .sort()
  .map((x) => "scripts/" + x);
const testResult = runTests({
  files,
  reporter: "./scripts/evidence-reporter.cjs",
  environment: process.env,
  run: spawnSync,
});
const tests = {
  exitCode:
    testResult.status === 0 && !testResult.error && !testResult.signal ? 0 : 1,
  stdout: testResult.stdout || "",
};
console.log(
  `Business / security regression: ${tests.exitCode === 0 ? "PASS" : "FAIL"}`,
);
const events = tests.stdout.split("\n").flatMap((line) => {
  try {
    return [JSON.parse(line)];
  } catch {
    return [];
  }
});
const final = events
  .filter((x) => x.type === "test:summary" && !x.data.file)
  .at(-1)?.data;
const failures = events
  .filter((event) => event.type === "test:fail")
  .map((event) => ({
    file: path.basename(event.data.file || "unknown"),
    name: String(event.data.name || "Unknown test").slice(0, 300),
    code: String(
      event.data.details?.error?.cause?.code ||
        event.data.details?.error?.code ||
        "TEST_FAILED",
    ).slice(0, 100),
    message: String(
      event.data.details?.error?.cause?.message ||
        event.data.details?.error?.message ||
        "Test failed",
    ).slice(0, 1500),
  }));
for (const failure of failures)
  console.error(JSON.stringify({ event: "REGRESSION_FAILED", ...failure }));
if (tests.exitCode !== 0 && !failures.length)
  console.error(
    "REGRESSION_RUN_INCOMPLETE: " +
      String(testResult.stderr || "No complete test result").slice(-3000),
  );
const suites = Object.fromEntries(
  events
    .filter((x) => x.type === "test:summary" && x.data.file)
    .map((x) => [
      path.basename(x.data.file),
      {
        ...x.data.counts,
        verified:
          x.data.success === true &&
          x.data.counts.tests > 0 &&
          x.data.counts.failed === 0 &&
          x.data.counts.cancelled === 0 &&
          x.data.counts.skipped === 0,
      },
    ]),
);
const regression = {
  exitCode: tests.exitCode,
  passed: final?.counts.passed || 0,
  failed: final?.counts.failed || 0,
  total: final?.counts.tests || 0,
  skipped: final?.counts.skipped || 0,
  suites,
  failures,
};
if (
  !final?.success ||
  !regression.total ||
  files.some((x) => !suites[path.basename(x)]?.verified)
)
  regression.exitCode = 1;
const audit = spawnSync(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["audit", "--omit=dev", "--json"],
  { cwd: root, encoding: "utf8", timeout: 60000, maxBuffer: 4 * 1024 * 1024 },
);
let dependencies = {
  verified: false,
  checkedAt: Date.now(),
  reason: "AUDIT_UNAVAILABLE",
};
try {
  const report = JSON.parse(audit.stdout);
  if (
    !report.error &&
    Number.isSafeInteger(report.metadata?.vulnerabilities?.total)
  )
    dependencies = {
      verified: true,
      checkedAt: Date.now(),
      ...report.metadata.vulnerabilities,
      vulnerabilities: report.metadata.vulnerabilities.total,
    };
} catch {}
const evidence = {
  version: 2,
  checkedAt,
  sourceDigest: require("../server/core/securityAssessment").sourceDigest(root),
  source: { exitCode: source.exitCode },
  modules: { exitCode: modules.exitCode },
  catalog: { exitCode: catalog.status ?? 1 },
  regression,
  dependencies,
};
fs.writeFileSync(
  path.join(root, "validation-evidence.json"),
  JSON.stringify(evidence, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    passed: regression.passed,
    failed: regression.failed,
    skipped: regression.skipped,
    suites: Object.keys(suites).length,
    dependencies,
  }),
);
process.exitCode =
  source.exitCode ||
  modules.exitCode ||
  (catalog.status ?? 1) ||
  regression.exitCode ||
  (!dependencies.verified || dependencies.vulnerabilities > 0 ? 1 : 0);
