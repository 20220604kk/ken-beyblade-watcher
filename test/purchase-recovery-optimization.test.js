import test from 'node:test';
import assert from 'node:assert/strict';
import { AutoPurchaseCoordinator, purchaseEsliteViaApi } from '../src/auto-purchase.js';
import { EsliteRestockTasks } from '../src/eslite-restock-tasks.js';

test('冷帳號會員與空車並行；只讀一次空車、只加一次、只送一次',async()=>{
  const calls=[];let added=false,memberReleased=false,release;
  const member=new Promise(resolve=>{release=()=>{memberReleased=true;resolve({id:'member'});};});
  const response=body=>({status:()=>200,ok:()=>true,json:async()=>body,dispose:async()=>{}});
  const api={async get(url){calls.push(url);if(url.includes('member'))return response(await member);if(!memberReleased)release();return response({cart:{cart_items:added?[{product_guid:'one',qty:1}]:[]}});},
    async post(url){calls.push(url);if(url.includes('/cart/')){added=true;return response({product_guid:'one',response_quantity:1});}return response({order_number:'MOCK'});}};
  const result=await purchaseEsliteViaApi({apiContext:api,prevalidated:false,product:{id:'one',stock:1},checkoutTemplate:{checkout:{discount_point:100}},
    settings:{action:'checkout',strictSingleProductOrder:true}});
  assert.equal(result.status,'ordered');assert.equal(calls.filter(c=>c.includes('member')).length,1);
  assert.equal(calls.filter(c=>c.startsWith('/api/v2/cart/items')).length,3); // clear GET + add POST + verify GET
  assert.equal(calls.filter(c=>c.includes('/orders/checkout')).length,1);assert.ok(result.timings.checkoutSubmittedMs>=0);assert.ok(result.timings.submitToResponseMs>=0);
});

test('明確忙碌讓該帳號全部商品冷卻，其他帳號可繼續；限流等待較長',()=>{
  let clock=Date.now();const tasks=new EsliteRestockTasks({now:()=>clock,maxAttempts:3});
  const observation=id=>({id,url:'https://www.eslite.com/product/'+id,available:true,stock:10,freshObservationAt:new Date(clock).toISOString()});
  tasks.observe(observation('one'),{activate:true});tasks.observe(observation('two'),{activate:true});tasks.complete('one','A-one',{purchaseStatus:'checkout_busy'},'A');
  assert.equal(tasks.reason('two','A-two','A'),'帳號忙碌冷卻中');assert.equal(tasks.reason('two','B-two','B'),'');
  clock+=5001;assert.equal(tasks.reason('two','A-two','A'),'');tasks.complete('two','A-two',{purchaseStatus:'rate_limited'},'A');
  clock+=10000;assert.equal(tasks.reason('one','A-one','A'),'帳號限流冷卻中');
});

function heldFixture({found=false}={}){
  const record={platform:'eslite',accountSlot:'B',accountIdentity:'identity-B',taskId:'held',status:'submitted_unconfirmed',startedAt:new Date(Date.now()-5000).toISOString(),product:{id:'one',title:'mock'},quantity:1,steps:[]};
  const state={data:{commerce:{autoPurchase:{records:{held:record},recent:[{...record}]}}},save:async()=>{}};let reads=0;
  const child={purchaseHold:{productId:'one'},_withAccountLock:async fn=>fn(),_ensureApiContext:async()=>({}),_resetApiReadiness(){},
    apiOrderReader:async(_api,opts)=>{reads++;assert.equal(opts.maxPages,1);assert.equal(opts.maxDurationMs,6000);return {complete:true,orders:found?[{orderId:'MOCK',createdAt:record.startedAt,items:[{id:'one',quantity:1}]}]:[]};}};
  const multi={adapters:{B:child},busySlots:new Set(),accountIdentity:()=> 'identity-B',credentialsStatus:()=>({}),runtimeStatus:()=>({}),close:async()=>{}};
  const coordinator=new AutoPurchaseCoordinator({state,adapters:{eslite:multi},getConfig:()=>({enabled:true,eslite:{enabled:true}}),notifyPrivate:async()=>{},continuousEsliteTasks:true});
  coordinator.esliteRestockTasks.observe({id:'one',url:'https://www.eslite.com/product/one',available:true,freshObservationAt:new Date().toISOString()},{activate:true});
  return {coordinator,record,child,state,get reads(){return reads;}};
}

test('補貨期結果不明只再補查兩次，不查到就不能解鎖；停止時取消計時器',async()=>{
  const f=heldFixture();try{
    await f.coordinator._runHeldEsliteCheck(f.record);await f.coordinator._runHeldEsliteCheck(f.record);await f.coordinator._runHeldEsliteCheck(f.record);
    assert.equal(f.reads,2);assert.equal(f.record.status,'submitted_unconfirmed');assert.ok(f.child.purchaseHold);assert.equal(f.record.steps.length,2);
    assert.equal(f.record.steps.at(-1).state,'unknown');assert.equal(f.state.data.commerce.autoPurchase.recent[0].holdRecheckCount,2);
  }finally{await f.coordinator.close();assert.equal(f.coordinator.heldEsliteChecks.size,0);}
});

test('背景補查确认單號、同品項、同數量、時間才解鎖並保存已購',async()=>{
  const f=heldFixture({found:true});try{
    await f.coordinator._runHeldEsliteCheck(f.record);assert.equal(f.reads,1);assert.equal(f.record.status,'ordered');assert.equal(f.record.orderId,'MOCK');assert.equal(f.child.purchaseHold,null);
    assert.equal(f.state.data.commerce.autoPurchase.eslitePurchased['identity-B'].one.orderId,'MOCK');assert.equal(f.record.steps.at(-1).state,'success');
  }finally{await f.coordinator.close();}
});
