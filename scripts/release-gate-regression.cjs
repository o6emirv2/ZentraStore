"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  vm = require("node:vm"),
  path = require("node:path");
const runner = require("./run-tests.cjs");
const source = fs.readFileSync(
  path.join(__dirname, "validate-production.cjs"),
  "utf8",
);
function scenario(audit, failed = false) {
  let saved;
  const logs = [],
    calls = [];
  const count = {
    tests: 2,
    failed: failed ? 1 : 0,
    passed: failed ? 1 : 2,
    cancelled: 0,
    skipped: 0,
    todo: 0,
  };
  const stdout = [
    {
      type: "test:pass",
      data: {
        name: "Passing control",
        file: "/project/scripts/control-regression.cjs",
      },
    },
    ...(failed
      ? [
          {
            type: "test:fail",
            data: {
              name: "Controlled security failure",
              file: "/project/scripts/control-regression.cjs",
              details: {
                error: {
                  code: "ERR_ASSERTION",
                  message: "Controlled failed check",
                },
              },
            },
          },
        ]
      : []),
    {
      type: "test:summary",
      data: {
        success: !failed,
        counts: count,
        file: "/project/scripts/control-regression.cjs",
      },
    },
    { type: "test:summary", data: { success: !failed, counts: count } },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n");
  const fakeFs = {
    readdirSync: () => ["control-regression.cjs"],
    writeFileSync: (_path, value) => (saved = JSON.parse(value)),
  };
  const process = {
    execPath: "/node",
    platform: "linux",
    env: {
      PATH: "/safe/bin",
      NODE_ENV: "production",
      FIREBASE_KEY: "parent-only-credential",
      NEW_PROVIDER_SECRET: "parent-only-unknown-key",
    },
    stdout: { write: (value) => logs.push(value) },
    stderr: { write: (value) => logs.push(value) },
    exitCode: 0,
  };
  vm.runInNewContext(source, {
    __dirname: "/project/scripts",
    Date,
    Buffer,
    console: {
      log: (value) => logs.push(value),
      error: (value) => logs.push(value),
    },
    process,
    require(name) {
      if (name === "node:fs") return fakeFs;
      if (name === "node:path") return path;
      if (name === "./run-tests.cjs") return runner;
      if (name === "node:child_process")
        return {
          spawnSync: (_executable, args, options) => {
            calls.push({ args, options });
            return args[0] === "audit"
              ? audit
              : {
                  status: args.includes("--test") && failed ? 1 : 0,
                  stdout: args.includes("--test") ? stdout : "",
                  stderr: "",
                };
          },
        };
      if (name === "../server/core/securityAssessment")
        return { sourceDigest: () => "controlled-source-digest" };
      throw Error(name);
    },
  });
  return {
    code: process.exitCode,
    evidence: saved,
    logs: logs.join("\n"),
    calls,
  };
}
const cleanAudit = {
  status: 0,
  stdout: JSON.stringify({
    metadata: {
      vulnerabilities: { total: 0, low: 0, moderate: 0, high: 0, critical: 0 },
    },
  }),
};
test("an unavailable dependency audit blocks the production release", () => {
  const result = scenario({
    status: 1,
    stdout: JSON.stringify({ error: { code: "ENETUNREACH" } }),
  });
  assert.equal(result.code, 1);
  assert.equal(result.evidence.dependencies.verified, false);
});
test("any reported production dependency vulnerability blocks release", () => {
  const result = scenario({
    status: 1,
    stdout: JSON.stringify({
      metadata: {
        vulnerabilities: {
          total: 1,
          low: 1,
          moderate: 0,
          high: 0,
          critical: 0,
        },
      },
    }),
  });
  assert.equal(result.code, 1);
  assert.equal(result.evidence.dependencies.verified, true);
});
test("only clean audit and real per-file passing summaries can produce a passing release record", () => {
  const result = scenario(cleanAudit);
  assert.equal(result.code, 0);
  assert.equal(result.evidence.regression.total, 2);
  assert.equal(
    result.evidence.regression.suites["control-regression.cjs"].verified,
    true,
  );
});
test("the release validator uses the isolated runner without passing production credentials", () => {
  const result = scenario(cleanAudit),
    call = result.calls.find((item) => item.args.includes("--test"));
  assert.equal(call.options.env.NODE_ENV, "test");
  assert.equal(call.options.env.PATH, "/safe/bin");
  assert.equal(call.options.env.FIREBASE_KEY, undefined);
  assert.equal(call.options.env.NEW_PROVIDER_SECRET, undefined);
});
test("a failed business check remains a release blocker and logs the actual failure without passing-test noise", () => {
  const result = scenario(cleanAudit, true);
  assert.equal(result.code, 1);
  assert.equal(result.evidence.regression.failed, 1);
  assert.equal(
    result.evidence.regression.suites["control-regression.cjs"].verified,
    false,
  );
  assert.equal(
    result.evidence.regression.failures[0].name,
    "Controlled security failure",
  );
  assert.match(result.logs, /REGRESSION_FAILED/);
  assert.match(result.logs, /Controlled failed check/);
  assert.doesNotMatch(result.logs, /Passing control|test:pass/);
});
