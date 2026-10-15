const KEY = 'zentra:referral:v1';
const valid = code => /^ZA-[A-Z0-9]{24}$/.test(String(code || ''));
let memory = null;
export function clearReferral() {
  memory = null;
  try { localStorage.removeItem(KEY); } catch (_) {}
}
export function currentReferral() {
  if (!memory) {
    try { memory = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (_) {}
  }
  if (!valid(memory?.code) || !Number.isFinite(memory?.expiresAt) || memory.expiresAt <= Date.now()) { clearReferral(); return ''; }
  return memory.code;
}
export function captureReferral() {
  const url = new URL(location.href), code = url.searchParams.get('ref');
  if (code !== null) {
    if (valid(code)) {
      memory = { code, expiresAt: Date.now() + 30 * 86400000 };
      try { localStorage.setItem(KEY, JSON.stringify(memory)); } catch (_) {}
    } else clearReferral();
    url.searchParams.delete('ref');
    history.replaceState(history.state, '', url.pathname + url.search + url.hash);
  }
  return currentReferral();
}
export function renderReferralNotice(root = document) {
  const host = root.querySelector('#registrationReferral');
  if (!host) return;
  const code = currentReferral();
  host.hidden = !code;
  const label = host.querySelector('[data-referral-label]');
  if (label) label.textContent = code ? `Referans bağlantısıyla kayıt oluyorsunuz: ${code}. Alışverişleriniz bağlantı sahibine komisyon kazandırır; fiyatınız değişmez.` : '';
}
