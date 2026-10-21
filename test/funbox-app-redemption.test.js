import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FunboxAppRedemption, validateRows, assertRedemptionCoupon, exactCart, selectConflictForm } from '../src/optional-tasks/funbox-app-redemption.js';
import { PurchaseLedger } from '../src/purchase-ledger.js';
import { clientScript } from '../src/optional-tasks/funbox-app-redemption-ui.js';

const origin = 'https://shop.funbox.com.tw', start = '2026-10-21T10:00:00+08:00';
const rows = [
  { productId:'bbpr07730',code:'AAAA-BBBB-0001' }, { productId:'bbpr07730',code:'AAAA-BBBB-0002' }, { productId:'bbpr07733',code:'AAAA-BBBB-0003' }
];
const response = (body, url, status=200) => ({ text:async()=>typeof body==='string'?body:JSON.stringify(body),json:async()=>body,url:()=>url,ok:()=>status>=200&&status<300,status:()=>status,headers:()=>({}),dispose:async()=>{} });

async function harness(work,{timeout=false,acceptedAfterTimeout=false,wrongPrice=false,invalidFirst=false,stockZero=false,subtotal=495,shipping=60}={}) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'funbox-special-'));
  const names={bbpr07730:'【APP兌換】黃蜂要塞',bbpr07733:'【APP兌換】海怪扭擺',bbpr07736:'【APP兌換】雄鹿戰角'};
  const variants={bbpr07730:'10',bbpr07733:'11',bbpr07736:'12'};
  const store={storeid:'000001',storename:'測試街門市',address:'測試市測試路1號',outside:'0'};
  const state={data:{commerce:{autoPurchase:{records:{},recent:[]}}},writeSnapshot:async()=>{events.push('durable');await fs.writeFile(path.join(dir,'main-state.json'),JSON.stringify(state.data));}};
  const ledger=new PurchaseLedger(state.data.commerce.autoPurchase),events=[],orders=[];
  let cart=null,discount=false,code=null,postCount=0,addCount=0,removed=0;
  const token=n=>String(n).padStart(32,'a'),cartUrl=()=>origin+'/carts/'+token(orders.length+1);
  const props=()=>({csrfToken:'synthetic',cart:{token:token(orders.length+1),customer:{email:'synthetic@example.invalid',mobile:'0900000000'}},paymentItems:[],requiresShipping:true,shop:{cart_extra_inputs:[]},coupons:discount?[{code}]:[],
    lineItems:cart?[{type:'normal',variant_id:variants[cart],quantity:1}]:[],
    priceValidations:{total_price_before_bonus_discount:discount?(wrongPrice?496:subtotal):999999,total_price_after_bonus_discount:discount?(wrongPrice?496:subtotal):999999,coupon_discount:discount?999999-subtotal:0,bonus_consumed:0,bonus_discount:0}});
  const html=()=>`<meta name="csrf-token" content="synthetic"><script>window.lineItems=${JSON.stringify(props().lineItems)};</script><div id="checkout-v3" data-react-props='${JSON.stringify(props())}'></div>`;
  const api={dispose:async()=>{},get:async(url)=>{
    if(url===origin+'/account')return response('<a href="/account/logout">logout</a>',url);
    if(/\/products\/.*\.json$/.test(url)){const id=url.match(/products\/(.*)\.json/)[1];return response({title:names[id],url:origin+'/products/'+id,price:999999,variants:[{id:variants[id],inventory_quantity:stockZero?0:5,inventory_policy:'deny'}]},url);}
    if(url===origin+'/cart'||/^\/carts\/[a-z0-9]{32}\/?$/.test(new URL(url).pathname))return cart?response(html(),cartUrl()):response('<a href="/account/logout">logout</a>',origin+'/account/index');
    if(url.includes('/shipping_rates_and_payment_method_items'))return response({payment_items:[{id:77,service:'seven_cod',is_cod:true,is_cvs:true,shipping_rate:'seven_cod',payment_rate:shipping,payment_charge:0}]},url);
    if(url===origin+'/account/orders')return response('<a href="/account/logout">logout</a>'+orders.map(o=>`<a href="/account/orders/${o.token}">order</a>`).join(''),url);
    const order=orders.find(o=>url===origin+'/account/orders/'+o.token);
    if(order)return response(`<div class="order_name"><span class="value">${order.number}</span></div><div class="order_total_price">NT$555</div><div class="item_title">付款方式</div><div class="item_content">7-11 取貨付款</div><div class="item_title">付款狀態</div><div class="item_content">等待付款</div><div class="item_title">配送方式</div><div class="item_content">000001 測試街門市</div><div class="order_line_items"><div class="table_row"><div class="line_item_title"><a href="/products/${order.productId}">${names[order.productId]} -</a></div><div class="line_item_price_quantity">NT$495 x 1</div></div></div>`,url);
    throw new Error('Unexpected GET '+url);
  },post:async(url,options)=>{
    if(url===origin+'/cart/add'){assert.equal(cart,null);assert.equal(options.form.quantity,'1');cart=Object.keys(variants).find(k=>variants[k]===options.form.id);addCount++;discount=false;code=null;return response({},url);}
    if(url.endsWith('/coupons'))return response(invalidFirst&&addCount===1?{err_msg:'invalid'}:{code:options.data.code},url);
    if(url.endsWith('/apply_coupon')){assert.equal(options.data.apply_maximun_bonus,false);assert.equal(options.data.bonus_used,0);assert.equal(options.data.codes.length,1);code=options.data.codes[0];discount=true;return response({total_amount:999504},url);}
    if(url.endsWith('/apply_bonus'))return response({bonus_used:0},url);
    if(url.endsWith('/update_line_item')){removed++;cart=null;discount=false;code=null;return response({},url);}
    if(/^\/carts\/[a-z0-9]{32}\/$/.test(new URL(url).pathname)){
      postCount++;events.push('post');assert.equal(options.form.total_price_frontend,'555');assert.equal(options.form.bonus_used,'0');assert.equal(options.form['order[shipping_rate]'],'seven_cod');
      assert.ok(Object.values(state.data.commerce.autoPurchase.records).some(r=>r.status==='processing'&&r.submitIntent?.total===555));
      if(!timeout||acceptedAfterTimeout){const order={token:token(orders.length+1),number:'FBTEST'+(orders.length+1),productId:cart};orders.push(order);cart=null;discount=false;code=null;}
      if(timeout)throw new Error('Synthetic timeout');return response({success:true,url:'/orders/'+orders.at(-1).token},url);
    }
    throw new Error('Unexpected POST '+url);
  }};
  const credentials={getFunboxAccount:()=>({slot:'C',account:'synthetic@example.invalid',password:'synthetic',enabled:true}),getPickupProfile:()=>({fullName:'測試人',phone:'0900000000',storeName:'測試街門市'}),getPickupSetup:()=>({storeInfo:store})};
  const multi={adapters:{C:{activePurchaseHold:()=>null}},accountPurchaseTails:new Map(),accountIdentity:()=> 'synthetic-identity'};
  const clock={now:Date.parse(start)+1000};
  const task=await new FunboxAppRedemption({dataDir:dir,state,credentials,multi,apiFactory:async()=>api,now:()=>clock.now,coordinator:{_ledger:()=>ledger}}).init();
  try{await task.configure({rows,startAt:start});task.data.enabled=true;task.data.accountIdentity='synthetic-identity';await work({task,state,ledger,events,orders,dir,api,clock,counts:()=>({postCount,addCount,removed})});}
  finally{await task.close();await fs.rm(dir,{recursive:true,force:true});}
}

test('特別任務：相同商品不同序號保留順序，重複序號與非目標商品拒絕',()=>{
 const parsed=validateRows(rows);assert.deepEqual(parsed.map(r=>r.productId),['bbpr07730','bbpr07730','bbpr07733']);assert.equal(new Set(parsed.map(r=>r.id)).size,3);
 assert.throws(()=>validateRows([rows[0],rows[0]]));assert.throws(()=>validateRows([{productId:'bbpr08914',code:rows[0].code}]));
});
test('特別任務：序號與紅利由官方確認，不限定單品價與運費拆分',()=>{
 const contract={props:{coupons:[{code:rows[0].code.toLowerCase()}],priceValidations:{coupon_discount:999504,total_price_before_bonus_discount:495,total_price_after_bonus_discount:495,bonus_consumed:0,bonus_discount:0}}};
 assertRedemptionCoupon(contract,rows[0].code);
 assertRedemptionCoupon({props:{...contract.props,priceValidations:{...contract.props.priceValidations,total_price_before_bonus_discount:450,total_price_after_bonus_discount:450}}},rows[0].code);
 for(const change of [{bonus_consumed:1},{bonus_discount:1},{coupon_discount:0}])assert.throws(()=>assertRedemptionCoupon({props:{...contract.props,priceValidations:{...contract.props.priceValidations,...change}}},rows[0].code));
 assert.throws(()=>assertRedemptionCoupon(contract,rows[1].code));
});
test('特別任務：混車、贈品及數量二不能當成單品結帳',()=>{
 const contract={props:{lineItems:[{type:'normal',variant_id:'10',quantity:1}]}};exactCart(contract,{variantId:'10'});
 assert.throws(()=>exactCart(contract,{variantId:'11'}));assert.throws(()=>exactCart({props:{lineItems:[{type:'normal',variant_id:'10',quantity:2}]}},{variantId:'10'}));
 assert.throws(()=>exactCart({props:{lineItems:[...contract.props.lineItems,{type:'gift',quantity:1}]}},{variantId:'10'}));
});
test('特別任務：多車選擇僅接受唯一目標車的官方表單',()=>{
 const cart=origin+'/carts/'+'a'.repeat(32),form=`<form action="${cart}/checkout_no_conflict"><input name="cart_hash" value="target"><input name="authenticity_token" value="csrf">黃蜂要塞</form>`;
 assert.equal(selectConflictForm(form,cart,{title:'黃蜂要塞'}).form.cart_hash,'target');
 assert.throws(()=>selectConflictForm(form+form,cart,{title:'黃蜂要塞'}));assert.throws(()=>selectConflictForm(form.replace(origin,'https://wrong.invalid'),cart,{title:'黃蜂要塞'}));
});
test('特別任務：官網現行cart_conflict亦含checkout-v3，React商品以複合id識別',async()=>{
 const token='a'.repeat(32),hash=JSON.stringify({'10_normal_':1});
 const props={cart:{token},conflictCartsGroups:{normal:[{[hash]:[[{id:'10_normal_',quantity:1,title:'測試黃蜂'}],['一般商品','normal','宅配']]}]}};
 const html=`<meta name="csrf-token" content="synthetic"><div id="checkout-v3" data-react-props='${JSON.stringify(props)}'></div>`;
 assert.equal(selectConflictForm(html,origin+'/carts/'+token+'/cart_conflict',{variantId:'10'}).form.cart_hash,hash);
 assert.throws(()=>selectConflictForm(html,origin+'/carts/'+token+'/cart_conflict',{variantId:'11'}));
 await harness(async({task})=>{
   const original=task.checked.bind(task);let selected=0;
   task.checked=async(api,method,url,options,job)=>{
    if(method==='get'&&url===origin+'/cart')return response(html,origin+'/carts/'+token+'/cart_conflict');
    if(method==='post'&&url.endsWith('/checkout_no_conflict')){selected++;assert.equal(options.form.cart_hash,hash);throw new Error('synthetic stop after correct selection');}
    return original(api,method,url,options,job);
   };
   await assert.rejects(()=>task.cart({}, {variantId:'10'},{}),/synthetic stop/);assert.equal(selected,1);
 });
});
test('特別任務：黃蜂、黃蜂、海怪依序建立三張555元COD訂單，意圖先保存',async()=>{
 await harness(async({task,state,events,orders,counts,dir})=>{await task.run();assert.deepEqual(orders.map(o=>o.productId),rows.map(r=>r.productId));assert.deepEqual(counts(),{postCount:3,addCount:3,removed:0});assert.equal(task.data.jobs.every(j=>j.status==='ordered'),true);
 const records=Object.values(state.data.commerce.autoPurchase.records);assert.equal(records.length,3);assert.equal(records.every(r=>r.specialTask&&r.accountSlot==='C'&&r.payment==='seven_cod'&&r.amount===555),true);assert.ok(events.indexOf('durable')<events.indexOf('post'));
 assert.equal(Object.keys(state.data.commerce.autoPurchase.purchaseLedger.orders).length,3);assert.equal(Object.keys(state.data.commerce.autoPurchase.purchaseLedger.reservations).length,0);
 const encrypted=await fs.readFile(path.join(task.directory,'queue.enc.json'),'utf8');for(const row of rows){assert.equal(encrypted.includes(row.code),false);assert.equal(JSON.stringify(task.status()).includes(row.code),false);assert.equal((await fs.readFile(path.join(dir,'main-state.json'),'utf8')).includes(row.code),false);}
 });
});
test('特別任務：總額不是555時完全不送單並保護C',async()=>{
 await harness(async({task,counts})=>{await task.run();assert.equal(counts().postCount,0);assert.equal(task.data.jobs[0].status,'cart_review');assert.equal(task.isReserved('C'),true);assert.equal(task.isReserved('A'),false);assert.equal(task.isReserved('B'),false);},{wrongPrice:true});
});
test('特別任務：只看總額，商品450加運費105也可成立555元COD單',async()=>{
 await harness(async({task,counts})=>{await task.run();assert.equal(counts().postCount,3);assert.equal(task.data.jobs.every(j=>j.status==='ordered'&&j.amount===555),true);},{subtotal:450,shipping:105});
});
test('特別任務：送單逾時但官方已建單，只查單確認，不重送',async()=>{
 await harness(async({task,counts})=>{await task.run();assert.equal(counts().postCount,3);assert.equal(task.data.jobs.every(j=>j.status==='ordered'),true);},{timeout:true,acceptedAfterTimeout:true});
});
test('特別任務：送單逾時且無法確認時只送一次，後兩筆不加車',async()=>{
 await harness(async({task,counts,state})=>{await task.run();assert.deepEqual(counts(),{postCount:1,addCount:1,removed:0});assert.deepEqual(task.data.jobs.map(j=>j.status),['unknown','queued','queued']);assert.equal(task.isReserved('C'),true);assert.equal(Object.values(state.data.commerce.autoPurchase.records)[0].status,'submitted_unconfirmed');},{timeout:true});
});
test('特別任務：序號明確無效只移除本筆商品，接續不同序號',async()=>{
 await harness(async({task,counts,orders})=>{await task.run();assert.deepEqual(task.data.jobs.map(j=>j.status),['skipped','ordered','ordered']);assert.deepEqual(counts(),{postCount:2,addCount:3,removed:1});assert.equal(orders.length,2);},{invalidFirst:true});
});
test('特別任務：明確售罄不加車、不送單',async()=>{
 await harness(async({task,clock,counts})=>{clock.now=Date.parse(start)+31000;await task.run();assert.equal(counts().addCount,0);assert.equal(counts().postCount,0);assert.equal(task.data.jobs.every(j=>j.status==='skipped'),true);},{stockZero:true});
});
test('特別任務：剛開放庫存零先等待更新，不將四筆全部略過',async()=>{
 await harness(async({task,counts})=>{await task.run();assert.equal(counts().addCount,0);assert.equal(task.data.jobs.every(j=>j.status==='queued'),true);assert.equal(task.data.enabled,true);},{stockZero:true});
});
test('特別任務：已啟用時調整到10:00:05，保留序號、順序與啟用狀態',async()=>{
 await harness(async({task})=>{const before=JSON.stringify(task.codes);await task.reschedule({startAt:'2026-10-21T10:00:05+08:00'});assert.equal(task.data.startAt,'2026-10-21T02:00:05.000Z');assert.equal(task.data.enabled,true);assert.equal(JSON.stringify(task.codes),before);task.data.jobs[0].status='unknown';await assert.rejects(()=>task.reschedule({startAt:'2026-10-21T10:00:10+08:00'}));});
});
test('特別任務：啟用必須確認，停用只釋放安全帳號',async()=>{
 await harness(async({task})=>{task.data.enabled=false;await assert.rejects(()=>task.arm({}));await task.arm({confirmRealOrders:true});assert.equal(task.isReserved('C'),true);await task.stop();assert.equal(task.isReserved('C'),false);task.data.jobs[0].status='unknown';await task.stop();assert.equal(task.isReserved('C'),true);});
});
test('特別任務：前端嵌入現有C列，序號明碼且使用視窗內確認',()=>{
 assert.doesNotThrow(()=>new Function(clientScript));assert.match(clientScript,/funbox-sheet-actions-C/);assert.match(clientScript,/funbox-special-reserved/);assert.match(clientScript,/confirmRealOrders:true/);assert.match(clientScript,/\.type = 'text'/);assert.doesNotMatch(clientScript,/window\.open|localhost:32[2-9]|\bconfirm\(/);
});
test('特別任務：只有受同源CSRF保護的編輯入口回填序號，普通狀態與本機狀態不含序號',async()=>{
 await harness(async({task})=>{
  const invoke=async(action,headers={})=>{let body='',status;const req={url:'/optional-tasks/funbox-app-redemption/'+action,method:'POST',headers:{host:'127.0.0.1:3210',origin:'http://127.0.0.1:3210','x-task-csrf':task.csrf,...headers},async *[Symbol.asyncIterator](){yield '{}';}};await task.handle(req,{writeHead:s=>{status=s;},end:text=>{body=text;}});return{status,body:JSON.parse(body)};};
  assert.equal(JSON.stringify(task.status()).includes(rows[0].code),false);
  const edit=await invoke('edit');assert.equal(edit.status,200);assert.deepEqual(edit.body.jobs.map(j=>j.code),rows.map(r=>r.code));
  assert.equal((await invoke('edit',{origin:'https://other.invalid'})).status,403);
  assert.equal((await invoke('edit',{'x-task-csrf':'wrong'})).status,403);
  assert.equal((await fs.readFile(path.join(task.directory,'state.json'),'utf8')).includes(rows[0].code),false);
 });
});
test('特別任務：開放時間之前及三十分鐘後都不加車、不送單',async()=>{
 await harness(async({task,clock,counts})=>{clock.now=Date.parse(start)-1;await task.run();assert.equal(counts().addCount,0);clock.now=Date.parse(start)+31*60000;await task.run();assert.equal(counts().postCount,0);assert.equal(task.data.enabled,false);});
});
test('特別任務：429遵守較長Retry-After，冷卻期間沒有新請求',async()=>{
 await harness(async({task,api,clock,counts})=>{const get=api.get;let productReads=0;api.get=async url=>{if(url.endsWith('.json')){productReads++;return {...response({},url,429),headers:()=>({'retry-after':'120'})};}return get(url);};await task.run();assert.equal(Date.parse(task.data.nextRetryAt),clock.now+120000);assert.equal(counts().addCount,0);assert.equal(task.data.jobs[0].status,'queued');await task.run();assert.equal(productReads,1);});
});
test('特別任務：已成立後C仍維持專用，手動停用才恢復一般派單',async()=>{
 await harness(async({task})=>{task.data.reserved=true;await task.reservation(true);await task.run();assert.equal(task.data.enabled,false);assert.equal(task.isReserved('C'),true);await task.stop();assert.equal(task.isReserved('C'),false);});
});
test('特別任務：有未決交易不能移除入口，安全移除後保留加密資料',async()=>{
 await harness(async({task})=>{await assert.rejects(()=>task.removeFeature({confirmRemoveFeature:true}));await task.stop();await task.removeFeature({confirmRemoveFeature:true});assert.equal(task.status().disabled,true);await fs.access(path.join(task.directory,'queue.enc.json'));await fs.access(path.join(task.directory,'disabled.flag'));});
});
test('特別任務：重啟後送單意圖保留未知保護，不自動重送',async()=>{
 await harness(async({task,state})=>{task.data.jobs[0].status='submitting';task.data.jobs[0].intent={total:555};await task.save();const restarted=await new FunboxAppRedemption({dataDir:task.dataDir,state,credentials:task.credentials,multi:task.multi,apiFactory:async()=>{throw new Error('No network allowed')}}).init();try{assert.equal(restarted.data.enabled,false);assert.equal(restarted.data.jobs[0].status,'unknown');assert.equal(restarted.isReserved('C'),true);assert.ok(state.data.commerce.autoPurchase.externalAccountReservations.C);await assert.rejects(()=>restarted.arm({confirmRealOrders:true}));}finally{await restarted.close();}});
});
test('持續重試：開放初期序號暫不可用不清車、不停任務，恢復後接續三單不重複加車',async()=>{
 await harness(async({task,api,clock,counts})=>{
  task.data.continuousRetry=true;task.waitFor=async()=>{};const post=api.post;let lookups=0;
  api.post=async(url,options)=>url.endsWith('/coupons')?response(++lookups===1?{err_msg:'not active yet'}:{code:options.data.code},url):post(url,options);
  await task.run();assert.equal(task.data.enabled,true);assert.equal(counts().addCount,1);assert.equal(counts().removed,0);assert.equal(counts().postCount,0);
  clock.now=Date.parse(task.data.nextRetryAt)+1;await task.run();assert.equal(counts().postCount,3);assert.equal(counts().addCount,3);assert.equal(task.data.jobs.every(j=>j.status==='ordered'),true);
 });
});
test('持續重試：官方回200但優惠重算延遲，先重讀到折抵成立，不因舊價格放棄或重複套券',async()=>{
 await harness(async({task,api,counts})=>{
  task.data.continuousRetry=true;task.waitFor=async()=>{};const get=api.get,post=api.post;let stale=0,apply=0;
  api.post=async(url,options)=>{if(url.endsWith('/apply_coupon'))apply++;return post(url,options);};
  api.get=async url=>{const r=await get(url);if(/^\/carts\/[a-z0-9]{32}$/.test(new URL(url).pathname)){let html=await r.text();if(html.includes('"coupon_discount":999504')&&stale<2){stale++;html=html.replace('"coupon_discount":999504','"coupon_discount":0');return response(html,r.url());}}return r;};
  await task.run();assert.equal(counts().postCount,3);assert.equal(apply,3);assert.equal(stale,2);
 });
});
test('持續重試：正式送單不明會持續自動查單，45分鐘後仍不盲重送或停用',async()=>{
 await harness(async({task,clock,counts})=>{
  task.data.continuousRetry=true;task.waitFor=async()=>{};await task.run();assert.equal(task.data.enabled,true);assert.equal(task.data.jobs[0].status,'unknown');
  clock.now+=45*60000;await task.run();assert.equal(task.data.enabled,true);assert.equal(counts().postCount,1);assert.equal(counts().addCount,1);
 },{timeout:true});
});
