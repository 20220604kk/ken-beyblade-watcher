const VIEW_KEYS = {
  overview: [],
  funbox: ['funbox','funboxSandbox','autoPurchase'],
  shopping: ['shoppingSites','shopee','autoPurchase'],
  japan: ['japanAuctions'],
  shared: ['funbox','shoppingSites','japanAuctions','autoPurchase','note','lastSelfCheck','notifications']
};
const LOG_KEYS = {
  funbox: ['funboxLogs'],
  shopping: ['shoppingLogs','shoppingSiteLogs'], japan: ['japanLogs'], shared: ['logs']
};

export function dashboardOverview(s, now = Date.now()) {
  const f = s.funbox || {}, shop = s.shoppingSites || {}, japan = s.japanAuctions || {};
  const amazon = japan.amazonJp || {}, purchase = s.autoPurchase || {};
  const sources = [];
  const add = (id, name, tab, enabled, withinHours, scanning, seconds, lastAt, error, count) => {
    const ageSeconds = lastAt ? Math.max(0, Math.round((now - Date.parse(lastAt)) / 1000)) : null;
    const stale = enabled && withinHours && ageSeconds !== null && ageSeconds > Math.max(120, seconds * 4);
    const state = !enabled ? 'paused' : !withinHours ? 'scheduled' : error ? 'error' : stale ? 'stale' : scanning ? 'scanning' : lastAt ? 'ready' : 'starting';
    sources.push({ id, name, tab, state, seconds, lastAt: lastAt || null, count, error: enabled ? String(error || '').slice(0, 320) : '', ageSeconds });
  };
  add('funbox','Funbox 官網','funbox',f.enabled,f.withinActiveHours,f.scanning,f.effectiveIntervalSeconds || f.intervalSeconds,f.lastScan?.completedAt,f.lastScan?.errors?.join('；'),f.seenCount);
  for (const t of shop.targets || []) {
    if (/mmtoy/i.test(t.id || '')) continue;
    add(t.id,t.name || t.siteName,'shopping',shop.enabled && t.enabled !== false,t.withinActiveHours,t.scanning,t.effectiveIntervalSeconds || shop.intervalSeconds,t.lastScanAt,t.lastError,t.productCount);
  }
  add('amazon','Amazon.co.jp 原價','japan',amazon.enabled !== false,true,amazon.scanning,amazon.effectiveIntervalSeconds || 20,amazon.lastScanAt,amazon.lastError,amazon.lastKnownCount);
  for (const t of japan.targets || []) add(t.id,t.name || t.siteName,'japan',japan.enabled && t.enabled !== false,japan.withinActiveHours,t.scanning,t.effectiveIntervalSeconds || japan.intervalSeconds,t.lastScanAt,t.lastError,t.productCount);
  const orders = ['funbox','eslite'].map((id) => ({
    id, enabled: Boolean(purchase.enabled && purchase[id]?.enabled),
    label: ({funbox:'Funbox 多帳號',eslite:'誠品',momo:'momo',kingstone:'墊腳石'})[id],
    tab: id === 'funbox' ? 'funbox' : 'shopping', state: id === 'eslite'
      ? eslitePurchaseReadinessLabel(purchase.runtime?.eslite?.accounts || [])
      : purchase.processing ? '處理中' : '待命'
  }));
  for (const item of japan.amazonJpProductOrders || []) {
    const checking = item.running && ['checking', 'inspecting'].includes(item.phase);
    const state = item.lastError
      ? '需要查看'
      : item.phase === 'ordering' || item.status === 'ordering'
        ? '下單中'
        : checking
          ? item.phase === 'inspecting' ? '只讀檢查' : item.mode === 'hybrid' ? '五秒巡檢' : '訊號驗證'
          : item.status === 'completed'
            ? '本輪完成'
            : item.status === 'needs_login'
              ? '需要登入'
              : item.mode === 'hybrid' ? '五秒待命' : '等待補貨';
    orders.push({ id: `amazonJpProductOrder${item.slot || ''}`, label: `日亞商品頁 ${item.slot || ''}`, tab: 'japan', enabled: Boolean(item.enabled), state, error: item.enabled ? item.lastError || '' : '' });
  }
  return {
    sources, orders, queued: purchase.queued || 0,
    notifications: { public: Boolean(s.notifications?.availability?.discordPublic), japan: Boolean(s.notifications?.availability?.discordJapan), private: Boolean(s.notifications?.availability?.discordPrivate) }
  };
}

export function eslitePurchaseReadinessLabel(accounts) {
  const enabled = accounts.filter((account) => account.enabled !== false);
  if (enabled.some((account) => account.busy || account.state === 'busy')) return '處理中';
  const ready = enabled.filter((account) => account.apiReady && !account.purchaseHold).length;
  if (ready) return `快線就緒 ${ready}／${enabled.length}`;
  if (enabled.some((account) => account.purchaseHold)) return '訂單待核對';
  if (enabled.some((account) => account.sessionRecoveryState === 'recovering')) return '背景登入恢復中';
  if (enabled.some((account) => account.loginState === 'needs_login')) return '需要登入';
  return enabled.some((account) => account.heartbeatEnabled) ? '預熱檢查中' : '心跳休眠';
}

export function dashboardStatusForView(status, view, { logs = false } = {}) {
  if (!Object.hasOwn(VIEW_KEYS, view)) return status;
  const result = { overview: dashboardOverview(status), performance: status.performance, notifications: status.notifications, systemPause: status.systemPause };
  for (const key of VIEW_KEYS[view]) if (Object.hasOwn(status, key)) result[key] = status[key];
  if (logs) for (const key of LOG_KEYS[view] || []) if (Object.hasOwn(status, key)) result[key] = status[key];
  // Keep monitoring responses and baselines intact; trim presentation history only.
  if (result.autoPurchase) result.autoPurchase = { ...result.autoPurchase, recent: result.autoPurchase.recent?.slice(0, 15) };
  if (result.shopee && !logs) {
    result.shopee = { ...result.shopee };
    delete result.shopee.logs;
  }
  return result;
}
