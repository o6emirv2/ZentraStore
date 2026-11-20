import { escape as e, icon, money, safeImage } from "./ui.js?v=108";

export function createSearch({ form, input, results, clear, search, navigate, available, schedule = setTimeout, cancel = clearTimeout }) {
  let timer, generation = 0, active = -1, choices = [], disposed = false;
  const setExpanded = value => input.setAttribute("aria-expanded", String(value));
  function close() {
    ++generation;
    cancel(timer);
    choices = [];
    active = -1;
    results.hidden = true;
    input.removeAttribute("aria-activedescendant");
    input.setAttribute("aria-busy", "false");
    form.dataset.searchState = "idle";
    setExpanded(false);
  }
  function select(index) {
    active = choices.length ? (index + choices.length) % choices.length : -1;
    for (const [i, choice] of choices.entries()) {
      choice.setAttribute("aria-selected", String(i === active));
      choice.classList.toggle("selected", i === active);
    }
    if (active >= 0) {
      input.setAttribute("aria-activedescendant", choices[active].id);
      choices[active].scrollIntoView({ block: "nearest" });
    }
  }
  async function update() {
    close();
    const query = input.value.trim(), request = generation;
    clear.hidden = !input.value;
    if (query.length < 2) return;
    input.setAttribute("aria-busy", "true");
    form.dataset.searchState = "loading";
    timer = schedule(async () => {
      if (disposed || request !== generation) return;
      try {
        const ready = available(), rows = ready ? (await search(query)).slice(0, 5) : [];
        if (disposed || request !== generation) return;
        results.innerHTML = `<div class="search-results-heading"><span>${ready ? "ÜRÜN SONUÇLARI" : "KATALOG HENÜZ HAZIR DEĞİL"}</span><small>${rows.length ? "↵ aç · ↑↓ seç" : ""}</small></div><div role="listbox" id="search-result-list" aria-label="Ürün önerileri">${rows.map((p, i) => `<a class="suggestion" id="search-result-${i}" role="option" aria-selected="false" tabindex="-1" href="/urun/${e(p.id)}" data-nav><img src="${e(safeImage(p.image))}" alt="" width="48" height="48"/><span><b>${e(p.name)}</b><small>${p.platform === "ios" ? "iOS" : "Android"} · ${e(p.game === "pubg" ? "PUBG Mobile" : p.game || "Ürün")}</small></span><span class="suggestion-price">${money(Math.min(...p.plans.map(plan => plan.priceKurus)))}${icon("chevron")}</span></a>`).join("")}</div>${!rows.length ? `<p class="search-no-results" role="status">${ready ? "Bu aramayla eşleşen ürün bulunamadı. Başka bir ürün adı dene." : "Ürünler yüklenemedi. Sayfadaki yeniden deneme seçeneğini kullanabilirsin."}</p>` : `<a class="search-all" href="/magaza?q=${encodeURIComponent(query)}" data-nav>Tüm sonuçları gör ${icon("arrow")}</a>`}`;
        choices = [...results.querySelectorAll('[role="option"]')];
        results.hidden = false;
        setExpanded(true);
      } catch {
        if (request !== generation || disposed) return;
        results.innerHTML = '<p class="search-no-results" role="status">Arama sonuçları hazırlanamadı. Yeniden deneyebilirsin.</p>';
        results.hidden = false;
        setExpanded(true);
      } finally {
        if (request === generation && !disposed) {
          input.setAttribute("aria-busy", "false");
          form.dataset.searchState = "idle";
        }
      }
    }, 180);
  }
  const submit = event => {
    event.preventDefault();
    const choice = active >= 0 && !results.hidden ? choices[active]?.getAttribute("href") : "",
      query = input.value.trim();
    close();
    navigate(choice || "/magaza" + (query ? "?q=" + encodeURIComponent(query) : ""));
  };
  const keydown = event => {
    if (event.key === "Escape") { close(); return; }
    if (["ArrowDown", "ArrowUp"].includes(event.key) && !results.hidden && choices.length) {
      event.preventDefault();
      select(active < 0 ? (event.key === "ArrowDown" ? 0 : choices.length - 1) : active + (event.key === "ArrowDown" ? 1 : -1));
    }
  };
  const reset = () => { input.value = ""; close(); clear.hidden = true; input.focus(); };
  const outside = event => { if (!form.contains(event.target)) close(); };
  const focusout = event => { if (!form.contains(event.relatedTarget)) close(); };
  input.addEventListener("input", update);
  input.addEventListener("keydown", keydown);
  form.addEventListener("submit", submit);
  form.addEventListener("focusout", focusout);
  clear.addEventListener("click", reset);
  document.addEventListener("click", outside);
  return { close, sync(query = "") { close(); input.value = query; clear.hidden = !query; }, dispose() {
    disposed = true; close(); input.removeEventListener("input", update); input.removeEventListener("keydown", keydown);
    form.removeEventListener("submit", submit); form.removeEventListener("focusout", focusout); clear.removeEventListener("click", reset); document.removeEventListener("click", outside);
  } };
}
