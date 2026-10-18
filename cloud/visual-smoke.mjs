import {chromium} from 'playwright';
import {writeFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createCloud} from './server.mjs';
await mkdir('artifacts/cloud/fixture',{recursive:true});
const evidence=[];
const base='http://127.0.0.1:3320';
for(const url of ['/health','/api/cloud/status','/api/cloud/events','/']){
 const r=await fetch(base+url);assert.equal(r.status,200);evidence.push({method:'GET',url,status:r.status});
 if(url==='/api/cloud/status')await writeFile('artifacts/cloud/live-status.json',JSON.stringify(await r.json(),null,2));
}
for(const url of ['/login','/checkout','/cart','/payment','/webhook','/purchase']){
 const r=await fetch(base+url,{method:'POST'});assert.equal(r.status,404);evidence.push({method:'POST',url,status:r.status});
}
await writeFile('artifacts/cloud/http-smoke.json',JSON.stringify(evidence,null,2));
const fixture=await createCloud({fixture:true,file:'data/cloud/phase2-fixture.json',env:{}});
await new Promise(r=>fixture.server.listen(0,'127.0.0.1',r));
const event={site:'funbox',productId:'FIXTURE-BX-01',stockSignature:'in-stock',price:399,title:'FIXTURE 示範商品',observedAt:'2026-10-19T01:00:01Z'};
await fixture.store.ingest({...event,source:'cloud'});
await fixture.store.ingest({...event,source:'local',observedAt:'2026-10-19T01:00:00.900Z'});
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true});
const results=[];
try{
 for(const [url,prefix,isFixture] of [[base,'artifacts/cloud/dashboard',false],['http://127.0.0.1:'+fixture.server.address().port,'artifacts/cloud/fixture/dashboard',true]]){
 const page=await browser.newPage({viewport:{width:1600,height:1050}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(url);await page.waitForFunction(()=>!document.querySelector('#summary').textContent.includes('載入中'));
 assert.match(await page.locator('#summary').textContent(),isFixture?/FIXTURE.*1 個唯一事件/:/LIVE 掃描/);
 assert.equal(await page.locator('.card').count(),5);
 if(isFixture)assert.match(await page.locator('#events').textContent(),/local/);
 else {const status=await fetch(base+'/api/cloud/status').then(r=>r.json());assert.equal(Object.keys(status.stations).length,5);assert.equal(status.fixture,false);for(const s of Object.values(status.stations))assert.equal(s.successes+s.failures,1);}
 assert.deepEqual(errors,[]);await page.screenshot({path:prefix+'.png',fullPage:true});
 await writeFile(prefix+'.html',(await page.content()).replace(/<script>[\s\S]*?<\/script>/g,''));
 results.push({kind:isFixture?'fixture':'real',cards:5,pageErrors:errors,summary:await page.locator('#summary').textContent()});await page.close();
 }
}finally{await browser.close();await fixture.close();}
await writeFile('artifacts/cloud/visual-smoke.json',JSON.stringify({chromium:browser.version(),results},null,2));
console.log(JSON.stringify({chromium:browser.version(),results}));
