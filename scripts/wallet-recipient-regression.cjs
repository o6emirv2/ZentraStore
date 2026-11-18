"use strict";
const { test, before, after } = require("node:test"),
  assert = require("node:assert/strict"),
  crypto = require("node:crypto");
const { applicationFixture } = require("./helpers/application-fixture.cjs");
let f, owner, service;
const root = "/api/admin/store/wallet";
const preview = (identifier, session = owner) =>
  f.request(
    root + "/recipient?identifier=" + encodeURIComponent(identifier),
    session,
  );
const write = (body) => f.adminWrite(owner, root + "/adjust", "POST", body);
function payload(p, extra = {}) {
  return {
    uid: p.recipient.uid,
    recipientToken: p.recipientToken,
    type: "CREDIT",
    amountKurus: 10050,
    reason: "Müşteri hediye bakiyesi",
    idempotencyKey: crypto.randomUUID(),
    ...extra,
  };
}
before(async () => {
  f = await applicationFixture();
  owner = await f.openAdmin();
  service = require("../server/core/walletRecipientService");
});
after(async () => f?.close());
test("wallet recipient and receipts require the complete admin gate and wallet role", async () => {
  assert.equal((await preview("EmirHan", {})).status, 401);
  assert.equal((await preview("EmirHan", { uid: "member" })).status, 403);
  const viewer = await f.openAdmin("viewer");
  assert.equal((await preview("EmirHan", viewer)).status, 403);
  assert.equal(
    (
      await f.request(
        root + "/attempt?idempotencyKey=valid-operation-key",
        viewer,
      )
    ).status,
    403,
  );
});
test("username, Turkish case, email and legacy UID resolve the canonical account without money writes", async () => {
  const initial = f.db.records.get("users/member").storeBalanceKurus;
  for (const query of [
    "EmirHan",
    "EMİRHAN",
    "MEMBER@ZENTRA.INVALID",
    "member",
  ]) {
    const r = await preview(query);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.recipient.uid, "member");
    assert.equal(r.body.recipient.balanceKurus, initial);
    assert.equal(r.body.recipient.email, "member@zentra.invalid");
    assert.match(r.headers.get("cache-control"), /no-store/);
    assert.equal(
      service.unseal(r.body.recipientToken, "owneruid", "member").balanceKurus,
      initial,
    );
  }
  assert.equal(
    [...f.db.records.keys()].filter((k) => k.startsWith("storeWalletLedger/"))
      .length,
    0,
  );
});
test("not found, malformed input, disabled identity and unavailable provider are distinct failures", async () => {
  assert.equal((await preview("missing@zentra.invalid")).status, 404);
  assert.equal((await preview("<invalid>")).status, 400);
  f.users.get("member").disabled = true;
  assert.equal((await preview("EmirHan")).body.code, "STORE_ACCOUNT_DISABLED");
  f.users.get("member").disabled = false;
  const original = f.auth.getUserByEmail;
  f.auth.getUserByEmail = async () => {
    throw Object.assign(new Error("provider outage"), {
      code: "auth/internal-error",
    });
  };
  try {
    const r = await preview("member@zentra.invalid");
    assert.equal(r.status, 503);
    assert.equal(r.body.code, "STORE_ACCOUNT_LOOKUP_UNAVAILABLE");
  } finally {
    f.auth.getUserByEmail = original;
  }
});
test("duplicate usernames and UID/username collisions never select an arbitrary account", async () => {
  f.db.records.set("users/duplicate", {
    username: "EmirHan",
    usernameLower: "emirhan",
  });
  assert.equal(
    (await preview("EmirHan")).body.code,
    "STORE_USER_IDENTIFIER_AMBIGUOUS",
  );
  f.db.records.delete("users/duplicate");
  f.users.set("EmirHan", { ...f.users.get("viewer"), uid: "EmirHan" });
  assert.equal(
    (await preview("EmirHan")).body.code,
    "STORE_USER_IDENTIFIER_AMBIGUOUS",
  );
  f.users.delete("EmirHan");
});
test("recipient proof is bound to actor, target, expiry and integrity", async () => {
  const p = (await preview("EmirHan")).body;
  for (const [token, actor, uid] of [
    [p.recipientToken, "finance", "member"],
    [p.recipientToken, "owneruid", "viewer"],
    [p.recipientToken + "x", "owneruid", "member"],
  ])
    assert.throws(() => service.unseal(token, actor, uid), {
      code: "STORE_WALLET_PREVIEW_INVALID",
    });
  assert.throws(
    () => service.unseal(p.recipientToken, "owneruid", "member", p.expiresAt),
    { code: "STORE_WALLET_PREVIEW_EXPIRED" },
  );
  assert.equal(
    (await write(payload(p, { uid: "viewer" }))).body.code,
    "STORE_WALLET_PREVIEW_INVALID",
  );
  assert.equal(
    (
      await f.request(root + "/adjust", {
        ...owner,
        method: "POST",
        body: payload(p),
      })
    ).status,
    401,
  );
});
test("reassigned usernames invalidate the recipient instead of crediting a new account", async () => {
  const p = (await preview("EmirHan")).body,
    member = f.db.records.get("users/member");
  f.db.records.set("users/member", {
    ...member,
    username: "ChangedName",
    usernameLower: "changedname",
  });
  f.db.records.set("users/viewer", {
    username: "EmirHan",
    usernameLower: "emirhan",
  });
  try {
    assert.equal(
      (await write(payload(p))).body.code,
      "STORE_WALLET_RECIPIENT_CHANGED",
    );
  } finally {
    f.db.records.set("users/member", member);
    f.db.records.delete("users/viewer");
  }
});
test("a concurrent balance change rejects a stale preview inside the transaction", async () => {
  const p = (await preview("member@zentra.invalid")).body,
    row = f.db.records.get("users/member");
  f.db.records.set("users/member", {
    ...row,
    storeBalanceKurus: row.storeBalanceKurus + 1,
  });
  assert.equal(
    (await write(payload(p))).body.code,
    "STORE_WALLET_BALANCE_CHANGED",
  );
  f.db.records.set("users/member", row);
});
test("credit commits atomically and a lost-response lookup verifies matching receipt and ledger", async () => {
  const p = (await preview("EmirHan")).body,
    body = payload(p),
    before = p.recipient.balanceKurus;
  const r = await write(body);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.adjustment.balanceKurus, before + 10050);
  assert.equal(r.body.adjustment.committed, true);
  const recover = await f.request(
    root + "/attempt?idempotencyKey=" + body.idempotencyKey,
    owner,
  );
  assert.equal(recover.body.found, true);
  assert.equal(
    recover.body.adjustment.transactionId,
    r.body.adjustment.transactionId,
  );
  const replay = await write({
    ...body,
    recipientToken: "expired-preview-still-matches-committed-request",
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.adjustment.idempotentReplay, true);
  assert.equal(
    f.db.records.get("users/member").storeBalanceKurus,
    before + 10050,
  );
  assert.equal(
    (await write({ ...body, amountKurus: 10051 })).body.code,
    "STORE_BALANCE_ADJUSTMENT_CONFLICT",
  );
  assert.equal(
    (
      await require("../server/core/storeService").readStoreBalanceAdjustment(
        "finance",
        body.idempotencyKey,
      )
    ).found,
    false,
  );
  const key = "storeWalletLedger/" + r.body.adjustment.transactionId,
    ledger = f.db.records.get(key);
  f.db.records.set(key, {
    ...ledger,
    balanceAfterKurus: ledger.balanceAfterKurus + 1,
  });
  assert.equal(
    (
      await f.request(
        root + "/attempt?idempotencyKey=" + body.idempotencyKey,
        owner,
      )
    ).body.code,
    "STORE_WALLET_RECEIPT_INVALID",
  );
  f.db.records.set(key, ledger);
});
test("debit cannot overdraw; exact cents are preserved", async () => {
  let p = (await preview("EmirHan")).body;
  assert.equal(
    (
      await write(
        payload(p, {
          amountKurus: -p.recipient.balanceKurus - 1,
          type: "DEBIT",
        }),
      )
    ).body.code,
    "STORE_BALANCE_WOULD_BE_NEGATIVE",
  );
  p = (await preview("EmirHan")).body;
  const r = await write(payload(p, { amountKurus: -51, type: "DEBIT" }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(
    r.body.adjustment.balanceAfterKurus,
    p.recipient.balanceKurus - 51,
  );
});
