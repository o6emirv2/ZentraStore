"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  vm = require("node:vm");
const filename = path.resolve(__dirname, "../../server/config/env.js");
function environmentFixture(environment = {}) {
  const module = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(filename, "utf8"),
    {
      module,
      process: { env: { ...environment } },
      Buffer,
      URL,
      require(name) {
        if (name !== "../../package.json")
          throw new Error("ENV_FIXTURE_IMPORT_REJECTED");
        return require("../../package.json");
      },
    },
    { filename },
  );
  return module.exports;
}
module.exports = { environmentFixture };
