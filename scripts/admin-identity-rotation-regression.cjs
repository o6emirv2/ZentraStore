"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { applicationFixture } = require("./helpers/application-fixture.cjs");
let f, env, oldEmails, oldUids, previous, oldSession;
const uid = "Mp5FsWUS7PeEFL7vHZZOeOurjC03",
  email = "o6emirv2@gmail.com";
before(async () => {
  f = await applicationFixture();
  env = require("../server/config/env");
  oldEmails = [...env.adminEmails];
  oldUids = [...env.adminUids];
  oldSession = await f.openAdmin();
  previous = require("../server/core/adminSessionPolicy").credentialRevision();
  f.users.set(uid, {
    uid,
    email,
    emailVerified: true,
    disabled: false,
    password: f.password,
    generation: 0,
  });
  env.adminEmails.splice(0, env.adminEmails.length, email);
  env.adminUids.splice(0, env.adminUids.length, uid);
});
after(async () => {
  env.adminEmails.splice(0, env.adminEmails.length, ...oldEmails);
  env.adminUids.splice(0, env.adminUids.length, ...oldUids);
  await f?.close();
});
test("the configured new email and UID resolve through Firebase and the server owner policy", async () => {
  assert.deepEqual(
    await require("../server/core/adminGateService").resolveAutomaticAdminIdentity(),
    { uid, email },
  );
  const policy =
    await require("../server/core/adminStoreService").resolveStaffPolicy(
      uid,
      email,
    );
  assert.equal(policy.systemOwner, true);
  assert.equal(policy.role, "owner");
  const account = await f.request("/api/auth/admin/gate/identity", { uid });
  assert.equal(account.status, 200);
});
test("owner rotation changes the credential revision and denies the previous owner's session", async () => {
  assert.notEqual(
    require("../server/core/adminSessionPolicy").credentialRevision(),
    previous,
  );
  const response = await f.request("/api/auth/admin/gate/status", {
    token: oldSession.token,
    cookie: oldSession.cookie,
  });
  assert.equal(response.status, 403);
  assert.equal(response.body.authenticated, false);
});
test("email-only matches, another UID and a wrong Firebase email never become the owner", async () => {
  const policies = require("../server/core/adminStoreService");
  assert.equal(await policies.resolveStaffPolicy("different-uid", email), null);
  assert.equal(
    await policies.resolveStaffPolicy(uid, "another@zentra.invalid"),
    null,
  );
  f.users.get(uid).email = "another@zentra.invalid";
  try {
    await assert.rejects(
      require("../server/core/adminGateService").resolveAutomaticAdminIdentity(),
      { code: "ADMIN_IDENTITY_MISMATCH" },
    );
  } finally {
    f.users.get(uid).email = email;
  }
});
test("an unverified or disabled new owner cannot skip the account verification gate", async () => {
  const row = f.users.get(uid);
  row.emailVerified = false;
  try {
    const result = await f.request("/api/auth/admin/gate/identity", { uid });
    assert.equal(result.status, 403);
    assert.equal(result.body.error, "EMAIL_VERIFICATION_REQUIRED");
  } finally {
    row.emailVerified = true;
  }
  row.disabled = true;
  try {
    assert.equal(
      (await f.request("/api/auth/admin/gate/identity", { uid })).status,
      401,
    );
  } finally {
    row.disabled = false;
  }
});
test("the new primary owner still completes every existing password and TOTP stage", async () => {
  const session = await f.openAdmin(uid);
  const result = await f.request("/api/auth/admin/gate/status", {
    token: session.token,
    cookie: session.cookie,
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.authenticated, true);
  assert.equal(result.body.admin.uid, uid);
});
test("public runtime configuration does not publish the primary administrator's UID or email", async () => {
  const response = await f.request("/api/public/runtime-config");
  const data = JSON.stringify(response.body);
  assert.equal(data.includes(uid), false);
  assert.equal(data.includes(email), false);
});
