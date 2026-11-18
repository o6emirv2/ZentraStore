"use strict";
const { test, before, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict"),
  crypto = require("node:crypto");
const { applicationFixture } = require("./helpers/application-fixture.cjs");
let f, R, email;
const key = () => crypto.randomUUID();
const provider = (id) => async () => ({
  ok: true,
  status: 200,
  json: async () => ({ id }),
});
const records = (name) =>
  [...f.db.records.entries()].filter(
    ([k]) => k.startsWith(name + "/") && k.split("/").length === 2,
  );
async function queue(
  kind = "password",
  identifier = "member@zentra.invalid",
  idempotencyKey = key(),
) {
  const before = new Set(
    records("storeAccountRecoveryRequests").map(([id]) => id),
  );
  await R.request(kind, { identifier, idempotencyKey });
  const [id] =
    records("storeAccountRecoveryRequests").find(([id]) => !before.has(id)) ||
    [];
  return f.db.collection("storeAccountRecoveryRequests").doc(id.split("/")[1]);
}
async function mailed(identifier = "member@zentra.invalid", kind = "password") {
  const ref = await queue(kind, identifier);
  let payload;
  await R.processRequest(ref, {
    fetcher: async (url, options) => {
      payload = JSON.parse(options.body);
      return provider(crypto.randomUUID())();
    },
  });
  const link = payload?.text.match(
    /(?:Şifremi Yenile|Hesabıma Giriş Yap): (\S+)/,
  )?.[1];
  return {
    ref,
    payload,
    link,
    token: link && new URLSearchParams(new URL(link).hash.slice(1)).get("recovery"),
  };
}
before(async () => {
  process.env.RESEND_API_KEY =
    "re_" + crypto.randomBytes(30).toString("base64url");
  process.env.EMAIL_NOTIFICATIONS_ENABLED = "true";
  process.env.RESEND_WEBHOOK_SECRET =
    "whsec_" + crypto.randomBytes(32).toString("base64");
  f = await applicationFixture();
  R = require("../server/core/accountRecoveryService");
  email = require("../server/email/service");
});
beforeEach(async () => {
  if (f)
    for (const [name] of records("storeAccountRecoveryQuotas"))
      await f.db
        .collection("storeAccountRecoveryQuotas")
        .doc(name.split("/")[1])
        .delete();
});
after(async () => {
  R?.worker.stop();
  email?.stop();
  await f?.close();
});
test("HTTP recovery accepts the same generic response for known and unknown accounts without exposing identity", async () => {
  for (const identifier of ["owner@zentra.invalid", "missing@zentra.invalid"]) {
    const r = await f.request("/api/auth/password-reset", {
      method: "POST",
      body: { identifier, idempotencyKey: key() },
    });
    assert.equal(r.status, 202);
    assert.deepEqual(r.body, { ok: true, accepted: true });
    assert(!JSON.stringify(r.body).includes(identifier));
  }
  const rejected = await f.request("/api/auth/username-recovery", {
    method: "POST",
    body: { identifier: "EmirHan", idempotencyKey: key() },
  });
  assert.equal(rejected.status, 400);
});
test("recovery rejects hostile origins and extra fields before creating a mail request", async () => {
  const body = { identifier: "viewer@zentra.invalid", idempotencyKey: key() };
  const hostile = await f.request("/api/auth/password-reset", {
    method: "POST",
    headers: { origin: "https://hostile.invalid" },
    body,
  });
  assert.equal(hostile.status, 403);
  const extra = await f.request("/api/auth/recovery/complete", {
    method: "POST",
    body: {
      token: "x",
      newPassword: "Xxxxxxxxx",
      idempotencyKey: key(),
      uid: "owneruid",
    },
  });
  assert.equal(extra.status, 400);
});
test("idempotent queue requests do not duplicate messages or permit a changed target", async () => {
  const idempotencyKey = key(),
    before = records("storeAccountRecoveryRequests").length;
  await R.request("username", {
    identifier: "member@zentra.invalid",
    idempotencyKey,
  });
  await R.request("username", {
    identifier: "member@zentra.invalid",
    idempotencyKey,
  });
  assert.equal(records("storeAccountRecoveryRequests").length, before + 1);
  await assert.rejects(
    R.request("username", {
      identifier: "owner@zentra.invalid",
      idempotencyKey,
    }),
    { code: "RECOVERY_OPERATION_CONFLICT" },
  );
  assert(
    !JSON.stringify(records("storeAccountRecoveryRequests")).includes(
      '"identifier":"member@zentra.invalid"',
    ),
  );
});
test("missing mail configuration fails visibly and creates no phantom send", async () => {
  const apiKey = process.env.RESEND_API_KEY,
    before = records("storeAccountRecoveryRequests").length;
  process.env.RESEND_API_KEY = "";
  try {
    await assert.rejects(queue(), { code: "RECOVERY_MAIL_UNAVAILABLE" });
    assert.equal(records("storeAccountRecoveryRequests").length, before);
  } finally { process.env.RESEND_API_KEY = apiKey; }
});
test("Zentra mail carries an opaque first-party reset URL; provider and code remain encrypted", async () => {
  const { ref, payload, link, token } = await mailed("EmirHan");
  assert.equal(payload.from, "ZENTRA STORE <bildirim@zentrastore.com.tr>");
  assert.deepEqual(payload.to, ["member@zentra.invalid"]);
  assert(payload.html.includes("/public/assets/images/logo.png"));
  assert.equal(new URL(link).origin, f.origin);
  assert.equal(new URL(link).pathname, "/sifre-yenile.html");
  assert.equal(new URL(link).search, "");
  assert.match(token, /^[-_A-Za-z0-9]{43}$/);
  assert(!link.includes("firebaseapp") && !link.includes("oobCode"));
  const row = (await ref.get()).data();
  assert.equal(row.state, "accepted");
  assert.equal(row.envelope, null);
  assert.equal(row.deliveredAt, undefined);
  const tokenRow = records("storeAccountRecoveryTokens").at(-1)[1];
  assert(!JSON.stringify(tokenRow).includes(token));
  assert(tokenRow.envelope);
  assert.equal(tokenRow.state, "ready");
});
test("password recovery keeps the branded sender when optional notifications are disabled or use another sender", async () => {
  const before = { enabled: process.env.EMAIL_NOTIFICATIONS_ENABLED, from: process.env.RESEND_FROM };
  process.env.EMAIL_NOTIFICATIONS_ENABLED = "false";
  process.env.RESEND_FROM = "Notifications <legacy@another.invalid>";
  try {
    const { payload, token } = await mailed();
    assert.equal(payload.from, "ZENTRA STORE <bildirim@zentrastore.com.tr>");
    assert.equal((await R.inspect(token)).state, "ready");
  } finally {
    process.env.EMAIL_NOTIFICATIONS_ENABLED = before.enabled;
    if (before.from === undefined) delete process.env.RESEND_FROM;
    else process.env.RESEND_FROM = before.from;
  }
});
test("custom reset links do not depend on an unused Firebase continue URL allowlist", async () => {
  const original = f.auth.generatePasswordResetLink;
  const calls = [];
  f.auth.generatePasswordResetLink = async (...args) => {
    calls.push(args);
    if (args[1]) throw Object.assign(new Error("unapproved continuation"), { code: "auth/unauthorized-continue-uri" });
    return original(...args);
  };
  try {
    const { token } = await mailed();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].length, 1);
    assert.equal((await R.inspect(token)).state, "ready");
  } finally { f.auth.generatePasswordResetLink = original; }
});
test("the standalone reset page is served privately and fragment tokens never reach the HTTP path", async () => {
  const { link, token } = await mailed();
  const response = await fetch(link);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control"), /no-store/);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  const html = await response.text();
  assert.match(html, /password-reset\.mjs/);
  assert(!html.includes(token));
  assert(!html.includes('src="/public/js/app/store.js'));
});
test("mail rejection diagnostics distinguish authorization, validation and throttling without private provider text", async () => {
  for (const [status, code] of [[403, "RECOVERY_MAIL_AUTHORIZATION_FAILED"], [422, "RECOVERY_MAIL_REJECTED"], [429, "RECOVERY_MAIL_RATE_LIMITED"]]) {
    const ref = await queue();
    await R.processRequest(ref, {
      fetcher: async () => ({ ok: false, status, json: async () => ({ message: "PRIVATE_PROVIDER_PAYLOAD" }) }),
    });
    const row = (await ref.get()).data();
    assert.equal(row.failureCode, code);
    assert.equal(row.state, status === 429 ? "uncertain" : "rejected");
    assert(!JSON.stringify(row).includes("PRIVATE_PROVIDER_PAYLOAD"));
  }
});
test("username recovery sends the actual stored username only to the current verified Firebase email", async () => {
  const before = f.users.size,
    profile = (await f.db.collection("users").doc("member").get()).data();
  const { payload } = await mailed("member@zentra.invalid", "username");
  assert(payload.text.includes("Kullanıcı adın: EmirHan"));
  assert.deepEqual(payload.to, ["member@zentra.invalid"]);
  assert.equal(f.users.size, before);
  assert.deepEqual(
    (await f.db.collection("users").doc("member").get()).data(),
    profile,
  );
  f.users.get("member").emailVerified = false;
  const unverified = await mailed("member@zentra.invalid", "username");
  assert.equal(unverified.payload, undefined);
  assert.equal((await unverified.ref.get()).data().state, "suppressed");
  f.users.get("member").emailVerified = true;
});
test("unknown, disabled and ambiguous accounts generate no email and expose no public account result", async () => {
  const unknown = await mailed("unknown@zentra.invalid");
  assert.equal(unknown.payload, undefined);
  f.users.get("viewer").disabled = true;
  const disabled = await mailed("viewer@zentra.invalid");
  assert.equal(disabled.payload, undefined);
  f.users.get("viewer").disabled = false;
  await f.db
    .collection("users")
    .doc("duplicate")
    .set({ username: "EmirHan", usernameLower: "emirhan" });
  const ambiguous = await mailed("EmirHan");
  assert.equal(ambiguous.payload, undefined);
  await f.db.collection("users").doc("duplicate").delete();
});
test("an uncertain mail response reuses the exact frozen payload and provider idempotency key", async () => {
  const ref = await queue(),
    sent = [];
  const fetcher = async (_, options) => {
    sent.push({ body: options.body, key: options.headers["Idempotency-Key"] });
    if (sent.length === 1) throw new Error("lost response");
    return provider(crypto.randomUUID())();
  };
  await R.processRequest(ref, { fetcher });
  assert.equal((await ref.get()).data().state, "uncertain");
  await ref.update({ availableAt: 0 });
  await R.processRequest(ref, { fetcher });
  assert.deepEqual(sent[0], sent[1]);
  assert.equal((await ref.get()).data().state, "accepted");
});
test("provider rejections do not become success; verified delivery can arrive before the HTTP response", async () => {
  const rejected = await queue();
  await R.processRequest(rejected, {
    fetcher: async () => ({ ok: false, status: 422, json: async () => ({}) }),
  });
  assert.equal((await rejected.get()).data().state, "rejected");
  const ref = await queue(),
    id = crypto.randomUUID();
  await R.processRequest(ref, {
    fetcher: async () => {
      await email.providerEvent(
        {
          type: "email.delivered",
          created_at: new Date().toISOString(),
          data: { email_id: id },
        },
        key(),
      );
      return provider(id)();
    },
  });
  assert.equal((await ref.get()).data().state, "delivered");
  await email.providerEvent(
    {
      type: "email.sent",
      created_at: new Date().toISOString(),
      data: { email_id: id },
    },
    key(),
  );
  assert.equal((await ref.get()).data().state, "delivered");
});
test("expired, superseded and changed-email reset links cannot change a password", async () => {
  const first = await mailed(),
    second = await mailed();
  await assert.rejects(R.inspect(first.token), { code: "RECOVERY_INVALID" });
  const entry = records("storeAccountRecoveryTokens").find(
    ([, r]) => r.requestId === second.ref.id,
  );
  await f.db
    .collection("storeAccountRecoveryTokens")
    .doc(entry[0].split("/")[1])
    .update({ expiresAt: 0 });
  await assert.rejects(R.inspect(second.token), { code: "RECOVERY_EXPIRED" });
  const changed = await mailed();
  f.users.get("member").email = "new@zentra.invalid";
  await assert.rejects(R.inspect(changed.token), { code: "RECOVERY_INVALID" });
  f.users.get("member").email = "member@zentra.invalid";
});
test("confirmed reset changes Firebase password once, revokes old tokens and preserves balances, roles and verification", async () => {
  const { token } = await mailed(),
    oldToken = f.idToken("member"),
    before = (await f.db.collection("users").doc("member").get()).data(),
    changes = f.passwordChanges;
  const input = {
    token,
    newPassword: "A new secure password 2026!",
    idempotencyKey: key(),
  };
  const result = await R.complete(input);
  assert.equal(result.changed, true);
  assert.equal(f.passwordChanges, changes + 1);
  await assert.rejects(f.auth.verifyIdToken(oldToken, true));
  assert.deepEqual(
    (await f.db.collection("users").doc("member").get()).data(),
    before,
  );
  assert.equal(f.users.get("member").emailVerified, true);
  assert.equal((await R.inspect(token)).state, "completed");
  assert.equal((await R.complete(input)).replayed, true);
  assert.equal(f.passwordChanges, changes + 1);
  await assert.rejects(
    R.complete({ ...input, newPassword: "Different secure password!" }),
    { code: "RECOVERY_OPERATION_CONFLICT" },
  );
  assert(
    records("storeEmailOutbox").some(([, r]) => r.type === "password_changed"),
  );
  assert(records("storeNotifications").some(([, r]) => r.type === "security"));
});
test("lost reset response recovers with password verification without a second reset operation", async () => {
  const { token } = await mailed(),
    input = {
      token,
      newPassword: "Lost response password 2026!",
      idempotencyKey: key(),
    },
    previousFetch = global.fetch;
  const changes = f.passwordChanges;
  global.fetch = async (url, options) => {
    const result = await previousFetch(url, options);
    if (String(url).includes("accounts:resetPassword"))
      throw new Error("response lost");
    return result;
  };
  await assert.rejects(R.complete(input), {
    code: "RECOVERY_RESULT_UNCERTAIN",
  });
  global.fetch = previousFetch;
  assert.equal((await R.inspect(token)).state, "uncertain");
  assert.equal((await R.inspect(token)).operationKey, input.idempotencyKey);
  assert.equal((await R.complete(input)).changed, true);
  assert.equal(f.passwordChanges, changes + 1);
});
test("definitively rejected Firebase codes cannot be recovered by merely reusing an existing password", async () => {
  const { token } = await mailed(),
    previousFetch = global.fetch;
  global.fetch = async (url, options) =>
    String(url).includes("accounts:resetPassword")
      ? {
          ok: false,
          status: 400,
          json: async () => ({ error: { message: "INVALID_OOB_CODE" } }),
        }
      : previousFetch(url, options);
  const input = {
    token,
    newPassword: f.users.get("member").password,
    idempotencyKey: key(),
  };
  await assert.rejects(R.complete(input), { code: "RECOVERY_REJECTED" });
  global.fetch = previousFetch;
  await assert.rejects(R.complete(input), { code: "RECOVERY_INVALID" });
});
test("one account lock prevents two independent password resets racing", async () => {
  const { token } = await mailed(),
    previousFetch = global.fetch;
  let release, entered;
  const gate = new Promise((resolve) => (release = resolve)),
    called = new Promise((resolve) => (entered = resolve));
  global.fetch = async (url, options) => {
    if (String(url).includes("accounts:resetPassword")) {
      entered();
      await gate;
    }
    return previousFetch(url, options);
  };
  const input = {
    token,
    newPassword: "Concurrent password test 2026!",
    idempotencyKey: key(),
  };
  const first = R.complete(input);
  await called;
  await assert.rejects(R.complete({ ...input, idempotencyKey: key() }), {
    code: "RECOVERY_OPERATION_CONFLICT",
  });
  release();
  assert.equal((await first).changed, true);
  global.fetch = previousFetch;
});
test("cleanup erases expired encrypted challenges without deleting customers or financial records", async () => {
  const { ref } = await mailed(),
    entry = records("storeAccountRecoveryTokens").find(
      ([, r]) => r.requestId === ref.id,
    ),
    tokenRef = f.db
      .collection("storeAccountRecoveryTokens")
      .doc(entry[0].split("/")[1]);
  await tokenRef.update({ expiresAt: 0, cleanupAt: 0 });
  const users = records("users").length,
    money = records("storeWalletLedger").length;
  await R.run({ fetcher: provider(crypto.randomUUID()) });
  assert.equal((await tokenRef.get()).data().envelope, null);
  assert.equal(records("users").length, users);
  assert.equal(records("storeWalletLedger").length, money);
});

test("distributed account send quotas block address/username aliases without exposing the account in HTTP replies", async () => {
  for (let i = 0; i < 5; i++)
    assert((await mailed(i % 2 ? "EmirHan" : "member@zentra.invalid")).payload);
  const sixth = await mailed("EmirHan");
  assert.equal(sixth.payload, undefined);
  assert.equal((await sixth.ref.get()).data().state, "suppressed");
});

test("a provider password-policy rejection preserves the unused link for a stronger password", async () => {
  const { token } = await mailed(),
    previousFetch = global.fetch;
  global.fetch = async (url, options) =>
    String(url).includes("accounts:resetPassword")
      ? {
          ok: false,
          status: 400,
          json: async () => ({
            error: { message: "PASSWORD_DOES_NOT_MEET_REQUIREMENTS" },
          }),
        }
      : previousFetch(url, options);
  await assert.rejects(
    R.complete({ token, newPassword: "Example 8!", idempotencyKey: key() }),
    { code: "PASSWORD_CHANGE_REJECTED" },
  );
  global.fetch = previousFetch;
  assert.equal((await R.inspect(token)).state, "ready");
  assert.equal(
    (
      await R.complete({
        token,
        newPassword: "A much stronger password 2026!",
        idempotencyKey: key(),
      })
    ).changed,
    true,
  );
});
