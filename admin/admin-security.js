import { escapeHtml } from './admin-core.js?v=zentra-ui-v90r1';

export function renderSecurityAssessment(security, { scoreHost, chip, levelHost, ring, checksHost, metricsHost, formatDate }) {
  const score = Math.max(0, Math.min(100, Number(security.score) || 0));
  scoreHost.textContent = String(score); chip.textContent = `${score}/100`;
  levelHost.textContent = String(security.level || 'Doğrulanmadı').toLocaleUpperCase('tr-TR');
  const color = security.criticalCount > 0 ? '#ff7485' : security.pendingCount > 0 ? '#e7b765' : 'var(--green)';
  ring.style.background = `radial-gradient(closest-side, #0b1322 80%, transparent 81%), conic-gradient(${color} ${score}%, #25324a 0)`;
  levelHost.style.color = color; chip.style.color = color;
  ring.closest('.security-overview')?.style.setProperty('--assessment-color', color);
  const fields = [['Son denetim', formatDate(security.checkedAt)], ['Kontrol', security.controlCount], ['Başarılı', security.passedCount],
    ['Başarısız', security.failedCount], ['Doğrulanmamış', security.unverifiedCount], ['Başarısız kritik kontrol', security.criticalCount], ['Çözüm bekleyen', security.pendingCount]];
  metricsHost.innerHTML = `<dl class="security-metrics">${fields.map(([key, value]) => `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value ?? '—')}</dd></div>`).join('')}</dl><p>${escapeHtml(security.scope || 'Doğrulanmış güvenlik değerlendirmesi henüz alınmadı.')}</p>`;
  const labels = { passed: 'Başarılı', failed: 'Başarısız', unverified: 'Doğrulanmamış', partial: 'Kısmen doğrulandı' };
  checksHost.innerHTML = (security.checks || []).map(check => `<article class="security-check ${check.ok ? 'is-ready' : ''}"><i class="fa-solid ${check.ok ? 'fa-circle-check' : check.status === 'unverified' ? 'fa-circle-question' : 'fa-triangle-exclamation'}" aria-hidden="true"></i><span><strong>${escapeHtml(check.label)}</strong><small>${escapeHtml(labels[check.status] || 'Doğrulanmamış')}${check.critical && !check.ok ? ' · KRİTİK KONTROL' : ''}</small><p>${escapeHtml(check.detail)}</p>${check.remediation ? `<p><strong>Gerekli işlem:</strong> ${escapeHtml(check.remediation)}</p>` : ''}</span><b>${escapeHtml(check.earned)}/${escapeHtml(check.weight)}</b></article>`).join('');
}
