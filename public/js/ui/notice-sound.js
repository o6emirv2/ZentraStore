const PREFERENCE_KEY = 'zentra-notification-sound-v1';
const tones = Object.freeze({
  success: [[660, 0, .08], [880, .09, .13]],
  error: [[330, 0, .12], [247, .14, .14]],
  warning: [[520, 0, .12], [520, .17, .10]],
  info: [[660, 0, .12]]
});
let installed = false;
let context = null;
let lastSoundAt = -Infinity;
let enabled = true;
try { enabled = localStorage.getItem(PREFERENCE_KEY) !== 'off'; } catch (_) {}

function updateControls() {
  document.querySelectorAll('[data-notice-sound-toggle]').forEach((button) => {
    button.setAttribute('aria-pressed', String(enabled));
    button.setAttribute('aria-label', enabled ? 'Bildirim sesini kapat' : 'Bildirim sesini aç');
    const label = button.querySelector('[data-notice-sound-label]');
    if (label) label.textContent = enabled ? 'Bildirim sesi açık' : 'Bildirim sesi kapalı';
    const icon = button.querySelector('i');
    if (icon) icon.className = `fa-solid ${enabled ? 'fa-volume-low' : 'fa-volume-xmark'}`;
  });
}

function unlock() {
  if (!enabled) return;
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;
  try {
    context ||= new AudioContext();
    if (context.state === 'suspended') void context.resume().catch(() => {});
  } catch (_) {}
}

export function setNoticeSoundEnabled(value) {
  enabled = value === true;
  try { localStorage.setItem(PREFERENCE_KEY, enabled ? 'on' : 'off'); } catch (_) {}
  updateControls();
  if (enabled) unlock();
}

export function installNoticeSound() {
  if (installed) return;
  installed = true;
  window.addEventListener('pointerdown', unlock, { capture: true, passive: true });
  window.addEventListener('keydown', unlock, { capture: true });
  document.addEventListener('click', (event) => {
    if (event.target.closest?.('[data-notice-sound-toggle]')) setNoticeSoundEnabled(!enabled);
  });
  window.addEventListener('storage', (event) => {
    if (event.key !== PREFERENCE_KEY) return;
    enabled = event.newValue !== 'off';
    updateControls();
  });
  updateControls();
}

export function playNoticeSound(type = 'info') {
  const now = performance.now();
  if (!enabled || !context || context.state !== 'running' || document.hidden || now - lastSoundAt < 450) return false;
  lastSoundAt = now;
  try {
    for (const [frequency, delay, duration] of tones[type] || tones.info) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const start = context.currentTime + delay;
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(.035, start + .015);
      gain.gain.exponentialRampToValueAtTime(.0001, start + duration);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
      oscillator.start(start);
      oscillator.stop(start + duration + .02);
    }
    return true;
  } catch (_) { return false; }
}
