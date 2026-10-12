import test from 'node:test';
import assert from 'node:assert/strict';
import {safePurchaseStep} from '../src/purchase-diagnostics.js';
import {purchaseEsliteViaApi} from '../src/auto-purchase.js';
import {esliteSheetStepsHtml} from '../src/eslite-purchase-ui.js';

const response=(body,status=200)=>({status:()=>status,ok:()=>status>=200&&status<300,json:async()=>body,dispose:async()=>{}});

test('同階段開始／完成使用同編號，重試不變成下一步，UI使用結構化編號',()=>{
  const start=safePurchaseStep({label:'購物車清空中',state:'start'});
  const end=safePurchaseStep({label:'購物車已清空並核對',state:'success'});
  assert.equal(start.displayLabel,'01｜購物車 清空中 0/1');
  assert.equal(end.displayLabel,'01｜購物車 完成 1/1');
  assert.equal(safePurchaseStep(end).displayLabel,end.displayLabel);
  const assigned=safePurchaseStep({label:'核對派單任務',state:'start',taskNumber:1});
  assert.equal(assigned.displayLabel,'02｜核對派單任務 本次取得任務 01 0/1');
  const html=esliteSheetStepsHtml({steps:[start,end,assigned]});
  assert.ok(html.includes(start.displayLabel));assert.ok(html.includes(end.displayLabel));
  assert.equal(safePurchaseStep({label:'官方明確拒單，準備有限重試',state:'retry'}).stepNumber,11);
});

for(const scenario of [{name:'順暢',lag:0,latency:250,busy:0},{name:'慢10秒',lag:10000,latency:250,busy:0},{name:'壅塞',lag:0,latency:1800,busy:2}]){
  test(`隔離 ${scenario.name}：ABCD送單、清車在加車前、紅利0、明確拒單才重試`,async()=>{
    for(const slot of ['A','B','C','D']){
      let clock=scenario.lag,submits=0,added=false,removed=false;const events=[],steps=[];
      const api={
        async get(){clock+=scenario.latency;events.push('cart-read');return response({cart:{cart_items:added?[{product_guid:'p',qty:1}]:removed?[]:[{cart_item_id:99,product_guid:'old',qty:1}]}});},
        async delete(){clock+=scenario.latency;events.push('cart-delete');removed=true;return response({});},
        async post(url,options){clock+=scenario.latency;events.push(url);if(url==='/api/v2/cart/items'){assert.ok(removed);added=true;return response({product_guid:'p',response_quantity:1});}
          assert.equal(options.data.checkout.discount_point,0);submits++;if(submits<=scenario.busy)return response({success:false,error:'系統忙碌，請稍後再試'},422);return response({order_id:'MOCK-'+slot});}
      };
      const result=await purchaseEsliteViaApi({product:{id:'p',title:'隔離商品',stock:1},settings:{action:'checkout',accountSlot:slot,strictSingleProductOrder:true,payment:['A','C'].includes(slot)?'seven_cod':'virtual_atm_home'},
        checkoutTemplate:{checkout:{discount_point:150}},apiContext:api,prevalidated:true,now:()=>clock,onStep:s=>steps.push(s)});
      assert.equal(result.status,'ordered');assert.equal(submits,scenario.busy+1);
      assert.ok(events.indexOf('cart-delete')<events.indexOf('/api/v2/cart/items'));
      assert.equal(steps[0].stepNumber,1);assert.ok(steps.some(s=>s.stepNumber===1&&s.progressCurrent===1));
      assert.ok(steps.some(s=>s.stepNumber===2&&s.progressCurrent===1));
    }
  });
}

test('清車DELETE逾時，即使後來可能清空也不加車／送單',async()=>{
  let posts=0;
  await assert.rejects(purchaseEsliteViaApi({product:{id:'p'},settings:{action:'checkout'},checkoutTemplate:{checkout:{}},prevalidated:true,
    apiContext:{get:async()=>response({cart:{cart_items:[{cart_item_id:1}]}}),delete:async()=>{throw Error('Timeout 5000ms exceeded');},post:async()=>posts++}}));
  assert.equal(posts,0);
});

test('送單逾時只送一次，不能因重試機制重送',async()=>{
  let posts=0;const steps=[];
  const result=await purchaseEsliteViaApi({product:{id:'p'},settings:{action:'checkout'},checkoutTemplate:{checkout:{}},prevalidated:true,onStep:s=>steps.push(s),
    apiContext:{get:async()=>response({cart:{cart_items:[]}}),post:async url=>{if(url.includes('/cart/'))return response({product_guid:'p',response_quantity:1});posts++;throw Error('Timeout 15000ms exceeded');}}});
  assert.equal(result.status,'submitted_unconfirmed');assert.equal(posts,1);assert.equal(steps.at(-1).progressCurrent,0);
});
