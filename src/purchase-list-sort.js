export function sortPurchaseListText(text) {
  const collator = new Intl.Collator('zh-Hant', { numeric: true, sensitivity: 'base' });
  const key = value => value.normalize('NFKC').replace(/[‐‑‒–—―]/g, '-');
  const isModel = value => /^[A-Z]+-\d+/i.test(key(value));
  return String(text ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    .sort((a, b) => Number(isModel(b)) - Number(isModel(a)) || collator.compare(key(a), key(b)))
    .join('\n');
}

export function sortAutoPurchaseList(platform, list) {
  if (!['funbox', 'eslite'].includes(platform) || !['black', 'white'].includes(list)) return;
  const input = document.getElementById(platform + (list === 'black' ? '-skip-buy-keywords' : '-buy-keywords'));
  if (!input) return;
  const sorted = sortPurchaseListText(input.value);
  const changed = sorted !== input.value;
  if (changed) {
    input.value = sorted;
    markAutoPurchaseDirty(platform);
  }
  const state = document.getElementById('auto-purchase-' + platform + '-state');
  if (state) state.textContent = (list === 'black' ? '黑名單' : '白名單') +
    (changed ? '已排序，請按「儲存自動下單設定」。' : '已是排序順序，無需調整。');
}

export const purchaseListSortClient = `${sortPurchaseListText.toString()}\n${sortAutoPurchaseList.toString()}`;
