import { friendlyStoreError, loadStoreRuntimeConfig, setStoreAppCheckTokenProvider, setStoreTokenProvider, storeApi } from './api.js?v=zentra-ui-v82r2';
import { createAccountReader } from './account-state.js?v=zentra-ui-v82r2';

const FIREBASE_VERSION = '12.17.1';
const FIREBASE_APP_URL = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-app.js`;
const FIREBASE_AUTH_URL = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-auth.js`;
const FIREBASE_APP_CHECK_URL = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-app-check.js`;
const REMEMBER_COOKIE = 'zentra_store_remember';
const INITIALIZATION_TIMEOUT_MS = 15000;
const subscribers = new Set(), appChecks = new WeakMap();
let initPromise = null, pendingRegistration = null, identityRevision = 0, unsubscribe = null;
const state = { ready: false, available: true, busy: false, user: null, account: null, auth: null, sdk: null, error: '', warning: '', pendingEmail: '', accountLoading: false, accountStale: false, localSignedOut: false };
const uid = user => String(user?.uid || '');
const failure = (code, message) => Object.assign(new Error(message || code), { code });
function snapshot() {
  const user = pendingRegistration || !state.ready ? null : state.user;
  return { ready: state.ready, available: state.available, busy: state.busy,
    user: user ? { uid: user.uid, email: user.email || '', displayName: user.displayName || '', emailVerified: user.emailVerified === true } : null,
    account: user && state.account ? { ...state.account } : null, error: state.error, warning: state.warning,
    pendingEmail: user ? state.pendingEmail : '', accountLoading: !!user && state.accountLoading, accountStale: !!user && state.accountStale };
}
function emit() { const value = snapshot(); for (const subscriber of subscribers) { try { subscriber(value); } catch (_) {} } }
function setBusy(value) { state.busy = !!value; emit(); }
function rememberPreference() { return document.cookie.split(';').some(part => part.trim() === `${REMEMBER_COOKIE}=1`); }
function writeRememberPreference(remember) {
  document.cookie = `${REMEMBER_COOKIE}=${remember ? '1; Max-Age=1209600' : '; Max-Age=0'}; Path=/; SameSite=Lax${window.location.protocol === 'https:' ? '; Secure' : ''}`;
}
async function boundedInitialization(promise, cleanup = () => {}) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => { cleanup(); reject(failure('AUTH_INITIALIZATION_TIMEOUT', 'Hesap bağlantısı zamanında kurulamadı. Yeniden deneyin.')); }, INITIALIZATION_TIMEOUT_MS); })]); }
  finally { clearTimeout(timer); }
}
const accountReader = createAccountReader({
  userId: () => uid(state.user), read: signal => storeApi('/api/store/account', { signal }),
  start: () => { state.accountLoading = true; emit(); },
  accept: account => { state.account = account; state.accountStale = false; state.error = ''; },
  failed: error => { state.accountStale = !!state.account; state.error = friendlyStoreError(error); },
  finish: () => { state.accountLoading = false; emit(); }
});
function bindUser(user) {
  if (uid(state.user) !== uid(user)) { accountReader.invalidate(); state.account = null; state.accountStale = false; state.accountLoading = false; state.pendingEmail = ''; }
  state.user = user || null; setStoreTokenProvider(user ? () => user.getIdToken() : null);
}
function requireSignedInUser() { const user = state.auth?.currentUser; if (!user || state.localSignedOut) throw failure('AUTH_REQUIRED', 'Devam etmek için giriş yapın.'); return user; }
function requireUnchangedUser(expected) {
  if (!uid(expected) || uid(state.auth?.currentUser) !== uid(expected) || (state.user && uid(state.user) !== uid(expected))) throw failure('AUTH_SESSION_CHANGED', 'Hesap oturumu değişti. Güvenli işlem durduruldu.');
  return state.auth.currentUser;
}
export async function refreshStoreAccount(options = {}) {
  if (!state.user) { state.account = null; state.accountStale = false; emit(); return null; }
  try { return await accountReader.load(options); }
  catch (error) {
    if (['AUTH_REQUIRED', 'AUTH_INVALID', 'AUTH_ACCOUNT_MISMATCH', 'SESSION_INVALID'].includes(String(error.code))) {
      bindUser(null); state.error = friendlyStoreError(error); emit();
      await state.sdk?.signOut(state.auth).catch(() => {});
    }
    throw error;
  }
}
async function syncServerSession(user, remember = rememberPreference()) {
  requireUnchangedUser(user); const idToken = await user.getIdToken(true); requireUnchangedUser(user);
  await storeApi('/api/auth/session', { method: 'POST', auth: false, body: { idToken, remember: !!remember } }); requireUnchangedUser(user);
}
async function finishIdentity(user, remember = rememberPreference(), { restore = false } = {}) {
  requireUnchangedUser(user); bindUser(user); state.warning = ''; state.error = '';
  try {
    let session = null;
    if (restore) session = await storeApi('/api/auth/session', { auth: false, timeoutMs: 4500 }).catch(() => null);
    requireUnchangedUser(user);
    if (!session?.authenticated || uid(session.user) !== uid(user)) await syncServerSession(user, remember);
  } catch (error) { requireUnchangedUser(user); state.warning = `Giriş korundu; sunucu oturumu yenilenemedi. ${friendlyStoreError(error)}`; }
  try { await refreshStoreAccount({ force: true }); }
  catch (error) { if (uid(state.auth?.currentUser) !== uid(user)) throw error; state.warning ||= 'Giriş korundu; hesap bilgileri yüklenemedi. Hesabınızı yenileyin.'; }
  if (state.account?.profileInitializationPending === true) { pendingRegistration = { uid: uid(user), email: user.email }; state.warning = 'Başlayan kaydı aynı e-posta ile Kayıt Ol alanından tamamlayın.'; }
  state.ready = true; emit(); return snapshot();
}
async function restoreAuthenticatedState(user) {
  const revision = ++identityRevision;
  bindUser(user); state.ready = false; state.error = ''; state.warning = ''; emit();
  if (!user) { state.ready = true; emit(); return; }
  try { await finishIdentity(user, rememberPreference(), { restore: true }); }
  catch (error) { if (revision === identityRevision && uid(state.auth?.currentUser) === uid(user)) state.error = friendlyStoreError(error); }
  if (revision === identityRevision) { state.ready = true; emit(); }
}
export function subscribeStoreAuth(subscriber) { if (typeof subscriber !== 'function') return () => {}; subscribers.add(subscriber); subscriber(snapshot()); return () => subscribers.delete(subscriber); }
export function getStoreAuthSnapshot() { return snapshot(); }
export async function initStoreAuth() {
  if (state.auth && state.sdk && state.available) return snapshot();
  if (initPromise) return initPromise;
  state.ready = false; state.available = true; state.error = ''; emit();
  initPromise = (async () => {
    try {
      const [runtime, appSdk, authSdk] = await boundedInitialization(Promise.all([loadStoreRuntimeConfig(), import(FIREBASE_APP_URL), import(FIREBASE_AUTH_URL)]));
      if (!runtime?.firebaseReady || !runtime.firebase?.apiKey || !runtime.firebase?.projectId || !runtime.firebase?.authDomain || !runtime.firebase?.appId) throw failure('AUTH_UNAVAILABLE');
      const app = appSdk.getApps().find(entry => entry.name === 'zentra-store') || appSdk.initializeApp(runtime.firebase, 'zentra-store');
      setStoreAppCheckTokenProvider(null);
      const siteKey = String(runtime.appCheck?.siteKey || '').trim();
      if (siteKey) {
        try {
          const sdk = await boundedInitialization(import(FIREBASE_APP_CHECK_URL));
          let instance = appChecks.get(app);
          if (!instance) { instance = sdk.initializeAppCheck(app, { provider: new sdk.ReCaptchaEnterpriseProvider(siteKey), isTokenAutoRefreshEnabled: true }); appChecks.set(app, instance); }
          setStoreAppCheckTokenProvider(async () => (await sdk.getToken(instance, false)).token || '');
        } catch (error) { if (runtime.appCheck?.mode === 'enforce') throw error; }
      } else if (runtime.appCheck?.mode === 'enforce') throw failure('APP_CHECK_UNAVAILABLE');
      const auth = authSdk.getAuth(app); auth.useDeviceLanguage();
      if (typeof auth.authStateReady === 'function') await boundedInitialization(auth.authStateReady());
      else {
        let stop;
        try { await boundedInitialization(new Promise((resolve, reject) => { stop = authSdk.onAuthStateChanged(auth, () => { resolve(); queueMicrotask(() => stop?.()); }, reject); }), () => stop?.()); }
        finally { stop?.(); }
      }
      state.sdk = authSdk; state.auth = auth;
      await restoreAuthenticatedState(auth.currentUser || null); unsubscribe?.();
      unsubscribe = authSdk.onAuthStateChanged(auth, user => {
        if (state.busy || (state.localSignedOut && user) || uid(user) === uid(state.user)) return;
        void restoreAuthenticatedState(user).catch(error => { state.ready = true; state.error = friendlyStoreError(error); emit(); });
      });
      state.available = true;
    } catch (error) { state.available = false; state.ready = true; state.error = friendlyStoreError(error, 'Hesap hizmeti başlatılamadı. Yeniden deneyin.'); emit(); }
    return snapshot();
  })().finally(() => { initPromise = null; }); return initPromise;
}
async function ensureAuthReady() { await initStoreAuth(); if (!state.available || !state.sdk || !state.auth) throw failure('AUTH_UNAVAILABLE', state.error); }
async function withOperation(operation) {
  if (state.busy) throw failure('AUTH_OPERATION_PENDING', 'Hesap işlemi sürüyor. Tamamlanmasını bekleyin.');
  setBusy(true);
  try { await ensureAuthReady(); return await operation(); }
  catch (error) { const friendly = new Error(friendlyStoreError(error), { cause: error }); friendly.code = error.code || 'AUTH_FAILED'; throw friendly; }
  finally {
    try { if (state.auth && !state.localSignedOut && !pendingRegistration && uid(state.auth.currentUser) !== uid(state.user)) await restoreAuthenticatedState(state.auth.currentUser || null); }
    finally { setBusy(false); }
  }
}
async function setAuthPersistence(remember) {
  try { await state.sdk.setPersistence(state.auth, remember ? state.sdk.browserLocalPersistence : state.sdk.browserSessionPersistence); writeRememberPreference(remember); return ''; }
  catch (error) {
    if (!state.sdk.inMemoryPersistence) throw error;
    await state.sdk.setPersistence(state.auth, state.sdk.inMemoryPersistence); writeRememberPreference(false);
    return 'Tarayıcı kalıcı oturuma izin vermedi; giriş bu sekmede korunuyor.';
  }
}
async function validatePassword(password) {
  if (password.length < 8 || password.length > 4096) throw failure('auth/weak-password', 'Şifre 8–4096 karakter arasında olmalıdır.');
  if (typeof state.sdk.validatePassword === 'function') {
    const policy = await state.sdk.validatePassword(state.auth, password);
    if (!policy || policy.isValid !== true) throw failure('auth/password-does-not-meet-requirements', 'Şifre güvenlik kurallarını karşılamıyor.');
  }
}
async function reauthenticateStoreUser(currentPassword) {
  const user = requireSignedInUser(), password = String(currentPassword || '');
  if (!password || password.length > 4096) throw failure('CURRENT_PASSWORD_INVALID');
  try { await state.sdk.reauthenticateWithCredential(user, state.sdk.EmailAuthProvider.credential(user.email, password)); }
  catch (error) { if (/auth\/(?:invalid-credential|wrong-password)/.test(String(error.code))) throw failure('CURRENT_PASSWORD_INVALID', 'Mevcut şifre doğrulanamadı.'); throw error; }
  return requireUnchangedUser(user);
}
export async function reauthenticateStoreSession(password = '') { return withOperation(async () => { const user = await reauthenticateStoreUser(password); await user.getIdToken(true); bindUser(requireUnchangedUser(user)); emit(); return snapshot(); }); }
export async function signInStore({ identifier = '', password = '', remember = false } = {}) {
  return withOperation(async () => {
    if (!String(identifier).trim() || !String(password) || String(password).length > 4096) throw failure('LOGIN_CREDENTIALS_INVALID');
    const persistenceWarning = await setAuthPersistence(remember);
    const login = await storeApi('/api/auth/login', { auth: false, body: { identifier: String(identifier).trim(), password: String(password) } });
    if (!login.customToken) throw failure('LOGIN_CREDENTIALS_INVALID');
    const credential = await state.sdk.signInWithCustomToken(state.auth, login.customToken);
    state.localSignedOut = false; pendingRegistration = null; bindUser(credential.user); await finishIdentity(credential.user, persistenceWarning ? false : remember);
    if (pendingRegistration) throw failure('REGISTER_PENDING', state.warning);
    state.warning = [persistenceWarning, state.warning].filter(Boolean).join(' '); emit(); return snapshot();
  });
}
export async function registerStore(input = {}) {
  return withOperation(async () => {
    const firstName = String(input.firstName || '').trim(), lastName = String(input.lastName || '').trim(), username = String(input.username || '').trim();
    const email = String(input.email || '').trim().toLowerCase(), password = String(input.password || ''), birthDate = String(input.birthDate || '');
    if (![firstName, lastName].every(value => value.length >= 2 && value.length <= 50 && /^[\p{L}]+(?:[ .'’-][\p{L}]+)*$/u.test(value))) throw failure('INVALID_PERSON_NAME');
    if (!/^[\p{L}\p{N}._-]{5,20}$/u.test(username)) throw failure('INVALID_USERNAME');
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw failure('EMAIL_INVALID');
    if (password !== String(input.passwordRepeat || '')) throw failure('PASSWORD_MISMATCH', 'Şifreler eşleşmiyor.');
    const date = new Date(`${birthDate}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate) || !Number.isFinite(+date) || date.toISOString().slice(0, 10) !== birthDate || +date > Date.now() || date.getUTCFullYear() < 1900) throw failure('BIRTH_DATE_INVALID');
    await validatePassword(password);
    const retry = pendingRegistration?.email === email && pendingRegistration.uid === uid(state.auth.currentUser);
    if (pendingRegistration && !retry) { await state.sdk.signOut(state.auth); pendingRegistration = null; bindUser(null); }
    const available = await storeApi(`/api/auth/check-username?username=${encodeURIComponent(username)}`, { auth: false });
    if (available.available === false) throw failure('USERNAME_TAKEN');
    const persistenceWarning = await setAuthPersistence(input.remember === true);
    const credential = retry ? { user: state.auth.currentUser } : await state.sdk.createUserWithEmailAndPassword(state.auth, email, password);
    state.localSignedOut = false;
    if (retry) await state.sdk.reauthenticateWithCredential(credential.user, state.sdk.EmailAuthProvider.credential(email, password));
    pendingRegistration = { uid: uid(credential.user), email }; bindUser(credential.user); emit();
    await storeApi('/api/profile/update', { method: 'POST', body: { firstName, lastName, username, birthDate } });
    requireUnchangedUser(credential.user); pendingRegistration = null;
    await state.sdk.updateProfile(credential.user, { displayName: username }).catch(() => {});
    await finishIdentity(credential.user, persistenceWarning ? false : input.remember === true);
    state.warning = [persistenceWarning, state.warning].filter(Boolean).join(' '); emit(); return snapshot();
  });
}
export async function resetStorePassword(identifier = '') { return withOperation(async () => { if (!String(identifier).trim()) throw failure('EMAIL_INVALID'); await storeApi('/api/auth/password-reset', { auth: false, body: { identifier: String(identifier).trim() } }); return true; }); }
export async function refreshStoreIdentity() { return withOperation(async () => { const user = requireSignedInUser(); await state.sdk.reload(user); requireUnchangedUser(user); if (String(user.email).toLowerCase() === state.pendingEmail) state.pendingEmail = ''; return finishIdentity(user); }); }
export async function changeStoreIdentity({ field = '', currentPassword = '', values = {} } = {}) {
  return withOperation(async () => {
    const routes = { username: 'username', fullName: 'name', birthDate: 'birth-date' }, route = routes[field];
    if (!route || !values || typeof values !== 'object' || Array.isArray(values)) throw failure('PROFILE_INPUT_INVALID');
    const user = await reauthenticateStoreUser(currentPassword); await user.getIdToken(true); requireUnchangedUser(user);
    const response = await storeApi(`/api/store/profile/${route}`, { method: 'PATCH', auth: 'bearer', body: values });
    requireUnchangedUser(user); accountReader.confirm(response.account); state.error = ''; emit(); return snapshot();
  });
}
export async function changeStoreEmail({ newEmail = '', currentPassword = '' } = {}) {
  return withOperation(async () => {
    const email = String(newEmail).trim().toLowerCase();
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw failure('EMAIL_INVALID');
    const user = await reauthenticateStoreUser(currentPassword); await state.sdk.reload(user); requireUnchangedUser(user);
    await user.getIdToken(true); requireUnchangedUser(user);
    const response = await storeApi('/api/store/profile/email-change/prepare', { method: 'POST', auth: 'bearer', body: { email } });
    if (response.verification?.verificationRequired !== true) throw failure('EMAIL_UPDATE_UNAVAILABLE');
    await state.sdk.verifyBeforeUpdateEmail(user, email); requireUnchangedUser(user);
    state.pendingEmail = email; state.error = ''; emit(); return { changed: false, verificationPending: true, email, account: state.account };
  });
}
export async function changeStorePassword({ currentPassword = '', newPassword = '', newPasswordRepeat = '' } = {}) {
  return withOperation(async () => {
    const password = String(newPassword);
    if (password !== String(newPasswordRepeat)) throw failure('PASSWORD_MISMATCH', 'Şifreler eşleşmiyor.');
    if (password === String(currentPassword)) throw failure('PASSWORD_UNCHANGED', 'Yeni şifre mevcut şifreden farklı olmalıdır.');
    const user = await reauthenticateStoreUser(currentPassword); await validatePassword(password); requireUnchangedUser(user);
    try { await state.sdk.updatePassword(user, password); }
    catch (error) { if (/network|timeout/i.test(String(error.code))) throw failure('PASSWORD_CHANGE_UNCERTAIN', 'Şifre değişiminin sonucu doğrulanamadı. Yeni şifrenizle girişinizi kontrol edin; işlemi tekrar göndermeyin.'); throw error; }
    requireUnchangedUser(user); let warning;
    try { await finishIdentity(user); warning = state.warning; }
    catch (error) { warning = `Şifre değişti; oturumun yenilenmesi doğrulanamadı. ${friendlyStoreError(error)}`; }
    return { changed: true, warning };
  });
}
export async function logoutStore() {
  return withOperation(async () => {
    let serverRevoked = false, signedOut = false;
    try { await storeApi('/api/auth/logout', { method: 'POST', body: {} }); serverRevoked = true; } catch (_) {}
    try { await state.sdk.signOut(state.auth); signedOut = true; }
    finally { state.localSignedOut = true; pendingRegistration = null; bindUser(null); writeRememberPreference(false); state.error = ''; state.warning = serverRevoked && signedOut ? '' : 'Görünür hesap bilgileri temizlendi; oturumun tamamen kapandığı doğrulanamadı. Yeniden deneyin.'; emit(); }
    return { signedOut, serverRevoked, warning: state.warning };
  });
}
