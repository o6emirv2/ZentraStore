"use strict";
const { test, before, beforeEach, after } = require("node:test"),
  assert = require("node:assert/strict");
const { applicationFixture } = require("./helpers/application-fixture.cjs");
const { browserModule } = require("./helpers/browser-module.cjs");
let fixture,
  registrationSequence = 0;
before(async () => {
  process.env.RESEND_API_KEY =
    "re_" + require("node:crypto").randomBytes(30).toString("base64url");
  process.env.EMAIL_NOTIFICATIONS_ENABLED = "true";
  fixture = await applicationFixture();
});
after(async () => {
  await fixture?.close();
});
beforeEach(() => {
  for (const key of fixture.db.records.keys())
    if (key.startsWith("storeSecurityRateLimits/"))
      fixture.db.records.delete(key);
});
const response = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
async function scenario(
  callback,
  source = "public/js/store/auth.js",
  setup = () => {},
) {
  const previous = {
    window: global.window,
    document: global.document,
    fetch: global.fetch,
    adapter: global.__authFixture,
  };
  const fetch = global.fetch,
    listeners = new Set(),
    faults = {},
    calls = [];
  const counts = { creates: 0, changes: 0, appCheck: 0 };
  const auth = {
    currentUser: null,
    useDeviceLanguage() {},
    authStateReady: async () => {},
  };
  function user(uid) {
    const row = fixture.users.get(uid);
    return {
      uid,
      email: row.email,
      emailVerified: row.emailVerified,
      displayName: "Fixture",
      getIdToken: async () => fixture.idToken(uid),
    };
  }
  const changed = (current) => {
    auth.currentUser = current;
    for (const listener of listeners) queueMicrotask(() => listener(current));
  };
  const changesBefore = fixture.passwordChanges;
  Object.defineProperty(counts, "changes", {
    get: () => fixture.passwordChanges - changesBefore,
  });
  const sdk = {
    getAuth: () => auth,
    browserLocalPersistence: {},
    browserSessionPersistence: {},
    inMemoryPersistence: {},
    setPersistence: async (_auth, persistence) => {
      if (faults.persistence && persistence !== sdk.inMemoryPersistence)
        throw new Error("storage unavailable");
    },
    onAuthStateChanged: (_auth, callback) => {
      listeners.add(callback);
      queueMicrotask(() => callback(auth.currentUser));
      return () => listeners.delete(callback);
    },
    signInWithCustomToken: async (_auth, token) => {
      const current = user(fixture.exchangeCustomToken(token).uid);
      changed(current);
      return { user: current };
    },
    signOut: async () => {
      if (faults.signOut) throw new Error("storage signout failed");
      changed(null);
    },
    EmailAuthProvider: {
      credential: (email, password) => ({ email, password }),
    },
    reauthenticateWithCredential: async (current, credential) => {
      if (fixture.users.get(current.uid).password !== credential.password)
        throw Object.assign(new Error("wrong password"), {
          code: "auth/invalid-credential",
        });
      return { user: current };
    },
    validatePassword: async () => {
      if (faults.policy)
        throw Object.assign(new Error("policy unavailable"), {
          code: "auth/network-request-failed",
        });
      return { isValid: true };
    },
    updatePassword: async () => {
      throw new Error(
        "password changes must use the authenticated server flow",
      );
    },
    sendEmailVerification: async () => {
      counts.verifications = (counts.verifications || 0) + 1;
    },
    reload: async (current) => Object.assign(current, user(current.uid)),
    updateProfile: async (current, input) => Object.assign(current, input),
    verifyBeforeUpdateEmail: async (current, email) => {
      faults.pendingEmail = email;
    },
    createUserWithEmailAndPassword: async (_auth, email, password) => {
      counts.creates++;
      const uid = "reg" + String(++registrationSequence).padStart(6, "0");
      fixture.users.set(uid, {
        uid,
        email,
        emailVerified: false,
        disabled: false,
        generation: 0,
        password,
      });
      const current = user(uid);
      changed(current);
      return { user: current };
    },
  };
  const app = { name: "zentra-store" },
    appSdk = { getApps: () => [app], initializeApp: () => app };
  const appCheckSdk = {
    ReCaptchaEnterpriseProvider: class {},
    initializeAppCheck: () => {
      counts.appCheck++;
      return {};
    },
    getToken: async () => ({ token: "fixture-appcheck" }),
  };
  global.__authFixture = { appSdk, sdk, appCheckSdk };
  global.window = {
    location: {
      origin: fixture.origin,
      href: fixture.origin + "/",
      protocol: "http:",
    },
    crypto: global.crypto,
    dispatchEvent() {},
    setTimeout,
    clearTimeout,
  };
  global.document = {
    cookie: "",
    querySelector: () => ({ content: fixture.origin }),
  };
  global.fetch = async (url, options = {}) => {
    if (String(url) === "https://api.resend.com/emails") {
      counts.verificationEmails = (counts.verificationEmails || 0) + 1;
      const message = JSON.parse(options.body);
      counts.lastCode = /kodun: (\d{6})/.exec(message.text)[1];
      return response({ id: require("node:crypto").randomUUID() });
    }
    if (!String(url).startsWith(fixture.origin)) return fetch(url, options);
    const path = new URL(url).pathname,
      method = options.method || "GET";
    calls.push({ path, method });
    if (path === "/api/auth/session" && method === "POST" && faults.session)
      return response({ ok: false, error: "AUTH_UNAVAILABLE" }, 503);
    if (path === "/api/auth/logout" && faults.logout)
      throw new TypeError("controlled logout outage");
    if (path === "/api/profile/update" && faults.profile)
      return response({ ok: false, error: "STORE_STORAGE_UNAVAILABLE" }, 503);
    if (path === "/api/auth/email-verification/start" && faults.profile)
      return response({ ok: false, error: "STORE_STORAGE_UNAVAILABLE" }, 503);
    if (
      path === "/api/auth/email-verification/verify" &&
      faults.forgedVerification
    )
      return response({ ok: true, ready: true, completed: true });
    if (path === "/api/store/account" && faults.account)
      return response({ ok: false, error: "STORE_STORAGE_UNAVAILABLE" }, 503);
    const headers = new Headers(options.headers);
    headers.set("Origin", fixture.origin);
    const result = await fetch(url, { ...options, headers });
    if (
      path === "/api/auth/email-verification/verify" &&
      faults.verificationLost
    )
      throw new TypeError("controlled verification reply loss");
    if (path === "/api/store/profile/password" && faults.passwordLost)
      throw new TypeError(
        "controlled response loss after real server mutation",
      );
    if (path === "/api/public/runtime-config" && faults.noAppCheck) {
      const body = await result.json();
      body.appCheck = { mode: "monitor", siteKey: "" };
      return response(body);
    }
    if (path === "/api/store/account" && faults.holdAccount) {
      const holding = faults.holdAccount;
      delete faults.holdAccount;
      const body = await result.json();
      return new Promise((resolve) => holding(() => resolve(response(body))));
    }
    if (path === "/api/store/account" && faults.wrongAccount) {
      const body = await result.json();
      body.account.uid = "other-user";
      return response(body);
    }
    return result;
  };
  const replacements = {
    "import(FIREBASE_APP_URL)":
      "Promise.resolve(globalThis.__authFixture.appSdk)",
    "import(FIREBASE_AUTH_URL)":
      "Promise.resolve(globalThis.__authFixture.sdk)",
    "import(FIREBASE_APP_CHECK_URL)":
      "Promise.resolve(globalThis.__authFixture.appCheckSdk)",
    "const INITIALIZATION_TIMEOUT_MS = 45000;":
      "const INITIALIZATION_TIMEOUT_MS = 15;",
  };
  setup({ faults, auth, sdk, user, adapter: global.__authFixture });
  replacements["const INITIALIZATION_TIMEOUT_MS = 45000;"] =
    `const INITIALIZATION_TIMEOUT_MS = ${faults.shortStartup ? 15 : 15000};`;
  try {
    const module = await browserModule(source, replacements);
    await module.initStoreAuth();
    return await callback({
      module,
      faults,
      calls,
      counts,
      auth,
      sdk,
      user,
      changed,
    });
  } finally {
    global.window = previous.window;
    global.document = previous.document;
    global.fetch = previous.fetch;
    global.__authFixture = previous.adapter;
  }
}
const login = (module) =>
  module.signInStore({
    identifier: "emirhan",
    password: fixture.users.get("member").password,
    remember: true,
  });
const passwordInput = () => ({
  currentPassword: fixture.users.get("member").password,
  newPassword: "Changed password " + Date.now() + "!",
  newPasswordRepeat: "Changed password " + Date.now() + "!",
});

test("full client module signs in through actual private login and account routes", async () =>
  scenario(async ({ module }) => {
    await login(module);
    assert.equal(module.getStoreAuthSnapshot().user.uid, "member");
    assert.equal(module.getStoreAuthSnapshot().account.uid, "member");
  }));
test("email verification is sent only for the signed-in unverified account", async () =>
  scenario(async ({ module, counts }) => {
    await login(module);
    const row = fixture.users.get("member");
    row.emailVerified = false;
    try {
      assert.equal((await module.sendStoreVerificationEmail()).accepted, true);
      assert.equal(counts.verificationEmails, 1);
      assert.equal(module.getStoreAuthSnapshot().user, null);
      row.emailVerified = true;
      assert.equal(
        (await module.sendStoreVerificationEmail()).alreadyVerified,
        true,
      );
      assert.equal(counts.verificationEmails, 1);
    } finally {
      row.emailVerified = true;
    }
  }));
test("supplementary cookie failure cannot turn a verified login into wrong credentials", async () =>
  scenario(async ({ module, faults }) => {
    faults.session = true;
    await login(module);
    assert.equal(module.getStoreAuthSnapshot().user.uid, "member");
    assert(module.getStoreAuthSnapshot().warning);
  }));
test("blocked persistence falls back to a declared memory session", async () =>
  scenario(async ({ module, faults }) => {
    faults.persistence = true;
    await login(module);
    assert.equal(module.getStoreAuthSnapshot().user.uid, "member");
    assert.match(module.getStoreAuthSnapshot().warning, /sekmede/);
  }));
test("a committed password stays successful when subsequent session renewal fails", async () =>
  scenario(async ({ module, faults, counts }) => {
    await login(module);
    faults.session = true;
    const input = passwordInput();
    input.newPasswordRepeat = input.newPassword;
    const result = await module.changeStorePassword(input);
    assert.equal(result.changed, true);
    assert(result.warning);
    assert.equal(counts.changes, 1);
  }));
test("policy service failure cannot silently bypass password validation", async () =>
  scenario(async ({ module, faults, counts }) => {
    await login(module);
    faults.policy = true;
    const input = passwordInput();
    input.newPasswordRepeat = input.newPassword;
    await assert.rejects(module.changeStorePassword(input));
    assert.equal(counts.changes, 0);
  }));
test("a lost password reply is uncertain and never starts a second provider write", async () =>
  scenario(async ({ module, faults, counts }) => {
    await login(module);
    faults.passwordLost = true;
    const input = passwordInput();
    input.newPasswordRepeat = input.newPassword;
    await assert.rejects(module.changeStorePassword(input), {
      code: "PASSWORD_CHANGE_UNCERTAIN",
    });
    assert.equal(counts.changes, 1);
  }));
test("parallel account reads share one request", async () =>
  scenario(async ({ module, calls }) => {
    await login(module);
    const before = calls.filter(
      (row) => row.path === "/api/store/account",
    ).length;
    await Promise.all(
      Array.from({ length: 5 }, () => module.refreshStoreAccount()),
    );
    assert.equal(
      calls.filter((row) => row.path === "/api/store/account").length - before,
      1,
    );
  }));
test("a late account response cannot overwrite a forced fresh balance", async () =>
  scenario(async ({ module, faults }) => {
    await login(module);
    let release, started;
    const waiting = new Promise((resolve) => {
      started = resolve;
    });
    faults.holdAccount = (done) => {
      release = done;
      started();
    };
    const old = module.refreshStoreAccount();
    await waiting;
    const row = fixture.db.records.get("users/member"),
      prior = row.storeBalanceKurus;
    try {
      row.storeBalanceKurus = 32000;
      await module.refreshStoreAccount({ force: true });
      release();
      await old;
      assert.equal(module.getStoreAuthSnapshot().account.balanceKurus, 32000);
    } finally {
      release();
      row.storeBalanceKurus = prior;
    }
  }));
test("a failed refresh preserves known funds with an explicit stale state", async () =>
  scenario(async ({ module, faults }) => {
    await login(module);
    const balance = module.getStoreAuthSnapshot().account.balanceKurus;
    faults.account = true;
    await assert.rejects(module.refreshStoreAccount());
    assert.equal(module.getStoreAuthSnapshot().account.balanceKurus, balance);
    assert.equal(module.getStoreAuthSnapshot().accountStale, true);
    faults.account = false;
    await module.refreshStoreAccount();
    assert.equal(module.getStoreAuthSnapshot().accountStale, false);
  }));
test("a provider identity switch clears the previous visible account before a new session read completes", async () =>
  scenario(async ({ module, faults, changed, user }) => {
    await login(module);
    let release, started;
    const waiting = new Promise((resolve) => {
      started = resolve;
    });
    faults.holdAccount = (done) => {
      release = done;
      started();
    };
    const old = module.refreshStoreAccount();
    await waiting;
    changed(user("finance"));
    await Promise.resolve();
    assert.equal(module.getStoreAuthSnapshot().user, null);
    assert.equal(module.getStoreAuthSnapshot().account, null);
    release();
    await old;
    const deadline = Date.now() + 2000;
    while (!module.getStoreAuthSnapshot().ready && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(module.getStoreAuthSnapshot().account.uid, "finance");
  }));
test("wrong-owner account responses clear private state", async () =>
  scenario(async ({ module, faults }) => {
    await login(module);
    faults.wrongAccount = true;
    await assert.rejects(module.refreshStoreAccount(), {
      code: "AUTH_ACCOUNT_MISMATCH",
    });
    assert.equal(module.getStoreAuthSnapshot().account, null);
    assert.equal(module.getStoreAuthSnapshot().user, null);
  }));
test("logout reports missing server revocation and never retains private data", async () =>
  scenario(async ({ module, faults }) => {
    await login(module);
    faults.logout = true;
    const result = await module.logoutStore();
    assert.equal(result.serverRevoked, false);
    assert(result.warning);
    assert.equal(module.getStoreAuthSnapshot().user, null);
  }));
test("a failed SDK signout cannot restore the cleared account", async () =>
  scenario(async ({ module, faults }) => {
    await login(module);
    faults.signOut = true;
    await assert.rejects(module.logoutStore());
    assert.equal(module.getStoreAuthSnapshot().user, null);
    assert.equal(module.getStoreAuthSnapshot().account, null);
  }));
test("simultaneous auth actions are locked before another request is sent", async () =>
  scenario(async ({ module }) => {
    const first = login(module);
    await assert.rejects(login(module), { code: "AUTH_OPERATION_PENDING" });
    await first;
  }));
test("retrying a partially created registration does not create a second provider account", async () =>
  scenario(async ({ module, faults, counts }) => {
    const input = {
      firstName: "Çağrı",
      lastName: "Öztürk",
      username: "NewMember" + registrationSequence,
      email: `new${registrationSequence}@zentra.invalid`,
      birthDate: "2000-02-29",
      password: "Registration password 2026!",
      passwordRepeat: "Registration password 2026!",
    };
    faults.profile = true;
    await assert.rejects(module.registerStore(input));
    assert.equal(module.getStoreAuthSnapshot().user, null);
    faults.profile = false;
    await module.registerStore(input);
    assert.equal(counts.creates, 1);
    assert.equal(module.getStoreAuthSnapshot().user, null);
    await module.verifyStoreEmailCode(counts.lastCode);
    assert(module.getStoreAuthSnapshot().user);
    assert.equal(
      module.getStoreAuthSnapshot().account.profileInitializationPending,
      false,
    );
  }));
module.exports = { scenario };
test("switching a failed registration to another email leaves the first provider account intact", async () =>
  scenario(async ({ module, faults, counts }) => {
    const input = {
      firstName: "Yeni",
      lastName: "Üye",
      username: "AnotherNewMember",
      email: "switch-first@zentra.invalid",
      birthDate: "2000-01-01",
      password: fixture.password,
      passwordRepeat: fixture.password,
    };
    faults.profile = true;
    await assert.rejects(module.registerStore(input));
    faults.profile = false;
    await module.registerStore({
      ...input,
      email: "switch-second@zentra.invalid",
    });
    assert.equal(counts.creates, 2);
    assert(
      [...fixture.users.values()].some((row) => row.email === input.email),
    );
    assert.equal(module.getStoreAuthSnapshot().user, null);
    await module.verifyStoreEmailCode(counts.lastCode);
    assert.equal(
      module.getStoreAuthSnapshot().user.email,
      "switch-second@zentra.invalid",
    );
  }));
test("startup has a deadline and a retry reuses App Check instead of initializing twice", async () =>
  scenario(
    async ({ module, auth, counts }) => {
      assert.equal(module.getStoreAuthSnapshot().available, false);
      assert.equal(module.getStoreAuthSnapshot().ready, true);
      auth.authStateReady = async () => {};
      await module.initStoreAuth();
      assert.equal(module.getStoreAuthSnapshot().available, true);
      assert.equal(counts.appCheck, 1);
    },
    "public/js/store/auth.js",
    ({ auth, faults }) => {
      faults.shortStartup = true;
      auth.authStateReady = () => new Promise(() => {});
    },
  ));
test("an absent optional App Check configuration never imports its failing provider module", async () =>
  scenario(
    async ({ module, counts }) => {
      assert.equal(module.getStoreAuthSnapshot().available, true);
      assert.equal(counts.appCheck, 0);
    },
    "public/js/store/auth.js",
    ({ faults, adapter }) => {
      faults.noAppCheck = true;
      Object.defineProperty(adapter, "appCheckSdk", {
        get() {
          throw new Error("optional module must not load");
        },
      });
    },
  ));
test("a pending provider account after reload can complete registration without another account", async () =>
  scenario(
    async ({ module, counts }) => {
      assert.equal(module.getStoreAuthSnapshot().user, null);
      await module.registerStore({
        firstName: "Çağrı",
        lastName: "Öztürk",
        username: "RecoveredMember",
        email: "recover@zentra.invalid",
        birthDate: "2000-02-29",
        password: fixture.password,
        passwordRepeat: fixture.password,
      });
      assert.equal(counts.creates, 0);
      assert.equal(module.getStoreAuthSnapshot().user, null);
      await module.verifyStoreEmailCode(counts.lastCode);
      assert.equal(module.getStoreAuthSnapshot().user.uid, "recover001");
    },
    "public/js/store/auth.js",
    ({ auth, user }) => {
      fixture.users.set("recover001", {
        uid: "recover001",
        email: "recover@zentra.invalid",
        emailVerified: false,
        disabled: false,
        generation: 0,
        password: fixture.password,
      });
      auth.currentUser = user("recover001");
    },
  ));

const verificationInput = () => ({
  firstName: "Emir",
  lastName: "Yılmaz",
  username: "VerifyMember" + registrationSequence,
  email: `flow${registrationSequence}@zentra.invalid`,
  birthDate: "2000-01-01",
  password: fixture.password,
  passwordRepeat: fixture.password,
});
test("registration never exposes an active customer before the server accepts the code and Firebase reload confirms it", async () =>
  scenario(async ({ module, counts }) => {
    const input = verificationInput();
    const pending = await module.registerStore(input);
    assert.equal(pending.user, null);
    assert.equal(pending.account, null);
    assert.equal(pending.verificationRequired, true);
    const wrong = String((Number(counts.lastCode) + 1) % 1000000).padStart(
      6,
      "0",
    );
    await assert.rejects(module.verifyStoreEmailCode(wrong), {
      code: "EMAIL_VERIFICATION_INCORRECT",
    });
    assert.equal(module.getStoreAuthSnapshot().user, null);
    assert.equal(
      module.getStoreAuthSnapshot().verification.remainingAttempts,
      4,
    );
    await module.verifyStoreEmailCode(counts.lastCode);
    assert.equal(module.getStoreAuthSnapshot().user.emailVerified, true);
    assert.equal(
      module.getStoreAuthSnapshot().account.username,
      input.username,
    );
  }));
test("a lost verification reply recovers by reading status without another code redemption or account creation", async () =>
  scenario(async ({ module, faults, counts, calls }) => {
    await module.registerStore(verificationInput());
    faults.verificationLost = true;
    await assert.rejects(module.verifyStoreEmailCode(counts.lastCode), {
      code: "NETWORK_ERROR",
    });
    assert.equal(module.getStoreAuthSnapshot().user, null);
    assert.equal(module.getStoreAuthSnapshot().verification.canComplete, true);
    faults.verificationLost = false;
    const result = await module.refreshStoreVerification();
    assert.equal(result.user.emailVerified, true);
    assert.equal(
      calls.filter((row) => row.path.endsWith("/email-verification/verify"))
        .length,
      1,
    );
    assert.equal(counts.creates, 1);
    assert.equal(counts.verificationEmails, 1);
  }));
test("a forged completed response cannot show registration success while Firebase remains unverified", async () =>
  scenario(async ({ module, faults, counts }) => {
    await module.registerStore(verificationInput());
    faults.forgedVerification = true;
    await assert.rejects(module.verifyStoreEmailCode(counts.lastCode), {
      code: "EMAIL_VERIFICATION_ACTIVATION_UNCERTAIN",
    });
    assert.equal(module.getStoreAuthSnapshot().user, null);
    assert.equal(module.getStoreAuthSnapshot().account, null);
    faults.forgedVerification = false;
    await module.verifyStoreEmailCode(counts.lastCode);
    assert.equal(module.getStoreAuthSnapshot().user.emailVerified, true);
  }));
test("a refresh restores the server-held pending challenge and the send cooldown cannot be bypassed through the client", async () =>
  scenario(async ({ module, auth, counts }) => {
    await module.registerStore(verificationInput());
    const id = module.getStoreAuthSnapshot().verification.challengeId;
    await assert.rejects(module.resendStoreEmailCode(), {
      code: "EMAIL_VERIFICATION_RESEND_WAIT",
    });
    assert.equal(counts.verificationEmails, 1);
    const restored = await browserModule("public/js/store/auth.js", {
      "import(FIREBASE_APP_URL)":
        "Promise.resolve(globalThis.__authFixture.appSdk)",
      "import(FIREBASE_AUTH_URL)":
        "Promise.resolve(globalThis.__authFixture.sdk)",
      "import(FIREBASE_APP_CHECK_URL)":
        "Promise.resolve(globalThis.__authFixture.appCheckSdk)",
    });
    await restored.initStoreAuth();
    assert.equal(restored.getStoreAuthSnapshot().user, null);
    assert.equal(restored.getStoreAuthSnapshot().verification.challengeId, id);
    assert(auth.currentUser);
    await restored.verifyStoreEmailCode(counts.lastCode);
    assert.equal(restored.getStoreAuthSnapshot().user.emailVerified, true);
  }));
