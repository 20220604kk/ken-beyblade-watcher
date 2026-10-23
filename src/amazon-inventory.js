// Public ASIN metadata supplied by the owner on 2026-10-23. These are discovery
// seeds, not proof of stock, price, seller, or permission to place an order.
export const AMAZON_INVENTORY_SEEDS = [
  ['B0FCLJ67NK', 'CX-07', 'ペガサスブラストATr'],
  ['B0C52SMHWN', 'BX-09', 'ベイバトルパス'],
  ['B0H861Y9Y3', 'UX-21', 'ヘルズネザーデッキセット'],
  ['B0GS4F6977', 'UX-19', 'バレットグリフォンH'],
  ['B0CV7HF3W6', 'UX-01', 'ドランバスター'],
  ['B0GS4M7T5B', 'BX-49', 'ドランストライク'],
  ['B0HJ75X3PN', 'BX-53', 'オールインワンセット'],
  ['B0H4PPV8MR', 'UX-20', 'グローリーワルキューレLF'],
  ['B0DC66WCDV', 'BX-36', 'ランダムブースター ホエールウェーブセレクト'],
  ['B0DMSQ57X5', 'UX-11', 'インパクトドレイク'],
  ['B0HJ783F18', 'BX-52', 'ラスタードラグーン'],
  ['B0HCXR5PWS', 'CX-19', 'ランダムブースター クロコトレッドセレクト']
].map(([asin, code, name]) => ({ asin, code, title: `BEYBLADE X ${code} ${name}` }));

export function amazonInventoryRetryMs(error) {
  return error?.code === 'AMAZON_PRODUCT_NOT_FOUND' ? 300_000 : 30_000;
}

export function amazonInventoryCandidates(entries, attempts = {}, delegated = new Set(), now = Date.now()) {
  return entries.filter(entry => !delegated.has(entry.asin)
    && !(Date.parse(attempts[entry.asin]?.retryAt || '') > now))
    .sort((a, b) => (Date.parse(attempts[a.asin]?.at || '') || 0) - (Date.parse(attempts[b.asin]?.at || '') || 0)
      || a.asin.localeCompare(b.asin));
}

export function amazonInventoryNextDelay(startedAt, now, error = null) {
  if (['AMAZON_RATE_LIMITED', 'AMAZON_VERIFICATION_REQUIRED', 'AMAZON_LOGIN_REQUIRED'].includes(error?.code)) return Math.max(60_000, error.retryAfterMs || 0);
  return Math.max(100, (error ? 2000 : 1000) - Math.max(0, now - startedAt));
}
