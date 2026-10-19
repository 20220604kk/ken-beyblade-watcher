import { runEdionPlan } from './runner.js';
const BASE = 'http://127.0.0.1:3210';
let polling = false;
async function request(path, body, token) {
  const response = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || '本機連接失敗'); return data;
}
async function poll() {
  if (polling) return; polling = true;
  try {
    const { token, enabled } = await chrome.storage.local.get(['token', 'enabled']); if (!enabled || !token) return;
    const { targets } = await request('/edion-browser/bridge/poll', { protocol: 2 }, token);
    for (const plan of targets) await runEdionPlan(plan, { chrome, request, token });
    await chrome.storage.local.set({ lastError: '', lastPollAt: new Date().toISOString() });
  } catch (error) { await chrome.storage.local.set({ lastError: error.message }); }
  finally { polling = false; }
}
async function restore() {
  const { enabled, token } = await chrome.storage.local.get(['enabled', 'token']);
  if (!enabled || !token) return;
  if (!await chrome.alarms.get('edion')) await chrome.alarms.create('edion', { periodInMinutes: 0.5 });
  await poll();
}
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'edion') void poll(); });
chrome.runtime.onStartup.addListener(() => void restore());
chrome.runtime.onInstalled.addListener(() => void restore());
chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  (async () => {
    if (message.type === 'connect') {
      const token = String(message.token || '').replace(/\s|\u200B/g, '').toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('請貼上完整 64 字元配對碼');
      // Authenticate first; never save an invalid pairing as enabled.
      await request('/edion-browser/bridge/check', {}, token);
      await chrome.storage.local.set({ token, enabled: true, lastError: '' });
      await restore(); return { ok: true };
    }
    if (message.type === 'disconnect') {
      await chrome.storage.local.set({ enabled: false }); await chrome.alarms.clear('edion'); return { ok: true };
    }
    throw new Error('未知操作');
  })().then(reply, error => reply({ error: error.message }));
  return true;
});
void restore();
