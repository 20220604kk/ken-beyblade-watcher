import { amazonDomAction } from './dom.js';
import { accountIdentity } from './identity.js';

const ENDPOINT = 'ws://127.0.0.1:3210/amazon-race/socket';
let socket, prefs, transaction, tabId, busy = false, ready = false, cooldownUntil = 0, blocked = false, connectionError = '';
const requests = new Map();
let timer;
const state = async patch => chrome.storage.local.set(patch);
async function status(text) { await state({ status: text }); }
function rpc(type, body = {}) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('本機連線未建立'));
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => { requests.delete(id); reject(new Error('本機回應逾時；不重送購買動作')); }, 20_000);
    requests.set(id, { resolve, reject, deadline }); socket.send(JSON.stringify({ id, type, ...body }));
  });
}
async function call(command, expected = {}) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url?.startsWith('https://www.amazon.co.jp/')) throw new Error('背景分頁已離開日亞，暫停');
  const results = await chrome.scripting.executeScript({ target: { tabId }, func: amazonDomAction, args: [command, expected] });
  return results[0]?.result;
}
async function navigate(url, reload = false) {
  if (reload) await chrome.tabs.reload(tabId, { bypassCache: true });
  else await chrome.tabs.update(tabId, { url }); // Never activate the tab/window.
  await new Promise((resolve, reject) => {
    const finish = error => { chrome.tabs.onUpdated.removeListener(listener); clearTimeout(deadline); error ? reject(error) : resolve(); };
    const listener = (id, change) => { if (id === tabId && change.status === 'complete') finish(); };
    const deadline = setTimeout(() => finish(new Error('日亞分頁載入逾時')), 15_000);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then(t => { if (t.status === 'complete') finish(); }, finish);
  });
}
async function ensureTab(task) {
  if (Number.isInteger(tabId)) { try { await chrome.tabs.get(tabId); return; } catch { if (transaction) throw new Error('交易分頁已關閉，只能人工查單'); } }
  const tab = await chrome.tabs.create({ url: task.url, active: false });
  tabId = tab.id; await state({ tabId });
}
async function reportResult(page = {}, error = '') {
  const result = await rpc('result', { lease: transaction.lease, url: page.url, html: page.html, error });
  transaction.stage = result.status === 'ordered' ? 'done' : result.status === 'failed' ? 'failed' : 'unknown';
  transaction.retryAt = result.retryAt || '';
  if (result.status === 'failed' && result.retryAt && !blocked) cooldownUntil = Date.parse(result.retryAt);
  await state({ transaction });
  await status(result.orderId ? `插件訂單成立：${result.orderId}` : result.status === 'failed' ? `插件尚未送單，將自動重試：${error || '流程未完成'}` : '插件送單結果待核對；不再點擊送單');
  return result;
}
async function tick(inspect = false) {
  if (!ready || busy || !inspect && (blocked || Date.now() < cooldownUntil)) return;
  if (inspect && (!transaction || !['submitted', 'unknown', 'grant_consumed'].includes(transaction.stage))) return;
  busy = true; const started = Date.now();
  try {
    const task = await rpc('task');
    if (!transaction && task.recovery) {
      transaction = { lease: task.recovery.lease, stage: task.recovery.state === 'preparing' ? 'review' : 'unknown',
        startedAt: task.recovery.at, submittedAt: task.recovery.at };
      await state({ transaction });
    }
    if (transaction) {
      await ensureTab(task);
      if (transaction.stage === 'done' || transaction.stage === 'failed') {
        // Only failed PRE-SUBMISSION preparation can retry on the server's
        // budget. Never discard or replay a granted/unknown final send.
        const retry = transaction.stage === 'failed' && task.enabled && task.retryAt && Date.now() >= Date.parse(task.retryAt);
        if (retry || task.asin !== transaction.lease.asin || !task.pending || task.recovery && task.recovery.lease.waveId !== transaction.lease.waveId) { transaction = null; await state({ transaction: null }); }
        else return;
      } else {
        const page = await call('read');
        if (page?.blocked) throw new Error('需要登入／人工驗證，插件已暫停');
        if (page.complete && !['submitted', 'unknown', 'grant_consumed'].includes(transaction.stage)) {
          await reportResult(page, '送單前意外出現訂單確認畫面，保留查單，不自動重試'); return;
        }
        if (['submitted', 'unknown', 'grant_consumed'].includes(transaction.stage)) {
          if (page.complete) await reportResult(page);
          else if (transaction.stage !== 'unknown' && Date.now() - transaction.submittedAt > 25_000) await reportResult(page, '送單後未取得正式訂單編號');
          return;
        }
        if (!(await rpc('continue', { lease: transaction.lease })).allowed) { await reportResult({}, '另一條路已成功或任務已取消，本路未送單'); return; }
        if (page.stockChanged) { await reportResult(page, '結帳時庫存不足，本輪未送單；繼續監控重試'); return; }
        if (page.checkout) {
          const answer = await rpc('review', { lease: transaction.lease, url: page.url, html: page.html });
          if (answer.action === 'stop') { await reportResult({}, '本路送單前已停止'); return; }
          if (answer.action === 'jpy') {
            if (transaction.jpyTried) throw new Error('JPY 切換未完成，不送單');
            transaction.jpyTried = true; await state({ transaction }); await call('jpy'); return;
          }
          if (answer.action !== 'submit' || answer.grantId !== transaction.lease.attemptId) throw new Error('缺少一次性送單授權');
          transaction.stage = 'grant_consumed'; transaction.submittedAt = Date.now();
          await state({ transaction }); // Must succeed BEFORE the native click.
          const clicked = await call('submit', page);
          if (!clicked?.clicked) throw new Error('最終按鈕未完成點擊；授權不重用');
          transaction.stage = 'submitted'; await state({ transaction }); await status('02｜安全結帳｜已送出，等待訂單編號');
        } else if (Date.now() - transaction.startedAt > 25_000) await reportResult(page, '未進入安全結帳，未送出最終訂單');
        return;
      }
    }
    if (!task.enabled) { await status('任務停止，插件不刷新／不下單'); return; }
    await ensureTab(task);
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'loading') return;
    if (!tab.url?.includes('/dp/' + task.asin)) await navigate(task.url);
    else await navigate(task.url, true);
    const page = await call('read');
    if (page?.blocked) throw new Error('需要登入／人工驗證，插件已暫停');
    if (!page.product || !accountIdentity(page.account) || accountIdentity(page.account) !== accountIdentity(prefs.accountLabel)) throw new Error('Amazon 登入身份變更或未能核對，請在插件重新確認帳號');
    const answer = await rpc('product', { url: page.url, html: page.html });
    if (answer.action === 'buy') {
      transaction = { lease: answer.lease, stage: 'buy_consumed', startedAt: Date.now() };
      await state({ transaction }); // Buy Now is one-shot too; restart never re-clicks.
      if (!(await rpc('continue', { lease: transaction.lease })).allowed) { await reportResult({}, '送出直購前已取消'); return; }
      const clicked = await call('buy', page);
      if (!clicked?.clicked) throw new Error('立即購買按鈕未完成點擊');
      transaction.stage = 'review'; await state({ transaction }); await status('01｜商品頁面｜已按立即購買');
      cooldownUntil = 0; return; // Product refresh cadence must not delay checkout.
    } else await status('插件背景刷新中｜API 獨立執行');
    cooldownUntil = started + Math.max(2000, task.intervalMs || 2000);
  } catch (error) {
    // Navigation may destroy an executeScript reply after a perfectly valid
    // native click. Inspect the resulting page immediately; never re-click or
    // mistake this common transition for a failed send and cool down 60s.
    if (transaction && ['grant_consumed', 'submitted', 'buy_consumed'].includes(transaction.stage)) {
      if (transaction.stage === 'buy_consumed') transaction.stage = 'review';
      await state({ transaction }); cooldownUntil = Date.now() + 500;
      await status('頁面正在跳轉，僅核對結果；不重複點擊');
      return;
    }
    cooldownUntil = Date.now() + 60_000;
    blocked = /驗證|身份|登入|離開日亞/.test(error.message);
    await status(error.message);
    if (ready) {
      if (transaction && !['done', 'failed', 'unknown'].includes(transaction.stage)) {
        try {
          const result = await reportResult({}, error.message);
          if (!blocked && result.status === 'failed' && result.retryAt) cooldownUntil = Math.max(Date.now(), Date.parse(result.retryAt));
        } catch { /* consumed local state is retained */ }
      }
      try { await rpc('health', { state: blocked ? 'blocked' : 'paused', error: error.message }); } catch { /* reconnect is read-only for consumed grants */ }
    }
  } finally { busy = false; }
}
async function connect() {
  const saved = await chrome.storage.local.get(['prefs', 'transaction', 'tabId']);
  prefs = saved.prefs; transaction = saved.transaction; tabId = saved.tabId;
  if (!prefs?.enabled || socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket.readyState)) return;
  blocked = false;
  connectionError = '';
  socket = new WebSocket(ENDPOINT);
  const connection = socket;
  socket.onmessage = event => {
    const message = JSON.parse(event.data), pending = requests.get(message.id);
    if (message.type === 'inspect') { void tick(true); return; }
    if (message.error && !message.id) { connectionError = message.error; void status(connectionError); return; }
    if (pending) { requests.delete(message.id); clearTimeout(pending.deadline); message.error ? pending.reject(new Error(message.error)) : pending.resolve(message.result); }
  };
  socket.onopen = async () => {
    try {
      await rpc('auth', { token: prefs.token, slot: prefs.slot, accountConfirmed: true });
      ready = true;
      // Interrupted Buy Now can only inspect, never re-click. Interrupted final
      // send can only inspect completion, never request a fresh grant.
      if (transaction?.stage === 'buy_consumed') { transaction.stage = 'review'; await state({ transaction }); }
      await status('插件已連線；等待本機任務');
      clearInterval(timer); timer = setInterval(() => void tick(), 500); void tick();
    } catch (error) { await status(error.message); socket.close(); }
  };
  socket.onerror = () => {};
  socket.onclose = () => {
    if (socket !== connection) return;
    ready = false; clearInterval(timer);
    for (const p of requests.values()) { clearTimeout(p.deadline); p.reject(new Error('本機連線中斷；購買指令不重送')); }
    requests.clear(); socket = null;
    void status(connectionError || '插件未連線；API 不受影響');
  };
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.url !== chrome.runtime.getURL('popup.html')) return;
  if (message.type === 'connect') {
    // Saving a different mapping must not erase a pending one-use transaction.
    void (async () => {
      const old = await chrome.storage.local.get(['prefs', 'transaction']);
      if (old.transaction && !['done', 'failed'].includes(old.transaction.stage)) throw new Error('仍有交易待核對，不能更換配對');
      if (!/^[a-f0-9]{64}$/.test(message.token) || !['A', 'B', 'C'].includes(message.slot) || !message.accountLabel) throw new Error('配對資料不完整');
      await state({ prefs: { token: message.token, slot: message.slot, accountLabel: message.accountLabel, enabled: true } });
      socket?.close(); socket = null; await connect(); reply({ ok: true });
    })().catch(e => reply({ error: e.message }));
    return true;
  }
  if (message.type === 'inspect') {
    void chrome.tabs.query({ active: true, currentWindow: true }).then(async tabs => {
      const tab = tabs[0];
      if (!tab?.url?.startsWith('https://www.amazon.co.jp/')) throw new Error('請先在這個 Chrome 個人資料開啟日亞商品頁');
      const result = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => document.querySelector('#nav-link-accountList-nav-line-1')?.innerText.trim() || '' });
      reply({ accountLabel: result[0]?.result || '' });
    }).catch(e => reply({ error: e.message })); return true;
  }
});
chrome.alarms.create('reconnect', { periodInMinutes: 0.5 });
chrome.tabs.onUpdated.addListener((id, change) => { if (id === tabId && change.status === 'complete' && transaction) void tick(); });
chrome.alarms.onAlarm.addListener(() => { void connect(); if (ready) void rpc('ping').catch(() => {}); });
// Application-level traffic every 20s keeps Chrome 116+ MV3 workers alive.
setInterval(() => { if (ready) void rpc('ping').catch(() => {}); }, 20_000);
// MV3 service workers cannot use top-level await during registration.
void chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).then(() => connect());
