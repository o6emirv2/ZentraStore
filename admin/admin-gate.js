import { installAppUI, setActionBusy, animateView } from '../public/js/ui/app-ui.js?v=zentra-app-v69';
import { installErrorReporter } from '../public/js/ui/error-reporter.js?v=zentra-app-v69';
import { adminFetch, lockAdminInteractions, startAmbientCanvas } from './admin-core.js?v=zentra-app-v69';
import { installInteractionGuard } from '/public/js/ui/interaction-guard.js?v=zentra-app-v69';

installInteractionGuard();
installAppUI();

const state = { step: 1, ticket: '', busy: false, automaticRunning: false };
const ADMIN_BLOCK_KEY = 'zentra_admin_entry_block_until_v47';
const ADMIN_BLOCK_MS = 5 * 60_000;
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function googleAuthenticatorCode(value = '') {
  return String(value || '').normalize('NFKC').replace(/\D/g, '').slice(0, 6);
}

function prepareFirstPartyHandoff(handoff = {}) {
  const action = new URL(String(handoff?.action || ''), window.location.href);
  const service = new URL(window.ZENTRA_ADMIN_AUTH.apiUrl('/api/public/runtime-config'), window.location.href);
  const code = String(handoff?.code || '').trim();
  const expiresAt = Math.max(0, Number(handoff?.expiresAt || 0) || 0);
  if (handoff?.required !== true || handoff?.mode !== 'single-use-first-party-post'
    || action.origin !== service.origin || action.pathname !== '/admin/session/handoff'
    || action.search || action.hash || !/^https:$/.test(action.protocol)
    || !/^[A-Za-z0-9_-]{43}$/.test(code) || expiresAt <= Date.now()) {
    const error = new Error('Güvenli yönetici geçişi doğrulanamadı. Lütfen son adımı yeniden deneyin.');
    error.code = 'ADMIN_HANDOFF_INVALID';
    throw error;
  }
  const form = document.createElement('form');
  form.method = 'post';
  form.action = action.href;
  form.enctype = 'application/x-www-form-urlencoded';
  form.target = '_self';
  form.hidden = true;
  form.setAttribute('aria-hidden', 'true');
  const field = document.createElement('input');
  field.type = 'hidden';
  field.name = 'handoffCode';
  field.value = code;
  form.appendChild(field);
  document.body.appendChild(form);
  return form;
}

async function verifyCompletedAdminAccess() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const status = await adminFetch('/api/auth/admin/gate/status');
      if (status?.authenticated === true && status?.admin) return status;
    } catch (error) {
      if (attempt === 2) throw error;
    }
    if (attempt < 2) await pause(150 * (attempt + 1));
  }
  const error = new Error('Yönetici oturumu doğrulanamadı. Son adımı yeniden deneyin.');
  error.code = 'ADMIN_GATE_ACCESS_INVALID';
  throw error;
}


function maskUid(value = '') {
  const uid = String(value || '').trim();
  if (uid.length <= 10) return uid;
  return `${uid.slice(0, 6)}…${uid.slice(-4)}`;
}

function blockedUntil() {
  try { return Math.max(0, Number(localStorage.getItem(ADMIN_BLOCK_KEY) || 0) || 0); }
  catch (_) { return 0; }
}

function clearExpiredBlock() {
  const until = blockedUntil();
  if (!until || until > Date.now()) return until;
  try { localStorage.removeItem(ADMIN_BLOCK_KEY); } catch (_) {}
  return 0;
}

function storefrontUrl() {
  const origin = window.ZENTRA_ADMIN_AUTH?.canonicalOrigin?.() || window.location.origin;
  return `${String(origin || window.location.origin).replace(/\/+$/, '')}/`;
}

function redirectToStorefront({ block = false } = {}) {
  if (block) {
    try { localStorage.setItem(ADMIN_BLOCK_KEY, String(Date.now() + ADMIN_BLOCK_MS)); } catch (_) {}
  }
  window.location.replace(storefrontUrl());
}

function isUnauthorizedSessionError(error) {
  return ['AUTH_REQUIRED', 'AUTH_INVALID', 'ADMIN_REQUIRED', 'ADMIN_ACTIVE_SESSION_MISMATCH'].includes(String(error?.code || ''));
}

function setStatus(selector, message = '', type = '') {
  const node = $(selector);
  if (!node) return;
  node.textContent = message;
  node.className = `gate-status${type ? ` is-${type}` : ''}`;
}

function setBusy(form, busy, label = 'Doğrulanıyor…') {
  state.busy = busy;
  setActionBusy(form?.querySelector('.primary-btn'), busy, label);
}

function securityView(security = {}) {
  const score = Math.max(0, Math.min(100, Number(security.score || 0) || 0));
  const minimum = Math.max(86, Number(security.minimum || 90) || 90);
  const ready = security.ready === true && score >= minimum;
  $('#securityMeter').dataset.ready = String(ready);
  $('#securityScore').textContent = `${score}/100`;
  $('#securityBar').style.width = `${score}%`;
  $('#securityLabel').textContent = ready ? `Güçlü koruma · eşik ${minimum}` : `Güvenlik ayarları tamamlanmalı · eşik ${minimum}`;
}

function activateStep(step) {
  state.step = step;
  $('#stepTrack').dataset.step = String(Math.min(5, step));
  $$('.gate-step').forEach((section) => {
    const active = Number(section.dataset.step) === step;
    section.classList.toggle('is-active', active);
    section.hidden = !active;
    section.inert = !active;
    if (active) animateView(section);
  });
  const focusTargets = { 3: '#firebasePassword', 4: '#fourthFactor', 5: '#fifthFactor' };
  const focus = $(focusTargets[step]);
  setTimeout(() => focus?.focus({ preventScroll: true }), 90);
}

function verificationView(step, verified, text) {
  const card = step === 1 ? $('.gate-step[data-step="1"] .verification-card') : $('.gate-step[data-step="2"] .verification-card');
  if (!card) return;
  card.classList.toggle('is-verified', verified);
  const icon = card.querySelector('i');
  if (icon) icon.className = `fa-solid ${verified ? 'fa-circle-check' : 'fa-spinner fa-spin'}`;
  const target = step === 1 ? $('#emailVerificationText') : $('#uidVerificationText');
  if (target) target.textContent = text;
}

async function runAutomaticVerification() {
  if (state.automaticRunning || state.busy) return;
  state.automaticRunning = true;
  state.ticket = '';
  $('#retryAutomatic').hidden = true;
  setStatus('#emailStatus', 'Yetkili e-posta güvenli biçimde algılanıyor.');
  setStatus('#uidStatus', '');
  verificationView(1, false, 'Yönetici e-postası denetleniyor…');
  verificationView(2, false, 'UID eşleşmesi denetleniyor…');
  activateStep(1);

  try {
    const active = window.ZENTRA_ADMIN_AUTH.activeSession();
    if (!active?.uid || !active?.email) {
      const missing = new Error('Ana sayfada aktif bir ZENTRA STORE oturumu bulunamadı.');
      missing.code = 'AUTH_REQUIRED';
      throw missing;
    }
    verificationView(1, false, `Aktif oturum okunuyor: ${active.email}`);
    setStatus('#emailStatus', `Ana sayfa oturumu algılandı: ${active.email}`);

    const emailResult = await adminFetch('/api/auth/admin/gate/step-email', { method: 'POST', body: {} });
    securityView(emailResult.security);
    state.ticket = emailResult.ticket || '';
    if (!state.ticket) throw new Error('Yetkili e-posta eşleşme oturumu oluşturulamadı.');
    const verifiedEmail = String(emailResult.verification?.value || active.email || '').trim().toLowerCase();
    verificationView(1, true, `Eşleşti: ${verifiedEmail}`);
    setStatus('#emailStatus', 'Aktif ZENTRA STORE e-postası yönetici rol politikasıyla eşleşti.', 'success');

    activateStep(2);
    verificationView(2, false, `Aktif UID okunuyor: ${maskUid(active.uid)}`);
    const uidResult = await adminFetch('/api/auth/admin/gate/step-uid', { method: 'POST', body: { ticket: state.ticket } });
    securityView(uidResult.security);
    state.ticket = uidResult.ticket || '';
    if (!state.ticket) throw new Error('UID doğrulama oturumu oluşturulamadı.');
    const verifiedUid = String(uidResult.verification?.value || active.uid || '').trim();
    verificationView(2, true, `Doğrulandı: ${maskUid(verifiedUid)}`);
    setStatus('#uidStatus', 'Aktif ZENTRA STORE UID değeri yönetici rol politikasıyla eşleşti.', 'success');

    activateStep(3);
    setStatus('#firebaseStatus', 'Otomatik kimlik kontrolleri tamamlandı.', 'success');
  } catch (error) {
    if (isUnauthorizedSessionError(error)) {
      setStatus('#emailStatus', 'Aktif ZENTRA STORE oturumu yetkili yönetici hesabıyla eşleşmedi. Ana sayfaya yönlendiriliyorsunuz.', 'error');
      await pause(350);
      redirectToStorefront({ block: true });
      return;
    }
    const selector = state.step === 2 ? '#uidStatus' : '#emailStatus';
    setStatus(selector, error.message || 'Otomatik doğrulama tamamlanamadı.', 'error');
    if (state.step !== 1) {
      await pause(180);
      activateStep(1);
      setStatus('#emailStatus', error.message || 'Otomatik doğrulama tamamlanamadı.', 'error');
    }
    $('#retryAutomatic').hidden = false;
  } finally {
    state.automaticRunning = false;
  }
}

async function submitFirebasePassword(event) {
  event.preventDefault();
  if (state.busy) return;
  const form = event.currentTarget;
  const password = String($('#firebasePassword').value || '');
  if (password.length < 6) return setStatus('#firebaseStatus', 'Hesap şifrenizi eksiksiz yazın.', 'error');
  setBusy(form, true, 'Hesap doğrulanıyor…');
  setStatus('#firebaseStatus', 'Hesap şifresi güvenli biçimde denetleniyor.');
  try {
    const response = await adminFetch('/api/auth/admin/gate/step-firebase-password', {
      method: 'POST',
      body: { ticket: state.ticket, password }
    });
    $('#firebasePassword').value = '';
    state.ticket = response.ticket || '';
    const factorExpiresAt = Math.max(0, Number(response.factor?.expiresAt || 0) || 0);
    if (!state.ticket || factorExpiresAt <= Date.now()) throw new Error('Dördüncü doğrulama adımı hazırlanamadı.');
    securityView(response.security);
    activateStep(4);
    setStatus('#fourthStatus', 'Hesap şifresi doğrulandı. Dördüncü güvenlik katmanı hazır.', 'success');
  } catch (error) {
    $('#firebasePassword').value = '';
    setStatus('#firebaseStatus', error.message || 'Hesap şifresi doğrulanamadı.', 'error');
  } finally {
    setBusy(form, false);
  }
}

async function submitFourthFactor(event) {
  event.preventDefault();
  if (state.busy) return;
  const form = event.currentTarget;
  const password = String($('#fourthFactor').value || '');
  if (password.length < 12) return setStatus('#fourthStatus', 'Dördüncü adım şifresini eksiksiz yazın.', 'error');
  setBusy(form, true, 'Dördüncü adım doğrulanıyor…');
  try {
    const response = await adminFetch('/api/auth/admin/gate/step-four', {
      method: 'POST',
      body: { ticket: state.ticket, password }
    });
    $('#fourthFactor').value = '';
    state.ticket = response.ticket || '';
    if (!state.ticket) throw new Error('Beşinci doğrulama adımı hazırlanamadı.');
    securityView(response.security);
    activateStep(5);
    setStatus('#fifthStatus', 'Dördüncü şifre doğrulandı. Google Authenticator’daki kodu girin.', 'success');
  } catch (error) {
    $('#fourthFactor').value = '';
    if (['ADMIN_GATE_FACTOR_REQUIRED', 'ADMIN_STEP_SESSION_INVALID'].includes(String(error?.code || ''))) state.ticket = '';
    setStatus('#fourthStatus', error.message || 'Dördüncü güvenlik şifresi doğrulanamadı.', 'error');
  } finally {
    setBusy(form, false);
  }
}

async function submitFifthFactor(event) {
  event.preventDefault();
  if (state.busy) return;
  const form = event.currentTarget;
  const password = String($('#fifthFactor').value || '');
  const totpCode = googleAuthenticatorCode($('#adminTotpCode')?.value);
  if (password.length < 12) return setStatus('#fifthStatus', 'Beşinci adım şifresini eksiksiz yazın.', 'error');
  if (!/^\d{6}$/.test(totpCode)) return setStatus('#fifthStatus', 'Google Authenticator’daki 6 haneli kodu yazın.', 'error');
  setBusy(form, true, 'Güvenli erişim oluşturuluyor…');
  try {
    const response = await adminFetch('/api/auth/admin/gate/step-five', {
      method: 'POST',
      body: { ticket: state.ticket, password, totpCode }
    });
    if (response.ok !== true || response.redirectTo !== '/admin/admin.html') {
      const invalid = new Error('Yönetim merkezi için güvenli yönlendirme hazırlanamadı.');
      invalid.code = 'ADMIN_GATE_ACCESS_INVALID';
      throw invalid;
    }
    const handoffForm = response.handoff?.required ? prepareFirstPartyHandoff(response.handoff) : null;
    if (!handoffForm) await verifyCompletedAdminAccess();
    $('#fifthFactor').value = '';
    $('#adminTotpCode').value = '';
    securityView(response.security);
    activateStep(6);
    setStatus('#fifthStatus', 'Tüm güvenlik katmanları doğrulandı. Güvenli yönetim merkezi açılıyor.', 'success');
    if (handoffForm) {
      handoffForm.submit();
      return;
    }
    state.ticket = '';
      setTimeout(() => window.location.replace('/admin/admin.html'), 120);
  } catch (error) {
    $('#fifthFactor').value = '';
    if (state.step === 6) activateStep(5);
    if (['ADMIN_GATE_FACTOR_REQUIRED', 'ADMIN_STEP_SESSION_INVALID'].includes(String(error?.code || ''))) state.ticket = '';
    setStatus('#fifthStatus', error.message || 'Son güvenlik doğrulaması tamamlanamadı.', 'error');
  } finally {
    setBusy(form, false);
  }
}

async function resetGate() {
  if (state.busy || state.automaticRunning) return;
  state.ticket = '';
  await adminFetch('/api/auth/admin/gate/logout', { method: 'POST', body: {} }).catch(() => null);
  $('#firebasePasswordForm')?.reset();
  $('#fourthFactorForm')?.reset();
  $('#fifthFactorForm')?.reset();
  setStatus('#firebaseStatus', '');
  setStatus('#fourthStatus', '');
  setStatus('#fifthStatus', '');
  await runAutomaticVerification();
}

function togglePassword(button) {
  const input = document.getElementById(button.dataset.passwordToggle || '');
  if (!input) return;
  const visible = input.type === 'text';
  input.type = visible ? 'password' : 'text';
  button.setAttribute('aria-label', visible ? 'Şifreyi göster' : 'Şifreyi gizle');
  const icon = button.querySelector('i');
  if (icon) icon.className = `fa-solid ${visible ? 'fa-eye' : 'fa-eye-slash'}`;
}

async function boot() {
  lockAdminInteractions();
  startAmbientCanvas($('#ambientCanvas'));

  if (clearExpiredBlock() > Date.now()) {
    redirectToStorefront();
    return;
  }
  $('#firebasePasswordForm').addEventListener('submit', submitFirebasePassword);
  $('#fourthFactorForm').addEventListener('submit', submitFourthFactor);
  $('#fifthFactorForm').addEventListener('submit', submitFifthFactor);
  $('#adminTotpCode').addEventListener('input', (event) => {
    const normalized = googleAuthenticatorCode(event.currentTarget.value);
    if (event.currentTarget.value !== normalized) event.currentTarget.value = normalized;
  });
  $('#retryAutomatic').addEventListener('click', runAutomaticVerification);
  $$('[data-reset-gate]').forEach((button) => button.addEventListener('click', resetGate));
  $$('[data-password-toggle]').forEach((button) => button.addEventListener('click', () => togglePassword(button)));

  try {
    await window.ZENTRA_ADMIN_AUTH.init();
    const status = await adminFetch('/api/auth/admin/gate/status');
    securityView(status.security);
    const apiOrigin = new URL(window.ZENTRA_ADMIN_AUTH.apiUrl('/api/public/runtime-config'), window.location.href).origin;
    if (status.authenticated && window.ZENTRA_ADMIN_AUTH.activeSession() && apiOrigin === window.location.origin) {
          activateStep(6);
      return setTimeout(() => location.replace('/admin/admin.html'), 420);
    }
  } catch (error) {
    securityView(error?.payload?.security || { score: 0, minimum: 90, ready: false });
  }

  await adminFetch('/api/auth/admin/gate/logout', { method: 'POST', body: {} }).catch(() => null);
  await runAutomaticVerification();
}

boot();

installErrorReporter();
