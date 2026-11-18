"use strict";

const { createRouter } = require("../core/asyncRouter");
const {
  identityRequest: identityToolkit,
} = require("../core/firebaseIdentityClient");
const { initFirebaseAdmin } = require("../config/firebaseAdmin");
const {
  authLoginLimiter,
  authAccountLimiter,
  resetAccountLimiter,
  passwordResetLimiter,
  requireAuth,
  strictLimiter,
} = require("../core/security");
const { trustedOrigin } = require("../core/userSessionService");

const {
  usernameKeys,
  usernameRegistryId,
  validateUsername,
  findUsernameProfiles,
} = require("../core/storeUsername");

const router = createRouter();

function serviceError(code, statusCode = 400, message = "") {
  return Object.assign(new Error(message || code), { code, statusCode });
}

function text(value = "", max = 200) {
  return String(value || "")
    .trim()
    .replace(/[<>\u0000-\u001f\u007f]/g, "")
    .slice(0, max);
}

async function usernameAvailability(value = "") {
  const username = validateUsername(value);
  const keys = usernameKeys(username);
  const { db } = initFirebaseAdmin();
  if (!db) throw serviceError("STORE_STORAGE_UNAVAILABLE", 503);
  const registry = await Promise.all(
    keys.map((key) =>
      db.collection("usernameRegistry").doc(usernameRegistryId(key)).get(),
    ),
  );
  if (registry.some((doc) => doc.exists)) {
    return {
      available: false,
      username,
      code: "USERNAME_TAKEN",
      message: "Bu kullanıcı adı kullanılıyor.",
    };
  }
  const profiles = await findUsernameProfiles(db, username, {
    includeRegistry: false,
  });
  const taken = profiles.length > 0;
  return {
    available: !taken,
    username,
    code: taken ? "USERNAME_TAKEN" : "",
    message: taken ? "Bu kullanıcı adı kullanılıyor." : "",
  };
}

function authInvalid() {
  return serviceError(
    "LOGIN_CREDENTIALS_INVALID",
    401,
    "Giriş bilgileri doğrulanamadı. E-posta/kullanıcı adı ve şifreni kontrol et.",
  );
}

function validEmail(value = "") {
  const email = text(value, 254).toLowerCase();
  return /^\S+@\S+\.\S+$/.test(email) ? email : "";
}

async function activeIdentity(auth, uid) {
  let user;
  try {
    user = await auth.getUser(uid);
  } catch (error) {
    if (error?.code === "auth/user-not-found") throw authInvalid();
    throw serviceError("AUTH_UNAVAILABLE", 503);
  }
  if (!user || user.disabled) throw authInvalid();
  return user;
}

async function resolvePrivateLogin(identifier = "") {
  const normalized = String(identifier || "").trim();
  if (normalized.length > 254 || /[<>\u0000-\u001f\u007f]/.test(normalized))
    throw authInvalid();
  const { db, auth } = initFirebaseAdmin();
  if (!db || !auth)
    throw serviceError(
      "AUTH_UNAVAILABLE",
      503,
      "Hesap hizmetine şu anda ulaşılamıyor. Lütfen kısa süre sonra tekrar dene.",
    );
  if (normalized.includes("@")) {
    const email = validEmail(normalized);
    if (!email) throw authInvalid();
    return { email, expectedUid: "" };
  }
  let username;
  try {
    username = validateUsername(normalized);
  } catch (_) {
    throw authInvalid();
  }
  const profiles = await findUsernameProfiles(db, username);
  if (profiles.length !== 1) throw authInvalid();
  const doc = profiles[0];
  const authUser = await activeIdentity(auth, doc.id);
  const email = validEmail(authUser.email);
  if (!email) throw authInvalid();
  return { email, expectedUid: doc.id };
}

router.post(
  "/auth/login",
  authLoginLimiter,
  authAccountLimiter,
  async (req, res, next) => {
    try {
      if (!trustedOrigin(req)) throw serviceError("ORIGIN_NOT_ALLOWED", 403);
      if (
        !req.body ||
        Object.keys(req.body).some(
          (key) => !["identifier", "password"].includes(key),
        ) ||
        typeof req.body.identifier !== "string" ||
        typeof req.body.password !== "string"
      )
        throw authInvalid();
      const identifier = req.body.identifier.trim();
      const password = req.body.password;
      if (!identifier || !password || password.length > 4096)
        throw authInvalid();
      const { email, expectedUid } = await resolvePrivateLogin(identifier);
      const result = await identityToolkit("signInWithPassword", {
        email,
        password,
        returnSecureToken: true,
      });
      const uid = String(result.payload?.localId || "").trim();
      if (
        result.status === 429 ||
        result.payload?.error?.message === "TOO_MANY_ATTEMPTS_TRY_LATER"
      )
        throw serviceError("TOO_MANY_REQUESTS", 429);
      if (result.status >= 500) throw serviceError("AUTH_UNAVAILABLE", 503);
      if (!result.ok || !uid || (expectedUid && uid !== expectedUid))
        throw authInvalid();
      const { auth } = initFirebaseAdmin();
      const account = await activeIdentity(auth, uid);
      if (
        validEmail(account.email) !== email ||
        (result.payload.email && validEmail(result.payload.email) !== email)
      )
        throw authInvalid();
      const customToken = await auth.createCustomToken(uid, {
        zentraLogin: true,
      });
      return res.json({ ok: true, customToken });
    } catch (error) {
      if (
        [
          "LOGIN_CREDENTIALS_INVALID",
          "AUTH_UNAVAILABLE",
          "AUTH_PROVIDER_CONFIGURATION_INVALID",
          "ORIGIN_NOT_ALLOWED",
          "TOO_MANY_REQUESTS",
        ].includes(String(error?.code || ""))
      )
        return next(error);
      return next(serviceError("AUTH_UNAVAILABLE", 503));
    }
  },
);

for (const [path, kind] of [
  ["password-reset", "password"],
  ["username-recovery", "username"],
])
  router.post(
    "/auth/" + path,
    passwordResetLimiter,
    resetAccountLimiter,
    async (req, res) => {
      if (!trustedOrigin(req))
        return res.status(403).json({ ok: false, error: "ORIGIN_NOT_ALLOWED" });
      const result = await require("../core/accountRecoveryService").request(
        kind,
        req.body,
      );
      res.status(202).json({ ok: true, ...result });
    },
  );
for (const action of ["inspect", "complete"])
  router.post("/auth/recovery/" + action, strictLimiter, async (req, res) => {
    if (!trustedOrigin(req))
      return res.status(403).json({ ok: false, error: "ORIGIN_NOT_ALLOWED" });
    const service = require("../core/accountRecoveryService");
    const result =
      action === "inspect"
        ? await service.inspect(req.body?.token)
        : await service.complete(req.body);
    res.json({ ok: true, result });
  });

router.get("/auth/check-username", strictLimiter, async (req, res, next) => {
  try {
    const result = await usernameAvailability(req.query.username);
    return res.json({ ok: true, ...result });
  } catch (error) {
    if (
      error.code === "INVALID_USERNAME" ||
      error.code === "USERNAME_RESERVED"
    ) {
      return res.json({
        ok: true,
        available: false,
        username: text(req.query.username, 20),
        code: error.code,
        message: error.message,
      });
    }
    return next(error);
  }
});

router.post(
  "/profile/update",
  requireAuth,
  strictLimiter,
  async (req, res, next) => {
    try {
      const { db } = initFirebaseAdmin();
      if (!db) throw serviceError("STORE_STORAGE_UNAVAILABLE", 503);
      const {
        normalizeProfile,
        writeInitialProfile,
      } = require("../core/registrationProfile");
      const profile = normalizeProfile(req.body);
      const user = await db.runTransaction((tx) =>
        writeInitialProfile(
          tx,
          db,
          { uid: req.user.uid, email: req.user.email },
          profile,
        ),
      );
      return res.json({ ok: true, user });
    } catch (error) {
      return next(error);
    }
  },
);

module.exports = router;
