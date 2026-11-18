"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const systemKeys = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "ComSpec",
  "COMSPEC",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
];
function testEnvironment(source = process.env) {
  const environment = { NODE_ENV: "test", TZ: "UTC" };
  for (const name of systemKeys)
    if (typeof source[name] === "string") environment[name] = source[name];
  return environment;
}
function runTests({
  files,
  reporter,
  environment = process.env,
  run = spawnSync,
} = {}) {
  const targets =
    files ||
    fs
      .readdirSync(__dirname)
      .filter((name) => name.endsWith("-regression.cjs"))
      .sort()
      .map((name) => "scripts/" + name);
  if (!targets.length) throw new Error("REGRESSION_FILES_REQUIRED");
  return run(
    process.execPath,
    [
      "--test",
      "--test-concurrency=2",
      ...(reporter ? ["--test-reporter=" + reporter] : []),
      ...targets,
    ],
    {
      cwd: root,
      env: testEnvironment(environment),
      encoding: "utf8",
      timeout: 240000,
      maxBuffer: 20 * 1024 * 1024,
    },
  );
}
function main() {
  const files = process.argv.slice(2);
  if (
    files.some(
      (file) =>
        !/^scripts\/[a-z0-9-]+-regression\.cjs$/.test(file) ||
        !fs.existsSync(path.join(root, file)),
    )
  ) {
    process.stderr.write("REGRESSION_TARGET_INVALID\n");
    return 1;
  }
  const result = runTests({ files: files.length ? files : undefined });
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
  if (result.error || result.signal)
    process.stderr.write("REGRESSION_RUN_INCOMPLETE\n");
  return result.status === 0 && !result.error && !result.signal ? 0 : 1;
}
if (require.main === module) process.exitCode = main();
module.exports = { runTests, testEnvironment };
