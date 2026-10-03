import { friendlyStoreError, loadStoreRuntimeConfig, setStoreAppCheckTokenProvider, setStoreTokenProvider, storeApi } from './api.js?v=audit-20260908-v1';

const FIREBASE_VERSION = '12.17.1';
const FIREBASE_APP_URL = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-app.js`;
const FIREBASE_AUTH_URL = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-auth.js`;
const FIREBASE_APP_CHECK_URL = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-app-check.js`;
const REMEMBER_COOKIE = 'shelby_store_remember';
const subscribers = new Set();
let initPromise = null;
let pendingRegistration = null;

const state = {
  ready: false,
  available: true,
  busy: false,
  user: null,
  account: null,
  auth: null,
  sdk: null,
  error: ''
};

function snapshot() {
  return {
    ready: state.ready,
    available: state.available,
    busy: state.busy,
    user: state.user ? {
      uid: state.user.uid,
      email: state.user.email || '',
      displayName: state.user.displayName || ''
    } : null,
    account: state.account ? { ...state.account } : null,
    error: state.error
  };
}

function emit() {
  const value = snapshot();
  subscribers.forEach((subscriber) => {
    try { subscriber(value); } catch (_) {}
  });
}

function setBusy(value) {
  state.busy = !!value;
  emit();
}

function rememberPreference() {
  return document.cookie.split(';').some((part) => part.trim() === `${REMEMBER_COOKIE}=1`);
}

function writeRememberPreference(remember) {
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = remember
    ? `${REMEMBER_COOKIE}=1; Path=/; Max-Age=1209600; SameSite=Lax${secure}`
    : `${REMEMBER_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
}

async function syncServerSession(user, remember = rememberPreference()) {
  if (!user) return false;
  const idToken = await user.getIdToken(true);
  await storeApi('/api/auth/session', {
    method: 'POST',
    auth: false,
    body: { idToken, remember: !!remember }
  });
  return true;
}

export async function refreshStoreAccount() {
  if (!state.user) {
    state.account = null;
    emit();
    return null;
  }
  const requestedUserId = String(state.user.uid || '');
  const payload = await storeApi('/api/store/account');
  if (String(state.user?.uid || '') !== requestedUserId) return null;
  state.account = payload.account || null;
  emit();
  return state.account;
}

async function restoreAuthenticatedState(user) {
  state.user = user || null;
  state.account = null;
  setStoreTokenProvider(user ? () => user.getIdToken() : null);
  if (!user) {
    state.ready = true;
    state.error = '';
    emit();
    return;
  }
  try {
    const session = await storeApi('/api/auth/session', { auth: false, timeoutMs: 4500 });
    if (session?.authenticated !== true) await syncServerSession(user);
  } catch (_) {
    await syncServerSession(user).catch(() => null);
  }
  try {
    await refreshStoreAccount();
    state.error = '';
  } catch (error) {
    state.error = friendlyStoreError(error);
  }
  state.ready = true;
  emit();
}

export function subscribeStoreAuth(subscriber) {
  if (typeof subscriber !== 'function') return () => {};
  subscribers.add(subscriber);
  subscriber(snapshot());
  return () => subscribers.delete(subscriber);
}

export function getStoreAuthSnapshot() {
  return snapshot();
}

export async function initStoreAuth() {
  if (state.sdk && state.auth) return snapshot();
  if (initPromise) return initPromise;
  state.ready = false;
  state.available = true;
  state.error = '';
  emit();
  initPromise = (async () => {
    try {
      const [runtime, appSdk, authSdk, appCheckSdk] = await Promise.all([
        loadStoreRuntimeConfig(),
        import(FIREBASE_APP_URL),
        import(FIREBASE_AUTH_URL),
        import(FIREBASE_APP_CHECK_URL)
      ]);
      const firebaseConfig = runtime?.firebase;
      if (!runtime?.firebaseReady || !firebaseConfig?.apiKey || !firebaseConfig?.authDomain || !firebaseConfig?.projectId || !firebaseConfig?.appId) {
        const error = new Error('Hesap yapılandırması tamamlanmamış.');
        error.code = 'AUTH_UNAVAILABLE';
        throw error;
      }
      window.__SHELBY_RUNTIME__ = Object.assign(window.__SHELBY_RUNTIME__ || {}, runtime, { apiBase: runtime.apiBase || '', firebase: firebaseConfig });
      const existing = appSdk.getApps().find((app) => app.name === 'shelby-store');
      const app = existing || appSdk.initializeApp(firebaseConfig, 'shelby-store');
      const appCheckSiteKey = String(runtime?.appCheck?.siteKey || '').trim();
      if (appCheckSiteKey) {
        try {
          const appCheck = appCheckSdk.initializeAppCheck(app, {
            provider: new appCheckSdk.ReCaptchaEnterpriseProvider(appCheckSiteKey),
            isTokenAutoRefreshEnabled: true
          });
          setStoreAppCheckTokenProvider(async () => (await appCheckSdk.getToken(appCheck, false)).token || '');
        } catch (_) {
          setStoreAppCheckTokenProvider(null);
        }
      }
      const auth = authSdk.getAuth(app);
      auth.useDeviceLanguage();
      state.auth = auth;
      state.sdk = authSdk;
      state.available = true;
      if (typeof auth.authStateReady === 'function') {
        await auth.authStateReady();
      } else {
        await new Promise((resolve) => {
          let stop = null;
          const finish = () => { resolve(); queueMicrotask(() => stop?.()); };
          stop = authSdk.onAuthStateChanged(auth, finish, finish);
        });
      }
      await restoreAuthenticatedState(auth.currentUser || null);
      let skipInitialUid = String(auth.currentUser?.uid || '');
      authSdk.onAuthStateChanged(auth, (user) => {
        if (state.ready && String(user?.uid || '') === skipInitialUid) {
          skipInitialUid = '';
          return;
        }
        skipInitialUid = '';
        if (state.busy && user) {
          state.user = user;
          setStoreTokenProvider(() => user.getIdToken());
          state.ready = true;
          state.error = '';
          emit();
          return;
        }
        restoreAuthenticatedState(user).catch((error) => {
          state.ready = true;
          state.error = friendlyStoreError(error);
          emit();
        });
      });
    } catch (error) {
      state.available = false;
      state.ready = true;
      state.error = friendlyStoreError(error, 'Hesap hizmeti şu anda başlatılamadı. Lütfen sayfayı yenile.');
      emit();
    }
    return snapshot();
  })().finally(() => {
    initPromise = null;
  });
  return initPromise;
}

function personNameValid(value = '') {
  const raw = String(value || '').trim().replace(/\s+/g, ' ');
  return raw.length >= 2 && raw.length <= 50 && /^[\p{L}]+(?:[ .'’\-][\p{L}]+)*$/u.test(raw);
}

function usernameValid(value = '') {
  const raw = String(value || '').trim();
  return raw.length >= 5 && raw.length <= 20 && /^[\p{L}\p{N}._-]+$/u.test(raw);
}

function birthDateValid(value = '') {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return false;
  return date.getTime() <= Date.now() && date.getUTCFullYear() >= 1900;
}

async function ensureAuthReady() {
  await initStoreAuth();
  if (!state.auth || !state.sdk) {
    const error = new Error('Hesap hizmeti şu anda kullanılamıyor.');
    error.code = 'AUTH_UNAVAILABLE';
    throw error;
  }
}

function requireSignedInUser() {
  const user = state.auth?.currentUser || state.user;
  if (!user) {
    const error = new Error('Devam etmek için giriş yapman gerekiyor.');
    error.code = 'AUTH_REQUIRED';
    throw error;
  }
  return user;
}

function requireUnchangedUser(expected) {
  const current = state.auth?.currentUser || state.user;
  const expectedUserId = String(expected?.uid || '');
  if (!expectedUserId || String(current?.uid || '') !== expectedUserId || (state.user && String(state.user.uid || '') !== expectedUserId)) {
    const error = new Error('Hesap oturumu değiştiği için güvenli işlem durduruldu.');
    error.code = 'AUTH_SESSION_CHANGED';
    throw error;
  }
  return current;
}

async function reauthenticateStoreUser(currentPassword = '') {
  await ensureAuthReady();
  const user = requireSignedInUser();
  const password = String(currentPassword || '');
  if (!password) throw new Error('Lütfen mevcut şifrenizi yazın.');
  const email = String(user.email || '').trim().toLowerCase();
  if (!email) throw new Error('Bu hesap parola ile yeniden doğrulanamıyor.');
  const credential = state.sdk.EmailAuthProvider.credential(email, password);
  try {
    await state.sdk.reauthenticateWithCredential(user, credential);
  } catch (error) {
    if (/auth\/(?:invalid-credential|wrong-password)/i.test(String(error?.code || ''))) {
      const invalid = new Error('Mevcut şifre doğrulanamadı.');
      invalid.code = 'CURRENT_PASSWORD_INVALID';
      throw invalid;
    }
    throw error;
  }
  return requireUnchangedUser(user);
}

export async function reauthenticateStoreSession(currentPassword = '') {
  const user = await reauthenticateStoreUser(currentPassword);
  requireUnchangedUser(user);
  await user.getIdToken(true);
  requireUnchangedUser(user);
  state.user = requireUnchangedUser(user);
  setStoreTokenProvider(() => state.user.getIdToken());
  emit();
  return snapshot();
}

async function setAuthPersistence(remember) {
  await ensureAuthReady();
  const persistence = remember ? state.sdk.browserLocalPersistence : state.sdk.browserSessionPersistence;
  await state.sdk.setPersistence(state.auth, persistence);
  writeRememberPreference(remember);
}

export async function signInStore({ identifier = '', password = '', remember = false } = {}) {
  await ensureAuthReady();
  if (!String(identifier).trim() || !String(password)) throw new Error('E-posta/kullanıcı adı ve şifre zorunludur.');
  setBusy(true);
  try {
    await setAuthPersistence(remember);
    const login = await storeApi('/api/auth/login', {
      auth: false,
      body: { identifier: String(identifier).trim(), password: String(password) }
    });
    if (!login?.customToken) {
      const error = new Error('Giriş bilgileri doğrulanamadı.');
      error.code = 'LOGIN_CREDENTIALS_INVALID';
      throw error;
    }
    const credential = await state.sdk.signInWithCustomToken(state.auth, login.customToken);
    await syncServerSession(credential.user, remember);
    state.user = credential.user;
    setStoreTokenProvider(() => credential.user.getIdToken());
    await refreshStoreAccount();
    state.error = '';
    setBusy(false);
    return snapshot();
  } catch (error) {
    const friendly = new Error(friendlyStoreError(error));
    friendly.code = error?.code || 'AUTH_FAILED';
    throw friendly;
  } finally {
    if (state.busy) setBusy(false);
  }
}

export async function registerStore(input = {}) {
  await ensureAuthReady();
  const firstName = String(input.firstName || '').trim();
  const lastName = String(input.lastName || '').trim();
  const username = String(input.username || '').trim();
  const email = String(input.email || '').trim().toLowerCase();
  const password = String(input.password || '');
  const passwordRepeat = String(input.passwordRepeat || '');
  const birthDate = String(input.birthDate || '');
  const remember = input.remember === true;

  if (!personNameValid(firstName) || !personNameValid(lastName)) throw new Error('İsim ve soyisim en az 2 karakter olmalı; harf, boşluk, kesme işareti ve tire kullanılabilir.');
  if (!usernameValid(username)) throw new Error('Kullanıcı adı 5-20 karakter olmalı; harf, sayı, nokta, alt çizgi ve tire kullanılabilir.');
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('Lütfen geçerli bir e-posta adresi yazın.');
  if (password.length < 8) throw new Error('Şifreniz en az 8 karakter olmalıdır.');
  if (password !== passwordRepeat) throw new Error('Şifreler birbiriyle eşleşmiyor.');
  if (!birthDateValid(birthDate)) throw new Error('Lütfen geçerli bir doğum tarihi seçin.');

  setBusy(true);
  let credential = null;
  try {
    const retryingPendingRegistration = !!state.user && pendingRegistration?.email === email;
    if (!retryingPendingRegistration) {
      const availability = await storeApi(`/api/auth/check-username?username=${encodeURIComponent(username)}`, { auth: false });
      if (availability.available === false) {
        const error = new Error(availability.message || 'Bu kullanıcı adı kullanılıyor.');
        error.code = availability.code || 'USERNAME_TAKEN';
        throw error;
      }
    }
    await setAuthPersistence(remember);
    credential = retryingPendingRegistration
      ? { user: state.user }
      : await state.sdk.createUserWithEmailAndPassword(state.auth, email, password);
    pendingRegistration = { firstName, lastName, username, email, birthDate };
    state.user = credential.user;
    setStoreTokenProvider(() => credential.user.getIdToken());
    await state.sdk.updateProfile(credential.user, { displayName: username });
    await syncServerSession(credential.user, remember);
    const profileBody = { firstName, lastName, fullName: `${firstName} ${lastName}`, username, birthDate, avatar: '' };
    try {
      await storeApi('/api/profile/update', { method: 'POST', body: profileBody });
    } catch (error) {
      if (!['NETWORK_ERROR', 'REQUEST_TIMEOUT'].includes(String(error?.code || ''))) throw error;
      await new Promise((resolve) => window.setTimeout(resolve, 450));
      await storeApi('/api/profile/update', { method: 'POST', body: profileBody });
    }
    await refreshStoreAccount();
    pendingRegistration = null;
    state.error = '';
    setBusy(false);
    return snapshot();
  } catch (error) {
    if (credential?.user && ['USERNAME_TAKEN', 'INVALID_USERNAME'].includes(String(error?.code || '').toUpperCase())) {
      await state.sdk.deleteUser(credential.user).catch(() => null);
      pendingRegistration = null;
    }
    const friendly = new Error(friendlyStoreError(error));
    friendly.code = error?.code || 'REGISTER_FAILED';
    throw friendly;
  } finally {
    if (state.busy) setBusy(false);
  }
}

export async function resetStorePassword(identifier = '') {
  const value = String(identifier || '').trim();
  if (!value) throw new Error('Lütfen e-posta adresinizi veya kullanıcı adınızı yazın.');
  setBusy(true);
  try {
    await storeApi('/api/auth/password-reset', { auth: false, body: { identifier: value } });
    return true;
  } catch (error) {
    throw new Error(friendlyStoreError(error, 'Şifre sıfırlama bağlantısı gönderilemedi. Lütfen yeniden deneyin.'));
  } finally {
    setBusy(false);
  }
}

export async function refreshStoreIdentity() {
  await ensureAuthReady();
  const user = requireSignedInUser();
  setBusy(true);
  try {
    await state.sdk.reload(user);
    const current = requireUnchangedUser(user);
    state.user = current;
    setStoreTokenProvider(() => current.getIdToken());
    await current.getIdToken(true);
    requireUnchangedUser(current);
    await syncServerSession(current);
    requireUnchangedUser(current);
    await refreshStoreAccount();
    state.error = '';
    emit();
    return snapshot();
  } catch (error) {
    const friendly = new Error(friendlyStoreError(error));
    friendly.code = error?.code || 'AUTH_REFRESH_FAILED';
    throw friendly;
  } finally {
    setBusy(false);
  }
}

export async function changeStoreEmail({ newEmail = '', currentPassword = '' } = {}) {
  await ensureAuthReady();
  const safeEmail = String(newEmail || '').trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(safeEmail)) throw new Error('Lütfen geçerli bir yeni e-posta adresi yazın.');
  setBusy(true);
  try {
    let user = requireSignedInUser();
    const expectedUserId = String(user.uid || '');
    await state.sdk.reload(user);
    user = requireUnchangedUser(user);
    state.user = user;
    if (String(user.email || '').trim().toLowerCase() === safeEmail) throw new Error('Yeni e-posta mevcut e-posta adresinle aynı.');
    await reauthenticateStoreSession(currentPassword);
    user = requireUnchangedUser(user);
    const response = await storeApi('/api/store/profile/email', {
      method: 'PATCH',
      auth: 'bearer',
      body: { email: safeEmail }
    });
    requireUnchangedUser(user);
    try {
      await state.sdk.reload(user);
      user = requireUnchangedUser(user);
      await user.getIdToken(true);
    } catch (_) {
      const signedIn = await state.sdk.signInWithEmailAndPassword(state.auth, safeEmail, String(currentPassword || ''));
      user = signedIn.user;
      if (String(user?.uid || '') !== expectedUserId) {
        const error = new Error('Hesap oturumu değiştiği için güvenli işlem durduruldu.');
        error.code = 'AUTH_SESSION_CHANGED';
        throw error;
      }
    }
    state.user = user;
    state.account = response.account || state.account;
    setStoreTokenProvider(() => user.getIdToken());
    await syncServerSession(user);
    await refreshStoreAccount();
    state.error = '';
    emit();
    return { changed: true, email: safeEmail, account: state.account };
  } catch (error) {
    const friendly = new Error(friendlyStoreError(error, 'E-posta adresi güncellenemedi. Lütfen yeniden deneyin.'));
    friendly.code = error?.code || 'EMAIL_CHANGE_FAILED';
    throw friendly;
  } finally {
    setBusy(false);
  }
}

export async function changeStoreIdentity({ field = '', currentPassword = '', values = {} } = {}) {
  await ensureAuthReady();
  const routes = Object.freeze({ username: 'username', fullName: 'name', birthDate: 'birth-date' });
  const route = routes[String(field || '')];
  if (!route || !values || typeof values !== 'object' || Array.isArray(values)) {
    const error = new Error('Güncellenecek hesap bilgisi doğrulanamadı.');
    error.code = 'PROFILE_INPUT_INVALID';
    throw error;
  }
  setBusy(true);
  try {
    const expected = requireSignedInUser();
    await reauthenticateStoreSession(currentPassword);
    requireUnchangedUser(expected);
    const response = await storeApi(`/api/store/profile/${route}`, {
      method: 'PATCH',
      auth: 'bearer',
      body: values
    });
    requireUnchangedUser(expected);
    state.account = response.account || state.account;
    state.error = '';
    emit();
    return snapshot();
  } catch (error) {
    const friendly = new Error(friendlyStoreError(error, 'Hesap bilgin güncellenemedi. Lütfen yeniden dene.'));
    friendly.code = error?.code || 'PROFILE_UPDATE_FAILED';
    throw friendly;
  } finally {
    setBusy(false);
  }
}

export async function changeStorePassword({ currentPassword = '', newPassword = '', newPasswordRepeat = '' } = {}) {
  await ensureAuthReady();
  const password = String(newPassword || '');
  if (password.length < 8) throw new Error('Yeni şifreniz en az 8 karakter olmalıdır.');
  if (password !== String(newPasswordRepeat || '')) throw new Error('Yeni şifreler birbiriyle eşleşmiyor.');
  if (password === String(currentPassword || '')) throw new Error('Yeni şifreniz mevcut şifrenizden farklı olmalıdır.');
  setBusy(true);
  try {
    const user = await reauthenticateStoreUser(currentPassword);
    if (typeof state.sdk.validatePassword === 'function') {
      const validation = await state.sdk.validatePassword(state.auth, password).catch(() => null);
      if (validation && validation.isValid === false) {
        const error = new Error('Yeni şifre güvenlik kurallarını karşılamıyor.');
        error.code = 'auth/password-does-not-meet-requirements';
        throw error;
      }
    }
    requireUnchangedUser(user);
    await state.sdk.updatePassword(user, password);
    requireUnchangedUser(user);
    await user.getIdToken(true);
    requireUnchangedUser(user);
    await syncServerSession(user);
    state.user = requireUnchangedUser(user);
    await refreshStoreAccount();
    return { changed: true };
  } catch (error) {
    const friendly = new Error(friendlyStoreError(error, 'Şifre değiştirilemedi. Lütfen mevcut şifrenizi kontrol edip yeniden deneyin.'));
    friendly.code = error?.code || 'PASSWORD_CHANGE_FAILED';
    throw friendly;
  } finally {
    setBusy(false);
  }
}

export async function logoutStore() {
  await ensureAuthReady();
  setBusy(true);
  try {
    await storeApi('/api/auth/logout', { method: 'POST', body: {} }).catch(() => null);
    await state.sdk.signOut(state.auth);
    writeRememberPreference(false);
    setStoreTokenProvider(null);
    state.user = null;
    state.account = null;
    state.error = '';
    emit();
  } finally {
    setBusy(false);
  }
}
