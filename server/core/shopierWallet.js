'use strict';
const { checkedBalance } = require('./storeMoney');
const { shopierError } = require('./shopierClient');
const TOPUP_LIMITS = Object.freeze({ minKurus: 10000, maxKurus: 1000000 });
function topupAmount(value) {
  if (!Number.isSafeInteger(value) || value < TOPUP_LIMITS.minKurus || value > TOPUP_LIMITS.maxKurus) throw shopierError('SHOPIER_TOPUP_AMOUNT_INVALID', 400);
  return value;
}
async function readWalletSettlement({ tx, db, order, refund, late, now }) {
  if (order.orderType !== 'wallet_topup') return null;
  const wallet = order.walletTopup || {}, previous = checkedBalance(wallet.netAppliedKurus || 0);
  let target = previous;
  if (!late && !refund.refundPending) target = order.totalKurus - refund.refundedKurus;
  else if (refund.refundedKurus) target = Math.min(previous, order.totalKurus - refund.refundedKurus);
  checkedBalance(target);
  const delta = target - previous;
  if (!delta) return { wallet, settled: !!wallet.settledAt };
  const userRef = db.collection('users').doc(order.uid), user = await tx.get(userRef);
  if (!user.exists) throw shopierError('SHOPIER_WALLET_ACCOUNT_MISSING', 409);
  const profile = user.data(), before = checkedBalance(profile.storeBalanceKurus ?? profile.storeWallet?.balanceKurus ?? 0);
  const debtBefore = checkedBalance(profile.storeWalletDebtKurus || 0);
  const debtSettled = delta > 0 ? Math.min(debtBefore, delta) : 0, removed = delta < 0 ? Math.min(before, -delta) : 0;
  const after = checkedBalance(delta > 0 ? before + delta - debtSettled : before - removed);
  const debtAfter = checkedBalance(delta > 0 ? debtBefore - debtSettled : debtBefore + -delta - removed);
  return { userRef, before, after, debtBefore, debtAfter, delta, now,
    ledgerRef: db.collection('storeWalletLedger').doc(`shopier_${order.id}_${target}`), settled: true,
    wallet: { ...wallet, netAppliedKurus: target, settledAt: wallet.settledAt || now,
      balanceAddedKurus: checkedBalance((wallet.balanceAddedKurus || 0) + Math.max(0, after - before)),
      debtSettledKurus: checkedBalance((wallet.debtSettledKurus || 0) + debtSettled), updatedAt: now } };
}
function applyWalletSettlement({ tx, db, order, settlement }) {
  if (!settlement?.delta) return;
  const { userRef, ledgerRef, before, after, debtBefore, debtAfter, delta, now } = settlement;
  tx.update(userRef, { storeBalanceKurus: after, storeWalletDebtKurus: debtAfter, storeUpdatedAt: now });
  tx.create(ledgerRef, { uid: order.uid, type: delta > 0 ? 'CREDIT' : 'DEBIT', amountKurus: after - before,
    balanceBeforeKurus: before, balanceAfterKurus: after, providerNetDeltaKurus: delta, debtBeforeKurus: debtBefore, debtAfterKurus: debtAfter,
    reason: delta > 0 ? 'Doğrulanmış Shopier bakiye yüklemesi' : 'Doğrulanmış Shopier bakiye yükleme iadesi',
    orderId: order.id, paymentMethod: 'shopier', actor: { uid: 'system', source: 'shopier-api-verified' }, createdAt: now });
  tx.create(db.collection('audit').doc(), { type: delta > 0 ? 'shopier.wallet.credited' : 'shopier.wallet.refunded',
    orderId: order.id, uid: order.uid, amountKurus: delta, balanceAfterKurus: after, debtAfterKurus: debtAfter, at: now });
}
module.exports = { TOPUP_LIMITS, topupAmount, readWalletSettlement, applyWalletSettlement };
