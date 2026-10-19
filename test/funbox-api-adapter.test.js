import test from 'node:test';
import assert from 'node:assert/strict';
import {FunboxPurchaseAdapter,AutoPurchaseCoordinator} from '../src/auto-purchase.js';
import {parseFunboxOrderReceipt} from '../src/funbox-api-checkout.js';
import {esliteSheetOrderRowsHtml} from '../src/eslite-purchase-ui.js';
const origin='https://shop.funbox.com.tw',token='a'.repeat(32),cartUrl=origin+'/carts/'+token;
const product={id:'tm-test',url:origin+'/products/tm-test',title:'TOMICA 測試商品',variantId:'123',stock:10};
const profile={fullName:'測試',phone:'0900000000',city:'桃園市',district:'中壢區',postalCode:'320',address:'測試地址'};
const props={csrfToken:'csrf-test',cart:{token,customer:{email:'test@example.invalid',mobile:'0900000000'}},
  lineItems:[{type:'normal',variant_id:123,quantity:1}],paymentItems:[],requiresShipping:true,shop:{cart_extra_inputs:[]},
  priceValidations:{total_price_before_bonus_discount:150}};
const choices={payment_items:[{id:1,service:'cyberbizpay_atm',cvs_payment:'no',label:'虛擬ATM',payment_charge:0}],
  price_weight_shipping_rates:[{id:2,name:'一般宅配',shipping_class:'ShippingRule',deliverable_countries:'On shore of Taiwan',price:120,payment_names:['虛擬ATM']}]};
const response=(body,url,status=200,headers={})=>({status:()=>status,ok:()=>status>=200&&status<300,url:()=>url,headers:()=>headers,
  text:async()=>typeof body==='string'?body:JSON.stringify(body),json:async()=>body,dispose:async()=>{}});
function harness({timeout=false,reject=false,wrongQuantity=false,busyResponses=0}={}){
  let added=false,orderPosts=0,browserLaunches=0;const events=[];
  const api={storageState:async()=>({cookies:[],origins:[]}),dispose:async()=>{},
    get:async url=>{
      if(url===origin+'/account'||url===origin+'/account/index')return response('<a href="/account/logout">登出</a>',url);
      if(url===origin+'/cart')return response('',url,302,{location:added?cartUrl:'/account/index'});
      if(url===cartUrl)return response(`<meta name="csrf-token" content="csrf-test"><script>window.lineItems = ${JSON.stringify(props.lineItems)};</script><div id="checkout-v3" data-react-props='${JSON.stringify(props)}'></div>`,url);
      if(url.includes('/shipping_rates_and_payment_method_items'))return response(choices,url);
      if(url===origin+'/account/orders')return response(`<a href="/account/logout">登出</a><a href="/account/orders/${token}">查單</a>`,url);
      if(url===origin+'/account/orders/'+token)return response(`<div class="order_name"><span class="value">FBTEST01</span></div><div class="order_total_price">NT$270</div><div class="item_title">付款方式</div><div class="item_content">虛擬ATM繳費</div><div class="item_title">付款狀態</div><div class="item_content">等待付款</div><div class="order_line_items"><div class="table_row"><div class="line_item_title"><a href="/products/tm-test">TOMICA 測試商品 -</a></div><div class="line_item_price_quantity">NT$150 x ${wrongQuantity?2:1}</div></div></div>`,url);
      if(url===origin+'/orders/'+token)return response('<h4 class="payment-way">您選擇的付款方式為: 虛擬ATM</h4><p>轉帳銀行: 玉山銀行(808) 城東分行 帳號: 12345678901234 轉帳金額: NT$270 請於 2026-10-12 23:59 前完成轉帳</p>',url);
      throw new Error('Unexpected GET '+url);
    },post:async(url,args)=>{
      if(url===origin+'/cart/add'){added=true;return response({},url)}
      if(url.endsWith('/apply_bonus'))return response({bonus_used:0},url);
      if(url===cartUrl+'/'){orderPosts++;events.push('order-post');assert.equal(args.form.total_price_frontend,'270');
        if(orderPosts<=busyResponses)return response({success:false,message:'系統忙碌，請稍後再試'},url,422);
        if(timeout)throw new Error('Timeout 15000ms exceeded');return response(reject?{success:false}:{success:true,url:'/orders/'+token},url,reject?422:200);}
      throw new Error('Unexpected POST '+url);
    }};
  const adapter=new FunboxPurchaseAdapter({dataDir:'test/nonexistent-api-session',apiAtmCheckout:true,apiContextFactory:async()=>api,
    browserLauncher:()=>{browserLaunches++;throw new Error('Browser forbidden')},getDeliveryProfile:()=>profile});
  return {adapter,events,counts:()=>({orderPosts,browserLaunches})};
}
const settings={payment:'virtual_atm_home',action:'checkout',quantity:1,confirmedManualAssignment:true};

for(const scenario of [{name:'順暢',lag:0,busyResponses:0},{name:'慢10秒',lag:10000,busyResponses:0},{name:'壅塞',lag:0,busyResponses:2}]){
  test(`FUNBOX隔離 ${scenario.name}：ABC不清車、編號與有限送單`,async()=>{
    for(const slot of ['A','B','C']){
      const h=harness(scenario),steps=[];h.adapter.accountSlot=slot;
      const result=await h.adapter.purchase({...product,detectedAt:new Date(Date.now()-scenario.lag).toISOString()},
        {...settings,onStep:s=>steps.push(s),onBeforeSubmit:async()=>h.events.push('durable-intent')});
      assert.equal(result.status,'ordered');assert.equal(h.counts().orderPosts,scenario.busyResponses+1);
      assert.equal(steps[0].label,'核對派單任務');assert.equal(steps.some(s=>/清空|已清空/.test(s.label)),false);
      assert.ok(steps.some(s=>s.stepNumber===2&&s.progressCurrent===1));assert.equal(h.counts().browserLaunches,0);
      await h.adapter.close();
    }
  });
}
test('production ATM adapter completes one API order, quantity and ATM proof without browser',async()=>{
  const h=harness(),steps=[];
  const result=await h.adapter.purchase(product,{...settings,onStep:s=>steps.push(s),onBeforeSubmit:async()=>h.events.push('durable-intent')});
  assert.equal(result.status,'ordered');assert.equal(result.orderNumber,'FBTEST01');assert.equal(result.atmInfoReady,true);
  assert.equal(result.bankCode,'808');assert.equal(result.quantity,1);assert.equal(h.adapter.activePurchaseHold(),null);
  assert.deepEqual(h.events,['durable-intent','order-post']);assert.deepEqual(h.counts(),{orderPosts:1,browserLaunches:0});
  assert.ok(steps.some(s=>s.label==='ATM 轉帳資料已取得' && /未執行匯款/.test(s.reason)));
  assert.ok(steps.every(s=>s.reason), 'each live API step must explain its action or confirmed result');
  await h.adapter.close();
});
test('production ATM adapter holds unknown submission; no next cart clearing or POST',async()=>{
  const h=harness({timeout:true});
  const result=await h.adapter.purchase(product,{...settings,onBeforeSubmit:async()=>{}});
  assert.equal(result.status,'submitted_unconfirmed');assert.ok(h.adapter.activePurchaseHold());
  await assert.rejects(h.adapter.purchase(product,settings),e=>e.purchaseStatus==='submitted_unconfirmed');
  assert.equal(h.counts().orderPosts,1);await h.adapter.close();
});
test('ATM preflight and missing durable boundary never submit an order',async()=>{
  const h=harness();
  assert.equal((await h.adapter.purchase(product,{...settings,verifyOnly:true})).status,'checkout_ready');
  assert.equal(h.counts().orderPosts,0);await h.adapter.close();
  const missing=harness();await assert.rejects(missing.adapter.purchase(product,settings),e=>e.purchaseStatus==='needs_setup');
  assert.equal(missing.counts().orderPosts,0);await missing.adapter.close();
});
test('explicit rejection releases hold; mismatched official quantity does not claim success',async()=>{
  const rejected=harness({reject:true});
  await assert.rejects(rejected.adapter.purchase(product,{...settings,onBeforeSubmit:async()=>{}}),e=>e.purchaseStatus==='checkout_rejected');
  assert.equal(rejected.adapter.activePurchaseHold(),null);await rejected.adapter.close();
  const wrong=harness({wrongQuantity:true});
  assert.equal((await wrong.adapter.purchase(product,{...settings,onBeforeSubmit:async()=>{}})).status,'submitted_unconfirmed');
  assert.ok(wrong.adapter.activePurchaseHold());await wrong.adapter.close();
});
test('ATM parser ignores translation scripts and accepts actual official payment labels',()=>{
  assert.equal(parseFunboxOrderReceipt('<script>const x="銀行代碼：999 轉帳帳號：12345678901234"</script><p>沒有資訊</p>',origin).bankCode,'');
  const receipt=parseFunboxOrderReceipt('<h4>您選擇的付款方式為: 虛擬ATM</h4><p>轉帳銀行: 玉山銀行(808) 城東分行 帳號: 12345678901234 請於 2026-10-12 23:59 前完成轉帳</p>',origin);
  assert.equal(receipt.bankCode,'808');assert.equal(receipt.bankAccount,'12345678901234');
});
test('shared order table displays verified bank info without treating order creation as payment',()=>{
  const html=esliteSheetOrderRowsHtml([{key:'proof',item:{platform:'funbox',accountSlot:'A',product,quantity:1,status:'ordered',orderNumber:'FBTEST01',
    payment:'virtual_atm_home',bankCode:'808',bankAccount:'12345678901234',amount:270,paymentDeadline:'2026-10-12T15:59:00Z'}}]);
  assert.ok(html.includes('808 · 12345678901234'));assert.ok(html.includes('訂單成立'));assert.equal(html.includes('已付款'),false);
});
test('manual acceptance route also persists API intent before its order submission',async()=>{
  const events=[],state={data:{},save:async()=>{},writeSnapshot:async()=>events.push('snapshot')};
  const adapter={accountIdentity:()=> 'test-A',close:async()=>{},credentialsStatus:()=>({}),runtimeStatus:()=>({}),purchaseAssignments:async(assignments,settings)=>{
    await settings.onBeforeSubmit({accountSlot:'A',productId:product.id,total:270,quantity:1});events.push('order-post');
    return [{slot:'A',product,ok:true,status:'ordered',orderNumber:'FBTESTMANUAL'}];
  }};
  const coordinator=new AutoPurchaseCoordinator({state,adapters:{funbox:adapter},getConfig:()=>({enabled:true,funbox:{enabled:true}}),notifyPrivate:async()=>{}});
  await coordinator.runFunboxAssignments([{slot:'A',product}]);
  assert.deepEqual(events,['snapshot','order-post']);
  assert.equal(state.data.commerce.autoPurchase.records['funbox:tm-test:A'].status,'ordered');
  await coordinator.close();
});
test('ATM session maintenance and cart clearing also use HTTP without a browser',async()=>{
  const h=harness();const result=await h.adapter.maintainSession({clearCart:true});
  assert.equal(result.ok,true);assert.equal(result.transport,'http_api');
  assert.deepEqual(h.counts(),{orderPosts:0,browserLaunches:0});await h.adapter.close();
});
