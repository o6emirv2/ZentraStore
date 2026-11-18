"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { applicationFixture } = require("./helpers/application-fixture.cjs");
const { browserModule } = require("./helpers/browser-module.cjs");
const { fromEnvironment } = require("../server/suppliers/hilehanem-config");
const service = require("../server/suppliers/hilehanem-service");
let f, owner;
before(async () => { f = await applicationFixture(); owner = await f.openAdmin(); });
after(async () => f?.close());
function source(extra = {}) {
  return { HILEHANEM_API_BASE_URL: "https://hilehanem.com/example-contract-only",
    HILEHANEM_API_KEY: "hh_" + crypto.randomBytes(24).toString("hex"), ...extra };
}
const money = () => structuredClone([...f.db.records].filter(([key]) => /^(users|storeWalletLedger|storeOrders|storeInventory)\//.test(key)));

test("supplier API configuration identifies missing fields without exposing the actual key", () => {
  const empty = fromEnvironment({});
  assert.equal(empty.configured, false);
  assert.deepEqual(empty.missing, ["HILEHANEM_API_BASE_URL", "HILEHANEM_API_KEY"]);
  const input = source(), c = fromEnvironment(input);
  assert.equal(c.configured, true);
  assert.equal(c.mode, "native_api");
  assert.equal(c.apiKey, input.HILEHANEM_API_KEY);
  assert(!JSON.stringify(c).includes(input.HILEHANEM_API_KEY));
  assert(!JSON.stringify(service.status({ config: c })).includes(input.HILEHANEM_API_KEY));
});
test("a reseller key is never accepted as an HTTPS API address", () => {
  const input = source();
  const c = fromEnvironment({ ...input, HILEHANEM_API_BASE_URL: input.HILEHANEM_API_KEY });
  assert.equal(c.configured, false);
  assert.deepEqual(c.invalid, ["HILEHANEM_API_BASE_URL"]);
});
test("invalid origins, embedded credentials and malformed keys are rejected by field name only", () => {
  for (const url of ["http://hilehanem.com", "https://hilehanem.com.evil.invalid/api", "https://hilehanem.com@evil.invalid", "https://user:secret@hilehanem.com/api", "https://127.0.0.1/api", "https://hilehanem.com/api?key=secret", "https://hilehanem.com/#secret", "https://hilehanem.com:444/api", "https://hilehanem.com\\@evil.invalid"]) {
    const c = fromEnvironment(source({ HILEHANEM_API_BASE_URL: url }));
    assert.deepEqual(c.invalid, ["HILEHANEM_API_BASE_URL"], url);
    assert(!JSON.stringify(c).includes(url));
  }
  const c = fromEnvironment(source({ HILEHANEM_API_KEY: "hh_private\r\nHeader: inject" }));
  assert.deepEqual(c.invalid, ["HILEHANEM_API_KEY"]);
});
test("credentials alone cannot activate purchasing, balance display or stock synchronization", () => {
  const status = service.status({ config: fromEnvironment(source()) });
  assert.equal(status.configured, true);
  assert.equal(status.active, false);
  assert.equal(status.state, "contract_required");
  assert.equal(status.balanceUsdCents, null);
  assert.equal(status.automaticPurchasing, false);
  assert.equal(status.stockSynchronization, false);
  assert(status.requirements.includes("idempotency"));
  assert(status.requirements.includes("order_lookup"));
});
test("previous integration balances cannot appear as native API verification", async () => {
  await f.db.collection("storeIntegrationState").doc("hilehanem").set({ state: "connected", balanceUsdCents: 999999, lastSuccessAt: Date.now() });
  const status = await service.status({ config: fromEnvironment(source()), db: f.db });
  assert.equal(status.active, false);
  assert.equal(status.balanceUsdCents, null);
  assert.equal(status.lastSuccessAt, 0);
});
test("supplier configuration is accessible only through the verified administrator gate", async () => {
  for (const credentials of [{}, { uid: "member" }, { token: owner.token }]) {
    const r = await f.request("/api/admin/store/suppliers/hilehanem", credentials);
    assert([401, 403].includes(r.status));
  }
  const r = await f.request("/api/admin/store/suppliers/hilehanem", owner);
  assert.equal(r.status, 200);
  assert.equal(r.body.connection.active, false);
  assert.match(r.headers.get("cache-control"), /no-store/);
});
test("a configuration check records the blocker without an outbound request or a financial mutation", async () => {
  const before = money(), fetcher = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls++; throw new Error("Unexpected supplier call"); };
  try {
    const status = await service.check({ uid: "owneruid" }, { config: fromEnvironment(source()), db: f.db });
    assert.equal(status.active, false);
    assert.equal(calls, 0);
    assert.deepEqual(money(), before);
    const audit = [...f.db.records].filter(([key]) => key.startsWith("audit/")).at(-1)[1];
    assert.equal(audit.result, "blocked");
    assert.equal(audit.code, "HILEHANEM_API_CONTRACT_REQUIRED");
    assert(!JSON.stringify(audit).includes("hh_"));
  } finally { global.fetch = fetcher; }
});
test("the real check route validates its body and never claims a provider connection", async () => {
  const before = money();
  const r = await f.request("/api/admin/store/suppliers/hilehanem/check", { ...owner, method: "POST", body: {} });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.connection.active, false);
  assert.deepEqual(money(), before);
  const invalid = await f.request("/api/admin/store/suppliers/hilehanem/check", { ...owner, method: "POST", body: { apiKey: "must-not-be-posted" } });
  assert.equal(invalid.status, 400);
});
test("the API administration screen explicitly displays unverified balances and the missing contract", async () => {
  const { supplierView } = await browserModule("admin/supplier-view.mjs");
  const html = supplierView(service.status({ config: fromEnvironment(source()) }));
  assert(html.includes("Doğrulanmadı"));
  assert(html.includes("Yapılandırmayı kontrol et"));
  assert(html.includes("API bilgileri kayıtlı"));
  assert(!html.includes("hh_"));
  assert(!html.includes("hilehanembot"));
});
test("the supplier SDK and session authorization tools are absent from the release", () => {
  const pkg = require("../package.json"), lock = require("../package-lock.json");
  assert(!pkg.dependencies.teleproto && !pkg.dependencies.telegram);
  assert(!Object.keys(lock.packages).some((key) => /node_modules\/(?:teleproto|telegram)$/.test(key)));
  assert(!pkg.scripts["hilehanem:session"] && !pkg.scripts["hilehanem:check"]);
  for (const name of ["server/suppliers/hilehanem-telegram.js", "server/suppliers/hilehanem-format.js", "scripts/hilehanem-session.cjs", "scripts/hilehanem-check.cjs"])
    assert(!fs.existsSync(require("node:path").join(__dirname, "..", name)), name);
});
