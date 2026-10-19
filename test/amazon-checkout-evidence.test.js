import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { AmazonCheckoutEvidence, checkoutEvidenceHtml, evidenceEndpoint, renderCheckoutEvidence } from '../src/amazon-checkout-evidence.js';
import { AmazonOrderHistory } from '../src/amazon-order-history.js';
import { AmazonJpProductOrderMonitor } from '../src/amazon-jp-product-order.js';
import { createDashboard } from '../src/dashboard.js';

const id='1792185640141-00000000-0000-0000-0000-000000000001';
const responseHtml='<h1>官方結帳錯誤 404</h1><p>這是離線測試回應，沒有對官網發出請求。</p>';
const input={html:responseHtml,status:404,url:'https://www.amazon.co.jp/checkout/p/private-flow/spc?token=private-token',method:'GET',source:'官方失敗回應（離線呈現）',error:'商品／頁面不存在'};
async function temporary(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'amazon-evidence-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}

test('API 快照移除可執行內容、隱藏憑證與查詢字串；只保留可定位的端點',()=>{
  const html=checkoutEvidenceHtml('<script>secret-script</script><iframe src="https://example.test"></iframe><input type="hidden" value="secret-csrf"><input value="private-input"><form action="https://example.test/?token=x"><a href="/?session=x" onclick="secret-handler()" data-token="secret-token">錯誤</a></form>',{kind:'failure',source:'官方回應',httpStatus:404,method:'GET',endpoint:evidenceEndpoint(input.url)});
  assert.doesNotMatch(html,/secret-script|secret-csrf|private-input|secret-handler|secret-token|<script|<iframe|session=x|token=x/);
  assert.match(html,/離線呈現/);assert.match(html,/HTTP 404/);assert.match(html,/\[flow\]/);
  assert.equal(evidenceEndpoint(input.url),'/checkout/p/[flow]/spc');
  assert.equal(evidenceEndpoint('https://www.amazon.co.jp/order/000-0000000-0000001?token=x'),'/order/[order]');
});

test('進入、回應、失敗分開保存且去重；保存非同步，不阻擋結帳',async t=>{
  const dir=await temporary(t);let release;let saved=0;
  const render=()=>new Promise(resolve=>release=()=>resolve(Buffer.from('fixture-png')));
  const evidence=new AmazonCheckoutEvidence(dir,{render,saveRecord:async()=>{saved++;}});
  const record={id};
  assert.equal(evidence.enqueue(record,'entry',input),undefined);
  evidence.enqueue(record,'entry',input);assert.equal(evidence.pending,1);
  while(!release)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(record.evidence[0].status,'pending');release();await evidence.queue;
  assert.equal(evidence.pending,0);assert.equal(saved,1);assert.equal(record.evidence[0].status,'saved');
  assert.equal((await evidence.read(id,'02-01-entry.png')).toString(),'fixture-png');
  const json=JSON.parse(await evidence.read(id,'02-01-entry.json'));
  assert.equal(json.httpStatus,404);assert.equal(json.endpoint,'/checkout/p/[flow]/spc');
  assert.doesNotMatch(JSON.stringify(json),/private-flow|private-token/);
  evidence.render=async()=>Buffer.from('next');
  evidence.enqueue(record,'response',input);evidence.enqueue(record,'failure',input);await evidence.queue;
  assert.deepEqual(record.evidence.map(item=>item.kind),['entry','response','failure']);
  await assert.rejects(evidence.read('../other','02-01-entry.png'),/路徑不符/);
  await assert.rejects(evidence.read(id,'../../other'),/路徑不符/);
});

test('截圖失敗仍保留 HTML 與原因；不偽稱已取得實際畫面',async t=>{
  const dir=await temporary(t),record={id};
  const evidence=new AmazonCheckoutEvidence(dir,{render:async()=>{throw new Error('renderer unavailable');},saveRecord:async()=>{}});
  evidence.enqueue(record,'failure',input);await evidence.queue;
  assert.equal(record.evidence[0].status,'failed');assert.match(record.evidence[0].captureError,/renderer unavailable/);
  assert.match((await evidence.read(id,'02-01-failure.html')).toString(),/官方結帳錯誤/);
  const native={id:id.replace(/1$/,'2')};
  evidence.enqueue(native,'failure',{captureError:'native screenshot timed out',source:'瀏覽器截圖未取得'});await evidence.queue;
  assert.equal(native.evidence[0].status,'failed');assert.match(native.evidence[0].captureError,/native screenshot/);
  await assert.rejects(evidence.read(native.id,'02-01-failure.png'),{code:'ENOENT'});
});

test('快照晚於訂單完成保存，不覆寫正式單號、成功狀態或通知',async t=>{
  const dir=await temporary(t),history=new AmazonOrderHistory(dir);await history.ready;
  const record=await history.begin({slot:'A',snapshot:{asin:'B0TEST0001'},steps:[],compactSteps:true});
  history.evidence.render=async()=>Buffer.from('fixture');history.captureEvidence(record,'entry',input);
  await Promise.all([history.step(record,{name:'buy_now_click',at:new Date().toISOString()}),history.finish(record,{status:'ordered',orderId:'000-0000000-0000002'}),history.notification(record,{status:'sent'})]);
  await history.evidence.queue;
  const loaded=new AmazonOrderHistory(dir);await loaded.ready;
  const result=loaded.status().recent[0];assert.equal(result.status,'ordered');assert.equal(result.orderId,'000-0000000-0000002');
  assert.equal(result.notification.status,'sent');assert.equal(result.evidence[0].status,'saved');
  assert.equal((await fs.readdir(history.directory)).filter(name=>name.endsWith('.tmp')).length,0);
});

test('離線真實 Chrome 渲染器可產出 PNG；不能載入外部資源或執行腳本',async()=>{
  const safe=checkoutEvidenceHtml(responseHtml+'<img src="https://invalid.example.test/image"><script>throw new Error("must not run")</script>',{kind:'failure',source:'測試回應',httpStatus:404});
  const png=await renderCheckoutEvidence(safe);
  assert.deepEqual([...png.subarray(0,8)],[137,80,78,71,13,10,26,10]);assert.ok(png.length>1000);
});

test('瀏覽器開始直購、進入結帳及失敗都留獨立快照，日常讀取不截圖',async t=>{
  const captures=[],monitor=new AmazonJpProductOrderMonitor({dataDir:'.',state:{data:{},save:async()=>{}},getConfig:()=>({checkoutTransport:'browser'}),orderHistory:{step:async()=>{},captureEvidence:(_record,kind,input)=>captures.push({kind,input})}});
  t.after(()=>monitor.close());
  monitor.page={url:()=>input.url,screenshot:async()=>Buffer.from('native-fixture')};
  await monitor.recordStep('refresh_start');assert.equal(captures.length,0);
  monitor.activeOrderRecord={id};
  await monitor.recordStep('buy_now_click');await monitor.recordStep('checkout_inspect');await monitor.recordStep('checkout_verified');
  await monitor.captureBrowserEvidence('failure',new Error('fixture error'));
  assert.deepEqual(captures.map(item=>item.kind),['entry','response','failure']);
  assert.equal(captures[2].input.error,'fixture error');assert.equal(captures[0].input.image.toString(),'native-fixture');
  monitor.page=null;monitor.activeOrderRecord=null;
});

test('快照端點供控制台讀取 PNG、HTML、HTTP 原因；錯誤路徑不能讀取其他檔案',async t=>{
  const reads=[],server=createDashboard({port:0,getStatus:()=>({}),log:()=>{},onReadAmazonJpOrderEvidence:async(recordId,name)=>{reads.push([recordId,name]);if(name==='02-02-failure.png')throw Object.assign(new Error('missing'),{code:'ENOENT'});return Buffer.from('fixture');}});
  await new Promise(resolve=>server.listening?resolve():server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const origin='http://127.0.0.1:'+server.address().port;
  for(const [ext,mime]of [['png','image/png'],['html','text/html'],['json','application/json']]){
    const response=await fetch(origin+'/amazon-product-order/evidence/'+id+'/02-01-failure.'+ext);
    assert.equal(response.status,200);assert.match(response.headers.get('content-type'),new RegExp(mime));assert.equal(response.headers.get('cache-control'),'no-store');assert.match(response.headers.get('content-security-policy'),/sandbox/);
  }
  assert.equal((await fetch(origin+'/amazon-product-order/evidence/'+id+'/02-02-failure.png')).status,404);
  for(const suffix of ['other/02-01-failure.png',id+'/%2Fconfig.json',id+'/02-01-failure.js'])assert.equal((await fetch(origin+'/amazon-product-order/evidence/'+suffix)).status,400);
  assert.equal(reads.length,4);
});

test('待核對的檢查先持久停止再查車／查單；解除後不自動搶購，執行中的任務不受中斷',async()=>{
  const source=await fs.readFile(new URL('../src/index.js',import.meta.url),'utf8');
  const code=source.slice(source.indexOf('onScanAmazonJpProductOrder: async'),source.indexOf('  onTestFunboxProductNotification:',source.indexOf('onScanAmazonJpProductOrder: async')));
  const calls=[],config={amazonJpProductOrders:{A:{enabled:true}}};let running=false;
  const monitor={slot:'A',storage:()=>({status:'needs_review'}),hasPendingApiTransaction:()=>true,canRecoverPreSubmit:()=>false,assertIdle:()=>{if(running)throw new Error('busy');},stop:()=>calls.push('stop'),check:async()=>{assert.equal(config.amazonJpProductOrders.A.enabled,false);calls.push('read-only check');return{message:'已解除'};}};
  const sandbox={config,amazonJpProductOrderBySlot:{A:monitor},amazonRaceCoordinator:{current:()=>null},saveConfig:async()=>calls.push('durable disabled')};vm.createContext(sandbox);
  const callback=vm.runInContext('({'+code+'}).onScanAmazonJpProductOrder',sandbox);
  assert.equal((await callback({slot:'A',check:true})).message,'已解除');assert.deepEqual(calls,['stop','durable disabled','read-only check']);
  running=true;calls.length=0;config.amazonJpProductOrders.A.enabled=true;
  await assert.rejects(callback({slot:'A',check:true}),/busy/);assert.equal(config.amazonJpProductOrders.A.enabled,true);assert.equal(calls.length,0);
});

test('正式 UI 而非舊版 renderer 會列出 02 快照與 HTTP 原因，並跳脫錯誤內容',async()=>{
  const source=await fs.readFile(new URL('../src/dashboard.js',import.meta.url),'utf8');
  const code=source.match(/function renderAmazonProductOrder\(s\)\{[\s\S]*?\n\}/)[0],elements=new Map();
  const element=key=>{if(!elements.has(key))elements.set(key,{});return elements.get(key);};
  const sandbox={document:{querySelector:element},localStorage:{getItem:()=>null},amazonProductOrderDirty:{},esc:value=>String(value??'').replaceAll('<','&lt;').replaceAll('>','&gt;')};vm.createContext(sandbox);vm.runInContext(code+';this.render=renderAmazonProductOrder;',sandbox);
  sandbox.render({japanAuctions:{amazonJpProductOrders:[{slot:'A',orderHistory:{recent:[{id,slot:'A',product:{code:'CX-20'},evidence:[{id:'02-01-failure',kind:'failure',status:'saved'},{id:'02-02-entry',kind:'entry',status:'failed',captureError:'<private-error>'}]}]}}]}});
  const html=element('#amazon-product-order-evidence-links').innerHTML;
  assert.match(html,/02-01-failure.png/);assert.match(html,/02-01-failure.json/);assert.match(html,/原因／HTTP/);assert.match(html,/&lt;private-error&gt;/);assert.doesNotMatch(html,/<private-error>/);
});
