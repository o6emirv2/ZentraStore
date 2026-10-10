import { escapeViewText as text, viewIcon as icon } from './view-utils.js?v=zentra-ui-v71';

export function renderProductPlans(plans = [], selectedKey = '', { formatPrice, channelFor } = {}) {
  return plans.map((plan) => {
    const channel = channelFor(plan);
    const selected = plan.key === selectedKey;
    const delivery = channel.automaticReady ? 'Otomatik teslimat' : channel.telegramOpen ? 'Telegram ile sipariş' : channel.deliveryLabel;
    return `<button class="detail-plan${selected ? ' is-selected' : ''}" type="button" data-purchase-plan="${text(plan.key)}" aria-pressed="${selected}"><span class="detail-plan__check">${icon(selected ? 'fa-circle-check' : 'fa-circle')}</span><span class="detail-plan__copy"><strong>${text(plan.label)}</strong><small>${text(plan.duration)} · ${text(delivery)}</small></span><b>${text(formatPrice(plan.priceKurus))}</b></button>`;
  }).join('');
}

export function renderProductSummary(plan, { formatPrice, channel } = {}) {
  if (!plan) return '<span><small>Paket seçimi</small><strong>Satın alınabilir paket bulunmuyor</strong></span><b>—</b>';
  return `<span><small>Seçiminiz</small><strong>${text(plan.label)} · ${text(plan.duration)}</strong><em>${text(channel.automaticReady ? 'Otomatik teslimat' : channel.telegramOpen ? 'Telegram ile sipariş' : channel.deliveryLabel)}</em></span><b>${text(formatPrice(plan.priceKurus))}</b>`;
}

export function renderProductFeatures(features = []) {
  return features.map((feature) => `<li>${icon('fa-check')}<span>${text(feature)}</span></li>`).join('');
}
