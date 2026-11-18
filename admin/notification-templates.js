import { escapeHtml as e } from "./admin-core.js?v=109";

export function createTemplateEditor({ api, reauthenticate, allowed, notify }) {
  let state, host;
  function show(type) {
    const form = host.querySelector("form"),
      row = state.templates[type] || {};
    for (const field of ["subject", "intro", "label"])
      form.elements[field].value = row[field] || "";
    preview();
  }
  function preview() {
    const form = host.querySelector("form");
    const demo = {
      tarih: new Date().toLocaleString("tr-TR", {
        timeZone: "Europe/Istanbul",
      }),
      urun: "Örnek ürün",
      kullanici: "Deniz",
      kod: "ORNEK",
      tutar: "₺100,00",
      cihaz: "iPhone · Safari",
    };
    host.querySelector("output").textContent = [
      form.elements.subject.value || state.labels[form.elements.type.value],
      form.elements.intro.value,
      form.elements.label.value,
    ]
      .filter(Boolean)
      .join("\n")
      .replace(/\{(\w+)\}/g, (token, key) => demo[key] || token);
  }
  async function load(container) {
    host = container;
    state = await api("/api/admin/store/notification-templates");
    host.innerHTML = `<form class="admin-card admin-form"><label>Bildirim türü<select name="type">${Object.entries(
      state.labels,
    )
      .map(([k, v]) => `<option value="${e(k)}">${e(v)}</option>`)
      .join(
        "",
      )}</select></label><label>Konu ve bildirim başlığı<input name="subject" maxlength="120" placeholder="Sistem başlığı"></label><label>Mesaj metni<textarea name="intro" rows="4" maxlength="1000" placeholder="Sistem mesajı"></textarea></label><label>Bağlantı düğmesi<input name="label" maxlength="60" placeholder="Sistem düğmesi"></label><p>Bir alanı boş bırakırsanız sistem metni kullanılır. Olayla ilgili değerleri ${state.variables.map((v) => "{" + e(v) + "}").join(", ")} biçiminde ekleyebilirsiniz. Bağlantı hedefini sistem belirler.</p><strong>Örnek önizleme</strong><output aria-live="polite"></output><button class="primary-action" type="submit" ${allowed() ? "" : "disabled"}>Şablonu kaydet</button></form>`;
    const form = host.querySelector("form");
    form.elements.type.onchange = () => show(form.elements.type.value);
    form.oninput = preview;
    form.onsubmit = async (event) => {
      event.preventDefault();
      const button = form.querySelector("[type=submit]");
      if (!allowed() || button.disabled) return;
      button.disabled = true;
      try {
        if (!(await reauthenticate())) return;
        const { type, subject, intro, label } = form.elements;
        const result = await api(
          "/api/admin/store/notification-templates/" +
            encodeURIComponent(type.value),
          {
            method: "PUT",
            body: {
              revision: state.revision,
              template: {
                subject: subject.value.trim(),
                intro: intro.value.trim(),
                label: label.value.trim(),
              },
            },
          },
        );
        state = { ...state, ...result };
        notify(
          "success",
          "Şablon kaydedildi",
          "Yeni iletiler güncel metinle hazırlanacak.",
        );
      } catch (error) {
        notify("error", "Şablon kaydedilemedi", error.message);
      } finally {
        button.disabled = false;
      }
    };
    show(form.elements.type.value);
  }
  return { load };
}
