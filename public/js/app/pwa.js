import { modal, toast } from "./ui.js?v=109";
import { tr } from "./preferences.mjs?v=109";
let installEvent = null,
  updateOffered = false;
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installEvent = event;
});
export async function installStore() {
  if (installEvent) {
    await installEvent.prompt();
    await installEvent.userChoice;
    installEvent = null;
    return;
  }
  modal({
    title: tr("Zentra Store uygulaması", "Zentra Store app"),
    body: `<p>${tr("iPhone: Safari paylaş menüsünden “Ana Ekrana Ekle” seçeneğini kullan. Android: tarayıcı menüsünden “Uygulamayı yükle” seçeneğini kullan. Sipariş ve hesap işlemleri internet bağlantısı gerektirir.", "iPhone: choose “Add to Home Screen” in Safari’s share menu. Android: choose “Install app” from the browser menu. Orders and account actions require an internet connection.")}</p>`,
  });
}
export function initPwa({ isBusy = () => false } = {}) {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
  if (["127.0.0.1", "localhost"].includes(location.hostname)) {
    void navigator.serviceWorker
      .getRegistrations()
      .then((registrations) =>
        Promise.all(
          registrations
            .filter(
              (registration) => registration.scope === location.origin + "/",
            )
            .map((registration) => registration.unregister()),
        ),
      )
      .catch(() => {});
    return;
  }

  const offer = (registration) => {
    if (
      !registration.waiting ||
      !navigator.serviceWorker.controller ||
      updateOffered
    )
      return;
    updateOffered = true;
    modal({
      title: tr("Yeni sürüm hazır", "New version ready"),
      body: `<p>${tr("Devam eden siparişini kontrol ettikten sonra yeni sürüme geçebilirsin.", "Finish checking any pending order before applying the update.")}</p>`,
      submit: tr("Güncelle", "Update"),
      onSubmit: () => {
        if (isBusy())
          throw new Error(
            tr(
              "Önce bekleyen siparişin sonucunu kontrol et.",
              "Check the pending order result first.",
            ),
          );
        registration.waiting.postMessage({ type: "APPLY_UPDATE" });
      },
    });
  };
  navigator.serviceWorker
    .register("/sw.js", { scope: "/", updateViaCache: "none" })
    .then((registration) => {
      offer(registration);
      registration.addEventListener("updatefound", () => {
        registration.installing?.addEventListener("statechange", () => {
          if (registration.waiting) offer(registration);
        });
      });
    })
    .catch(() =>
      toast(
        tr(
          "Uygulama önbelleği kurulamadı; çevrimiçi mağazayı kullanabilirsin.",
          "App cache could not be installed; the online store remains available.",
        ),
        "info",
      ),
    );
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!reloading && !isBusy()) {
      reloading = true;
      location.reload();
    }
  });
}
