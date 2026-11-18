"use strict";
const crypto = require("node:crypto");
const { initFirebaseAdmin } = require("../config/firebaseAdmin");
const { purposeKey } = require("./adminAccessService");
const K = require("../email/config");
const { identityRequest } = require("./firebaseIdentityClient");
const { findUsernameProfiles } = require("./storeUsername");
const { createWorker } = require("./workerScheduler");
const { recordMutationAudit } = require("./storeMutationAudit");
const FINAL = 8640000000000000,
  TTL = 15 * 60000;
const digest = (...v) =>
  crypto
    .createHmac("sha256", purposeKey("account-recovery-id-v1"))
    .update(v.join("\0"))
    .digest("hex");
function seal(value) {
  const iv = crypto.randomBytes(12),
    c = crypto.createCipheriv(
      "aes-256-gcm",
      purposeKey("account-recovery-envelope-v1"),
      iv,
    ),
    data = Buffer.concat([c.update(JSON.stringify(value)), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), data]).toString("base64url");
}
function open(value) {
  try {
    const b = Buffer.from(value, "base64url"),
      c = crypto.createDecipheriv(
        "aes-256-gcm",
        purposeKey("account-recovery-envelope-v1"),
        b.subarray(0, 12),
      );
    c.setAuthTag(b.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([c.update(b.subarray(28)), c.final()]).toString(),
    );
  } catch {
    throw K.failure("RECOVERY_INVALID", 400);
  }
}
function firebase() {
  const f = initFirebaseAdmin();
  if (!f.db || !f.auth) throw K.failure("AUTH_UNAVAILABLE", 503);
  return f;
}
function tokenId(token) {
  if (typeof token !== "string" || !/^[-_A-Za-z0-9]{43}$/.test(token))
    throw K.failure("RECOVERY_INVALID");
  return digest("token", token);
}
async function request(kind, input) {
  if (
    !["password", "username"].includes(kind) ||
    !input ||
    Object.keys(input).some(
      (k) => !["identifier", "idempotencyKey"].includes(k),
    )
  )
    throw K.failure("RECOVERY_INPUT_INVALID");
  const identifier =
    typeof input.identifier === "string"
      ? input.identifier.trim().normalize("NFC")
      : "";
  const key = input.idempotencyKey || crypto.randomUUID();
  if (
    !identifier ||
    identifier.length > 254 ||
    /[<>\x00-\x1f\x7f]/.test(identifier) ||
    typeof key !== "string" ||
    !/^[-_A-Za-z0-9]{12,100}$/.test(key) ||
    (kind === "username" && !K.validEmail(identifier))
  )
    throw K.failure("RECOVERY_INPUT_INVALID");
  const c = K.recoveryConfiguration();
  if (!c.configured)
    throw K.failure("RECOVERY_MAIL_UNAVAILABLE", 503);
  const { db } = firebase(),
    ref = db
      .collection("storeAccountRecoveryRequests")
      .doc(digest("request", kind, key)),
    fingerprint = digest(kind, identifier.toLocaleLowerCase("tr-TR"));
  await db.runTransaction(async (tx) => {
    const old = await tx.get(ref);
    if (old.exists) {
      if (old.data().fingerprint !== fingerprint)
        throw K.failure("RECOVERY_OPERATION_CONFLICT", 409);
      return;
    }
    const now = Date.now();
    tx.create(ref, {
      kind,
      fingerprint,
      envelope: seal({ identifier }),
      state: "queued",
      attempts: 0,
      createdAt: now,
      expiresAt: now + TTL,
      availableAt: now,
      providerId: "",
    });
  });
  worker.wake();
  return { accepted: true };
}
async function resolve(identifier, kind) {
  const { db, auth } = firebase();
  let user;
  try {
    if (identifier.includes("@"))
      user = await auth.getUserByEmail(identifier.toLowerCase());
    else {
      const rows = await findUsernameProfiles(db, identifier);
      if (rows.length !== 1) return null;
      user = await auth.getUser(rows[0].id);
    }
  } catch (error) {
    if (
      error.code === "auth/user-not-found" ||
      ["INVALID_USERNAME", "USERNAME_RESERVED", "USERNAME_AMBIGUOUS"].includes(
        error.code,
      )
    )
      return null;
    throw error;
  }
  if (!user?.uid || user.disabled || !K.validEmail(user.email)) return null;
  const profile = (await db.collection("users").doc(user.uid).get()).data();
  if (profile?.storeAccountStatus && profile.storeAccountStatus !== "active")
    return null;
  if (
    kind === "username" &&
    (!user.emailVerified ||
      typeof profile?.username !== "string" ||
      !profile.username.trim())
  )
    return null;
  return {
    uid: user.uid,
    email: user.email.toLowerCase(),
    username: profile?.username || "",
  };
}
async function processRequest(ref, { fetcher = global.fetch } = {}) {
  const { db, auth } = firebase(),
    lease = crypto.randomUUID(),
    now = Date.now();
  const job = await db.runTransaction(async (tx) => {
    const row = (await tx.get(ref)).data();
    if (!row || row.availableAt > now || row.availableAt === FINAL) return null;
    if (row.expiresAt <= now || row.attempts >= 5) {
      tx.update(ref, { state: "expired", availableAt: FINAL, envelope: null });
      return null;
    }
    tx.update(ref, {
      lease,
      state: "processing",
      availableAt: now + 60000,
      attempts: row.attempts + 1,
    });
    return { ...row, lease };
  });
  if (!job) return;
  const finish = async (patch) =>
    db.runTransaction(async (tx) => {
      const row = (await tx.get(ref)).data();
      if (row?.lease !== lease) return;
      const event = patch.providerId
        ? (
            await tx.get(
              db.collection("storeEmailProviderState").doc(patch.providerId),
            )
          ).data()
        : null;
      const effective = event
        ? { ...patch, ...require("../email/service").providerPatch(event) }
        : patch;
      tx.update(ref, { ...effective, lease: "", updatedAt: Date.now() });
      if (patch.providerId) {
        tx.set(db.collection("storeEmailProviderMap").doc(patch.providerId), {
          jobId: ref.id,
          collection: "storeAccountRecoveryRequests",
          recipientHash: row.recipientHash,
        });
        if (event?.blocked)
          tx.set(
            db.collection("storeEmailSuppressions").doc(row.recipientHash),
            { blocked: true, reason: event.type, updatedAt: Date.now() },
          );
      }
    });
  try {
    const source = open(job.envelope),
      person = await resolve(source.identifier, job.kind);
    if (!person)
      return finish({
        state: "suppressed",
        availableAt: FINAL,
        envelope: null,
      });
    if (
      (
        await db
          .collection("storeEmailSuppressions")
          .doc(K.addressHash(person.email))
          .get()
      ).data()?.blocked
    )
      return finish({
        state: "suppressed",
        availableAt: FINAL,
        envelope: null,
      });
    let payload = source.payload;
    if (
      payload &&
      (source.uid !== person.uid ||
        source.recipientHash !== digest(person.email) ||
        (job.kind === "username" && source.username !== person.username))
    )
      return finish({
        state: "suppressed",
        availableAt: FINAL,
        envelope: null,
      });
    if (!payload) {
      const sendLock = db
        .collection("storeAccountRecoverySendLocks")
        .doc(digest("send-lock", person.uid));
      await db.runTransaction(async (tx) => {
        const current = (await tx.get(ref)).data();
        const quotaRef = db
          .collection("storeAccountRecoveryQuotas")
          .doc(digest("send-quota", person.uid));
        const quota = (await tx.get(quotaRef)).data();
        const head = (
          await tx.get(
            db
              .collection("storeAccountRecoveryHeads")
              .doc(digest("owner", person.uid)),
          )
        ).data();
        const lock = (await tx.get(sendLock)).data();
        if (current?.lease !== lease)
          throw K.failure("RECOVERY_LEASE_CHANGED", 409);
        if (job.kind === "password" && head?.requestCreatedAt > job.createdAt)
          throw K.failure("RECOVERY_SUPERSEDED", 409);
        if (lock?.expiresAt > Date.now() && lock.lease !== lease)
          throw K.failure("RECOVERY_SEND_BUSY", 503);
        const recent = (quota?.sentAt || []).filter(
          (at) => at > Date.now() - 1800000,
        );
        if (!current.quotaClaimed && recent.length >= 5)
          throw K.failure("RECOVERY_SEND_LIMIT", 429);
        if (!current.quotaClaimed)
          tx.set(quotaRef, { sentAt: [...recent, Date.now()] });
        tx.set(sendLock, { lease, expiresAt: Date.now() + 120000 });
        tx.update(ref, { quotaClaimed: true });
      });
      try {
        let link = new URL(
          "/?devam=" + encodeURIComponent("/hesabim?islem=giris"),
          K.recoveryConfiguration().origin,
        ).href;
        let tokenRef = null,
          tokenRow = null;
        if (job.kind === "password") {
          const raw = await auth.generatePasswordResetLink(person.email);
          const code = new URL(raw).searchParams.get("oobCode");
          if (!code || code.length > 2048)
            throw K.failure("RECOVERY_PROVIDER_UNAVAILABLE", 503);
          const token = crypto.randomBytes(32).toString("base64url"),
            id = tokenId(token);
          tokenRef = db.collection("storeAccountRecoveryTokens").doc(id);
          tokenRow = {
            uid: person.uid,
            emailHash: digest(person.email),
            envelope: seal({ code }),
            state: "ready",
            createdAt: Date.now(),
            expiresAt: job.expiresAt,
            cleanupAt: job.expiresAt,
            requestId: ref.id,
          };
          const destination = new URL("/sifre-yenile.html", K.recoveryConfiguration().origin);
          destination.hash = new URLSearchParams({ recovery: token }).toString();
          link = destination.href;
        }
        payload = require("../email/recovery").message({
          kind: job.kind,
          template: (await require("../email/editor").read(db)).templates["recovery_" + job.kind],
          ...person,
          link,
          expiresAt: job.expiresAt,
        });
        const envelope = seal({
          ...source,
          payload,
          uid: person.uid,
          recipientHash: digest(person.email),
          username: person.username,
        });
        await db.runTransaction(async (tx) => {
          const current = (await tx.get(ref)).data();
          if (current?.lease !== lease)
            throw K.failure("RECOVERY_LEASE_CHANGED", 409);
          const headRef = db
            .collection("storeAccountRecoveryHeads")
            .doc(digest("owner", person.uid));
          const head = tokenRef ? (await tx.get(headRef)).data() : null;
          if (tokenRef) {
            if (head?.requestCreatedAt > job.createdAt)
              throw K.failure("RECOVERY_SUPERSEDED", 409);
            tx.create(tokenRef, tokenRow);
            tx.set(headRef, {
              tokenId: tokenRef.id,
              requestCreatedAt: job.createdAt,
              updatedAt: Date.now(),
            });
          }
          tx.update(ref, {
            envelope,
            uid: person.uid,
            recipientHash: K.addressHash(person.email),
            recipientLabel: person.email.replace(/^(.).*(@.*)$/, "$1***$2"),
          });
        });
      } finally {
        await db.runTransaction(async (tx) => {
          const lock = (await tx.get(sendLock)).data();
          if (lock?.lease === lease)
            tx.set(sendLock, { lease: "", expiresAt: 0 });
        });
      }
    }
    const c = K.recoveryConfiguration(),
      response = await fetcher("https://api.resend.com/emails", {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10000),
        headers: {
          Authorization: "Bearer " + c.apiKey,
          "Content-Type": "application/json",
          "Idempotency-Key": "zentra/recovery/" + ref.id,
        },
        body: JSON.stringify(payload),
      }),
      data = await response.json().catch(() => null);
    if (
      response.ok &&
      typeof data?.id === "string" &&
      /^[a-f0-9-]{36}$/i.test(data.id)
    )
      return finish({
        state: "accepted",
        providerId: data.id,
        acceptedAt: Date.now(),
        failureCode: "",
        availableAt: FINAL,
        envelope: null,
      });
    const retry =
      response.ok ||
      response.status === 429 ||
      response.status >= 500 ||
      response.status === 409;
    return finish({
      state: retry ? "uncertain" : "rejected",
      failureCode: response.status === 401 || response.status === 403
        ? "RECOVERY_MAIL_AUTHORIZATION_FAILED"
        : response.status === 429 ? "RECOVERY_MAIL_RATE_LIMITED"
        : retry ? "RECOVERY_PROVIDER_UNAVAILABLE" : "RECOVERY_MAIL_REJECTED",
      availableAt: retry ? Date.now() + 30000 : FINAL,
      ...(!retry ? { envelope: null } : {}),
    });
  } catch (error) {
    if (["RECOVERY_SUPERSEDED", "RECOVERY_SEND_LIMIT"].includes(error.code))
      return finish({
        state: "suppressed",
        availableAt: FINAL,
        envelope: null,
      });
    const failureCode = error.code === "AUTH_PROVIDER_CONFIGURATION_INVALID"
      ? "AUTH_PROVIDER_CONFIGURATION_INVALID"
      : ["AUTH_UNAVAILABLE", "auth/internal-error", "auth/insufficient-permission"].includes(error.code)
        ? "RECOVERY_IDENTITY_UNAVAILABLE"
        : "RECOVERY_PROVIDER_UNAVAILABLE";
    await finish({
      state: "uncertain",
      availableAt: Date.now() + 30000,
      failureCode,
    });
  }
}
async function readToken(token, { allowCompleted = true } = {}) {
  const { db, auth } = firebase(),
    id = tokenId(token),
    ref = db.collection("storeAccountRecoveryTokens").doc(id),
    row = (await ref.get()).data();
  if (!row) throw K.failure("RECOVERY_INVALID");
  if (row.state === "completed" && allowCompleted) return { ref, row };
  if (row.state === "rejected") throw K.failure("RECOVERY_INVALID");
  const head = (
    await db
      .collection("storeAccountRecoveryHeads")
      .doc(digest("owner", row.uid))
      .get()
  ).data();
  if (row.expiresAt <= Date.now()) throw K.failure("RECOVERY_EXPIRED");
  if (head?.tokenId !== id) throw K.failure("RECOVERY_INVALID");
  const user = await auth.getUser(row.uid);
  if (
    user.disabled ||
    digest(String(user.email).toLowerCase()) !== row.emailHash
  )
    throw K.failure("RECOVERY_INVALID");
  return { ref, row, user };
}
async function inspect(token) {
  const { row } = await readToken(token);
  return {
    operationKey: ["provider_pending", "uncertain"].includes(row.state)
      ? row.operationKey || ""
      : "",
    state:
      row.state === "completed"
        ? "completed"
        : row.state === "ready"
          ? "ready"
          : "uncertain",
    expiresAt: row.expiresAt,
  };
}
async function complete(input) {
  if (
    !input ||
    Object.keys(input).some(
      (k) => !["token", "newPassword", "idempotencyKey"].includes(k),
    ) ||
    typeof input.newPassword !== "string" ||
    input.newPassword.length < 8 ||
    input.newPassword.length > 4096 ||
    typeof input.idempotencyKey !== "string" ||
    !/^[-_A-Za-z0-9]{12,100}$/.test(input.idempotencyKey)
  )
    throw K.failure("PASSWORD_INPUT_INVALID");
  const { db, auth } = firebase(),
    { ref, row, user } = await readToken(input.token),
    proof = digest("password", ref.id, input.newPassword),
    operationId = "recovery_" + ref.id;
  if (row.state === "completed") {
    if (row.proof !== proof || row.operationKey !== input.idempotencyKey)
      throw K.failure("RECOVERY_OPERATION_CONFLICT", 409);
    return { changed: true, replayed: true };
  }
  const lockRef = db
    .collection("storePasswordLocks")
    .doc(crypto.createHash("sha256").update(row.uid).digest("hex"));
  const recovered = await db.runTransaction(async (tx) => {
    const current = (await tx.get(ref)).data(),
      lock = (await tx.get(lockRef)).data(),
      head = (
        await tx.get(
          db
            .collection("storeAccountRecoveryHeads")
            .doc(digest("owner", row.uid)),
        )
      ).data();
    if (head?.tokenId !== ref.id || current.expiresAt <= Date.now())
      throw K.failure("RECOVERY_INVALID");
    if (current.state !== "ready") {
      if (
        current.proof !== proof ||
        current.operationKey !== input.idempotencyKey
      )
        throw K.failure("RECOVERY_OPERATION_CONFLICT", 409);
      return true;
    }
    if (lock?.expiresAt > Date.now())
      throw K.failure("PASSWORD_CHANGE_IN_PROGRESS", 409);
    tx.update(ref, {
      state: "provider_pending",
      proof,
      operationKey: input.idempotencyKey,
      startedAt: Date.now(),
    });
    tx.set(lockRef, { operationId, expiresAt: Date.now() + 120000 });
    return false;
  });
  let verified = recovered;
  if (!recovered) {
    let result;
    try {
      result = await identityRequest("resetPassword", {
        oobCode: open(row.envelope).code,
        newPassword: input.newPassword,
      });
    } catch {
      throw K.failure("RECOVERY_RESULT_UNCERTAIN", 503);
    }
    if (!result.ok) {
      const passwordRejected =
        /^(?:WEAK_PASSWORD|PASSWORD_DOES_NOT_MEET_REQUIREMENTS)(?:\b|$)/.test(
          String(result.payload?.error?.message || ""),
        );
      if (passwordRejected) {
        await db.runTransaction(async (tx) => {
          const lock = (await tx.get(lockRef)).data();
          tx.update(ref, {
            state: "ready",
            proof: null,
            operationKey: null,
            startedAt: 0,
          });
          if (lock?.operationId === operationId)
            tx.set(lockRef, { operationId: "", expiresAt: 0 });
        });
        throw K.failure("PASSWORD_CHANGE_REJECTED", 400);
      }
      const uncertain = result.status >= 500 || result.status === 429;
      await db.runTransaction(async (tx) => {
        const lock = (await tx.get(lockRef)).data();
        tx.update(ref, {
          state: uncertain ? "uncertain" : "rejected",
          ...(!uncertain ? { envelope: null } : {}),
        });
        if (!uncertain && lock?.operationId === operationId)
          tx.set(lockRef, { operationId: "", expiresAt: 0 });
      });
      throw K.failure(
        uncertain ? "RECOVERY_RESULT_UNCERTAIN" : "RECOVERY_REJECTED",
        uncertain ? 503 : 400,
      );
    }
    if (
      String(result.payload.email || "").toLowerCase() !==
      user.email.toLowerCase()
    )
      throw K.failure("RECOVERY_RESULT_UNCERTAIN", 503);
    verified = true;
  }
  if (recovered) {
    const result = await identityRequest("signInWithPassword", {
      email: user.email,
      password: input.newPassword,
      returnSecureToken: true,
    });
    if (!result.ok || result.payload.localId !== row.uid)
      throw K.failure("RECOVERY_RESULT_UNCERTAIN", 503);
  }
  if (!verified) throw K.failure("RECOVERY_RESULT_UNCERTAIN", 503);
  const currentUser = await auth.getUser(row.uid);
  if (
    currentUser.disabled ||
    digest(String(currentUser.email).toLowerCase()) !== row.emailHash
  )
    throw K.failure("RECOVERY_INVALID");
  await auth.revokeRefreshTokens(row.uid);
  await db
    .collection("storeCustomerSessionRevocations")
    .doc(row.uid)
    .set({ revokedAt: Date.now() });
  await require("./adminSessionRegistry").revokeAdminSessionsForUser(row.uid);
  await db.runTransaction(async (tx) => {
    const current = (await tx.get(ref)).data(),
      opRef = db.collection("storePasswordOperations").doc(operationId),
      op = await tx.get(opRef),
      lock = (await tx.get(lockRef)).data();
    if (current.state === "completed") return;
    if (
      current.proof !== proof ||
      current.operationKey !== input.idempotencyKey
    )
      throw K.failure("RECOVERY_OPERATION_CONFLICT", 409);
    tx.update(ref, {
      state: "completed",
      completedAt: Date.now(),
      envelope: null,
    });
    if (lock?.operationId === operationId)
      tx.set(lockRef, { operationId: "", expiresAt: 0 });
    if (!op.exists) {
      tx.create(opRef, {
        uid: row.uid,
        state: "completed",
        createdAt: current.startedAt,
        completedAt: Date.now(),
        source: "email-recovery",
      });
      require("../email/service").enqueue(tx, db, {
        uid: row.uid,
        type: "password_changed",
        key: operationId,
        data: { operationId },
      });
      const note = db
        .collection("storeNotifications")
        .doc(digest("notice", operationId));
      tx.create(note, {
        id: note.id,
        uid: row.uid,
        type: "security",
        templateType:"password_reset_completed",
        title: "Şifre sıfırlama tamamlandı",
        message:
          "Hesabının şifresi yenilendi. Güvenlik için yeniden giriş yapmalısın.",
        createdAt: Date.now(),
        readAt: 0,
      });
      recordMutationAudit(
        tx,
        db,
        "store.password.recovery",
        { uid: row.uid },
        { operationId, providerConfirmed: true },
      );
    }
  });
  return { changed: true, replayed: recovered };
}
async function run(options) {
  if (!K.recoveryConfiguration().configured) return 0;
  const { db } = firebase();
  const expired = await db
    .collection("storeAccountRecoveryTokens")
    .where("cleanupAt", "<=", Date.now())
    .limit(10)
    .get();
  for (const d of expired.docs)
    await db.runTransaction(async (tx) => {
      const r = (await tx.get(d.ref)).data();
      if (r?.expiresAt <= Date.now())
        tx.update(d.ref, {
          envelope: null,
          cleanupAt: FINAL,
          ...(r.state !== "completed" ? { state: "expired" } : {}),
        });
    });
  const rows = await db
    .collection("storeAccountRecoveryRequests")
    .where("availableAt", "<=", Date.now())
    .orderBy("availableAt", "asc")
    .limit(5)
    .get();
  for (const d of rows.docs) await processRequest(d.ref, options);
  return rows.size;
}
const worker = createWorker({
  run,
  idleMs: 60000,
  activeMs: 2000,
  onError: () =>
    require("./errorLogger").logError(null, {
      event: "account.recovery.worker",
      code: "RECOVERY_STORAGE_UNAVAILABLE",
    }),
});
module.exports = {
  request,
  inspect,
  complete,
  run,
  processRequest,
  resolve,
  worker,
  TTL,
};
