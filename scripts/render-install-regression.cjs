"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  path = require("node:path");
const { main } = require("./render-install.cjs");
test("local and CI installs do not recursively invoke the Render build gate", () => {
  for (const environment of [{}, { RENDER: "false" }])
    assert.equal(
      main({
        environment,
        run() {
          throw new Error("must not run");
        },
      }),
      0,
    );
});
test("Render npm install validates the actual checked-out source before accepting the build", () => {
  let calls = 0;
  const environment = { RENDER: "true", NODE_ENV: "production" };
  assert.equal(
    main({
      environment,
      run(executable, args, options) {
        calls++;
        assert.equal(executable, process.execPath);
        assert.deepEqual(args, [
          path.join(__dirname, "validate-production.cjs"),
        ]);
        assert.equal(options.cwd, path.resolve(__dirname, ".."));
        assert.equal(options.env, environment);
        assert.equal(options.stdio, "inherit");
        assert.ok(options.timeout <= 15 * 60 * 1000);
        return { status: 0 };
      },
    }),
    0,
  );
  assert.equal(calls, 1);
  assert.equal(
    require("../package.json").scripts.postinstall,
    "node scripts/render-install.cjs",
  );
});
test("test failures, build timeouts and aborted validators cannot create a successful install", () => {
  for (const result of [
    { status: 1 },
    { status: null },
    { status: 0, error: new Error("timeout") },
    { status: null, signal: "SIGTERM" },
  ])
    assert.equal(
      main({ environment: { RENDER: "true" }, run: () => result }),
      1,
    );
});
