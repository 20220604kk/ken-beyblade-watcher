import { collectShopeeDom, collectShopeePdp } from './collector.js';
import { validatePairingToken } from './pairing.js';
const BASE = 'http://127.0.0.1:3210';
let polling = false;
async function request(path, body, token) {
  const response = await fetch(BASE + path, {method:'POST', headers:{'Content-Type':'application/json',Authorization:'Bearer '+token}, body:JSON.stringify(body), signal:AbortSignal.timeout(8000)});
  const data = await response.json(); if(!response.ok) throw new Error(data.error || '本機連接失敗'); return data;
}
const pause = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function scan(plan, token) {
  const { bindings = {} } = await chrome.storage.local.get('bindings');
  let tab, old = bindings[plan.id];
  if (old?.url === plan.url) { try { tab = await chrome.tabs.get(old.tabId); } catch { /* User closed this dedicated tab. */ } }
  // Never navigate/reload a tab that the user has taken away from its target.
  if (tab && tab.url !== plan.url && !tab.url?.startsWith('https://shopee.tw/verify/')) tab = null;
  let created = false;
  if (!tab) {
    tab = await chrome.tabs.create({url:plan.url, active:false});
    created = true;
    const latest = (await chrome.storage.local.get('bindings')).bindings || {};
    latest[plan.id] = {tabId:tab.id,url:plan.url}; await chrome.storage.local.set({bindings:latest});
  }
  const execute = async func => {
    const start = Date.now();
    let lastError;
    while (Date.now()-start < 22000) {
      try {
        const result = await chrome.scripting.executeScript({
          target:{tabId:tab.id},
          world: func === collectShopeePdp ? 'MAIN' : 'ISOLATED',
          func,
          args:[plan]
        });
        const value = result[0]?.result;
        if (value && (func === collectShopeePdp || value.rendered || value.accessText
          || /\/verify\/|\/buyer\/login/.test(value.finalUrl || ''))) return value;
      } catch { lastError = '讀取失敗'; }
      await pause(1000);
    }
    return {finalUrl:plan.url,rendered:false,items:[],loginState:'unknown',accessText:lastError || '讀取逾時'};
  };
  // Known item IDs take the fast lane: small read-only PDP requests, no page
  // reload and no cart mutation.  This continues to work even when the search
  // page itself is waiting for a traffic-verification cooldown.
  let probe = plan.probeProducts?.length ? await execute(collectShopeePdp) : null;
  let discovery = null;
  let discoveryAttempted = false;
  let current;
  try { current = await chrome.tabs.get(tab.id); } catch { current = tab; }
  const onVerify = current.url?.startsWith('https://shopee.tw/verify/');
  if (plan.kind === 'search' && plan.discoveryDue && (!onVerify || plan.allowVerifyRecovery)) {
    discoveryAttempted = true;
    try {
      if (!created) {
        await chrome.tabs.update(tab.id, { url: plan.url });
        const navigationStart = Date.now();
        while (Date.now() - navigationStart < 22000) {
          const state = await chrome.tabs.get(tab.id);
          if (state.status === 'complete' || state.url?.startsWith('https://shopee.tw/verify/')) break;
          await pause(500);
        }
      }
      discovery = await execute(collectShopeeDom);
    } catch { discovery = {finalUrl:plan.url,rendered:false,items:[],loginState:'unknown',accessText:'賣場探索讀取失敗'}; }
  } else if (plan.kind === 'product' && !probe?.rendered) {
    discovery = await execute(collectShopeeDom);
  }
  const merged = new Map();
  for (const item of [...(discovery?.items || []), ...(probe?.items || [])]) {
    const old = merged.get(item.productUrl);
    if (!old || item.availability !== 'unknown') merged.set(item.productUrl, item);
  }
  const healthyProbe = probe?.rendered && probe.items?.length;
  const healthyDiscovery = discovery?.rendered && discovery.items?.length;
  let observation = healthyProbe || healthyDiscovery ? {
    finalUrl: plan.url,
    rendered: true,
    httpStatus: 200,
    transport: healthyProbe ? 'pdp-api' : 'dom',
    mode: healthyDiscovery ? 'probe+discovery' : 'probe',
    loginState: probe?.loginState === 'logged-in' || discovery?.loginState === 'logged-in' ? 'logged-in' : 'unknown',
    accessText: '',
    items: [...merged.values()],
    diagnostics: {...(discovery?.diagnostics || {}), ...(probe?.diagnostics || {}),
      discoveryAttempted, discoveryHealthy:Boolean(healthyDiscovery), discoverySkipped:onVerify && !plan.allowVerifyRecovery}
  } : discovery || probe || {finalUrl:plan.url,rendered:false,items:[],loginState:'unknown',accessText:'讀取逾時'};
  observation.diagnostics = {...(observation.diagnostics || {}), discoveryAttempted,
    discoveryHealthy:Boolean(healthyDiscovery), discoverySkipped:onVerify && !plan.allowVerifyRecovery};
  await request('/shopee/bridge/report',{id:plan.id,scanId:plan.scanId,observation},token);
}
async function poll() {
  if(polling) return; polling = true;
  try {
    const {token,enabled} = await chrome.storage.local.get(['token','enabled']);
    if(!token || !enabled) return;
    const {targets} = await request('/shopee/bridge/poll',{},token);
    // Sequential tab setup avoids losing bindings; independent scan failures do
    // not affect other sites or the watcher server's existing scheduler.
    let scanFailed = false;
    for(const plan of targets) {
      if (!(await chrome.storage.local.get('enabled')).enabled) break;
      try { await scan(plan,token); } catch { scanFailed=true; await chrome.storage.local.set({lastError:'蝦皮分頁或回報失敗，請到儀表重新檢查'}); }
    }
    await chrome.storage.local.set({lastPollAt:new Date().toISOString()});
    if(!scanFailed) await chrome.storage.local.set({lastError:''});
  } catch(e) { await chrome.storage.local.set({lastError:e.message}); }
  finally {polling=false;}
}
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name==='shopee')void poll();});
let restoring;
function restoreConnection() {
  if (restoring) return restoring;
  restoring = (async()=>{
    const {enabled,token} = await chrome.storage.local.get(['enabled','token']);
    // Updates/reloads may clear alarms. Respect an explicit stop and preserve
    // the existing paired token; never reset a surviving alarm's next deadline.
    if (!enabled || !token) return;
    const alarm = await chrome.alarms.get('shopee');
    if (!alarm) await chrome.alarms.create('shopee',{periodInMinutes:0.5});
    await poll();
  })().catch(()=>chrome.storage.local.set({lastError:'無法恢復蝦皮排程，請重新載入連接器'})).finally(()=>{restoring=undefined;});
  return restoring;
}
chrome.runtime.onStartup.addListener(restoreConnection);
chrome.runtime.onInstalled.addListener(restoreConnection);
chrome.runtime.onMessage.addListener((message,_sender,reply)=>{
  if(message.type==='connect') {
    (async()=>{
      const token = validatePairingToken(message.token);
      await chrome.storage.local.set({token,enabled:true,lastError:''});
      await chrome.alarms.create('shopee',{periodInMinutes:0.5});
      await poll(); return {ok:true};
    })().then(reply,e=>reply({error:e.message}));return true;
  }
  if(message.type==='disconnect') {
    chrome.storage.local.set({enabled:false}).then(()=>chrome.alarms.clear('shopee')).then(()=>reply({ok:true})); return true;
  }
});
// A service-worker start is not necessarily a browser onStartup event.
void restoreConnection();
