import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/state.js';
import { AmazonJpProductOrderMonitor } from '../src/amazon-jp-product-order.js';
import { AmazonOrderHistory } from '../src/amazon-order-history.js';
import { createDashboard } from '../src/dashboard.js';

async function setup(t) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'amazon-live-log-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const state=new StateStore(dir,{saveDelayMs:0});await state.load();
  const history=new AmazonOrderHistory(dir);await history.ready;
  const make=slot=>new AmazonJpProductOrderMonitor({slot,storageKey:'amazonJpProductOrder'+slot,dataDir:dir,state,orderHistory:history,
    getConfig:()=>({enabled:false,targetUrl:'https://www.amazon.co.jp/dp/B0TEST0001'})});
  const monitors=['A','B','C'].map(make);
  t.after(async()=>{for(const monitor of monitors)await monitor.close();});
  return{dir,state,history,monitors,make};
}

test('ABC 日常 LOG、刷新次數及訊號歷史只存在記憶體；重建實例歸零，交易狀態仍保存',async t=>{
  const f=await setup(t);
  for(const monitor of f.monitors){
    monitor.storage().completedCount=2;
    monitor.storage().apiTransaction={phase:'submitted',asin:'B0TEST0001'};
    await monitor.recordStep('refresh_start');
    await monitor.recordStep('product_evaluated',{result:'not_purchasable'});
    monitor.refreshCount=15;monitor.signalChecks=[{result:'no_offers'}];
    assert.equal(monitor.status().stepLog.length,2);
  }
  await f.state.writeSnapshot();
  const raw=JSON.parse(await fs.readFile(f.state.file,'utf8'));
  for(const slot of ['A','B','C']){
    const saved=raw.commerce['amazonJpProductOrder'+slot];
    assert.equal(saved.completedCount,2);assert.equal(saved.apiTransaction.phase,'submitted');
    for(const key of ['stepLog','refreshCount','signalChecks'])assert.equal(key in saved,false);
    const restarted=f.make(slot);t.after(()=>restarted.close());
    assert.equal(restarted.status().stepLog.length,0);assert.equal(restarted.status().refreshCount,0);
    assert.equal(restarted.hasPendingApiTransaction(),true);
  }
  assert.equal(f.history.total,0,'日常巡檢不建立下單紀錄檔');
});

test('讀取舊狀態及任何平台觸發存檔都不能讓 ABC 舊 LOG 復活；不清其他平台資料',async t=>{
  const f=await setup(t);
  const legacy={status:'needs_review',completedCount:3,apiTransaction:{phase:'submitted'},backoffUntil:'2099-01-01',stepLog:[{name:'legacy-log'}],refreshCount:789,signalChecks:[{at:'old'}],lastIdleCartCheckCount:500};
  f.state.data.commerce={amazonJpProductOrderA:{...legacy},amazonJpProductOrderB:{...legacy},amazonJpProductOrderC:{...legacy},amazonJpSingleOrder:{refreshCount:99},funbox:{stepLog:['keep']}};
  await f.state.writeSnapshot();
  const loaded=new StateStore(f.dir);await loaded.load();
  for(const slot of ['A','B','C']){
    const saved=loaded.data.commerce['amazonJpProductOrder'+slot];
    assert.equal(saved.stepLog,undefined);assert.equal(saved.refreshCount,undefined);
    assert.equal(saved.signalChecks,undefined);assert.equal(saved.lastIdleCartCheckCount,undefined);
    assert.equal(saved.apiTransaction.phase,'submitted');assert.equal(saved.backoffUntil,'2099-01-01');
  }
  assert.equal(loaded.data.commerce.amazonJpSingleOrder.refreshCount,99);
  assert.deepEqual(loaded.data.commerce.funbox.stepLog,['keep']);
  // Also cover pre-upgrade files rather than only the sanitized write path.
  await fs.writeFile(f.state.file,JSON.stringify({commerce:{amazonJpProductOrderA:legacy}}));
  const old=new StateStore(f.dir);await old.load();assert.equal(old.data.commerce.amazonJpProductOrderA.stepLog,undefined);
});

test('清空可在送單中執行；不動任務、冷卻、交易鎖、保養計數或完整下單證據',async t=>{
  const f=await setup(t),monitor=f.monitors[0];
  const snapshot={asin:'B0TEST0001',title:'Test CX-20',priceYen:880};
  monitor.activeOrderRecord=await f.history.begin({slot:'A',snapshot,steps:[{name:'refresh_start',at:new Date().toISOString()}],compactSteps:true});
  await monitor.recordStep('buy_now_click');
  monitor.running=true;monitor.phase='ordering';monitor.refreshCount=40;monitor.maintenancePollCount=499;
  Object.assign(monitor.storage(),{status:'needs_review',completedCount:3,apiTransaction:{phase:'submitted',asin:snapshot.asin},backoffUntil:'2099-01-01'});
  monitor.pendingSignal={asin:snapshot.asin};
  const operational=JSON.stringify(monitor.storage()),evidence=JSON.stringify(monitor.currentScanSteps);
  monitor.clearDiagnostics();
  assert.equal(monitor.status().refreshCount,0);assert.deepEqual(monitor.status().stepLog,[]);
  assert.equal(JSON.stringify(monitor.storage()),operational);assert.equal(JSON.stringify(monitor.currentScanSteps),evidence);
  assert.equal(monitor.running,true);assert.equal(monitor.phase,'ordering');assert.equal(monitor.maintenancePollCount,499);
  assert.ok(monitor.pendingSignal);
  await monitor.recordStep('checkout_verified');await monitor.recordStep('submit_order');
  await monitor.recordStep('submit_result',{status:'ordered',orderId:'000-0000000-0000001'});
  await f.history.finish(monitor.activeOrderRecord,{status:'ordered',orderId:'000-0000000-0000001'});
  const reloaded=new AmazonOrderHistory(f.dir);await reloaded.ready;
  assert.equal(reloaded.status().recent[0].orderId,'000-0000000-0000001');
  assert.equal(reloaded.status().recent[0].steps.length,5,'清空前的購買步驟仍在正式下單紀錄');
  monitor.running=false;
});

test('清空端點一次只呼叫 LOG 處理器，不走設定、重設或購買端點',async t=>{
  let cleared=0;
  const server=createDashboard({port:0,getStatus:()=>({}),log:()=>{},
    onClearAmazonJpProductOrderLogs:async()=>{cleared++;return{message:'已清空 ABC'};},
    onSaveAmazonJpProductOrder:()=>assert.fail('不能改任務設定'),onScanAmazonJpProductOrder:()=>assert.fail('不能查商品或送單')});
  await new Promise(resolve=>server.listening?resolve():server.once('listening',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const response=await fetch(`http://127.0.0.1:${server.address().port}/japan/amazon-product-order/clear-log`,{method:'POST'});
  assert.equal(response.status,200);assert.equal(cleared,1);assert.match((await response.json()).message,/ABC/);
});
