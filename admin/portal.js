import { initPasswordFields } from "../public/js/app/ui.js?v=109";
import "../public/js/app/device.js?v=109";
import "./admin-browser-session.js?v=109";
import "./admin-auth.js?v=109";
import { adminFetch } from "./admin-core.js?v=109";
import {
  escape as e,
  brand,
  icon,
  field,
  busy,
  toast,
} from "../public/js/app/ui.js?v=109";
const root = document.getElementById("admin-root");
let ticket = "",
  step = 0,
  operating = false,
  context = null,
  disposeWorkspace = null,
  portalGeneration = 0;
const auth = () => window.ZENTRA_ADMIN_AUTH;
const readableError = (error) => {
  const text = String(error?.message || "Güvenli bağlantı kurulamadı.");
  return /^[A-Z][A-Z0-9_]{4,}$/.test(text) ||
    /firebase|network|failed to fetch/i.test(text)
    ? auth().friendly(error)
    : text;
};
function gate(error = "") {
  ++portalGeneration;
  disposeWorkspace?.();
  disposeWorkspace = null;
  root.innerHTML = `<main class="gate-layout" id="admin-main"><section class="gate-brand">${brand()}<div><span class="eyebrow">MAĞAZANIN KONTROLÜ SENDE</span><h1>Her ayrıntı.<br/>Tek bir merkez.</h1><p>Ürünlerin, siparişlerin ve müşterilerin.<br/>Güvenli ve düzenli bir yönetim deneyimi.</p></div><span class="gate-security">${icon("shield")} Kimlik ve işlemler sunucuda doğrulanır.</span></section><section class="gate-content"><div class="gate-inner"><span class="eyebrow">YÖNETİCİ ERİŞİMİ</span><h2>Güvenli giriş.</h2><p class="fine-print">Mağaza hesabın ve ek güvenlik adımları birlikte doğrulanır.</p><ol class="gate-steps" aria-label="Güvenlik adımları">${["Hesap eşleşmesi", "UID doğrulaması", "Hesap şifresi", "Güvenlik şifresi 1", "Güvenlik şifresi 2", "Authenticator kodu"].map((s, i) => `<li class="${i + 1 < step ? "complete" : i + 1 === step ? "current" : ""}"><span>${i + 1 < step ? "✓" : i + 1}</span>${s}</li>`).join("")}</ol>${error ? `<p class="form-error" role="alert">${e(error)}</p>` : ""}<div id="gate-form-area">${step < 3 ? `<p class="fine-print">Mağazada yetkili hesabınla oturum açtıktan sonra güvenlik adımlarını başlat.</p><a class="button secondary" href="/hesabim" style="margin-top:18px">Hesabıma git ${icon("arrow")}</a><button class="button primary" id="gate-start" style="margin-top:18px">Oturumu doğrula</button>` : `<form id="gate-step-form">${step === 6 ? field("totpCode", "Google Authenticator kodu", "text", "", 'required inputmode="numeric" pattern="[0-9]{6}" minlength="6" maxlength="6" autocomplete="one-time-code"') : field("password", step === 3 ? "Hesap şifren" : `Güvenlik şifresi ${step - 3}`, "password", "", 'required autocomplete="current-password" minlength="' + (step === 3 ? "6" : "12") + '" maxlength="4096"')}<p class="form-error" id="gate-error" role="alert" hidden></p><button class="button primary" type="submit">Doğrula ve devam et ${icon("arrow")}</button></form><button class="text-button fine-print" id="gate-reset">Güvenlik adımlarını baştan başlat</button>`}</div></div><a href="/" class="gate-home">${icon("back")} Mağazaya dön</a></section></main>`;
  initPasswordFields(root);
  document.getElementById("gate-start")?.addEventListener("click", startGate);
  document.getElementById("gate-reset")?.addEventListener("click", resetGate);
  document
    .getElementById("gate-step-form")
    ?.addEventListener("submit", submitStep);
  root.querySelector("input")?.focus({ preventScroll: true });
}
async function startGate() {
  if (operating) return;
  operating = true;
  const button = document.getElementById("gate-start");
  busy(button, true, "Oturum denetleniyor…");
  try {
    await auth().init();
    await auth().refreshIdentity();
    if (!auth().activeSession()?.uid)
      throw new Error("Önce mağazada yetkili hesabınla oturum aç.");
    const browserKey = await auth().prepareBrowserKey();
    let result = await adminFetch("/api/auth/admin/gate/step-email", {
      body: { browserKey },
    });
    ticket = result.ticket;
    if (!ticket) throw new Error("Hesap doğrulaması başlatılamadı.");
    result = await adminFetch("/api/auth/admin/gate/step-uid", {
      body: { ticket },
    });
    ticket = result.ticket;
    if (!ticket) throw new Error("UID doğrulanamadı.");
    step = 3;
    gate();
  } catch (error) {
    gate(readableError(error));
  } finally {
    operating = false;
    busy(button, false);
  }
}
async function resetGate() {
  if (operating) return;
  try {
    await adminFetch("/api/auth/admin/gate/logout", { body: {} });
    await auth().clearBrowserSession();
    ticket = "";
    step = 0;
    gate();
  } catch (error) {
    toast(readableError(error), "error");
  }
}
async function submitStep(event) {
  event.preventDefault();
  if (operating) return;
  operating = true;
  const form = event.target,
    button = form.querySelector("[type=submit]"),
    data = new FormData(form),
    endpoint = {
      3: "step-firebase-password",
      4: "step-four",
      5: "step-five",
      6: "step-six",
    }[step];
  busy(button, true, "Doğrulanıyor…");
  try {
    const result = await adminFetch("/api/auth/admin/gate/" + endpoint, {
      body: {
        ticket,
        ...(step === 6
          ? { totpCode: data.get("totpCode") }
          : { password: data.get("password") }),
      },
    });
    form.reset();
    if (step === 6) {
      if (result.ok !== true || !result.browserSession)
        throw new Error("Yönetici oturumu oluşturulamadı.");
      await auth().acceptBrowserSession(result.browserSession);
      const status = await adminFetch("/api/auth/admin/gate/status");
      if (status.authenticated !== true || !status.admin)
        throw new Error("Yönetici erişimi doğrulanamadı.");
      ticket = "";
      context = status.admin;
      await openWorkspace();
    } else {
      if (!result.ticket)
        throw new Error("Sonraki güvenlik adımı hazırlanamadı.");
      ticket = result.ticket;
      step++;
      gate();
    }
  } catch (error) {
    form.reset();
    const node = document.getElementById("gate-error");
    if (node) {
      node.hidden = false;
      node.textContent = readableError(error);
    } else gate(readableError(error));
    if (
      ["ADMIN_STEP_SESSION_INVALID", "ADMIN_GATE_FACTOR_REQUIRED"].includes(
        error.code,
      )
    ) {
      ticket = "";
      step = 0;
      gate("Güvenlik adımlarının süresi doldu. Yeniden başlat.");
    }
  } finally {
    operating = false;
    busy(button, false);
  }
}
async function openWorkspace() {
  const generation = portalGeneration,
    session = context;
  const { mountWorkspace, unmountWorkspace } =
    await import("./workspace.js?v=109");
  if (!session || generation !== portalGeneration || context !== session)
    return;
  disposeWorkspace = unmountWorkspace;
  await mountWorkspace({
    root,
    context: session,
    api: adminFetch,
    onLogout: async () => {
      await adminFetch("/api/auth/admin/gate/logout", { body: {} });
      await auth().clearBrowserSession();
      auth().clearActionPassword();
      step = 0;
      context = null;
      gate();
    },
  });
}
window.addEventListener("zentra:admin-session-invalid", () => {
  step = 0;
  context = null;
  gate("Yönetici oturumu değişti. Yeniden doğrulama gerekli.");
});
try {
  await auth().init();
  const result = await adminFetch("/api/auth/admin/gate/status");
  if (result.authenticated && result.admin) {
    context = result.admin;
    await openWorkspace();
  } else gate();
} catch (error) {
  gate(readableError(error));
}
