// Spreadsheet-style account labels: A … Z, AA … . No three-account limit.
export function isEsliteAccountSlot(value) {
  return typeof value === 'string' && /^[A-Z]{1,4}$/.test(value);
}

export function esliteSlotIndex(slot) {
  if (!isEsliteAccountSlot(slot)) return -1;
  return [...slot].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
}

export function esliteSlotLabel(index) {
  let n = index + 1, label = '';
  while (n > 0) { n--; label = String.fromCharCode(65 + n % 26) + label; n = Math.floor(n / 26); }
  return label;
}

export function esliteAccountSlots(extra = []) {
  return [...new Set(['A', 'B', 'C', ...extra].filter(isEsliteAccountSlot))]
    .sort((a, b) => esliteSlotIndex(a) - esliteSlotIndex(b));
}

export const esliteSlotClient = [isEsliteAccountSlot, esliteSlotIndex, esliteSlotLabel, esliteAccountSlots]
  .map(fn => fn.toString()).join('\n');
