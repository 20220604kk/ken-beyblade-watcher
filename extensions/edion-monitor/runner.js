import { collectEdionDom } from './collector.js';
export function sameEdionPage(value, expected) {
  try {
    const normalize = value => { const u = new URL(value); if (u.protocol !== 'https:' || !['www.edion.com', 'edion.com'].includes(u.hostname) || u.username || u.password || u.port) return ''; u.hostname = 'www.edion.com'; u.hash = ''; u.searchParams.sort(); return u.href; };
    return Boolean(normalize(value)) && normalize(value) === normalize(expected);
  } catch { return false; }
}
export async function runEdionPlan(plan, { chrome, request, token, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if (!sameEdionPage(plan.url, plan.url) || new URL(plan.url).pathname !== '/item_list.html') throw new Error('愛電王監控網址異常');
  if (!(await chrome.storage.local.get('enabled')).enabled || !(await request('/edion-browser/bridge/check', { id: plan.id }, token)).enabled) return;
  const bindings = (await chrome.storage.local.get('bindings')).bindings || {};
  let tab; const binding = bindings[plan.id];
  if (binding) { try { const candidate = await chrome.tabs.get(binding.tabId); if (sameEdionPage(candidate.url, plan.url)) tab = candidate; } catch { /* closed */ } }
  const observe = async () => {
    const result = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', func: collectEdionDom });
    return result[0]?.result || { url: plan.url, health: 'unreadable', items: [] };
  };
  if (!tab) {
    tab = await chrome.tabs.create({ url: plan.url, active: false });
    bindings[plan.id] = { tabId: tab.id, url: plan.url }; await chrome.storage.local.set({ bindings });
  } else if (plan.action === 'reload') {
    // A stale server plan must never reload a challenge that has just appeared.
    const before = await observe();
    if (before.health === 'verification_required') {
      await request('/edion-browser/bridge/report', { id: plan.id, scanId: plan.scanId, observation: before }, token);
      return;
    }
    if ((await chrome.tabs.get(tab.id)).active) {
      // Do not reload while the user is interacting with this page.
      await request('/edion-browser/bridge/report', { id: plan.id, scanId: plan.scanId, observation: before }, token);
      return;
    }
    if (!(await chrome.storage.local.get('enabled')).enabled || !(await request('/edion-browser/bridge/check', { id: plan.id }, token)).enabled) return;
    await chrome.tabs.reload(tab.id);
    await pause(1000);
  }
  let observation;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (!(await chrome.storage.local.get('enabled')).enabled) return;
    if (!sameEdionPage((await chrome.tabs.get(tab.id)).url, plan.url)) return;
    try { observation = await observe(); } catch { observation = { url: plan.url, health: 'unreadable', items: [] }; }
    if (observation.health !== 'unreadable') break;
    await pause(1000);
  }
  await request('/edion-browser/bridge/report', { id: plan.id, scanId: plan.scanId, observation }, token);
}
