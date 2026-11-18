import { escape as e, icon } from "./ui.js?v=109";
export function remainingTime(deadline, now = Date.now()) {
  const value = Math.max(0, Math.ceil((Number(deadline) - now) / 1000) || 0);
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}
export function verificationMarkup(value = {}) {
  const accepted = value.delivery === "accepted",
    active = value.canComplete === true;
  const sending = value.delivery === "sending";
  const uncertain = value.delivery === "uncertain",
    failed = value.delivery === "failed";
  return `<section class="auth-page"><div class="auth-form-panel verification-panel"><span class="verification-symbol" aria-hidden="true">${icon("shield")}</span><span class="eyebrow">HESABINA GÜVENLİ BİR BAŞLANGIÇ</span><h1>E-postanı doğrula.</h1><p>${value.email ? `<strong>${e(value.email)}</strong> adresine ait ` : "Hesabına ait "}6 haneli doğrulama kodunu gir. Doğrulama tamamlanana kadar hesabın kullanıma açılmaz.</p>${accepted ? '<p class="verification-notice">Doğrulama e-postası gönderim için kabul edildi. Gelen kutunu ve spam klasörünü kontrol edebilirsin.</p>' : failed ? '<p class="verification-notice warning" role="status">Doğrulama e-postası gönderilemedi. Bekleme süresi sonunda yeni kod isteyebilirsin.</p>' : uncertain ? '<p class="verification-notice warning" role="status">Gönderim sonucu doğrulanamadı. Kod ulaştıysa kullanabilir, ulaşmadıysa süre sonunda yeni kod isteyebilirsin.</p>' : sending ? '<p class="verification-notice" role="status">E-posta gönderimi sürüyor. Durumu kontrol edebilirsin.</p>' : ""}${value.error ? `<p class="form-error" role="alert">${e(value.error)}</p>` : ""}${active ? '<div class="verification-notice" role="status">Kodun doğrulandı. Hesabın etkinleşme sonucunu kontrol ederek devam edebilirsin.</div><button type="button" class="button primary" data-action="verification-complete">Doğrulamayı tamamla</button>' : value.challengeId ? `<form id="verification-form"><label class="field" for="verification-code"><span>E-posta doğrulama kodu</span><input class="verification-code" id="verification-code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" minlength="6" maxlength="6" placeholder="000000" aria-describedby="verification-time verification-attempts" required/></label><div class="verification-meta"><span id="verification-time" role="timer" aria-live="off">Kalan süre: ${remainingTime(value.expiresAt, value.serverNow)}</span><span id="verification-attempts">${e(value.remainingAttempts ?? 5)} deneme hakkı</span></div><p class="form-error" role="alert" hidden></p><button class="button primary" type="submit">E-postamı doğrula ${icon("arrow")}</button></form>` : '<button type="button" class="button primary" data-action="verification-resend">Doğrulama kodu gönder</button>'}<p class="verification-security">Kod 5 dakika geçerlidir ve yalnızca bir kez kullanılabilir. Yeni kod istediğinde önceki kod geçersiz olur.</p><div class="verification-actions">${value.challengeId && !active ? '<button type="button" class="text-button" data-action="verification-resend" id="verification-resend">Kodu yeniden gönder</button>' : ""}<button type="button" class="text-button" data-action="verification-refresh">Durumu kontrol et</button><button type="button" class="text-button" data-action="verification-switch">Farklı hesap kullan</button></div></div></section>`;
}
export function mountVerificationClock(
  doc,
  value,
  { clock = Date.now, schedule = setInterval, cancel = clearInterval } = {},
) {
  if (!doc.querySelector(".verification-panel") || !value) return () => {};
  const offset = Number(value.serverNow || clock()) - clock();
  const tick = () => {
    const now = clock() + offset,
      expired = Number(value.expiresAt || 0) <= now;
    const timer = doc.querySelector("#verification-time");
    if (timer)
      timer.textContent = expired
        ? "Kodun süresi doldu. Yeni kod iste."
        : "Kalan süre: " + remainingTime(value.expiresAt, now);
    const form = doc.querySelector("#verification-form");
    const locked = Number(value.remainingAttempts ?? 5) <= 0;
    for (const field of form?.querySelectorAll("input, button") || [])
      field.disabled =
        expired || locked || field.getAttribute?.("aria-busy") === "true";
    const resend = doc.querySelector("#verification-resend");
    if (resend) {
      const seconds = Math.max(
        0,
        Math.ceil((Number(value.resendAt || 0) - now) / 1000),
      );
      resend.disabled =
        seconds > 0 || locked || resend.getAttribute?.("aria-busy") === "true";
      resend.textContent =
        seconds > 0
          ? `Yeni kod için ${seconds} sn bekle`
          : "Kodu yeniden gönder";
    }
  };
  tick();
  const timer = schedule(tick, 1000);
  return () => cancel(timer);
}
