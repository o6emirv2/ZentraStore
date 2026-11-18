"use strict";
const path = require("node:path");
const { spawnSync } = require("node:child_process");
function main({ environment = process.env, run = spawnSync } = {}) {
  if (environment.RENDER !== "true") return 0;
  const result = run(
    process.execPath,
    [path.join(__dirname, "validate-production.cjs")],
    {
      cwd: path.resolve(__dirname, ".."),
      env: environment,
      stdio: "inherit",
      timeout: 12 * 60 * 1000,
    },
  );
  if (result.status === 0 && !result.error && !result.signal) return 0;
  process.stderr.write(
    "RENDER_BUILD_VALIDATION_FAILED: production checks did not complete successfully.\n",
  );
  return 1;
}
if (require.main === module) process.exitCode = main();
module.exports = { main };
