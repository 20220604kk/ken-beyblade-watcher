import { syncEsliteSession } from './sync.js';
let running = false;
async function sync() {
  if (running) return; running = true;
  try { await syncEsliteSession({ chrome, fetch }); } finally { running = false; }
}
chrome.cookies.onChanged.addListener(({ cookie, removed }) => {
  if (!removed && cookie.name === 'auth._token.prd' && ['eslite.com', '.eslite.com', 'www.eslite.com', '.www.eslite.com'].includes(cookie.domain)) void sync();
});
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'eslite-sync') void sync(); });
async function restore() { await chrome.alarms.create('eslite-sync', { periodInMinutes: 1 }); await sync(); }
chrome.runtime.onStartup.addListener(() => void restore());
chrome.runtime.onInstalled.addListener(() => void restore());
chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message.type !== 'configure') return;
  (async () => {
    if (!/^[A-Z]{1,4}$/.test(message.slot) || !/^[a-f0-9]{64}$/.test(message.token)) throw new Error('請輸入帳號代號與完整配對碼');
    await chrome.storage.local.set({ slot: message.slot, token: message.token, enabled: true, fingerprint: '', retryAt: 0 });
    await restore(); return { ok: true };
  })().then(reply, () => reply({ error: '設定失敗' })); return true;
});
void restore();
