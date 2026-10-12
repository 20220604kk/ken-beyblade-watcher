// Pure policy: no HTTP, timers, credentials or purchase side effects.
export function purchaseKeywordMatches(title, keyword) {
  const normalize = value => String(value || '').normalize('NFKC').toUpperCase().replace(/[‐‑‒–—―]/g, '-').replace(/\s+/g, ' ').trim();
  const source = normalize(title), target = normalize(keyword);
  if (!source || !target) return false;
  if (!/^[A-Z]+-\d+$/.test(target)) return source.includes(target);
  return new RegExp(`(^|[^A-Z0-9])${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![0-9])`, 'i').test(source);
}

export function purchasePolicy(platform, product, settings = {}) {
  const title = product.title || product.name || '';
  const black = (settings.skipBuyKeywords || []).find(word => purchaseKeywordMatches(title, word));
  if (black) return { eligible: false, reason: 'blacklist', keyword: black };
  const white = (settings.buyKeywords || []).find(word => purchaseKeywordMatches(title, word));
  if ((platform === 'funbox' || settings.buyMode === 'whitelist') && !white) return { eligible: false, reason: 'not_whitelisted' };
  const random = platform === 'funbox' && /隨機強化組/i.test(title);
  const index = (settings.priorityKeywords || []).findIndex(word => purchaseKeywordMatches(title, word));
  return { eligible: true, random, quantity: random ? 3 : platform === 'funbox' ? 1 : Number(settings.quantity) || 1,
    dailyLimit: platform === 'funbox' ? random ? 3 : 1 : null,
    priority: index < 0 ? Number.MAX_SAFE_INTEGER : index,
    keyword: index < 0 ? '' : settings.priorityKeywords[index],
    evidence: platform === 'eslite' ? 'confirmed_permanent' : random ? 'user_confirmed_daily_3' : 'manual_assumption_daily_1',
    resetEvidence: platform === 'funbox' ? 'manual_assumption_taipei_midnight' : 'never' };
}

export function normalizeDispatchSettings(settings = {}) {
  const modes = Object.fromEntries(Object.entries(settings.accountModes || {}).filter(([slot]) => /^[A-Z]{1,3}$/.test(slot))
    .map(([slot, mode]) => [slot, mode === 'batch' ? 'batch' : 'single']));
  const clamp = (value, low, high, fallback) => Number.isFinite(Number(value)) ? Math.max(low, Math.min(high, Math.floor(Number(value)))) : fallback;
  return { accountModes: modes, batchMaxItems: clamp(settings.batchMaxItems, 1, 20, 5),
    batchCollectMs: clamp(settings.batchCollectMs, 0, 2000, 500), batchBuildMs: clamp(settings.batchBuildMs, 1000, 20000, 8000),
    batchMaxTotal: clamp(settings.batchMaxTotal, 100, 100000, 1500),
    batchAllowPartial: settings.batchAllowPartial !== false,
    sevenCodBlockedKeywords: Array.isArray(settings.sevenCodBlockedKeywords) ? settings.sevenCodBlockedKeywords.filter(v => typeof v === 'string' && v.trim()) : [],
    ruleAssumptions: { funboxStandardDailyOne: 'manual', funboxMidnightReset: 'Asia/Taipei 00:00 manual' } };
}
