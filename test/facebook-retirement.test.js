import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createDashboard } from '../src/dashboard.js';
import { dashboardOverview } from '../src/dashboard-status.js';
import { enforceFacebookArchive, activeProjectConfig, retireFacebookState, withoutFacebookStatus, isArchivedFacebookRequest, FacebookScanner, FormAutoFill } from '../src/facebook-retired.js';

test('legacy enable/resume settings cannot reactivate Facebook or forms', () => {
  const config={ monitoringEnabled:true, pages:[{url:'https://facebook.com/example'}], hotspot:{enabled:true,autoFillEnabled:true}, funbox:{enabled:true}, notifications:{facebook:'discord',funbox:'discord'} };
  enforceFacebookArchive(config);
  config.monitoringEnabled=true;
  config.hotspot.enabled=true;
  config.hotspot.autoFillEnabled=true;
  assert.equal(config.monitoringEnabled,false);
  assert.equal(config.hotspot.enabled,false);
  assert.equal(config.hotspot.autoFillEnabled,false);
  assert.deepEqual(config.pages,[]);
  const active=activeProjectConfig(config);
  assert.equal(active.hotspot,undefined);
  assert.equal(active.pages,undefined);
  assert.equal(active.notifications.facebook,undefined);
  assert.equal(active.funbox.enabled,true);
  const scanner=new FacebookScanner();
  assert.equal(scanner.getOpenPageCount(),0);
  assert.equal(new FormAutoFill({profileSlot:1}).getStatus().browserOpen,false);
});
test('retiring Facebook state preserves commerce orders and baselines', () => {
  const commerce={autoPurchase:{records:{order:{id:'123'}}},funbox:{seen:{product:{stock:2}}}};
  const state={seen:{post:{}},forms:{form:{}},initializedPages:{page:{}},facebookAccess:{},lastScan:{},commerce};
  retireFacebookState(state);
  assert.equal(state.commerce,commerce);
  assert.deepEqual(state.seen,{});
  assert.deepEqual(state.forms,{});
  assert.equal(state.facebookAccess,undefined);
});
test('active dashboard excludes Facebook panel, source and notification settings', async () => {
  const source=await fs.readFile(new URL('../src/dashboard.js',import.meta.url),'utf8');
  assert.doesNotMatch(source,/<main id="tab-fb"|<button id="tab-button-fb"|id="facebook-notification-mode"|id="shared-fb-status"/);
  const s=withoutFacebookStatus({pages:[{}],hotspot:{},autoFill:{},notifications:{facebook:'discord',funbox:'discord'},funbox:{enabled:true}});
  assert.equal(s.pages,undefined);
  assert.equal(s.notifications.facebook,undefined);
  assert.equal(dashboardOverview(s).sources.some(x=>x.id==='fb'),false);
});
test('archived routes return 410 before reading data or invoking callbacks', async () => {
  let called=false;
  const server=createDashboard({port:0,log:()=>{},onScan:()=>{called=true;},getStatus:()=>({funbox:{}})});
  await new Promise(resolve=>server.listening?resolve():server.once('listening',resolve));
  try {
    const base='http://127.0.0.1:'+server.address().port;
    for(const [method,url] of [['POST','/scan'],['POST','/monitor/start'],['POST','/hotspot'],['POST','/google-login'],['GET','/api/form-preview'],['GET','/api/autofill-profile?slot=1'],['GET','/api/status?view=fb']]) {
      assert.equal(isArchivedFacebookRequest(url),true);
      const response=await fetch(base+url,{method});
      assert.equal(response.status,410);
      assert.equal((await response.json()).code,'facebook_archived');
    }
    assert.equal(called,false);
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
