import {
  escape as e,
  field,
  icon,
  modal,
  toast,
  busy,
  initPasswordFields,
} from "./ui.js?v=109";
export function createAccountRecovery({ api }) {
  let recoveredKey = "";
  let pending = false,
    generation = 0,
    attempt = null;
  const generic =
    "Talebin alındı. Bilgiler bir hesapla eşleşiyorsa kayıtlı e-posta adresine bir ileti gönderilecek. Gelen kutunu ve istenmeyen iletileri kontrol et.";
  function request(kind = "password") {
    const username = kind === "username";
    let key = crypto.randomUUID(),
      last = "";
    return modal({
      title: username ? "Kullanıcı adını hatırla" : "Şifreni güvenle yenile",
      body: `<p>${username ? "Kayıtlı e-posta adresini gir. Gerçek kullanıcı adın yalnızca hesabına ait adrese gönderilir." : "E-posta adresini veya kullanıcı adını gir. Zentra’dan gelen tek kullanımlık bağlantıyla yeni bir şifre belirleyebilirsin."}</p>${field("identifier", username ? "Kayıtlı e-posta" : "E-posta veya kullanıcı adı", username ? "email" : "text", "", 'required maxlength="254" autocomplete="' + (username ? "email" : "username") + '"')}<p class="fine-print">Gönderici: ZENTRA STORE · bildirim@zentrastore.com.tr</p>`,
      submit: username ? "Hatırlatma iste" : "Yenileme bağlantısı iste",
      onSubmit: async (data) => {
        const identifier = String(data.get("identifier") || "").trim();
        if (last && last !== identifier) key = crypto.randomUUID();
        last = identifier;
        const result = await api(
          "/api/auth/" + (username ? "username-recovery" : "password-reset"),
          { auth: false, body: { identifier, idempotencyKey: key } },
        );
        if (result.accepted !== true)
          throw new Error(
            "Talep kaydı doğrulanamadı. Aynı bilgileri koruyarak yeniden dene.",
          );
        toast({
          type: "info",
          title: "Kurtarma talebin alındı",
          message: generic,
          persistent: true,
          key: "recovery-request",
        });
      },
    });
  }
  function completed() {
    attempt = null;
    return `<section class="recovery-card panel"><span class="state-emblem success">${icon("success")}</span><span class="eyebrow">HESAP GÜVENLİĞİ</span><h1>Şifren yenilendi</h1><p>Şifre değişikliği sunucuda doğrulandı. Önceki oturumlar kapatıldı. Yeni şifrenle tekrar giriş yapabilirsin.</p><a class="button primary" href="/hesabim?islem=giris" data-nav>${icon("user")} Giriş ekranına dön</a><p class="fine-print">E-posta doğrulaması ve yönetici güvenlik adımları korunur.</p></section>`;
  }
  const markup = (token) =>
    `<section class="recovery-card panel" data-recovery-token="${e(token)}"><span class="state-emblem">${icon("shield")}</span><span class="eyebrow">ZENTRA HESAP GÜVENLİĞİ</span><h1>Yeni şifreni belirle</h1><p data-recovery-status role="status">Bağlantının geçerliliği kontrol ediliyor…</p><form id="recovery-form" hidden>${field("newPassword", "Yeni şifre", "password", "", 'required minlength="8" maxlength="4096" autocomplete="new-password"')}${field("repeat", "Yeni şifre tekrarı", "password", "", 'required minlength="8" maxlength="4096" autocomplete="new-password"')}<p class="fine-print">En az 8 karakter kullan. Başka hesaplarında kullanmadığın güçlü bir şifre seç.</p><p class="form-error" role="alert" hidden></p><button class="button primary" type="submit">${icon("shield")} Şifremi yenile</button><button type="button" class="button secondary" data-recovery-check hidden>${icon("refresh")} İşlem sonucunu kontrol et</button></form><button type="button" class="button secondary" data-recovery-retry hidden>Bağlantıyı tekrar kontrol et</button><button type="button" class="text-button" data-recovery-request>Yeni bağlantı iste</button><a class="section-link" href="/hesabim?islem=giris" data-nav>Giriş ekranına dön ${icon("arrow")}</a></section>`;
  async function mount(root, token) {
    if (attempt?.token !== token) attempt = null;
    recoveredKey = "";
    const version = ++generation,
      status = root.querySelector("[data-recovery-status]"),
      form = root.querySelector("#recovery-form");
    if (!status || !form) return;
    const current = () => version === generation && form.isConnected;
    const showError = (error, uncertain = false) => {
      const message = form.querySelector(".form-error");
      message.innerHTML = `${icon(uncertain ? "warning" : "error")}<span>${e(error.message || "Bağlantı doğrulanamadı.")}</span>`;
      message.classList.toggle("uncertain", uncertain);
      message.hidden = false;
      message.tabIndex = -1;
      message.focus();
    };
    root.querySelector("[data-recovery-request]").onclick = () =>
      request("password");
    if (!/^[-_A-Za-z0-9]{43}$/.test(token)) {
      status.textContent = "E-postandaki şifre yenileme bağlantısını aç veya aşağıdan yeni bir bağlantı iste.";
      return;
    }
    async function inspect() {
      const { result } = await api("/api/auth/recovery/inspect", {
        auth: false,
        body: { token },
      });
      if (!current()) return result;
      if (result?.state === "completed") {
        root.innerHTML = completed();
        return result;
      }
      recoveredKey = result?.operationKey || "";
      form.hidden = false;
      status.textContent =
        result?.state === "ready"
          ? "Bağlantı geçerli. Şifre değişmeden önce kayıt doğrulanacak."
          : "Önceki isteğin sonucu doğrulanıyor. İlk istekte kullandığın yeni şifreyi tekrar gir; aynı işlem kaydı kontrol edilecek.";
      return result;
    }
    root.querySelector("[data-recovery-retry]").onclick = () =>
      mount(root, token);
    try {
      await inspect();
    } catch (error) {
      if (current()) {
        status.textContent = error.message;
        status.className = "form-error";
        root.querySelector("[data-recovery-retry]").hidden = false;
      }
      return;
    }
    if (!current()) return;
    initPasswordFields(form);
    const check = form.querySelector("[data-recovery-check]");
    async function submit(event) {
      event?.preventDefault();
      if (pending) return;
      const data = new FormData(form),
        password = String(data.get("newPassword") || "");
      if (!attempt) {
        if (password.length < 8 || password !== data.get("repeat"))
          return showError(
            new Error("Şifreler aynı ve en az 8 karakter olmalı."),
          );
        attempt = {
          token,
          newPassword: password,
          idempotencyKey: recoveredKey || crypto.randomUUID(),
        };
      }
      pending = true;
      const button =
        event?.type === "click" ? check : form.querySelector("[type=submit]");
      busy(button, true, "Sonuç doğrulanıyor…");
      form
        .querySelectorAll("input")
        .forEach((input) => (input.readOnly = true));
      try {
        if ((await inspect())?.state === "completed") return;
        const response = await api("/api/auth/recovery/complete", {
          auth: false,
          timeoutMs: 25000,
          body: attempt,
        });
        if (response.result?.changed !== true)
          throw Object.assign(
            new Error("Şifre değişikliğinin sonucu doğrulanamadı."),
            { code: "RECOVERY_RESULT_UNCERTAIN" },
          );
        if (current()) root.innerHTML = completed();
        toast({
          type: "success",
          message: "Şifren yenilendi. Yeni şifrenle yeniden giriş yap.",
        });
      } catch (error) {
        if (!current()) return;
        const uncertain =
          [
            "NETWORK_ERROR",
            "REQUEST_TIMEOUT",
            "RESPONSE_INVALID",
            "RECOVERY_RESULT_UNCERTAIN",
          ].includes(error.code) ||
          error.status >= 500 ||
          error.status === 429;
        if (!uncertain) {
          attempt = null;
          form
            .querySelectorAll("input")
            .forEach((input) => (input.readOnly = false));
        }
        check.hidden = !uncertain;
        form.querySelector("[type=submit]").hidden = uncertain;
        showError(error, uncertain);
      } finally {
        pending = false;
        busy(button, false);
      }
    }
    form.onsubmit = submit;
    check.onclick = submit;
  }
  return {
    request,
    markup,
    mount,
    get busy() {
      return pending;
    },
    dispose() {
      generation++;
      if (!pending) attempt = null;
    },
  };
}
