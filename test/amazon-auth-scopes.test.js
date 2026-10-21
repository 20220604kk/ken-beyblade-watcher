import test from 'node:test';
import assert from 'node:assert/strict';
import { AmazonJpProductOrderMonitor } from '../src/amazon-jp-product-order.js';
import { AmazonJpHttpClient } from '../src/amazon-jp-http.js';
import { asin, origin, product, review, completion } from './fixtures/amazon-race-fixtures.js';

function fixture(t, {slot='A',history='signin',productIssue='',buyIssue='',finalIssue='',cartIssue=''}={}) {
  const calls=[],notifications=[],records=[];
  let available=false;
  const config={enabled:true,fastLane:true,checkoutTransport:'api',mode:'hybrid',targetUrl:origin+'/dp/'+asin,targetSuccessCount:3,maxShippingYen:500};
  const state={data:{},save:async()=>{},writeSnapshot:async()=>{}};
  const transport={async fetch(url,options={}) {
    const path=new URL(url).pathname;calls.push({path,method:options.method||'GET'});
    let html='',status=200,headers={},issue='';
    if(path.startsWith('/dp/')){html=product({available});issue=productIssue;}
    else if(path.includes('order-history')){html='<h1>No orders</h1>';issue=history;}
    else if(path.includes('/cart/view')){html='<div id="sc-active-cart"><h1>Your Amazon Cart is empty</h1></div>';issue=cartIssue;}
    else if(path==='/checkout/entry/buynow'){html=review();issue=buyIssue;}
    else if(path.endsWith('/place-order')){status=302;headers.location='/gp/buy/thankyou/handlers/display.html';issue=finalIssue;}
    else if(path.includes('/thankyou/'))html=completion(finalIssue==='no_id'?'':undefined);
    else if(path==='/ap/signin')html='<form name="signIn"><input id="ap_email"></form>';
    else assert.fail('Unexpected request '+path);
    if(issue==='signin'){status=302;headers.location='/ap/signin?session=PRIVATE_DIAGNOSTIC_VALUE';html='';}
    else if(issue==='captcha')html='<title>Robot Check</title><input id="captchacharacters">';
    else if(issue==='rate'){status=429;headers['retry-after']='180';}
    else if(issue==='timeout')throw new Error('private transport value');
    else if(issue==='blank')html='<h1>Unknown history</h1>';
    return {status:()=>status,headers:()=>headers,text:async()=>html,dispose:async()=>{}};
  }};
  const historyStore={status:()=>({}),begin:async input=>{const r={...input};records.push(r);return r;},
    step:async()=>{},finish:async(r,result)=>Object.assign(r,result),notification:async()=>{}};
  const monitor=new AmazonJpProductOrderMonitor({slot,dataDir:'.',state,getConfig:()=>config,orderHistory:historyStore,
    notifyPrivate:async message=>{notifications.push(message);}});
  monitor.contextFor=async()=>({request:transport});monitor.resolveMsrp=()=>({msrpYen:880,code:'BX-40'});
  monitor.scheduleNext=delay=>{monitor.nextAttemptAt=new Date(Date.now()+delay).toISOString();};
  t.after(()=>monitor.close());
  return {monitor,config,state,calls,records,notifications,available:value=>{available=value;},
    historyCalls:()=>calls.filter(c=>c.path.includes('order-history')).length};
}

for(const slot of ['A','B','C'])for(const issue of ['signin','captcha']) {
  test(`${slot}: 背景查單 ${issue} 只暫停查單，連續輪詢及後續購買持續`,async t=>{
    const f=fixture(t,{slot,history:issue}),m=f.monitor;
    await m.runScheduledScan();
    assert.equal(m.storage().status,'waiting_poll');assert.equal(m.storage().lastError,'');
    assert.equal(m.storage().orderHistoryCheck.status,issue==='signin'?'needs_login':'needs_verification');
    assert.equal(m.storage().orderHistoryCheck.scope,'order_history');
    assert.ok(m.nextAttemptAt);assert.equal(f.historyCalls(),1);assert.equal(f.notifications.length,0);
    for(let i=0;i<3;i++)await m.scanOnce({purchase:true,trigger:'poll'});
    assert.equal(f.historyCalls(),1,'查單驗證不每20秒重撞');
    assert.equal(m.refreshCount,4);assert.equal(m.directIdleOrderBaseline,null);
    assert.equal(f.calls.some(c=>c.method==='POST'),false);
    f.available(true);
    const result=await m.scanOnce({purchase:true,trigger:'poll'});
    assert.equal(result.status,'ordered');assert.equal(m.storage().completedCount,1);
    assert.equal(f.calls.filter(c=>c.path.endsWith('/place-order')).length,1);
    assert.equal(f.historyCalls(),1);assert.equal(f.records[0].status,'ordered');
  });
}

test('背景查單狀態持久保存，重建執行器繼續商品監控，未取得基準不冒充空歷史',async t=>{
  const f=fixture(t);await f.monitor.runScheduledScan();
  const copy=JSON.parse(JSON.stringify(f.state.data));
  const g=fixture(t);g.monitor.state.data=copy;
  await g.monitor.runScheduledScan();
  assert.equal(g.historyCalls(),0);assert.equal(g.monitor.storage().status,'waiting_poll');
  assert.equal(g.monitor.directIdleOrderBaseline,null);
  assert.doesNotMatch(JSON.stringify(copy),/PRIVATE_DIAGNOSTIC_VALUE|<input|session=/);
});

for(const issue of ['timeout','blank'])test(`選用背景查單 ${issue} 有限退避，商品刷新繼續`,async t=>{
  const f=fixture(t,{history:issue});await f.monitor.runScheduledScan();
  assert.equal(f.monitor.storage().orderHistoryCheck.status,'unavailable');
  assert.equal(f.monitor.storage().status,'waiting_poll');
  assert.ok(Date.parse(f.monitor.storage().orderHistoryCheck.nextCheckAt)>Date.now()+290000);
  await f.monitor.scanOnce({purchase:true,trigger:'poll'});assert.equal(f.historyCalls(),1);
});

test('背景查單真正 HTTP429 仍遵守官網降速，商品請求等待 Retry-After',async t=>{
  const f=fixture(t,{history:'rate'});await f.monitor.runScheduledScan();
  assert.ok(Date.parse(f.monitor.storage().backoffUntil)>=Date.now()+179000);
  assert.equal(f.calls.some(c=>c.path.startsWith('/dp/')),false);
  const before=f.calls.length;await f.monitor.runScheduledScan();assert.equal(f.calls.length,before);
  assert.notEqual(f.monitor.storage().status,'needs_login');
});

for(const issue of ['signin','captcha'])test(`商品頁真正 ${issue} 保留商品驗證狀態，與背景查單分開`,async t=>{
  const f=fixture(t,{productIssue:issue});
  await assert.rejects(f.monitor.scanOnce({purchase:true,trigger:'poll'}));
  assert.equal(f.monitor.storage().status,issue==='signin'?'needs_login':'needs_verification');
  assert.equal(f.monitor.storage().loginIssueScope,'product');assert.equal(f.historyCalls(),0);
  assert.equal(f.calls.some(c=>c.method==='POST'),false);
});

test('直購結帳要求登入標示 checkout；本輪沒有最終送單',async t=>{
  const f=fixture(t,{buyIssue:'signin'});f.available(true);
  await assert.rejects(f.monitor.scanOnce({purchase:true,trigger:'poll'}));
  assert.equal(f.monitor.storage().status,'waiting_poll');assert.equal(f.monitor.storage().checkoutAccessIssue.scope,'checkout');
  assert.equal(f.monitor.canSchedule(),true);const count=f.calls.filter(c=>c.method==='POST').length;
  await f.monitor.scanOnce({purchase:true,trigger:'poll'});assert.equal(f.calls.filter(c=>c.method==='POST').length,count);
  assert.equal(f.calls.filter(c=>c.path.endsWith('/place-order')).length,0);
});

test('最終送單後要求登入仍保留未決交易，禁止任何重送',async t=>{
  const f=fixture(t,{finalIssue:'signin'});f.available(true);
  await assert.rejects(f.monitor.scanOnce({purchase:true,trigger:'poll'}));
  assert.equal(f.monitor.storage().status,'needs_review');assert.equal(f.monitor.storage().loginIssueScope,'checkout');
  assert.equal(f.monitor.storage().apiTransaction.phase,'submitted');
  await f.monitor.scanOnce({purchase:true,trigger:'poll'});
  assert.equal(f.calls.filter(c=>c.path.endsWith('/place-order')).length,1);
  assert.equal(f.monitor.storage().completedCount,0);
});

test('背景查單受限且完成頁缺單號時保留待核對，不把未知當空基準或成功',async t=>{
  const f=fixture(t,{finalIssue:'no_id'});await f.monitor.runScheduledScan();f.available(true);
  const result=await f.monitor.scanOnce({purchase:true,trigger:'poll'});
  assert.equal(result.status,'submitted_unconfirmed');assert.equal(f.historyCalls(),1);
  assert.equal(f.monitor.storage().status,'needs_review');assert.equal(f.monitor.storage().completedCount,0);
  assert.equal(f.monitor.storage().apiTransaction.baselineOrderIds,undefined);
  assert.equal(f.calls.filter(c=>c.path.endsWith('/place-order')).length,1);
});

for(const issue of ['signin','captcha'])test(`待機清車 ${issue} 只停清車，不拖停商品監控`,async t=>{
  const f=fixture(t,{history:'',cartIssue:issue}),m=f.monitor;
  m.directIdleOrderBaseline={asin,at:new Date().toISOString(),ids:[]};m.maintenancePollCount=499;
  await m.scanOnce({purchase:true,trigger:'poll'});
  assert.equal(m.storage().status,'waiting_poll');assert.equal(m.storage().lastError,'');
  assert.equal(m.storage().idleCartMaintenance.scope,'cart');
  assert.equal(m.storage().idleCartMaintenance.status,issue==='signin'?'needs_login':'needs_verification');
  m.maintenancePollCount=499;await m.scanOnce({purchase:true,trigger:'poll'});
  assert.equal(f.calls.filter(c=>c.path.includes('/cart/view')).length,1);
});

test('HTTP 錯誤 scope 綁定原操作，不洩漏登入跳轉的 session query',async()=>{
  for(const [url,scope] of [['/dp/'+asin,'product'],['/checkout/entry/buynow','checkout'],
    ['/-/zh/gp/your-account/order-history','order_history'],['/your-orders/order-details','order_detail'],['/-/zh/gp/cart/view.html','cart']]) {
    const client=new AmazonJpHttpClient({request:{fetch:async url=>({status:()=>url.includes('/ap/signin')?200:302,headers:()=>({location:'/ap/signin?session=PRIVATE'}),text:async()=>'<input id="ap_email">',dispose:async()=>{}})}});
    await assert.rejects(client.request(url),error=>error.code===(scope==='checkout'?'AMAZON_CHECKOUT_AUTH_REQUIRED':'AMAZON_LOGIN_REQUIRED')&&error.requestScope===scope&&!JSON.stringify(error).includes('PRIVATE'));
  }
});

test('restart rechecks legacy checkout redirect and auxiliary auth once; unknown final intent remains held', async t => {
  const f=fixture(t),m=f.monitor;
  Object.assign(m.storage(),{status:'needs_login',loginIssueScope:'checkout',orderHistoryCheck:{status:'needs_login',scope:'order_history'}});
  await m.start();assert.equal(m.storage().status,'waiting_poll');assert.equal(m.canSchedule(),true);
  assert.equal(m.storage().orderHistoryCheck,undefined);assert.equal(m.storage().authContractVersion,2);
  m.storage().orderHistoryCheck={status:'needs_login',scope:'order_history'};
  await m.start();assert.equal(m.storage().orderHistoryCheck.status,'needs_login','only invalidate old contract once');
  m.storage().status='needs_login';m.storage().loginIssueScope='checkout';m.storage().apiTransaction={phase:'submitted',asin};
  await m.start();assert.equal(m.storage().status,'needs_review');assert.equal(m.canSchedule(),false);
  assert.equal(f.calls.length,0);
});
