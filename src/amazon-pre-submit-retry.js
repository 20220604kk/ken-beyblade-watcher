export const AMAZON_PRE_SUBMIT_RETRY_LIMIT = 3;
export const AMAZON_PRE_SUBMIT_COOLDOWN_MS = 30_000;

// Only this persisted stage is proof that the FINAL order endpoint was not
// entered. An unknown Buy Now navigation is not an unknown final order POST.
export function canRecoverAmazonDirectIntent({ transaction: tx, asin, fastLane, submitted = false, raceState = '' }) {
  return Boolean(fastLane && !submitted && tx && !tx.accounted && tx.route === 'direct_buy_now'
    && tx.phase === 'buy_now' && tx.asin === asin && tx.quantity === 1
    && !['granted', 'unknown', 'ordered'].includes(raceState));
}

// Three consecutive failed preparations, then a cooling period, not a terminal
// task stop. Persisted so service restarts cannot erase the retry budget.
export function nextAmazonPreSubmitRetry(previous, { asin, now = Date.now(), minimumDelayMs = 0 } = {}) {
  const same = previous?.asin === asin;
  const cooled = same && previous.attempts >= AMAZON_PRE_SUBMIT_RETRY_LIMIT && now >= Date.parse(previous.nextRetryAt);
  const reset = !same || cooled || now - Date.parse(previous.failedAt || '') > 60_000;
  const attempts = (reset ? 0 : Number(previous.attempts) || 0) + 1;
  const delayMs = Math.max(minimumDelayMs, attempts >= AMAZON_PRE_SUBMIT_RETRY_LIMIT ? AMAZON_PRE_SUBMIT_COOLDOWN_MS : attempts === 1 ? 2000 : 5000);
  return { asin, attempts, failedAt: new Date(now).toISOString(), nextRetryAt: new Date(now + delayMs).toISOString(), delayMs };
}
