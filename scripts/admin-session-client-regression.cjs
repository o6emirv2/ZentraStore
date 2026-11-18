"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { browserModule } = require("./helpers/browser-module.cjs");
async function scenario(callback, { firebase = true } = {}) {
  const previous = Object.fromEntries(
    ["window", "document", "fetch", "CustomEvent", "__zentraAdminImport"].map(
      (key) => [key, global[key]],
    ),
  );
  const calls = { signOut: 0, reload: 0, clear: 0, restored: [], invalid: 0 };
  const user = (uid) => ({
    uid,
    email: uid + "@zentra.invalid",
    getIdToken: async () => "signed-" + uid,
  });
  const auth = {
    currentUser: firebase ? user("new-owner") : null,
    useDeviceLanguage() {},
    authStateReady: async () => {},
  };
  let observer;
  const sdk = {
    getAuth: () => auth,
    onAuthStateChanged: (_auth, callback) => {
      observer = callback;
      callback(auth.currentUser);
      return () => {};
    },
    reload: async () => {
      calls.reload++;
    },
    signOut: async () => {
      calls.signOut++;
      auth.currentUser = null;
      observer(null);
    },
  };
  const app = { name: "zentra-store" };
  global.__zentraAdminImport = async (target) =>
    target.includes("firebase-auth.js")
      ? sdk
      : { getApps: () => [app], initializeApp: () => app };
  global.window = {
    location: {
      href: "https://store.zentra.invalid/admin/",
      origin: "https://store.zentra.invalid",
    },
    dispatchEvent: () => {
      calls.invalid++;
    },
    ZENTRA_ADMIN_BROWSER: {
      clear: async () => {
        calls.clear++;
      },
      restore: async (uid) => {
        calls.restored.push(uid);
      },
    },
  };
  global.document = {
    querySelector: () => ({ content: "https://store.zentra.invalid" }),
  };
  global.CustomEvent = class {
    constructor(type) {
      this.type = type;
    }
  };
  global.fetch = async (target) =>
    new Response(
      JSON.stringify(
        String(target).includes("runtime-config")
          ? {
              ok: true,
              firebaseReady: true,
              firebase: { projectId: "fixture" },
              clientCompatibility: { adminAction: 1 },
            }
          : {
              authenticated: true,
              user: { uid: "old-owner", email: "old-owner@zentra.invalid" },
            },
      ),
      { headers: { "content-type": "application/json" } },
    );
  try {
    await browserModule("admin/admin-auth.js", {
      "import(": "globalThis.__zentraAdminImport(",
    });
    const client = global.window.ZENTRA_ADMIN_AUTH;
    await client.init();
    return await callback({
      client,
      auth,
      calls,
      change: (uid) => {
        auth.currentUser = uid ? user(uid) : null;
        observer(auth.currentUser);
      },
    });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete global[key];
      else global[key] = value;
    }
  }
}
test("a stale first-party cookie cannot sign out the current Firebase administrator", async () =>
  scenario(async ({ client, calls }) => {
    assert.equal(client.activeSession().uid, "new-owner");
    assert.equal(await client.token(), "signed-new-owner");
    assert.equal(calls.signOut, 0);
    assert.deepEqual(calls.restored, ["new-owner"]);
  }));
test("a first-party session is a fallback when no Firebase account is present", async () =>
  scenario(
    async ({ client, calls }) => {
      assert.equal(client.activeSession().uid, "old-owner");
      assert.equal(await client.token(), "");
      assert.deepEqual(calls.restored, ["old-owner"]);
    },
    { firebase: false },
  ));
test("identity changes invalidate proofs until an explicit gate restart rebinds the current account", async () =>
  scenario(async ({ client, calls, change }) => {
    change("replacement-owner");
    assert.equal(client.activeSession(), null);
    await assert.rejects(client.token(), {
      code: "ADMIN_ACTIVE_SESSION_MISMATCH",
    });
    const restarted = await client.refreshIdentity();
    assert.equal(restarted.uid, "replacement-owner");
    assert.equal(await client.token(), "signed-replacement-owner");
    assert.equal(calls.reload, 1);
    assert(calls.clear >= 2);
    assert.equal(calls.signOut, 0);
  }));
