'use strict';

window.ZENTRA_ADMIN_AUTH = (() => {
  const FIREBASE_VERSION = '12.17.1';
  const STOREFRONT_APP_NAME = 'zentra-store';
  let auth = null;
  let sdk = null;
  let appSdk = null;
  let user = null;
  let initialization = null;
  let runtime = null;
  let appCheck = null;
  let appCheckSdk = null;
  let authStateUnsubscribe = null;
  let transportBase = null;
  let serverSession = null;
  let actionPassword = null;
  let boundIdentity = null;
  let sessionInvalid = false;
  function invalidateSession() {
    sessionInvalid = true; clearActionPassword();
    window.dispatchEvent(new CustomEvent('zentra:admin-session-invalid', { detail: { code: 'ADMIN_ACTIVE_SESSION_MISMATCH' } }));
  }
  function observeIdentity(current) {
    const previousUid = String(user?.uid || '');
    user = current || null;
    if (actionPassword && (actionPassword.uid !== user?.uid || actionPassword.email !== user?.email)) clearActionPassword();
    if (boundIdentity && ((user?.uid && (user.uid !== boundIdentity.uid || String(user.email || '').trim().toLowerCase() !== boundIdentity.email)) || (!user && previousUid))) invalidateSession();
  }
  function clearActionPassword() { actionPassword = null; }
  function consumeActionPassword() {
    const approval = actionPassword; clearActionPassword();
    const current = activeSession();
    return approval && approval.expiresAt > Date.now() && approval.uid === current?.uid && approval.email === current?.email ? approval.value : '';
  }

  function normalizeBase(value = '') {
    return String(value || '').trim().replace(/\/+$/, '').replace(/\/api$/i, '');
  }

  function fallbackBase() {
    return normalizeBase(document.querySelector('meta[name="zentra-api-origin"]')?.content || 'https://emirhan-siye.onrender.com');
  }

  function apiUrl(path = '') {
    const raw = String(path || '');
    if (/^https?:\/\//i.test(raw)) return raw;
    const base = transportBase !== null ? transportBase : normalizeBase(runtime?.apiBase || fallbackBase());
    return `${base}${raw.startsWith('/') ? raw : `/${raw}`}`;
  }

  async function loadRuntime() {
    if (runtime?.firebaseReady) return runtime;
    const preferred = fallbackBase();
    const bases = [...new Set(['', preferred].filter((base, index) => index === 0 || base))];
    for (const base of bases) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), base ? 6500 : 3200);
      try {
        const response = await fetch(`${base}/api/public/runtime-config`, {
          headers: { Accept: 'application/json', 'X-Zentra-Store-Client': 'secure-admin-bootstrap-v77' },
          credentials: 'include', cache: 'no-store', signal: controller.signal
        });
        const type = String(response.headers.get('content-type') || '');
        const payload = type.includes('application/json') ? await response.json().catch(() => null) : null;
        if (response.ok && payload?.ok === true) {
          if (payload.version !== 77 && payload.clientCompatibility?.adminAction !== 1) throw new Error('CLIENT_VERSION_MISMATCH');
          transportBase = normalizeBase(base);
          runtime = { ...payload, apiBase: normalizeBase(base || window.location.origin) };
          window.__ZENTRA_RUNTIME__ = runtime;
          return runtime;
        }
      } catch (error) {
        if (error?.message === 'CLIENT_VERSION_MISMATCH') throw error;
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error('ADMIN_RUNTIME_UNAVAILABLE');
  }

  function friendly(error) {
    const code = String(error?.code || error?.message || error || '');
    if (code === 'CLIENT_VERSION_MISMATCH') return 'Mağaza ve sunucu sürümleri eşleşmiyor. Güncel paketin birlikte yayınlandığını kontrol edin.';
    if (/invalid-credential|wrong-password|user-not-found/i.test(code)) return 'Hesap şifresi doğrulanamadı.';
    if (/too-many-requests/i.test(code)) return 'Çok fazla deneme yapıldı. Lütfen kısa bir süre bekleyip yeniden deneyin.';
    if (/network|failed to fetch|load failed/i.test(code)) return 'Güvenli giriş hizmetine ulaşılamadı. Bağlantınızı kontrol edin.';
    if (/configuration|firebase/i.test(code)) return 'Güvenli giriş hizmeti kullanıma hazır değil.';
    return 'Yönetici hesabı doğrulanamadı.';
  }

  function resolveApp(config, name) {
    return appSdk.getApps().find((app) => app.name === name) || appSdk.initializeApp(config, name);
  }

  async function waitForAuthState(targetAuth, assign, onSubscribe) {
    if (typeof targetAuth?.authStateReady === 'function') {
      await targetAuth.authStateReady();
      assign(targetAuth.currentUser || null);
    } else {
      await new Promise((resolve) => {
        let settled = false;
        const stop = sdk.onAuthStateChanged(targetAuth, (current) => {
          assign(current || null);
          if (!settled) {
            settled = true;
            stop();
            resolve();
          }
        }, () => {
          assign(null);
          if (!settled) {
            settled = true;
            resolve();
          }
        });
      });
    }
    onSubscribe();
  }

  async function restoreFirstPartySession() {
    const endpoint = new URL(apiUrl('/api/auth/session'), window.location.href);
    if (endpoint.origin !== window.location.origin) return null;
    const headers = new Headers({ Accept: 'application/json' });
    if (appCheck && appCheckSdk) {
      try {
        const verified = await appCheckSdk.getToken(appCheck, false);
        if (verified?.token) headers.set('X-Firebase-AppCheck', verified.token);
      } catch (_) {}
    }
    const response = await fetch(endpoint.href, {
      method: 'GET',
      headers,
      credentials: 'include',
      cache: 'no-store'
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.authenticated !== true || !payload?.user?.uid || !payload?.user?.email) {
      return null;
    }
    return {
      uid: String(payload.user.uid).trim(),
      email: String(payload.user.email).trim().toLowerCase()
    };
  }

  async function init() {
    if (initialization) return initialization;
    const pending = (async () => {
      const resolvedRuntime = await loadRuntime();
      if (!resolvedRuntime.firebaseReady) throw new Error('FIREBASE_CONFIGURATION_MISSING');
      const modules = await Promise.all([
        import(`https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-app.js`),
        import(`https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-auth.js`)
      ]);
      [appSdk, sdk] = modules;

      const storefrontApp = resolveApp(resolvedRuntime.firebase, STOREFRONT_APP_NAME);
      const siteKey = String(resolvedRuntime?.appCheck?.siteKey || '').trim();
      if (siteKey) {
        try {
          appCheckSdk = await import(`https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-app-check.js`);
          appCheck = appCheckSdk.initializeAppCheck(storefrontApp, {
            provider: new appCheckSdk.ReCaptchaEnterpriseProvider(siteKey),
            isTokenAutoRefreshEnabled: true
          });
        } catch (error) {
          appCheck = null;
          if (resolvedRuntime.appCheck?.mode === 'enforce') throw error;
        }
      } else if (resolvedRuntime.appCheck?.mode === 'enforce') {
        throw new Error('APP_CHECK_UNAVAILABLE');
      }

      auth = sdk.getAuth(storefrontApp);
      auth.useDeviceLanguage();
      await waitForAuthState(auth, (current) => { user = current; }, () => {
        if (!authStateUnsubscribe) {
          authStateUnsubscribe = sdk.onAuthStateChanged(auth, observeIdentity, () => { user = null; invalidateSession(); });
        }
      });
      const restored = await restoreFirstPartySession().catch(() => null);
      if (restored?.uid) {
        serverSession = restored;
        const currentUid = String(user?.uid || '').trim();
        const currentEmail = String(user?.email || '').trim().toLowerCase();
        if (currentUid && (currentUid !== restored.uid || currentEmail !== restored.email)) {
          await sdk.signOut(auth).catch(() => null);
          user = null;
        }
      }
      boundIdentity = activeSession();
      return { auth, user, session: boundIdentity };
    })();
    initialization = pending;
    try {
      return await pending;
    } catch (error) {
      if (initialization === pending) initialization = null;
      throw error;
    }
  }

  async function reauthenticate(password = '') {
    clearActionPassword();
    await init();
    let current = auth?.currentUser || user;
    const expected = activeSession();
    const email = String(current?.email || expected?.email || '').trim().toLowerCase();
    const value = String(password || '');
    if ((!current?.uid && !expected?.uid) || !email || !value) {
      const error = new Error('Hesap şifresi gerekli.');
      error.code = 'ADMIN_REAUTH_REQUIRED';
      throw error;
    }
    try {
      let result;
      if (current?.uid) {
        const credential = sdk.EmailAuthProvider.credential(email, value);
        result = await sdk.reauthenticateWithCredential(current, credential);
      } else {
        if (sdk.browserSessionPersistence && typeof sdk.setPersistence === 'function') {
          await sdk.setPersistence(auth, sdk.browserSessionPersistence);
        }
        result = await sdk.signInWithEmailAndPassword(auth, email, value);
      }
      user = result.user || current;
      const verifiedUid = String(user?.uid || '').trim();
      const verifiedEmail = String(user?.email || '').trim().toLowerCase();
      if (!verifiedUid || verifiedUid !== String(expected?.uid || verifiedUid)
        || verifiedEmail !== String(expected?.email || verifiedEmail).trim().toLowerCase()) {
        await sdk.signOut(auth).catch(() => null);
        user = null;
        const mismatch = new Error('Yönetici hesap oturumu eşleşmedi.');
        mismatch.code = 'ADMIN_ACTIVE_SESSION_MISMATCH';
        throw mismatch;
      }
      await user.getIdToken(true);
      serverSession = { uid: verifiedUid, email: verifiedEmail };
      actionPassword = { uid: verifiedUid, email: verifiedEmail, value, expiresAt: Date.now() + 60_000 };
      return { ...serverSession, reauthenticatedAt: Date.now() };
    } catch (error) {
      const output = new Error(friendly(error));
      output.code = /invalid-credential|wrong-password/i.test(String(error?.code || '')) ? 'ADMIN_REAUTH_INVALID' : (error?.code || 'ADMIN_REAUTH_FAILED');
      throw output;
    }
  }

  async function token(force = false) {
    await init();
    if (sessionInvalid) throw Object.assign(new Error('Yönetici oturumu değişti.'), { code: 'ADMIN_ACTIVE_SESSION_MISMATCH' });
    if (user?.getIdToken) return user.getIdToken(force);
    return '';
  }

  async function appCheckToken(force = false) {
    await init();
    if (!appCheck || !appCheckSdk) return '';
    return (await appCheckSdk.getToken(appCheck, force)).token || '';
  }

  function activeSession() {
    if (sessionInvalid) return null;
    const current = user?.uid ? user : serverSession;
    if (!current?.uid) return null;
    return {
      uid: String(current.uid || ''),
      email: String(current.email || '').trim().toLowerCase()
    };
  }

  function canonicalOrigin() {
    return normalizeBase(runtime?.canonicalOrigin || runtime?.publicBaseUrl || window.location.origin) || window.location.origin;
  }

  return {
    init,
    reauthenticate,
    consumeActionPassword,
    clearActionPassword,
    token,
    appCheckToken,
    apiUrl,
    loadRuntime,
    currentUser: () => user,
    activeSession,
    canonicalOrigin,
    friendly
  };
})();
