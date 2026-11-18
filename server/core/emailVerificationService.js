"use strict";
const crypto = require("node:crypto");
const { initFirebaseAdmin } = require("../config/firebaseAdmin");
const { purposeKey } = require("./adminAccessService");
const { liveIdentity, accountAccess, fail } = require("./accountActivation");
const {
  normalizeProfile,
  writeInitialProfile,
} = require("./registrationProfile");
const delivery = require("../email/verification");
const { createWorker } = require("./workerScheduler");
const { logError } = require("./errorLogger");
const CODE_TTL = 5 * 60000,
  WINDOW = 30 * 60000,
  COOLDOWN = 60000,
  MAX_SENDS = 5,
  MAX_ATTEMPTS = 5;
const hmac = (purpose, value) =>
  crypto.createHmac("sha256", purposeKey(purpose)).update(value).digest("hex");
const emailKey = (email) =>
  hmac("email-verification-address-v1", email.trim().toLowerCase());
const codeFor = (row) =>
  String(
    Number(
      BigInt(
        "0x" + hmac("email-verification-code-v1", `${row.id}:${row.seed}`),
      ) % 1000000n,
    ),
  ).padStart(6, "0");
const codeHash = (id, code) =>
  hmac("email-verification-proof-v1", `${id}:${code}`);
const database = () => {
  const value = initFirebaseAdmin().db;
  if (!value) throw fail("AUTH_UNAVAILABLE", 503);
  return value;
};
function references(db, uid, email) {
  return {
    challenge: db.collection("storeEmailVerificationChallenges").doc(uid),
    quota: db.collection("storeEmailVerificationQuotas").doc(emailKey(email)),
    profile: db.collection("users").doc(uid),
    receipt: db.collection("storeAccountVerifications").doc(uid),
  };
}
function maskedEmail(email) {
  const [local, domain] = email.split("@");
  return `${local.slice(0, 1)}***@${domain}`;
}
function descriptor(row, { profileRequired = false } = {}) {
  if (!row) return { profileRequired, challengeId: "", delivery: "none" };
  return {
    challengeId: row.id,
    email: maskedEmail(row.email),
    expiresAt: row.expiresAt,
    resendAt: row.resendAt,
    delivery: row.delivery,
    state: row.state,
    serverNow: Date.now(),
    remainingAttempts: Math.max(
      0,
      MAX_ATTEMPTS - Number(row.failedAttempts || 0),
    ),
    profileRequired: profileRequired || row.profileRequired === true,
    canComplete: ["verified", "activating"].includes(row.state),
    failureCode: row.failureCode || "",
  };
}
function audit(tx, db, row, action, result) {
  tx.create(
    db.collection("storeAuthVerificationAudit").doc(crypto.randomUUID()),
    {
      uid: row.uid,
      action,
      result,
      createdAt: Date.now(),
      verificationId: hmac("email-verification-audit-v1", row.id),
      failedAttempts: Number(row.failedAttempts || 0),
    },
  );
}
async function status(decoded) {
  const user = await liveIdentity(decoded),
    db = database();
  const access = await accountAccess(decoded, { user });
  if (access.ready) return { ready: true, verificationRequired: false };
  const refs = references(db, user.uid, user.email);
  const [snapshot, profile] = await Promise.all([
    refs.challenge.get(),
    refs.profile.get(),
  ]);
  const row = snapshot.data();
  const bound =
    row &&
    row.uid === user.uid &&
    row.email === user.email.toLowerCase() &&
    row.cleanupAt > Date.now();
  return {
    ready: false,
    verificationRequired: true,
    verification: descriptor(bound ? row : null, {
      profileRequired:
        (!profile.exists ||
          profile.data()?.profileInitializationPending === true) &&
        !(bound && row?.profile),
    }),
  };
}
async function deliver(decoded, id, { fetcher = global.fetch } = {}) {
  const user = await liveIdentity(decoded),
    db = database(),
    refs = references(db, user.uid, user.email);
  const leaseId = crypto.randomBytes(24).toString("hex");
  const row = await db.runTransaction(async (tx) => {
    const current = (await tx.get(refs.challenge)).data();
    if (
      !current ||
      current.id !== id ||
      current.email !== user.email.toLowerCase()
    )
      throw fail("EMAIL_VERIFICATION_INVALID", 400);
    if (current.state !== "pending" || current.expiresAt <= Date.now())
      throw fail("EMAIL_VERIFICATION_EXPIRED", 410);
    if (
      current.delivery === "accepted" ||
      Number(current.sendLeaseUntil) > Date.now()
    )
      return null;
    if (Number(current.sendAttempts || 0) >= 3)
      throw fail("EMAIL_VERIFICATION_SEND_LIMIT", 429);
    const next = {
      ...current,
      sendLeaseId: leaseId,
      sendLeaseUntil: Date.now() + 30000,
      sendAttempts: Number(current.sendAttempts || 0) + 1,
      delivery: "sending",
    };
    tx.set(refs.challenge, next);
    return next;
  });
  if (!row) return status(decoded);
  const result = await delivery.send(
    { email: row.email, code: codeFor(row), expiresAt: row.expiresAt },
    {
      key: `zentra-email-verification/${row.id}/${row.generation}`,
      fetcher,
    },
  );
  await db.runTransaction(async (tx) => {
    const current = (await tx.get(refs.challenge)).data();
    if (
      !current ||
      current.id !== id ||
      current.sendLeaseId !== leaseId ||
      current.generation !== row.generation ||
      current.state !== "pending"
    )
      return;
    tx.update(refs.challenge, {
      delivery: result.state,
      providerId: result.providerId || "",
      failureCode: result.failureCode || "",
      sendLeaseUntil: 0,
      updatedAt: Date.now(),
    });
    audit(tx, db, current, "verification.email", result.state);
  });
  if (result.state !== "accepted") throw fail(result.failureCode, 503);
  return status(decoded);
}
async function start(
  decoded,
  profileInput,
  { resendId = "", fetcher = global.fetch } = {},
) {
  const user = await liveIdentity(decoded),
    db = database();
  const email = user.email.trim().toLowerCase(),
    refs = references(db, user.uid, email);
  const access = await accountAccess(decoded, { user });
  if (access.ready)
    return { ready: true, alreadyVerified: true, verificationRequired: false };
  const profile =
    profileInput === undefined ? null : normalizeProfile(profileInput);
  const decision = await db.runTransaction(async (tx) => {
    const [snapshot, quotaSnapshot, profileSnapshot] = await Promise.all([
      tx.get(refs.challenge),
      tx.get(refs.quota),
      tx.get(refs.profile),
    ]);
    const old = snapshot.data(),
      now = Date.now(),
      stored = profileSnapshot.data() || {};
    const needsProfile =
      !profileSnapshot.exists || stored.profileInitializationPending === true;
    if (needsProfile && !profile && !(old?.email === email && old?.profile))
      return { profileRequired: true };
    if (
      old?.email === email &&
      ["verified", "activating"].includes(old.state) &&
      old.proofExpiresAt > now
    ) {
      if (profile)
        tx.update(refs.challenge, { profile, profileRequired: false });
      return { complete: true, id: old.id };
    }
    if (resendId && (!old || old.id !== resendId || old.email !== email))
      throw fail("EMAIL_VERIFICATION_INVALID", 400);
    if (
      !resendId &&
      old?.email === email &&
      old.state === "pending" &&
      old.expiresAt > now
    ) {
      if (profile)
        tx.update(refs.challenge, { profile, profileRequired: false });
      return { id: old.id };
    }
    let quota = quotaSnapshot.data() || {};
    if (Number(quota.windowUntil || 0) <= now)
      quota = { sent: 0, failedAttempts: 0, windowUntil: now + WINDOW };
    if (quota.failedAttempts >= MAX_ATTEMPTS)
      throw fail("EMAIL_VERIFICATION_LOCKED", 429);
    if (quota.sent >= MAX_SENDS)
      throw fail("EMAIL_VERIFICATION_SEND_LIMIT", 429);
    if (Number(quota.resendAt || 0) > now)
      throw fail("EMAIL_VERIFICATION_RESEND_WAIT", 429);
    const row = {
      id: crypto.randomBytes(32).toString("base64url"),
      uid: user.uid,
      email,
      seed: crypto.randomBytes(32).toString("hex"),
      generation: crypto.randomUUID(),
      profile: needsProfile
        ? profile || (old?.email === email ? old.profile : null)
        : null,
      state: "pending",
      delivery: "queued",
      failedAttempts: Number(quota.failedAttempts || 0),
      createdAt: now,
      updatedAt: now,
      expiresAt: now + CODE_TTL,
      resendAt: now + COOLDOWN,
      cleanupAt: now + WINDOW,
      sendAttempts: 0,
      profileRequired: false,
      providerId: "",
      failureCode: "",
    };
    while (
      old?.state === "pending" &&
      old.seed &&
      codeFor(row) === codeFor(old)
    )
      row.seed = crypto.randomBytes(32).toString("hex");
    row.proofHash = codeHash(row.id, codeFor(row));
    tx.set(refs.challenge, row);
    tx.set(refs.quota, {
      ...quota,
      sent: Number(quota.sent || 0) + 1,
      resendAt: row.resendAt,
      cleanupAt: quota.windowUntil + WINDOW,
    });
    audit(tx, db, row, "verification.started", "pending");
    return { id: row.id };
  });
  if (decision.profileRequired)
    return {
      ready: false,
      verificationRequired: true,
      verification: descriptor(null, { profileRequired: true }),
    };
  if (decision.complete) return complete(decoded, decision.id);
  return deliver(decoded, decision.id, { fetcher });
}
async function verify(decoded, id, code) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(id) || !/^\d{6}$/.test(code))
    throw fail("EMAIL_VERIFICATION_INPUT_INVALID", 400);
  const user = await liveIdentity(decoded),
    db = database(),
    refs = references(db, user.uid, user.email);
  const result = await db.runTransaction(async (tx) => {
    const [snapshot, quotaSnapshot] = await Promise.all([
      tx.get(refs.challenge),
      tx.get(refs.quota),
    ]);
    const row = snapshot.data(),
      quota = quotaSnapshot.data() || {},
      now = Date.now();
    if (
      !row ||
      row.id !== id ||
      row.uid !== user.uid ||
      row.email !== user.email.toLowerCase()
    )
      return { error: "EMAIL_VERIFICATION_INVALID", status: 400 };
    if (row.state !== "pending")
      return { error: "EMAIL_VERIFICATION_USED", status: 409 };
    if (row.expiresAt <= now)
      return { error: "EMAIL_VERIFICATION_EXPIRED", status: 410 };
    if (
      quota.failedAttempts >= MAX_ATTEMPTS ||
      row.failedAttempts >= MAX_ATTEMPTS
    )
      return { error: "EMAIL_VERIFICATION_LOCKED", status: 429 };
    if (!["accepted", "uncertain", "sending"].includes(row.delivery))
      return { error: "EMAIL_VERIFICATION_NOT_SENT", status: 503 };
    const expected = Buffer.from(row.proofHash || "", "hex"),
      actual = Buffer.from(codeHash(id, code), "hex");
    if (
      expected.length !== actual.length ||
      !crypto.timingSafeEqual(expected, actual)
    ) {
      const failedAttempts = Number(quota.failedAttempts || 0) + 1;
      tx.update(refs.challenge, { failedAttempts, updatedAt: now });
      tx.set(refs.quota, {
        ...quota,
        failedAttempts,
        cleanupAt: Number(quota.cleanupAt || now + WINDOW),
      });
      audit(
        tx,
        db,
        { ...row, failedAttempts },
        "verification.code",
        "rejected",
      );
      return {
        error:
          failedAttempts >= MAX_ATTEMPTS
            ? "EMAIL_VERIFICATION_LOCKED"
            : "EMAIL_VERIFICATION_INCORRECT",
        status: failedAttempts >= MAX_ATTEMPTS ? 429 : 400,
      };
    }
    tx.update(refs.challenge, {
      state: "verified",
      verifiedAt: now,
      proofExpiresAt: now + 10 * 60000,
      seed: "",
      proofHash: "",
      sendLeaseUntil: 0,
      updatedAt: now,
    });
    audit(tx, db, row, "verification.code", "verified");
    return { verified: true };
  });
  if (result.error) throw fail(result.error, result.status);
  return complete(decoded, id);
}
async function complete(decoded, id) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(id))
    throw fail("EMAIL_VERIFICATION_INPUT_INVALID", 400);
  const user = await liveIdentity(decoded),
    db = database(),
    refs = references(db, user.uid, user.email);
  const leaseId = crypto.randomBytes(24).toString("hex");
  const row = await db
    .runTransaction(async (tx) => {
      const [snapshot, receipt, profile] = await Promise.all([
        tx.get(refs.challenge),
        tx.get(refs.receipt),
        tx.get(refs.profile),
      ]);
      const value = snapshot.data();
      if (!value || value.id !== id || value.email !== user.email.toLowerCase())
        throw fail("EMAIL_VERIFICATION_INVALID", 400);
      if (value.state === "completed" && receipt.data()?.state === "completed")
        return null;
      if (
        !["verified", "activating"].includes(value.state) ||
        !value.verifiedAt ||
        value.proofExpiresAt <= Date.now()
      )
        throw fail("EMAIL_VERIFICATION_PROOF_REQUIRED", 403);
      if (Number(value.activationLeaseUntil || 0) > Date.now())
        throw fail("EMAIL_VERIFICATION_ACTIVATING", 409);
      const current = profile.data() || {};
      if (!profile.exists || current.profileInitializationPending === true) {
        if (!value.profile) throw fail("REGISTRATION_PROFILE_REQUIRED", 409);
        await writeInitialProfile(
          tx,
          db,
          { uid: user.uid, email: value.email },
          value.profile,
          { verificationRequired: true },
        );
      } else
        tx.set(
          refs.profile,
          { registrationVerificationRequired: 1 },
          { merge: true },
        );
      tx.set(
        refs.receipt,
        {
          uid: user.uid,
          state: "activating",
          verifiedAt: value.verifiedAt,
          updatedAt: Date.now(),
        },
        { merge: true },
      );
      tx.update(refs.challenge, {
        state: "activating",
        activationLeaseId: leaseId,
        activationLeaseUntil: Date.now() + 60000,
        profileRequired: false,
      });
      return value;
    })
    .catch(async (error) => {
      if (
        ["USERNAME_TAKEN", "PROFILE_INITIALIZATION_LOCKED"].includes(error.code)
      ) {
        await db.runTransaction(async (tx) => {
          const current = (await tx.get(refs.challenge)).data();
          if (current?.id === id && current.email === user.email.toLowerCase())
            tx.update(refs.challenge, { profileRequired: true });
        });
      }
      throw error;
    });
  if (!row) {
    const current = await liveIdentity(decoded);
    if (!current.emailVerified) throw fail("EMAIL_VERIFICATION_REQUIRED");
    return { ready: true, completed: true, verificationRequired: false };
  }
  try {
    const { auth } = initFirebaseAdmin();
    const current = await liveIdentity(decoded);
    if (current.email.toLowerCase() !== row.email)
      throw fail("AUTH_ACCOUNT_MISMATCH", 401);
    await auth.updateUser(user.uid, { email: row.email, emailVerified: true });
    const checked = await liveIdentity(decoded);
    if (checked.emailVerified !== true)
      throw fail("EMAIL_VERIFICATION_ACTIVATION_UNCERTAIN", 503);
    await db.runTransaction(async (tx) => {
      const active = (await tx.get(refs.challenge)).data();
      if (active?.id !== id || active.activationLeaseId !== leaseId)
        throw fail("EMAIL_VERIFICATION_ACTIVATION_UNCERTAIN", 503);
      tx.set(
        refs.receipt,
        {
          uid: user.uid,
          state: "completed",
          verifiedAt: row.verifiedAt,
          completedAt: Date.now(),
          updatedAt: Date.now(),
        },
        { merge: true },
      );
      tx.update(refs.challenge, {
        state: "completed",
        activationLeaseUntil: 0,
        profile: null,
        updatedAt: Date.now(),
      });
      audit(tx, db, active, "verification.activation", "completed");
    });
    return { ready: true, completed: true, verificationRequired: false };
  } catch {
    await db
      .runTransaction(async (tx) => {
        const active = (await tx.get(refs.challenge)).data();
        if (
          active?.id === id &&
          active.activationLeaseId === leaseId &&
          active.state !== "completed"
        ) {
          tx.update(refs.challenge, { activationLeaseUntil: 0 });
          audit(tx, db, active, "verification.activation", "uncertain");
        }
      })
      .catch(() => {});
    throw fail("EMAIL_VERIFICATION_ACTIVATION_UNCERTAIN", 503);
  }
}
async function cleanup() {
  const db = database();
  let deleted = 0;
  for (const name of [
    "storeEmailVerificationChallenges",
    "storeEmailVerificationQuotas",
  ]) {
    const rows = await db
      .collection(name)
      .where("cleanupAt", "<=", Date.now())
      .limit(20)
      .get();
    for (const doc of rows.docs)
      await db.runTransaction(async (tx) => {
        const current = (await tx.get(doc.ref)).data();
        if (
          current &&
          current.cleanupAt <= Date.now() &&
          Number(current.activationLeaseUntil || 0) <= Date.now()
        ) {
          tx.delete(doc.ref);
          deleted++;
        }
      });
  }
  return deleted;
}
const worker = createWorker({
  run: cleanup,
  idleMs: 60000,
  onError: (error) => logError(error, { event: "email.verification.cleanup" }),
});
module.exports = { start, status, verify, complete, deliver, cleanup, worker };
