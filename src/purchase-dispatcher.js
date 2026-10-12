import { purchasePolicy, purchaseKeywordMatches } from './purchase-rules.js';

export function planAccountPurchase({ platform, product, settings, identity, ledger, at, purchased = false }) {
  const policy = purchasePolicy(platform, product, settings);
  if (!policy.eligible) return { ...policy, quantity: 0 };
  if (platform === 'eslite' && purchased) return { ...policy, eligible: false, quantity: 0, reason: 'permanent_limit' };
  const remaining = ledger.remaining(platform, identity, product.id, policy.dailyLimit, at);
  const quantity = Math.min(policy.quantity, remaining, Number(product.stock) > 0 ? Number(product.stock) : policy.quantity,
    platform === 'funbox' && Number(product.qtyCap) > 0 ? Number(product.qtyCap) : policy.quantity);
  return { ...policy, eligible: quantity > 0, quantity, remaining, reason: quantity > 0 ? 'eligible' : 'quota_used' };
}

export function sortPurchaseTasks(items, settings) {
  return [...items].sort((a, b) => {
    const left = purchasePolicy(a.platform, a.product, settings), right = purchasePolicy(b.platform, b.product, settings);
    return left.priority - right.priority || (left.keyword ? a.discoveryOrder - b.discoveryOrder : a.rank - b.rank);
  });
}

export function compatibleWithPayment(product, payment, settings) {
  return payment !== 'seven_cod' || !(settings.sevenCodBlockedKeywords || []).some(word => purchaseKeywordMatches(product.title, word));
}

export function selectAccountBatch(first, queue, settings, runnable) {
  if (settings.accountModes?.[first.accountSlot] !== 'batch') return [first];
  const selected = [first];
  for (const item of queue) {
    if (selected.length >= settings.batchMaxItems) break;
    if (item.platform === first.platform && item.accountIdentity === first.accountIdentity && item.accountSlot === first.accountSlot && runnable(item)) selected.push(item);
  }
  return selected;
}
