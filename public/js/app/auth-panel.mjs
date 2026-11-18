import { escape as e, field, icon, brand } from "./ui.js?v=109";
import { verificationMarkup } from "./verification.mjs?v=109";
export function authPanel({
  auth,
  mode = "login",
  error = "",
  background = "",
}) {
  const verification = auth.verification;
  const pending = verification && !verification.profileRequired;
  const register =
    mode === "register" || verification?.profileRequired === true;
  const title = pending
    ? "E-posta doğrulaması"
    : register
      ? "Hesap oluştur"
      : "Giriş";
  const content = pending
    ? verificationMarkup({ ...verification, error })
    : `<div class="auth-form-panel"><p class="auth-intro">${register ? "Yeni bir hesap mı?" : "Hesabın var mı?"}</p><h2 class="auth-lead">${register ? "HEMEN KAYIT OL" : "HEMEN GİRİŞ YAP"}</h2><form id="auth-form" data-mode="${register ? "register" : "login"}">${register ? `<div class="field-row">${field("firstName", "Ad", "text", "", 'required maxlength="50" autocomplete="given-name"')}${field("lastName", "Soyad", "text", "", 'required maxlength="50" autocomplete="family-name"')}</div>${field("username", "Kullanıcı adı", "text", "", 'required minlength="5" maxlength="20" autocomplete="username"')}${field("birthDate", "Doğum tarihi", "date", "", 'required min="1900-01-01" max="' + new Date().toISOString().slice(0, 10) + '"')}${field("email", "E-posta", "email", auth.registrationEmail || "", 'required maxlength="254" autocomplete="email"')}` : field("identifier", "E-posta veya kullanıcı adı", "text", "", 'required maxlength="254" autocomplete="username"')}${field("password", "Parola", "password", "", 'required minlength="' + (register ? "8" : "1") + '" maxlength="4096" autocomplete="' + (register ? "new-password" : "current-password") + '"')}${register ? field("passwordRepeat", "Parola tekrarı", "password", "", 'required minlength="8" autocomplete="new-password"') : ""}<label class="checkbox"><input type="checkbox" name="remember"/> Bu cihazda oturumumu açık tut</label><p class="form-error" role="alert" ${error ? "" : "hidden"}>${e(error)}</p><button class="button primary" type="submit">${register ? "Doğrulama kodu gönder" : "Giriş Yap"}</button>${!register ? '<div class="auth-recovery-links"><button type="button" class="text-button" data-action="reset-password">Şifremi Unuttum</button><button type="button" class="text-button" data-action="recover-username">Kullanıcı Adımı Unuttum</button></div>' : ""}</form><p class="auth-switch">${register ? 'Üyeliğin var mı? <button class="text-button" data-action="auth-tab" data-tab="login">Giriş Yap</button>' : 'Hesabın yok mu? <button class="text-button" data-action="auth-tab" data-tab="register">Hemen oluştur</button>'}</p><p class="auth-privacy">Hesap bilgilerinin kullanımı için <button type="button" class="text-button" data-info="privacy">Gizlilik &amp; veri</button> açıklamasını inceleyebilirsin.</p></div>`;
  return `${background}<dialog class="auth-sheet" id="auth-sheet" aria-labelledby="auth-sheet-title"><header class="sheet-title">${brand()}<div class="sheet-account-actions"><button type="button" class="button primary small" data-action="auth-tab" data-tab="${register ? "login" : "register"}">${register ? "Giriş" : "Kayıt"}</button><button type="button" class="icon-button" data-action="auth-close" aria-label="Hesap panelini kapat">${icon("close")}</button></div><h1 id="auth-sheet-title" class="sr-only">${title}</h1></header>${content}<a class="auth-support-link" href="/destek" data-nav>${icon("support")} DESTEK İLE İLETİŞİME GEÇ</a></dialog>`;
}
