import { collectEdionDom } from './collector.js';
// Ordinary first-party GET in the browser. No UI changes, token extraction,
// CAPTCHA interaction, header spoofing or alternate security endpoints.
export async function fetchEdionHtml(url) {
  try {
    const input = new URL(url);
    if (input.origin !== location.origin || input.pathname !== '/item_list.html') return { health: 'unreadable' };
    const response = await fetch(url, { method: 'GET', credentials: 'same-origin', mode: 'same-origin',
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000) });
    const retry = response.headers.get('retry-after');
    const retryAfterSeconds = retry ? Math.max(0, /^\d+$/.test(retry) ? Number(retry) : (Date.parse(retry) - Date.now()) / 1000) : 0;
    if (!response.ok) return { health: [403,429].includes(response.status) ? 'verification_required' : 'unreadable',
      httpStatus: response.status, retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : 0 };
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > 2000000 || bytes.byteLength < 900) return { health: 'unreadable', httpStatus: response.status };
    const head = new TextDecoder().decode(bytes.slice(0,2000));
    const charset = (response.headers.get('content-type') || head).match(/charset\s*=\s*["']?([\w-]+)/i)?.[1] || 'utf-8';
    const html = new TextDecoder(charset).decode(bytes);
    return { html, httpStatus: response.status };
  } catch { return { health: 'unreadable' }; }
}
export function sameEdionPage(value, expected) {
  try {
    const normalize = value => { const u = new URL(value); if (u.protocol !== 'https:' || !['www.edion.com', 'edion.com'].includes(u.hostname) || u.username || u.password || u.port) return ''; u.hostname = 'www.edion.com'; u.hash = ''; u.searchParams.sort(); return u.href; };
    return Boolean(normalize(value)) && normalize(value) === normalize(expected);
  } catch { return false; }
}
export async function runEdionPlan(plan, { chrome, request, token, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if (!sameEdionPage(plan.url, plan.url) || new URL(plan.url).pathname !== '/item_list.html') throw new Error('愛電王監控網址異常');
  if (plan.action !== 'fetch') return;
  if (!(await chrome.storage.local.get('enabled')).enabled || !(await request('/edion-browser/bridge/check', { id: plan.id }, token)).enabled) return;
  const bindings = (await chrome.storage.local.get('bindings')).bindings || {};
  let tab; const binding = bindings[plan.id];
  if (binding) { try { const candidate = await chrome.tabs.get(binding.tabId); if (sameEdionPage(candidate.url, plan.url)) tab = candidate; } catch { /* closed */ } }
  if (plan.action === 'fetch') {
    if (!tab) {
      // A single inactive anchor tab provides the first-party origin. Never
      // activate/focus it or open a verification window.
      tab = await chrome.tabs.create({ url: plan.url, active: false });
      bindings[plan.id] = { tabId: tab.id, url: plan.url }; await chrome.storage.local.set({ bindings });
      await pause(1000);
    }
    if (!(await chrome.storage.local.get('enabled')).enabled || !(await request('/edion-browser/bridge/check', { id: plan.id }, token)).enabled) return;
    const reads = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', func: fetchEdionHtml, args: [plan.url] });
    const fetched = reads[0]?.result || { health: 'unreadable' };
    let observation = { url: plan.url, health: fetched.health || 'unreadable', items: [], httpStatus: fetched.httpStatus,
      retryAfterSeconds: fetched.retryAfterSeconds, fetched: true };
    if (fetched.html) {
      const parsed = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', func: collectEdionDom, args: [fetched.html, plan.url] });
      observation = { ...observation, ...(parsed[0]?.result || {}), fetched: true };
    }
    if (!(await chrome.storage.local.get('enabled')).enabled || !sameEdionPage((await chrome.tabs.get(tab.id)).url, plan.url)) return;
    await request('/edion-browser/bridge/report', { id: plan.id, scanId: plan.scanId, observation }, token);
    return;
  }
}
