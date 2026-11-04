import { escapeHtml } from './admin-core.js?v=zentra-ui-v88r1';

export function renderSecurityAssessment(security, { scoreHost, chip, levelHost, ring, checksHost, metricsHost, formatDate }) {
  const score = Math.max(0, Math.min(100, Number(security.score) || 0));
  scoreHost.textContent = String(score); chip.textContent = `${score}/100`;
  levelHost.textContent = String(security.level || 'Doğrulanmadı').toLocaleUpperCase('tr-TR');
  const color = security.criticalCount > 0 ? '#ff7485' : security.pendingCount > 0 ? '#e7b765' : 'var(--green)';
  ring.style.background = `conic-gradient(${color} ${score}%, rgba(92,240,173,.08) 0)`;
  const fields = [['Son denetim', formatDate(security.checkedAt)], ['Kontrol', security.controlCount], ['Başarılı', security.passedCount],
    ['Başarısız', security.failedCount], ['Doğrulanmamış', security.unverifiedCount], ['Kritik açık / eksik', security.criticalCount], ['Çözüm bekleyen', security.pendingCount]];
  metricsHost.innerHTML = `<dl class="security-metrics">${fields.map(([key, value]) => `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value ?? '—')}</dd></div>`).join('')}</dl><p>${escapeHtml(security.scope || 'Doğrulanmış güvenlik değerlendirmesi henüz alınmadı.')}</p>`;
  const labels = { passed: 'Başarılı', failed: 'Başarısız', unverified: 'Doğrulanmamış', partial: 'Kısmen doğrulandı' };
  checksHost.innerHTML = (security.checks || []).map(check => `<article class="security-check ${check.ok ? 'is-ready' : ''}"><i class="fa-solid ${check.ok ? 'fa-circle-check' : check.status === 'unverified' ? 'fa-circle-question' : 'fa-triangle-exclamation'}" aria-hidden="true"></i><span><strong>${escapeHtml(check.label)}</strong><small>${escapeHtml(labels[check.status] || 'Doğrulanmamış')}${check.critical && !check.ok ? ' · KRİTİK' : ''}</small><p>${escapeHtml(check.detail)}</p></span><b>${escapeHtml(check.earned)}/${escapeHtml(check.weight)}</b></article>`).join('');
}
