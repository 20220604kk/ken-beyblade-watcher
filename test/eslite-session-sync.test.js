import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import { EsliteSessionBridge } from '../src/eslite-session-bridge.js';
import { syncEsliteSession } from '../extensions/eslite-session-sync/sync.js';
import { esliteTokenCountdown } from '../src/eslite-purchase-ui.js';
import { LocalCredentialStore } from '../src/credential-store.js';

test('countdown uses real expiry, never resets to 24 hours or equates it to API readiness', () => {
  const now=Date.parse('2026-10-14T00:00:00Z');
  assert.equal(esliteTokenCountdown('2026-10-14T01:02:03Z',now).text,'01:02:03');
  assert.equal(esliteTokenCountdown('2026-10-14T01:02:03Z',now+1000).text,'01:02:02');
  assert.equal(esliteTokenCountdown('2026-10-13T00:00:00Z',now).text,'已到期');
  assert.equal(esliteTokenCountdown(null,now).text,'未取得');
});
test('local display identities reveal account and member name, never include password or tokens', () => {
  const store=new LocalCredentialStore('.');
  store.data={esliteAccounts:{C:{account:'fixture-phone',password:'PRIVATE'}},esliteMemberProfiles:{C:{name:'測試姓名'}}};
  const result=store.getEsliteDisplayIdentities();
  assert.equal(result.accounts.find(a=>a.slot==='C').account,'fixture-phone');
  assert.equal(result.accounts.find(a=>a.slot==='C').memberName,'測試姓名');
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE|password|token/);
  assert.notEqual(store.getEsliteMemberNames().C,'測試姓名');
});
test('connector sends only auth cookies; unchanged credential makes no extra API call; errors back off', async () => {
  let now=10000, calls=0, fail=false;
  const storage={enabled:true,slot:'C',token:'pairing',retryAt:0};
  const chrome={storage:{local:{get:async()=>storage,set:async v=>Object.assign(storage,v)}},cookies:{getAll:async()=>[
    {name:'auth._token.prd',value:'fixture',domain:'.eslite.com',path:'/'},
    {name:'tracking',value:'TRACKING',domain:'.eslite.com'}, {name:'auth._token.prd',value:'FOREIGN',domain:'.evil.test'}]}};
  const send=async (_url, options)=>{calls++;assert.doesNotMatch(options.body,/TRACKING|FOREIGN/);return {ok:!fail,json:async()=>({ok:!fail,expiresAt:'2026-10-15T00:00:00Z'})};};
  const run=()=>syncEsliteSession({chrome,fetch:send,now:()=>now});
  await run();await run();assert.equal(calls,1);assert.doesNotMatch(JSON.stringify(storage),/fixture|TRACKING|FOREIGN/);
  storage.fingerprint='';fail=true;await run();await run();assert.equal(calls,2);
  now+=60001;await run();assert.equal(calls,3);storage.enabled=false;now+=60001;await run();assert.equal(calls,3);
});
test('bridge requires explicit loopback pairing and authorized extension; delegates identity guard', async t => {
  let imports=0;
  const bridge=new EsliteSessionBridge({state:{data:{},save:async()=>{}},importSession:async body=>{imports++;return {ok:true,accountSlot:body.accountSlot};}});
  const server=http.createServer((req,res)=>void bridge.handle(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>server.close(r)));const base='http://127.0.0.1:'+server.address().port;
  const send=(route,origin,token='',body={})=>fetch(base+route,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Authorization:'Bearer '+token,'x-local-session-import':'1'},body:JSON.stringify(body)});
  assert.equal((await send('/eslite-browser/pair','https://evil.test')).status,400);
  const pair=await(await send('/eslite-browser/pair',base)).json();
  const origin='chrome-extension://'+'a'.repeat(32);
  assert.equal((await send('/eslite-browser/import',origin,'wrong',{accountSlot:'C'})).status,400);
  assert.equal((await send('/eslite-browser/import',origin,pair.token,{accountSlot:'C'})).status,200);
  assert.equal(imports,1);assert.equal((await send('/eslite-browser/import','chrome-extension://'+'b'.repeat(32),pair.token,{accountSlot:'C'})).status,400);
});
test('extension permissions are limited to eslite auth and localhost, not purchases or arbitrary sites', async()=>{
  const manifest=JSON.parse(await fs.readFile(new URL('../extensions/eslite-session-sync/manifest.json',import.meta.url),'utf8'));
  assert.deepEqual(manifest.permissions,['cookies','storage','alarms']);
  assert.equal(manifest.host_permissions.length,2);assert.equal(manifest.host_permissions.some(p=>p.includes('<all_urls>')),false);
});
