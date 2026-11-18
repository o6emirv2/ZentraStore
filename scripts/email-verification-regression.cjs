"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict"),
  crypto = require("node:crypto");
const { applicationFixture } = require("./helpers/application-fixture.cjs");
let f,
  service,
  originalFetch,
  sequence = 0;
const sent = [];
const provider = async (url, options) => {
  assert.equal(url, "https://api.resend.com/emails");
  assert.equal(options.redirect, "error");
  const body = JSON.parse(options.body);
  sent.push({ body, key: options.headers["Idempotency-Key"] });
  return {
    ok: true,
    status: 200,
    json: async () => ({ id: crypto.randomUUID() }),
  };
};
before(async () => {
  process.env.RESEND_API_KEY =
    "re_" + crypto.randomBytes(30).toString("base64url");
  process.env.EMAIL_NOTIFICATIONS_ENABLED = "true";
  f = await applicationFixture();
  service = require("../server/core/emailVerificationService");
  originalFetch = global.fetch;
  global.fetch = (url, options) =>
    String(url) === "https://api.resend.com/emails"
      ? provider(url, options)
      : originalFetch(url, options);
});
after(async () => {
  service.worker.stop();
  global.fetch = originalFetch;
  await f?.close();
});
function identity({ verified = false, stored = null, email } = {}) {
  const uid = "verify" + String(++sequence).padStart(6, "0");
  email ||= uid + "@zentra.invalid";
  const user = {
    uid,
    email,
    emailVerified: verified,
    disabled: false,
    generation: 0,
    password: f.password,
  };
  f.users.set(uid, user);
  if (stored) f.db.records.set("users/" + uid, structuredClone(stored));
  return { uid, email };
}
const profile = () => ({
  firstName: "Çağrı",
  lastName: "Öztürk",
  username: "Member" + sequence,
  birthDate: "2000-02-29",
});
const challenge = (user) =>
  f.db.records.get("storeEmailVerificationChallenges/" + user.uid);
const code = (user) =>
  /kodun: (\d{6})/.exec(
    sent.findLast((row) => row.body.to[0] === user.email).body.text,
  )[1];
function quota(user) {
  const { purposeKey } = require("../server/core/adminAccessService");
  const id = crypto
    .createHmac("sha256", purposeKey("email-verification-address-v1"))
    .update(user.email.toLowerCase())
    .digest("hex");
  return f.db.records.get("storeEmailVerificationQuotas/" + id);
}
async function begin(user, fields = profile(), fetcher = provider) {
  return service.start(user, fields, { fetcher });
}

test("the real HTTP boundary blocks account, orders, profile and cookie activation until the six-digit proof completes", async () => {
  const user = identity();
  for (const path of [
    "/api/store/account",
    "/api/store/orders",
    "/api/store/commerce/profile",
  ])
    assert.equal((await f.request(path, { uid: user.uid })).status, 403, path);
  const cookie = await f.request("/api/auth/session", {
    method: "POST",
    body: { idToken: f.idToken(user.uid) },
  });
  assert.equal(cookie.status, 403);
  assert.equal(cookie.body.error, "EMAIL_VERIFICATION_REQUIRED");
  assert.equal(
    (
      await f.request("/api/profile/update", {
        uid: user.uid,
        method: "POST",
        body: profile(),
      })
    ).status,
    403,
  );
  const start = await f.request("/api/auth/email-verification/start", {
    uid: user.uid,
    method: "POST",
    body: { profile: profile() },
  });
  assert.equal(start.status, 200);
  assert.equal(start.body.verification.delivery, "accepted");
  assert.equal(f.users.get(user.uid).emailVerified, false);
  assert.equal(f.db.records.has("users/" + user.uid), false);
  const id = start.body.verification.challengeId;
  const result = await f.request("/api/auth/email-verification/verify", {
    uid: user.uid,
    method: "POST",
    body: { challengeId: id, code: code(user) },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.completed, true);
  assert.equal(f.users.get(user.uid).emailVerified, true);
  assert.equal(
    f.db.records.get("storeAccountVerifications/" + user.uid).state,
    "completed",
  );
  assert.equal(
    (await f.request("/api/store/account", { uid: user.uid })).status,
    200,
  );
  const replay = await f.request("/api/auth/email-verification/verify", {
    uid: user.uid,
    method: "POST",
    body: { challengeId: id, code: code(user) },
  });
  assert.equal(replay.status, 409);
  assert.equal(replay.body.error, "EMAIL_VERIFICATION_USED");
});

test("codes expire exactly five minutes after generation and expired codes cannot modify Firebase or the profile", async () => {
  const user = identity();
  await begin(user);
  const row = challenge(user);
  assert.equal(row.expiresAt - row.createdAt, 300000);
  const value = code(user);
  row.expiresAt = Date.now() - 1;
  await assert.rejects(service.verify(user, row.id, value), {
    code: "EMAIL_VERIFICATION_EXPIRED",
  });
  assert.equal(f.users.get(user.uid).emailVerified, false);
  assert.equal(f.db.records.has("users/" + user.uid), false);
});

test("wrong attempts commit atomically and a new send cannot reset the five-attempt email lock", async () => {
  const user = identity();
  await begin(user);
  const correct = code(user),
    wrong = String((Number(correct) + 1) % 1000000).padStart(6, "0"),
    id = challenge(user).id;
  for (let i = 1; i <= 5; i++) {
    await assert.rejects(service.verify(user, id, wrong), {
      code:
        i === 5 ? "EMAIL_VERIFICATION_LOCKED" : "EMAIL_VERIFICATION_INCORRECT",
    });
    assert.equal(challenge(user).failedAttempts, i);
    assert.equal(quota(user).failedAttempts, i);
  }
  await assert.rejects(service.verify(user, id, correct), {
    code: "EMAIL_VERIFICATION_LOCKED",
  });
  quota(user).resendAt = 0;
  await assert.rejects(
    service.start(user, undefined, { resendId: id, fetcher: provider }),
    { code: "EMAIL_VERIFICATION_LOCKED" },
  );
  assert.equal(f.users.get(user.uid).emailVerified, false);
});

test("resends honor the cooldown, invalidate the previous code and cannot exceed the send quota", async () => {
  const user = identity();
  await begin(user);
  const oldId = challenge(user).id,
    oldCode = code(user);
  await assert.rejects(
    service.start(user, undefined, { resendId: oldId, fetcher: provider }),
    { code: "EMAIL_VERIFICATION_RESEND_WAIT" },
  );
  quota(user).resendAt = 0;
  await service.start(user, undefined, { resendId: oldId, fetcher: provider });
  assert.notEqual(challenge(user).id, oldId);
  assert.notEqual(code(user), oldCode);
  await assert.rejects(service.verify(user, oldId, oldCode), {
    code: "EMAIL_VERIFICATION_INVALID",
  });
  quota(user).sent = 5;
  quota(user).resendAt = 0;
  await assert.rejects(
    service.start(user, undefined, {
      resendId: challenge(user).id,
      fetcher: provider,
    }),
    { code: "EMAIL_VERIFICATION_SEND_LIMIT" },
  );
});

test("a lost provider reply retries an identical message and idempotency key without creating another code", async () => {
  const user = identity(),
    requests = [],
    accepted = new Map();
  const fetcher = async (url, options) => {
    requests.push(options);
    const key = options.headers["Idempotency-Key"];
    if (!accepted.has(key)) accepted.set(key, crypto.randomUUID());
    if (requests.length === 1) {
      await provider(url, options);
      throw new TypeError("controlled provider reply loss");
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: accepted.get(key) }),
    };
  };
  await begin(user, profile(), fetcher);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body, requests[1].body);
  assert.equal(
    requests[0].headers["Idempotency-Key"],
    requests[1].headers["Idempotency-Key"],
  );
  assert.equal(quota(user).sent, 1);
  const before = sent.length;
  await begin(user);
  assert.equal(sent.length, before);
});

test("provider rejection never becomes a sent message or activates an account", async () => {
  const user = identity();
  let rejectedCode;
  await assert.rejects(
    begin(user, profile(), async (_url, options) => {
      rejectedCode = /kodun: (\d{6})/.exec(JSON.parse(options.body).text)[1];
      return {
        ok: false,
        status: 401,
        json: async () => ({ error: "private-provider-response" }),
      };
    }),
    { code: "EMAIL_VERIFICATION_SEND_FAILED" },
  );
  assert.equal((await service.status(user)).verification.delivery, "failed");
  await assert.rejects(service.verify(user, challenge(user).id, rejectedCode), {
    code: "EMAIL_VERIFICATION_NOT_SENT",
  });
  assert.equal(f.users.get(user.uid).emailVerified, false);
  assert(
    !JSON.stringify(challenge(user)).includes("private-provider-response"),
  );
});

test("uncertain delivery is reported truthfully and a genuinely received code can still prove email ownership", async () => {
  const user = identity();
  await assert.rejects(
    begin(user, profile(), async (url, options) => {
      await provider(url, options);
      throw new TypeError("controlled response loss");
    }),
    { code: "EMAIL_VERIFICATION_SEND_UNCERTAIN" },
  );
  assert.equal(challenge(user).delivery, "uncertain");
  assert.equal(f.users.get(user.uid).emailVerified, false);
  assert.equal(
    (await service.verify(user, challenge(user).id, code(user))).completed,
    true,
  );
});

test("a success status with a malformed provider receipt remains uncertain and never reports accepted", async () => {
  const user = identity();
  let attempts = 0;
  await assert.rejects(
    begin(user, profile(), async (url, options) => {
      attempts++;
      await provider(url, options);
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: "-".repeat(36) }),
      };
    }),
    { code: "EMAIL_VERIFICATION_SEND_UNCERTAIN" },
  );
  assert.equal(attempts, 2);
  assert.equal(challenge(user).delivery, "uncertain");
  assert.equal(challenge(user).providerId, "");
  assert.equal(f.users.get(user.uid).emailVerified, false);
  assert.equal(
    (await service.verify(user, challenge(user).id, code(user))).completed,
    true,
  );
});

test("a failed proof transaction cannot set the Firebase verification flag", async () => {
  const user = identity();
  await begin(user);
  f.db.setFailure(true);
  try {
    await assert.rejects(service.verify(user, challenge(user).id, code(user)));
  } finally {
    f.db.setFailure(false);
  }
  assert.equal(f.users.get(user.uid).emailVerified, false);
  assert.equal(challenge(user).state, "pending");
  assert.equal(f.db.records.has("users/" + user.uid), false);
});

test("Firebase activation failure consumes the OTP once and resumes only through the verified completion path", async () => {
  const user = identity();
  await begin(user);
  const id = challenge(user).id,
    value = code(user),
    update = f.auth.updateUser;
  f.auth.updateUser = async () => {
    throw new Error("controlled provider outage");
  };
  try {
    await assert.rejects(service.verify(user, id, value), {
      code: "EMAIL_VERIFICATION_ACTIVATION_UNCERTAIN",
    });
  } finally {
    f.auth.updateUser = update;
  }
  assert.equal(f.users.get(user.uid).emailVerified, false);
  assert.equal(
    (await f.request("/api/store/account", { uid: user.uid })).status,
    403,
  );
  await assert.rejects(service.verify(user, id, value), {
    code: "EMAIL_VERIFICATION_USED",
  });
  assert.equal((await service.complete(user, id)).completed, true);
  assert.equal(f.db.records.get("users/" + user.uid).storeBalanceKurus, 0);
});

test("a lost successful Firebase response cannot bypass the durable activation receipt", async () => {
  const user = identity();
  await begin(user);
  const id = challenge(user).id,
    update = f.auth.updateUser;
  f.auth.updateUser = async (...args) => {
    await update(...args);
    throw new TypeError("controlled reply loss");
  };
  try {
    await assert.rejects(service.verify(user, id, code(user)), {
      code: "EMAIL_VERIFICATION_ACTIVATION_UNCERTAIN",
    });
  } finally {
    f.auth.updateUser = update;
  }
  assert.equal(f.users.get(user.uid).emailVerified, true);
  assert.equal(
    (await f.request("/api/store/account", { uid: user.uid })).status,
    403,
  );
  await service.complete(user, id);
  assert.equal(
    (await f.request("/api/store/account", { uid: user.uid })).status,
    200,
  );
});

test("a changed email or another UID cannot redeem the original challenge", async () => {
  const user = identity();
  await begin(user);
  const id = challenge(user).id,
    value = code(user),
    other = identity();
  await assert.rejects(service.verify(other, id, value), {
    code: "EMAIL_VERIFICATION_INVALID",
  });
  f.users.get(user.uid).email = "changed-" + user.email;
  await assert.rejects(service.verify(user, id, value), {
    code: "AUTH_ACCOUNT_MISMATCH",
  });
  assert.equal(f.users.get(user.uid).emailVerified, false);
  assert.equal(f.users.get(other.uid).emailVerified, false);
});

test("an out-of-band Firebase verified flag cannot create a new store account without the registration proof", async () => {
  const user = identity({ verified: true });
  const account = await f.request("/api/store/account", { uid: user.uid });
  assert.equal(account.status, 403);
  assert.equal(account.body.error, "REGISTRATION_REQUIRED");
  assert.equal(
    (
      await f.request("/api/profile/update", {
        uid: user.uid,
        method: "POST",
        body: profile(),
      })
    ).status,
    403,
  );
  await begin(user);
  await service.verify(user, challenge(user).id, code(user));
  assert.equal(
    (await f.request("/api/store/account", { uid: user.uid })).status,
    200,
  );
});

test("existing customer data, funds and order references survive mandatory email verification", async () => {
  const stored = {
    username: "ExistingMember",
    firstName: "Emir",
    fullName: "Emir Yılmaz",
    storeBalanceKurus: 123450,
    storeProfile: { avatarId: "3" },
    createdAt: 123456,
  };
  const user = identity({ stored });
  f.db.records.set("storeOrders/preserved-" + user.uid, {
    uid: user.uid,
    status: "paid",
    totalKurus: 5000,
  });
  await service.start(user, undefined, { fetcher: provider });
  await service.verify(user, challenge(user).id, code(user));
  const saved = f.db.records.get("users/" + user.uid);
  for (const [key, value] of Object.entries(stored))
    assert.deepEqual(saved[key], value, key);
  assert.equal(
    f.db.records.get("storeOrders/preserved-" + user.uid).totalKurus,
    5000,
  );
});

test("cleanup removes expired challenges without deleting Firebase identities, verification receipts or financial data", async () => {
  const user = identity();
  await begin(user);
  challenge(user).cleanupAt = Date.now() - 1;
  const beforeUsers = f.users.size;
  await service.cleanup();
  assert.equal(challenge(user), undefined);
  assert.equal(f.users.size, beforeUsers);
  assert.equal((await service.status(user)).verification.profileRequired, true);
  assert(
    f.db.records.has("storeOrders/preserved-verify000014") ||
      [...f.db.records.keys()].some((key) =>
        key.startsWith("storeOrders/preserved-"),
      ),
  );
});

test("the public descriptor and audit records contain no code, proof hash, nonce or customer profile", async () => {
  const user = identity();
  const result = await begin(user);
  const v = result.verification;
  assert.equal(v.email, "v***@zentra.invalid");
  for (const key of [
    "uid",
    "seed",
    "proofHash",
    "profile",
    "code",
    "firstName",
    "birthDate",
  ])
    assert.equal(Object.hasOwn(v, key), false, key);
  assert.equal(typeof challenge(user).proofHash, "string");
  assert.equal(challenge(user).proofHash.length, 64);
  assert.equal(Object.hasOwn(challenge(user), "code"), false);
  const audit = [...f.db.records.entries()]
    .filter(
      ([key, row]) =>
        key.startsWith("storeAuthVerificationAudit/") && row.uid === user.uid,
    )
    .map(([, row]) => row);
  assert(audit.length);
  for (const row of audit)
    for (const key of ["code", "seed", "proofHash", "email"])
      assert.equal(Object.hasOwn(row, key), false);
});

test("only one concurrent redemption can consume a code and create the activation receipt", async () => {
  const user = identity();
  await begin(user);
  const id = challenge(user).id,
    value = code(user);
  const results = await Promise.allSettled([
    service.verify(user, id, value),
    service.verify(user, id, value),
  ]);
  assert.equal(results.filter((row) => row.status === "fulfilled").length, 1);
  assert.equal(
    results.find((row) => row.status === "rejected").reason.code,
    "EMAIL_VERIFICATION_USED",
  );
  assert.equal(
    f.db.records.get("storeAccountVerifications/" + user.uid).state,
    "completed",
  );
});

test("direct requests cannot nominate another UID, email, role or a pre-verified account state", async () => {
  const user = identity();
  for (const extra of [
    { uid: "owneruid" },
    { email: "owner@zentra.invalid" },
    { role: "owner" },
    { emailVerified: true },
  ]) {
    const result = await f.request("/api/auth/email-verification/start", {
      uid: user.uid,
      method: "POST",
      body: { profile: profile(), ...extra },
    });
    assert.equal(result.status, 400);
    assert.equal(result.body.error, "API_BODY_INVALID");
  }
  const unauthenticated = await f.request("/api/auth/email-verification");
  assert.equal(unauthenticated.status, 401);
});

test("recreating an identity cannot reset the address-wide incorrect-code limit", async () => {
  const user = identity();
  await begin(user);
  const wrong = code(user) === "000000" ? "000001" : "000000";
  for (let i = 0; i < 5; i++)
    await assert.rejects(service.verify(user, challenge(user).id, wrong));
  f.users.delete(user.uid);
  const replacement = identity({ email: user.email });
  const before = sent.length;
  await assert.rejects(begin(replacement), {
    code: "EMAIL_VERIFICATION_LOCKED",
  });
  assert.equal(sent.length, before);
  assert.equal(f.db.records.has("users/" + replacement.uid), false);
});

test("a username claimed during verification can be replaced without redeeming a code or sending again", async () => {
  const user = identity(),
    fields = profile();
  await begin(user, fields);
  const {
    usernameKeys,
    usernameRegistryId,
  } = require("../server/core/storeUsername");
  for (const key of usernameKeys(fields.username))
    f.db.records.set("usernameRegistry/" + usernameRegistryId(key), {
      uid: "someone-else",
    });
  await assert.rejects(service.verify(user, challenge(user).id, code(user)), {
    code: "USERNAME_TAKEN",
  });
  assert.equal(challenge(user).state, "verified");
  assert.equal(challenge(user).profileRequired, true);
  assert.equal(f.users.get(user.uid).emailVerified, false);
  const before = sent.length;
  const result = await begin(user, {
    ...fields,
    username: fields.username + "new",
  });
  assert.equal(result.completed, true);
  assert.equal(sent.length, before);
  assert.equal(
    f.db.records.get("users/" + user.uid).username,
    fields.username + "new",
  );
});

test("an old delivery response cannot overwrite the replacement challenge or provider receipt", async () => {
  const user = identity();
  let release, started;
  const pending = new Promise((resolve) => {
    started = resolve;
  });
  const first = begin(user, profile(), async () => {
    started();
    return new Promise((resolve) => {
      release = () =>
        resolve({
          ok: true,
          status: 200,
          json: async () => ({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
        });
    });
  });
  await pending;
  const oldId = challenge(user).id;
  quota(user).resendAt = 0;
  const replacement = await service.start(user, undefined, {
    resendId: oldId,
    fetcher: provider,
  });
  const providerId = challenge(user).providerId;
  release();
  await first;
  assert.notEqual(challenge(user).id, oldId);
  assert.equal(challenge(user).id, replacement.verification.challengeId);
  assert.equal(challenge(user).providerId, providerId);
  assert.equal(challenge(user).delivery, "accepted");
});

test("a database outage refuses access without misreporting valid Firebase credentials as invalid", async () => {
  const user = identity({
    verified: true,
    stored: { email: "legacy@zentra.invalid" },
  });
  const collection = f.db.collection;
  f.db.collection = (name) => {
    const value = collection(name);
    if (name !== "users") return value;
    const doc = value.doc;
    value.doc = (id) => {
      const ref = doc(id);
      if (id === user.uid)
        ref.get = async () => {
          throw Object.assign(new Error("controlled database outage"), {
            code: 14,
          });
        };
      return ref;
    };
    return value;
  };
  try {
    const denied = await f.request("/api/store/account", { uid: user.uid });
    assert.equal(denied.status, 503);
    assert.equal(denied.body.error, "AUTH_UNAVAILABLE");
    assert.equal(f.users.get(user.uid).emailVerified, true);
  } finally {
    f.db.collection = collection;
  }
  assert.equal(
    (await f.request("/api/store/account", { uid: user.uid })).status,
    200,
  );
});
