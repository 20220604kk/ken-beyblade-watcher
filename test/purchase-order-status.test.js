import test from 'node:test';
import assert from 'node:assert/strict';
import { PurchaseOrderStatusRefresher, readFunboxOrderStatus, readEsliteOrderStatus } from '../src/purchase-order-status.js';
import { parseFunboxOrderReceipt } from '../src/funbox-api-checkout.js';
import { summarizeEsliteOrder } from '../src/eslite-orders.js';
import { esliteSheetOutcome, esliteSheetOrderRowsHtml, esliteSheetRecords } from '../src/eslite-purchase-ui.js';
import { funboxOrderTablesHtml } from '../src/funbox-purchase-ui.js';

const target='https://shop.funbox.com.tw/account/orders/'+ 'a'.repeat(32);
const html=(status='未出貨',action='')=>`<div class="order_info"><div class="order_name"><span class="value">FB123456</span></div><div class="order_action"><div class="text">${action}</div></div></div>
<div class="item_title">配送狀態</div><div class="item_content">${status}</div><div class="item_title">付款狀態</div><div class="item_content">等待付款</div><div class="modal">已取消</div>`;
const response=(body,status=200)=>({status:()=>status,ok:()=>status===200,url:()=>target,text:async()=>body,json:async()=>body,dispose:async()=>{}});
const record=extra=>({platform:'funbox',accountSlot:'C',orderNumber:'FB123456',status:'ordered',resultUrl:target,startedAt:'2026-10-10T01:00:00Z',completedAt:'2026-10-10T01:00:05Z',...extra});

test('訂單取消以官方狀態為準，不受等待付款／取消按鈕誤導',async()=>{
  assert.equal(parseFunboxOrderReceipt(html(),target).orderStatus,'ordered');
  const result=await readFunboxOrderStatus({get:async()=>response(html('未出貨','已取消'))},record());
  assert.equal(result.status,'canceled');assert.equal(result.paymentStatus,'等待付款');
  assert.equal(esliteSheetOutcome({...record(),...result}).text,'訂單取消');
  assert.match(funboxOrderTablesHtml,/refreshPurchaseOrderStatuses\('funbox',true\)/);
});

test('單號不符、登入重新導向、未知官方狀態都保留原結果',async()=>{
  for(const r of [response(html().replaceAll('FB123456','FB999999')),response(html(),302),response(html('未知新狀態'))]){
    await assert.rejects(readFunboxOrderStatus({get:async()=>r},record()));
  }
});

test('誠品子訂單取消／已出貨／完成，以具體官方狀態判定',()=>{
  const body={order_id:1,order_number:'10001',sub_orders:[{status:{order_init:'time'},sub_order_items:[{item_type:'product',product_guid:'one',quantity:1}]}]};
  assert.equal(summarizeEsliteOrder(body).orderStatus,'ordered');
  for(const [field,want] of [['order_canceled','canceled'],['order_shipped','shipped'],['order_finished','completed']]){
    assert.equal(summarizeEsliteOrder({...body,sub_orders:[{...body.sub_orders[0],status:{[field]:'time'}}]}).orderStatus,want);
  }
  assert.equal(summarizeEsliteOrder({...body,sub_orders:[body.sub_orders[0],{...body.sub_orders[0],status:{order_canceled:'time'}}]}).orderStatus,'ordered');
});

test('已知 officialId 直接一個 GET，不遍歷歷史或碰購物車',async()=>{
  const calls=[];const body={order_id:7,order_number:'10001',sub_orders:[{status:{order_canceled:'time'},sub_order_items:[{item_type:'product',product_guid:'one',quantity:1}]}]};
  const result=await readEsliteOrderStatus({get:async url=>{calls.push(url);return response(body);}}, {officialId:'7',orderId:'10001'});
  assert.equal(result.status,'canceled');assert.deepEqual(calls,['/api/v2/orders/details/7']);
});

function fixture({readOrder=async()=>({orderId:'FB123456',status:'canceled'}),busy=false,records=[record()],now=Date.parse('2026-10-10T02:00:00Z')}={}){
  const storage={records:Object.fromEntries(records.map((r,i)=>[i,r])),recent:records.map(r=>({...r}))};let saves=0,clock=now;
  const service=new PurchaseOrderStatusRefresher({getStorage:()=>storage,isBusy:()=>busy,readOrder,save:async()=>{saves++;},now:()=>clock});
  return {service,storage,advance(ms){clock+=ms;},get saves(){return saves;}};
}

test('更新 records/recent 所有副本並保存，取消後不再自動輪詢',async()=>{
  const f=fixture();await f.service.refresh({platform:'funbox'});
  assert.equal(f.storage.records[0].status,'canceled');assert.equal(f.storage.recent[0].status,'canceled');assert.equal(f.saves,1);
  f.advance(700000);assert.equal((await f.service.refresh({platform:'funbox'})).checked,0);
  assert.equal(esliteSheetRecords({esliteOrders:[{...record(),platform:'eslite',taskId:'one',status:'canceled'}]}).total,1);
});

test('忙碌不查；十分快取、30秒手動上限；失败也節流且不改成功結果',async()=>{
  let calls=0;const f=fixture({readOrder:async()=>{calls++;throw new Error('Timeout 5000ms exceeded\nCookie: SECRET');}});
  await f.service.refresh({platform:'funbox'});assert.equal(f.storage.records[0].status,'ordered');assert.doesNotMatch(f.storage.records[0].orderStatusError,/SECRET/);
  assert.equal((await f.service.refresh({platform:'funbox'})).cached,true);assert.equal((await f.service.refresh({platform:'funbox',force:true})).cached,true);
  f.advance(30001);await f.service.refresh({platform:'funbox',force:true});assert.equal(calls,2);
  const busy=fixture({busy:true,readOrder:async()=>assert.fail('不能查')});assert.equal((await busy.service.refresh({platform:'funbox'})).deferred,true);
});

test('同時查單合併，自动最多2筆，下一輪換查其他筆；結果不明不混成已成立',async()=>{
  let calls=0;const records=Array.from({length:4},(_,i)=>record({orderNumber:'FB'+i}));records.push(record({status:'submitted_unconfirmed',orderNumber:'FBUNKNOWN'}));
  const f=fixture({records,readOrder:async(_p,r)=>{calls++;await Promise.resolve();return {orderId:r.orderNumber,status:'ordered'};}});
  const [a,b]=await Promise.all([f.service.refresh({platform:'funbox'}),f.service.refresh({platform:'funbox'})]);
  assert.equal(a.checked,2);assert.equal(b.checked,2);assert.equal(calls,2);
  f.advance(600001);await f.service.refresh({platform:'funbox'});assert.equal(calls,4);assert.ok(f.storage.records[2].orderStatusCheckedAt);assert.equal(f.storage.records[4].status,'submitted_unconfirmed');
});

test('UI結果有取消筛选及官方查單時間，查單錯誤不變未成立',()=>{
  const item=record({status:'canceled',orderStatusCheckedAt:'2026-10-10T02:00:00Z'});
  const table=esliteSheetOrderRowsHtml([{item,key:'test'}]);assert.match(table,/訂單取消/);assert.match(table,/官方查單/);
});
